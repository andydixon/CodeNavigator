# Development

Requirements: Go 1.26+, git, and Node 20+ (only to run the frontend tests).

```bash
go run .                          # http://127.0.0.1:4177, frontend served from web/ via go:embed
SHOW_LOCAL=true go run .          # also allow local folder uploads
```

The frontend is embedded at build time, so **restart `go run` after changing files in `web/`**.

## Tests

```bash
go test -race ./...                               # server, indexer, GitHub flows (fake GitHub)
node --test webtest/*.test.mjs                    # frontend maths: camera, city, routing, signs, posters
go test -run x -bench Index                       # indexing benchmark on $CODENAV_BENCH_DIR (default: Go's stdlib)
```

What the suites cover:

- **Go:**
  - Indexing: ignore rules, parsing and linking.
  - Jobs: the local job lifecycle end to end (upload → SSE → scene → source release), session
    isolation, expiry and eviction, the concurrency queue, SSE keep-alives, and the `SHOW_LOCAL` gate.
  - GitHub: the sign-in flow including forged and reused state, clone token handling and timeouts,
    security alert pagination and permissions.
- **Node:**
  - Camera: parity with the original landscape projection.
  - City: layout invariants (no overlaps, avenue widths), collision and movement, routing (detours,
    enclosed buildings, a large-city time budget), ribbon lanes and mitred corners.
  - Signs and walls: sign readability and placement, hazard tape, walls and posters, text fitting.
  - Other: residents staying walkable, and place links rejecting untrusted input.

## Project layout

```
main.go            HTTP server, sessions, jobs, snapshots, expiry
github.go          GitHub App sign-in, clone command, security alerts
indexer.go         Walking, parsing, linking, classification
*_test.go          Go tests
web/
  index.html       Markup
  styles.css       All styling (see the design notes below)
  app.js           UI, input, overlays, city orchestration
  renderer.js      WebGL2 passes and shaders
  city.js          Pure city logic (layout, routing, signs, residents…)
  camera.js        Matrix maths
  labels.js        Sign atlas, poster atlas, text fitting
  api.mjs          fetch + SSE helpers
  fonts/           Self-hosted Archivo Black, Atkinson Hyperlegible, Space Mono
webtest/           node:test suites for web/ modules
docs/              This documentation and screenshots
Dockerfile, build.sh
```

## Conventions

- **No dependencies:** the Go side uses only the standard library, and the frontend is plain ES
  modules with no bundler.
- **Keep logic testable:** anything that can be pure maths or data goes in `city.js`, `camera.js`
  or `labels.js`, with a `node:test` test. `app.js` wires it to the DOM and `renderer.js` draws it.
- **Commits** are small and describe why, not just what.

## Design notes

The interface is deliberately hand-made rather than polished:

- **Colour:** flat warm ink surfaces, hard 2px black edges, offset shadows instead of blur, and a
  clashing lime/pink/sky/tangerine palette.
- **Type:** chunky Archivo Black headings, Atkinson Hyperlegible body text and Space Mono labels.
- **Personality:** small tilts, stickers and wiggles give it some energy. Everything animated
  respects `prefers-reduced-motion`.
- **Tokens:** colours and fonts are CSS variables at the top of `styles.css`, and the city's
  palette lives in the shaders in `renderer.js`.
