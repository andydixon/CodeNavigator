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

Configuration: `PORT` (default `4177`, or `--port`), `CORS_ORIGIN` (default `*`).
`git` must be on `PATH` to load GitHub repositories (the image includes it).

The browser frontend in `web/` is plain JavaScript (it has to run in the browser) and
is embedded into the binary; `web/config.js` points it at the same origin.

Notes:
- `GET /` serves the frontend instead of a JSON service description.
- Search queries are percent-decoded properly.
- `.gitignore` support covers standard globs but not global excludes or `.git/info/exclude`.
