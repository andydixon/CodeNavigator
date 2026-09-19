# Architecture

```
browser ──HTTP/SSE──▶ Go server (main.go, github.go) ──▶ indexer (indexer.go) ──▶ temp workspace
   │                        │
   │                        └── GitHub (OAuth token exchange, alerts API, git clone)
   └── WebGL2 frontend (web/): app.js · renderer.js · city.js · camera.js · labels.js
```

## Server

One Go binary using only the standard library. The frontend is embedded with `go:embed` and served
from the same origin as the API.

### Indexing (`indexer.go`)

1. **Walk** the checkout in lexical order. Skip `.git`, `node_modules`, `target`, `dist`, `build`
   and `.next`, honour `.ignore` files everywhere and `.gitignore` inside git checkouts. Only regular
   files count (no symlinks).
2. **Parse** files in parallel (one worker per CPU). Binary files (a NUL byte in the first 4 KB) and
   files over 8 MB are skipped. For each file it records lines, bytes, a complexity score (branching
   tokens), the first 60 lines as a preview, definitions (class/struct/function patterns) and import
   targets (from/import/require/#include/use/using patterns). Each regex has a cheap literal
   prefilter, which made indexing about 3× faster than regex alone.
3. **Link** imports to files: relative paths first (`known`), then module-style names resolved by
   path suffix or file stem (`inferred`). Ambiguous names are never guessed.
4. Classify each file's **language** (by extension) and **layer** (test, vendor, generated, platform,
   library, docs or application) by path.

### Sessions, jobs and snapshots (`main.go`)

- **Sessions:** a random cookie identifies each browser, and jobs, snapshots and GitHub tokens are
  owned by it.
- **Jobs:** a job is a GitHub clone or a local upload, reporting progress over SSE.
- **Snapshots:** each session keeps only its latest snapshot. Snapshots idle for an hour are expired,
  at most 8 are held (least recently used evicted), and at most 2 indexes run at once.
- **Delivery:** once the scene is sent, previews are released, and each source file is deleted after
  every line of it has been fetched.
- **Workspace cleanup:** only paths inside the workspace directory are ever deleted.

### GitHub (`github.go`)

- **Sign-in:** the GitHub App user-authorisation flow. A single-use `state` is bound to the
  session, and the resulting user token is held in memory only (8-hour expiry).
- **Clones** pass the token as an HTTP header through `GIT_CONFIG_*` environment variables, never in
  arguments or URLs, with host git config and credential helpers disabled.
- **Security alerts** are fetched per request with the viewer's token, following pagination only on
  the API host.

## Frontend (`web/`)

Plain ES modules, no framework, no build step.

| Module | Responsibility |
|---|---|
| `app.js` | UI, input, data loading, 2D overlay canvas, city orchestration (signs, routes, residents, tour, links, alerts) |
| `renderer.js` | All WebGL2 drawing: instanced boxes, sign quads, route ribbons, particles, sprites |
| `camera.js` | Matrix maths: perspective, lookAt, inverse, orbit pose |
| `city.js` | Pure city logic, unit tested: layout, collision, navigation grid and routing, sign placement, tape, walls, posters, residents, place links |
| `labels.js` | Text atlas for signs (shelf-packed canvas) and the poster atlas |
| `people.js` | Residents' identities, generated deterministically from the repository name and resident index, plus the ID card portrait |
| `api.mjs` | `fetch` wrapper and SSE-over-fetch parser |

### Views

- **2D:** squarified treemap in a 1000×680 world, orthographic. Source text is painted into an
  overview canvas when zoomed out, and into per-tile textures (LRU, 192 MB budget) when zoomed in.
- **3D:** the same instances extruded, rendered through a perspective orbit camera. Roofs sample the
  overview canvas as a GPU texture, and only nearby roofs get sharp per-file textures.
- **City:** `layoutCity` lays the directory tree out in metres. Folders shrink by half a road on
  each side (18 m avenues between districts, narrower streets deeper down). Files become buildings,
  with footprint ≈ 1.1 m² per line and height 6 m + 10 m × log₂(1 + complexity).

### City rendering passes (in order)

1. **Floor:** ground and folder pavements in nesting order, depth test off, top faces only (so
   nested pavements a few centimetres apart can't z-fight).
2. **Buildings and wall:** instanced boxes. The city shader adds procedural windows (lit share from
   definition count), neon edges, a concrete wall and exponential fog.
3. **Doors and street furniture:** small instanced boxes (lit doorways, lamp posts and heads, bins,
   benches, trees, hydrants, post boxes) drawn with a separate shader variant, and only within a few
   hundred metres of the camera. Streetlights stand on folder boundaries, and everything sits on
   folder pavements, never the road. Cars use the same shader: each block inside a folder has a
   one-lane loop half-way into the street around it, and only cars near the camera are rebuilt
   each frame.
4. **Effects:** additive and never occluding. Lamp light pools, search beacons, fire and smoke particles (stateless,
   animated in the vertex shader), residents (procedural stick-figure sprites), street routes
   (mitred ribbons with chevrons or pulsing dashes, kept in right-hand lanes) and import arcs.
5. **Signs:** textured quads from the label atlas, depth-tested but not depth-writing. A shader test
   discards any quad face that would read mirrored, which is how two-faced blade signs work.

### Routing

- **Grid:** a 3 m occupancy grid blocks buildings (grown by 2 m, so a ribbon in its lane can't clip a
  wall) and the city wall, and makes pavements slightly dearer than roads.
- **Doors:** each building gets one door, centred where possible and clear of its corners. Street
  doors face the nearest open street. Buildings with no frontage get a back door whose path follows
  a distance-to-street field computed once on a 0.5 m grid (chamfer sweeps until stable) through the
  2.4 m alleys.
- **Search:** one Dijkstra run from the selected building's doorstep reaches every import and
  dependent (paths cost the same both ways). It uses float64 distances and a settled set.
- **Shaping:** street paths are straightened by line-of-sight (sampled every quarter cell), then joined
  to each building's door path: inside the building, out through the doorway, along the alley, onto
  the street. Alley points are drawn narrower and centred. Buildings with no door fall back to the
  nearest reachable street.
