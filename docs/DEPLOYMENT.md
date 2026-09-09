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

There are two supported ways to run it, and they deploy the same two pieces either way — the
Node API, and a web server holding the built front end:

- **From source**, with systemd keeping it alive. Start at [First run](#first-run).
- **With Docker Compose**, if you would rather not have Node on the host at all. Skip to
  [Running it in Docker](#running-it-in-docker).

Neither is more supported than the other; the container images are built from this
repository by the `Dockerfile` at its root, and run the same code with the same
configuration.

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

## Running it in Docker

An alternative to the two sections above, not an addition to them. Same application, same
`.env`, same data on disk — the host just needs Docker instead of Node.

### The short way

```sh
curl -fsSL https://raw.githubusercontent.com/gondhijagapathi/networth-tracker/main/scripts/deploy.sh -o networth-deploy.sh
bash networth-deploy.sh
```

`scripts/deploy.sh` is the supported path for a container install, and the one to hand to
somebody who does not want to read this document. It checks that Docker is present and
reachable, downloads the source, generates the three secrets with `openssl rand`, asks the
four questions that have no safe default, writes a `.env` at mode 600, builds, starts, and
waits for the API to report healthy — printing the log and the variable to fix if it does
not.

It is safe to re-run and it never overwrites an existing `.env`.

```sh
bash networth-deploy.sh status      # what is running
bash networth-deploy.sh logs        # follow them
bash networth-deploy.sh backup      # an encrypted bundle, now
bash networth-deploy.sh upgrade     # back up, fetch, rebuild, restart
bash networth-deploy.sh uninstall   # stop and remove; asks separately about the data
```

Two environment variables steer it:

| Variable | Default | |
| --- | --- | --- |
| `NETWORTH_DIR` | `$HOME/networth-tracker` | Where the source lives |
| `NETWORTH_REF` | `main` | Branch or tag to deploy |
| `NETWORTH_NONINTERACTIVE` | unset | Accept every default, ask nothing |

`upgrade` takes a backup **before** it fetches anything. Migrations run at boot and are not
reversible, so that is the only moment a bundle can still capture the old shape of the data.
If no `BACKUP_PASSPHRASE` is set it says so and asks whether to continue. It then hard-resets
the checkout — that directory is a deployment, not somewhere to keep local commits — and
reports any new settings the upgrade introduced, adding the ones that have a sane default
and naming the ones that do not rather than writing a placeholder into your configuration.

### The long way

If you would rather drive Compose yourself, or you already have the source:

```sh
git clone https://github.com/gondhijagapathi/networth-tracker.git
cd networth-tracker
cp .env.example .env
# fill in the three secrets and BOOTSTRAP_INVITE_CODE exactly as in "First run"
docker compose up -d --build
```

Then open <http://localhost:8080> and register with the bootstrap code.

### What comes up

Two containers, mirroring the reverse-proxy layout above rather than inventing a second
architecture for containers:

| Service | Image | Role |
| --- | --- | --- |
| `api` | built from `Dockerfile`, target `api` | The Node server. Publishes no port. |
| `web` | built from `Dockerfile`, target `web` | nginx: serves `apps/web/dist`, proxies `/api` to `api`. |

The API is reachable only from the compose network. Everything goes through nginx, which is
what makes the single trusted proxy hop the API assumes actually true — the same reason the
bare-metal instructions bind it to loopback.

### Configuration

`docker-compose.yml` reads your `.env` for secrets, then overrides the handful of variables
that describe the *host* filesystem and cannot mean the same thing inside a container:

```
NODE_ENV=production
API_HOST=0.0.0.0                          # so nginx can reach it; loopback would not work
COOKIE_SECURE=true                        # see below
DATABASE_PATH=/var/lib/networth/networth.db
UPLOAD_DIR=/var/lib/networth/uploads
BACKUP_DIR=/var/lib/networth/backups
```

Setting them in `.env` has no effect on this route; compose pins them.

`COOKIE_SECURE` is pinned rather than read because `.env.example` ships `false` — correct for
`npm run dev` over plain HTTP, and fatal here, where `NODE_ENV=production` requires it to be
true. A copied `.env` would otherwise crash-loop the container with the reason buried in
`docker compose logs`. True is also simply right for every way this stack is meant to be
reached: the published port is loopback, and browsers treat `localhost` as a secure context
and accept the cookie there; anything else is behind the TLS proxy the next section requires.

Everything else — the secrets, the token lifetimes, `BACKUP_CRON`, `STOCK_PRICE_PROVIDER` —
comes from `.env` and behaves exactly as documented above. Secrets are passed at run time
and never baked into an image: a layer is readable by anyone who can pull it.

Three variables exist only for this route:

```
NETWORTH_HTTP_PORT=8080   # host port the stack is published on
NETWORTH_BIND=127.0.0.1   # 0.0.0.0 ONLY when a TLS proxy on another host reaches it
TZ=Asia/Kolkata           # cron is local time; without this the nightly backup runs at 02:00 UTC
```

`NETWORTH_HTTP_PORT` is deliberately not `WEB_PORT` — that one is the Vite dev server's port
and has nothing to do with where this stack is published.

### TLS

The stack listens on plain HTTP and expects your own TLS proxy in front of it, exactly like
the nginx block in [Behind a reverse proxy](#behind-a-reverse-proxy). Point that proxy at the
published port and set, in `.env`:

```
CORS_ORIGIN=https://networth.example.com
```

`COOKIE_SECURE` needs no attention here — compose already pins it to `true`, which is what
makes the session cookie safe to carry over your proxy's HTTPS.

Answering *yes* to `deploy.sh`'s "behind an HTTPS reverse proxy?" question sets both that
`CORS_ORIGIN` and `NETWORTH_BIND=0.0.0.0`, for a proxy running on another host. If your proxy
is on this machine, leave `NETWORTH_BIND` at `127.0.0.1`.

Do not publish the port on `0.0.0.0` without TLS in front of it — the session lives in a
cookie, and a `Secure` cookie over plain HTTP is simply dropped by the browser, so sign-in
will appear to do nothing at all.

### Where the data goes

One named volume, `networth-data`, mounted at `/var/lib/networth`. It holds the database,
the encrypted upload blobs and the backup bundles — everything worth keeping.

```sh
# Take a bundle now. Uses BACKUP_PASSPHRASE from .env; add -it to be prompted instead.
docker compose exec api node apps/api/dist/cli/backup.js create
docker compose exec api node apps/api/dist/cli/backup.js list
docker compose exec -it api node apps/api/dist/cli/backup.js restore /var/lib/networth/backups/<bundle>.ntb

# Migration state, without starting a server
docker compose exec api node apps/api/dist/db/cli.js status

docker volume inspect networth-tracker_networth-data   # where it lives on the host
```

> Note the `node dist/...` form rather than `npm run backup`. The npm scripts run the CLI
> from TypeScript source through `tsx`, and the runtime image contains neither — it ships
> compiled JavaScript and production dependencies only. The compiled entry points take the
> same arguments and read the same environment.

Bundles land inside the volume, which is the one place a backup must not stay. Copy them out
on a schedule of its own:

```sh
docker compose cp api:/var/lib/networth/backups ./backups
```

> `docker compose down` stops the stack and leaves the volume alone. **`docker compose down -v`
> deletes it**, and with it every account, asset and document. Copy your backup bundles off
> the host before you reach for `-v`.

To keep the data somewhere you can see it, replace the named volume with a bind mount:

```yaml
volumes:
  - /srv/networth/data:/var/lib/networth
```

That directory must be writable by UID 1000 — the container drops to the unprivileged `node`
user rather than running as root.

### Upgrading

```sh
bash networth-deploy.sh upgrade
```

That is the whole procedure: it backs up, fetches, rebuilds, restarts and waits for health.
By hand it is

```sh
git pull
docker compose up -d --build
```

with the backup as your own responsibility beforehand.

Migrations run at boot, in the API container, before it serves a request. The same rule as
everywhere else applies: a bundle from a *newer* version is refused rather than restored, so
upgrade before restoring across machines.

### Logs and health

```sh
docker compose logs -f api
docker compose ps          # the api container reports healthy/unhealthy
```

Both containers carry a `HEALTHCHECK`. The API's polls `/api/health`, which needs no
authentication and touches no user data, and `web` waits for the API to report healthy
before it starts — nginx resolves its upstream at boot, so it needs the API to exist and not
merely to have been created.

The in-process schedules are unchanged by containerisation: the dead-man sweep, the NAV
refresh and the nightly backup all run inside the `api` container. A container that is not
running at 02:00 does not take that night's backup, which is what `restart: unless-stopped`
is for.

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
