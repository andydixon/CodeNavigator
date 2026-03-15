# CodeNavigator

A single binary that serves the WebGL frontend and the
indexing API (jobs, SSE progress, snapshots, search, source) on one origin.
No dependencies beyond the Go standard library.

```bash
go run .                 # http://127.0.0.1:4177
go test -race ./...
go test -run x -bench Index   # indexes $CODENAV_BENCH_DIR (default: Go's stdlib source)
./build.sh [tag]         # Docker image, tests run during the build
docker run --rm -p 4177:4177 codenavigator:latest
```

Configuration:

- `PORT` (default `4177`, or `--port`), `CORS_ORIGIN` (default `*`)
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: a GitHub App's credentials; enables sign-in for private repositories
- `GITHUB_APP_SLUG`: the app's URL name, for the "grant repository access" link

`git` must be on `PATH` to load GitHub repositories (the image includes it).

## Multiple users

Every browser gets an HttpOnly session cookie. Jobs, snapshots and GitHub sign-ins belong to
that session and are invisible (404) to others. Each session keeps its latest snapshot; snapshots
idle for an hour are deleted, at most 8 are held (least recently used evicted), and two indexes
run at once while the rest queue. State is in memory, so a restart signs everyone out.

## Private GitHub repositories

Uses a GitHub App's user authorisation. When an anonymous clone fails, the frontend offers
**Sign in with GitHub**; the callback (`/api/github/callback`) stores an 8-hour user token in
memory for the session. Clones send it as an HTTP header via environment git config, never in
the URL or arguments, and host git config and credential helpers are ignored. A signed-in user
can only open repositories where the app is installed and they have access, otherwise the
frontend links to the app's installation page.

GitHub App settings: callback URL `https://<host>/api/github/callback`, setup URL `https://<host>/`
with "Redirect on update", token expiry on, no webhook, repository permission Contents: read-only.

The browser frontend in `web/` is plain JavaScript (it has to run in the browser) and
is embedded into the binary; `web/config.js` points it at the same origin.

Notes:
- `GET /` serves the frontend instead of a JSON service description.
- Jobs and snapshots are private to the browser session that created them (see above).
- Search queries are percent-decoded properly.
- `.gitignore` support covers standard globs but not global excludes or `.git/info/exclude`.
