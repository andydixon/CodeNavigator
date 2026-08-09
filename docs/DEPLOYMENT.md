# Deployment

## Docker

```bash
./build.sh [tag]            # default codenavigator:latest; runs go test inside the build
docker run -d --name codenavigator -p 127.0.0.1:4177:4177 \
  --env-file /etc/codenavigator/app.env \
  --memory 2g --cpus 4 --pids-limit 512 \
  codenavigator:latest
```

The image is a static binary on Alpine with `git` and CA certificates, running as a non-root user,
with a `HEALTHCHECK` on `/api/health`. Workspaces live in the container's `/tmp` and disappear with
it.

`app.env` (keep it `chmod 600`):

```bash
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_APP_SLUG=
# SHOW_LOCAL=true         # only if visitors should be able to upload local folders
```

## systemd

`/etc/systemd/system/codenavigator.service`:

```ini
[Unit]
Description=CodeNavigator (docker container)
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Restart=always
RestartSec=5
TimeoutStartSec=0
ExecStartPre=-/usr/bin/docker rm -f codenavigator
ExecStart=/usr/bin/docker run --rm --name codenavigator \
  --env-file /etc/codenavigator/app.env \
  -p 127.0.0.1:4177:4177 \
  --memory 2g --cpus 4 --pids-limit 512 \
  codenavigator:latest
ExecStop=/usr/bin/docker stop -t 30 codenavigator

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now codenavigator
```

Redeploy: `./build.sh && sudo systemctl restart codenavigator`.

## nginx

```nginx
server {
    listen 80;
    server_name codenav.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name codenav.example.com;

    ssl_certificate     /etc/letsencrypt/live/codenav.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/codenav.example.com/privkey.pem;

    # Local folder uploads send one file per request; the frontend skips files over 8 MB.
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:4177;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Indexing progress is a server-sent event stream: don't buffer it.
        proxy_buffering    off;
        proxy_read_timeout 300s;
    }
}
```

`X-Forwarded-Proto: https` makes the session cookie `Secure`. Certificates: `certbot certonly --nginx -d codenav.example.com`.

## Operating limits

| Limit | Value |
|---|---|
| Concurrent indexing | 2 jobs; others queue |
| Snapshots held | 8 in total, 1 per session, least recently used evicted |
| Idle expiry | 1 hour for snapshots, finished jobs and abandoned uploads |
| Clone timeout | 10 minutes |
| File size | files over 8 MB are skipped; uploads capped at 64 MB |
| GitHub tokens | in memory, 8 hours |

All state is in memory. A restart clears snapshots and signs everyone out.

## Security notes

- **Local folders** are off unless `SHOW_LOCAL=true`. With them on, anyone who can reach the site
  can upload files to the server's temporary workspace.
- **Anyone who can reach the site can clone public repositories** through it. Put it behind
  authentication if that matters to you.
- **Visitors' GitHub tokens** never reach the browser, git arguments or logs. Host git config and
  credential helpers are ignored, so the server's own credentials can't be used by a visitor.
