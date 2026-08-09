# HTTP API

All endpoints are under `/api/` and return JSON unless noted. Everything else is the static frontend.
Every response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and CORS
headers (`Access-Control-Allow-Origin` from `CORS_ORIGIN`). `OPTIONS` on any path returns `204`.
Errors look like `{"error": "message"}`.

## Sessions and ownership

The first `POST /api/jobs` (or GitHub sign-in) sets an `HttpOnly`, `SameSite=Lax` cookie called
`codenav_session` (`Secure` when served over HTTPS or behind a proxy sending
`X-Forwarded-Proto: https`). Jobs, snapshots and GitHub sign-ins belong to that session. Any other
session gets `404` for them, exactly as if they didn't exist. IDs are random (`crypto/rand`).

## Health

### `GET /api/health`

```json
{ "ok": true, "version": "0.1.0", "localFolders": false }
```

`localFolders` is `true` only when the server runs with `SHOW_LOCAL=true`.

## Jobs (indexing)

### `POST /api/jobs`

```json
{ "kind": "github", "url": "https://github.com/owner/repo", "name": "repo" }
{ "kind": "local", "name": "my-folder" }
```

| Status | Meaning |
|---|---|
| `201` | `{"jobId": "job-…"}`; GitHub jobs start cloning immediately |
| `400` | Invalid body, unknown kind, missing or invalid GitHub URL (`https://github.com/owner/repo` only) |
| `403` | `kind: local` while local folders are disabled |

GitHub clones are shallow (`--depth=1`), time out after 10 minutes, ignore the host's git config and
credential helpers, and authenticate with the visitor's GitHub token when they're signed in.

### `POST /api/jobs/{id}/files?path=relative/path`

Local jobs only. The request body is the raw file content (at most 64 MB). `path` must be relative
with no `..` segments. Returns `{"ok": true}`, `400` for unsafe paths, `404` for unknown or non-local jobs.

### `POST /api/jobs/{id}/commit`

Local jobs only. Starts indexing the uploaded files. Returns `202 {"ok": true}`.

### `GET /api/jobs/{id}`

```json
{
  "id": "job-…", "sourceKind": "github", "name": "prometheus",
  "phase": "parsing", "completed": 420, "total": 1676, "message": "Parsing 421 of 1676",
  "snapshotId": null, "error": null, "warnings": [],
  "authRequired": "signin"
}
```

`phase` is `receiving`, `cloning`, `queued`, `scanning`, `parsing`, `linking`, `ready` or `error`.
`authRequired` only appears on failed clones that signing in (`signin`) or granting the GitHub App
access (`install`) could fix.

### `GET /api/jobs/{id}/events`

Server-sent events. Each change to the job is sent as:

```
event: progress
data: {…same shape as GET /api/jobs/{id}…}
```

A `: keep-alive` comment is sent every 15 seconds. The stream ends when the job has a `snapshotId`
or an `error`, or when the client disconnects. At most two jobs index at once; others report
`queued`.

## Snapshots

### `GET /api/snapshots/{id}`

```json
{ "id": "snapshot-…", "name": "prometheus", "source": "github", "fileCount": 1676,
  "totalLines": 568224, "definitions": 13717, "references": 790, "edges": 790, "warnings": [] }
```

### `GET /api/snapshots/{id}/scene`

Everything the frontend needs to lay out the map and city:

```json
{
  "id": "snapshot-…", "name": "prometheus", "source": "github",
  "files": [{ "id": 1, "path": "cmd/prometheus/main.go", "name": "main.go", "directory": "cmd/prometheus",
              "extension": "go", "language": "Go", "layer": "application", "lines": 2296,
              "bytes": 91234, "complexity": 90, "preview": "// first 60 lines…", "symbolCount": 55 }],
  "edges": [{ "from": 1, "to": 2, "kind": "import", "confidence": "known" }],
  "totalLines": 568224, "definitions": 13717, "references": 790
}
```

After a scene is delivered the server drops its copy of the previews. `layer` is one of
`application`, `library`, `test`, `generated`, `vendor`, `platform`, `docs`. `confidence` is `known`
(resolved path) or `inferred` (matched by module name).

### `GET /api/snapshots/{id}/search?q=text`

Case-insensitive substring match on file paths and symbol names (at least 2 characters, at most 180 hits):

```json
[{ "entityId": 1, "path": "cmd/prometheus/main.go", "name": "main", "line": 120, "kind": "definition", "preview": "func main() {" }]
```

### `GET /api/snapshots/{id}/entities/{fileId}`

The full file record, including `symbols: [{name, kind, line, signature}]`.

### `GET /api/snapshots/{id}/entities/{fileId}/source?start=0&limit=600`

```json
{ "start": 0, "lines": ["package main", "…"], "totalLines": 2296 }
```

`limit` is clamped to 1–4096. Once every line of a file has been delivered the server deletes it
from disk, and the workspace is removed once all files are delivered.

### `GET /api/snapshots/{id}/alerts`

Open security alerts for a GitHub snapshot, fetched with the viewer's own token:

```json
{
  "available": true,
  "codeScanning": { "status": "ok", "alerts": [
    { "path": "web/app.js", "title": "Cross-site scripting", "severity": "critical", "url": "https://github.com/…", "line": 7 } ] },
  "dependabot": { "status": "forbidden", "alerts": [] }
}
```

When alerts can't be fetched at all: `{"available": false, "reason": "not-github" | "signin"}`.
Per-set `status` is `ok`, `forbidden` (permission not granted or feature disabled) or
`unavailable`. Severities are normalised to `critical`, `high`, `medium` or `low`. Dependabot alerts
point at the manifest that declares the vulnerable package.

## GitHub sign-in

| Endpoint | Purpose |
|---|---|
| `GET /api/github/status` | `{"configured", "connected", "login", "installUrl"}` for the current session |
| `GET /api/github/login` | Redirects to GitHub with a single-use `state` bound to the session (10 minutes) |
| `GET /api/github/callback` | Exchanges the code, stores the user token in memory, redirects to `/?github=connected` (or `denied`/`error`) |
| `POST /api/github/logout` | Forgets the session's token |

Login, callback and logout return `404` when no GitHub App is configured.
