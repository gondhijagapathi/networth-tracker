# Deployment

Self-hosted, single machine, small circle. This application is designed for a household
running it on a box they control — not for the public internet, and not for multi-tenancy.
`SECURITY.md` says that plainly and this document assumes it.

## What you need

- **Node 22 or newer** (`.nvmrc` pins the version CI uses).
- A machine that stays on, with a disk you can back up.
- A TLS reverse proxy, if it is reachable by anything other than localhost.

There is no database server, no Redis, no message queue. One SQLite file, one directory of
encrypted blobs.

## First run

```sh
git clone <your fork> networth-tracker
cd networth-tracker
cp .env.example .env
```

Generate the three secrets. They must be different from one another:

```sh
for k in JWT_ACCESS_SECRET JWT_REFRESH_SECRET SECRET_ENCRYPTION_KEY; do
  echo "$k=$(openssl rand -base64 48)"
done
```

Set a `BOOTSTRAP_INVITE_CODE` — this is used exactly once, to create the first admin
account, after which every account comes from an admin-issued invite.

```sh
npm install
npm run build
npm start
```

Open the web app, register with the bootstrap code, and that account is the admin.

The server refuses to start on a bad configuration rather than failing at the first request:
a reused secret, a `.env.example` placeholder left in production, a malformed cron
expression, or `COOKIE_SECURE=false` in production are all boot-time errors with the reason
printed.

## Where the data goes

`DATABASE_PATH`, `UPLOAD_DIR` and `BACKUP_DIR` default to paths relative to the process's
working directory:

```
./data/networth.db
./data/uploads
./data/backups
```

> **Relative to the API workspace, not the repository root.** `npm start` runs
> `npm run start -w @networth/api`, whose working directory is `apps/api/` — so the defaults
> land in `apps/api/data/`, not `./data/`. That is easy to miss and unpleasant to discover
> during a restore, so **set absolute paths in `.env` on any real deployment**:
>
> ```
> DATABASE_PATH=/var/lib/networth/networth.db
> UPLOAD_DIR=/var/lib/networth/uploads
> BACKUP_DIR=/var/lib/networth/backups
> ```
>
> Settings → Backup prints the resolved absolute directory, which is the reliable way to see
> where a given installation is actually writing.

Migrations run automatically at boot, before the first request is served. `npm run db:migrate`
applies them without starting the server, and `npm run db:status` prints what has been
applied — useful as a deployment step when you want to confirm a migration before letting
traffic near it.

## Behind a reverse proxy

Bind the API to loopback and let the proxy terminate TLS:

```
API_HOST=127.0.0.1
COOKIE_SECURE=true
CORS_ORIGIN=https://networth.example.com
```

`COOKIE_SECURE=true` is mandatory in production and enforced at boot — the session lives in
those cookies.

Express is told to trust exactly one proxy hop when `API_HOST` is not loopback, so the client
address in `X-Forwarded-For` is the proxy's idea of it rather than whatever a caller claimed.
That matters: the login backoff is keyed by address, and trusting the header unconditionally
would let anyone walk straight past it.

A minimal nginx server block:

```nginx
server {
  listen 443 ssl http2;
  server_name networth.example.com;

  ssl_certificate     /etc/letsencrypt/live/networth.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/networth.example.com/privkey.pem;

  # The built front end: apps/web/dist
  root /srv/networth/web;

  location /api/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Backup bundles can be large, and a restore uploads one.
    client_max_body_size 512M;
    proxy_read_timeout   600s;
  }

  # A single-page app: unknown paths are routes, not missing files.
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

`npm run build` produces `apps/web/dist`; serve it as static files. Do not proxy it through
the API — the API serves no HTML.

## Running it as a service

```ini
# /etc/systemd/system/networth.service
[Unit]
Description=Net Worth Tracker
After=network.target

[Service]
Type=simple
User=networth
WorkingDirectory=/srv/networth
EnvironmentFile=/srv/networth/.env
ExecStart=/usr/bin/node apps/api/dist/index.js
Restart=on-failure
RestartSec=5

# The process needs its data directory and nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/networth

[Install]
WantedBy=multi-user.target
```

`ExecStart` runs the built entry point directly, so the working directory is whatever
`WorkingDirectory` says — another reason to set absolute data paths rather than relying on
the defaults.

Note that the nightly jobs are in-process `setInterval`/cron timers, not system cron: the
dead-man sweep runs hourly and the NAV refresh and backup run on their configured schedules,
all inside this one service. If the service is down at 02:00, that night's backup does not
happen — which is an argument for `Restart=on-failure` and for checking Settings → Backup
occasionally.

## Backups

Turn them on. Both variables are required:

```
BACKUP_CRON=0 2 * * *
BACKUP_PASSPHRASE=a-long-phrase-stored-somewhere-else
BACKUP_RETENTION=14
```

Then copy `BACKUP_DIR` off the machine on a schedule of its own — the bundles are encrypted,
so an `rsync` to any host or a synced cloud folder is fine. `docs/BACKUP.md` has the full
story, including how to restore and how to open a bundle without this application.

Cron expressions are matched against the server's **local** time, the same as `cron(8)`. For
IST, set `TZ=Asia/Kolkata` in the environment.

## Upgrading

```sh
git pull
npm install
npm run build
sudo systemctl restart networth
```

Migrations run at boot. Take a backup first — that is what it is for.

Restoring a bundle taken by a *newer* version is refused rather than attempted, so upgrade
before restoring if you are moving a bundle between machines that have drifted apart.

## Health

`GET /api/health` answers `{"status":"ok"}` without authentication and touches no user data.
It is a liveness probe, not a metric.

The audit log in the database is the record of everything security-relevant: sign-ins and
failures, vault reads, escrow releases, backups taken and restored, exports generated. It is
append-only by convention and by use — nothing in the codebase updates or deletes a row.
