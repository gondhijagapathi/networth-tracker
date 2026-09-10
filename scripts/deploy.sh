#!/usr/bin/env bash
#
# Net Worth Tracker — install and upgrade.
#
# One script for both, because they are the same job with a different starting point and
# because an upgrade path that is a separate set of instructions is an upgrade path people
# get wrong. It fetches the source, asks the handful of questions that have no safe default,
# generates the secrets that must never have one, and hands the rest to Docker Compose.
#
#     bash deploy.sh              install, or upgrade an existing installation
#     bash deploy.sh upgrade      upgrade explicitly (refuses if nothing is installed)
#     bash deploy.sh status|logs|backup|start|stop|restart|reset|uninstall
#
# It is safe to re-run. Your `.env` is never overwritten, and the data volume is never
# touched except by `reset` and `uninstall`, both of which ask first.

set -euo pipefail

REPO_URL="${NETWORTH_REPO:-https://github.com/gondhijagapathi/networth-tracker.git}"
REPO_REF="${NETWORTH_REF:-main}"
INSTALL_DIR="${NETWORTH_DIR:-$HOME/networth-tracker}"
PROJECT_NAME="networth"

# Written into .env so a re-run can tell what the last run chose. Bumped only when this
# script needs to do something different with an installation made by an older one.
DEPLOY_FORMAT=1

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$RESET" "$BOLD" "$*" "$RESET"; }
ok()   { printf '%s  ok%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s warn%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '\n%serror%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Prompting
#
# Reads from the terminal rather than stdin, so that `curl ... | bash` still asks its
# questions instead of silently swallowing the script itself as the answers.
# ---------------------------------------------------------------------------

INTERACTIVE=1
TTY_IN=/dev/stdin
if [ -n "${NETWORTH_NONINTERACTIVE:-}" ]; then
  INTERACTIVE=0
elif [ -t 0 ]; then
  TTY_IN=/dev/stdin
elif [ -r /dev/tty ]; then
  TTY_IN=/dev/tty
else
  INTERACTIVE=0
fi

# ask <variable> <prompt> <default>
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __reply=''
  if [ "$INTERACTIVE" -eq 0 ]; then
    printf -v "$__var" '%s' "$__default"
    return
  fi
  if [ -n "$__default" ]; then
    printf '%s %s[%s]%s ' "$__prompt" "$DIM" "$__default" "$RESET"
  else
    printf '%s ' "$__prompt"
  fi
  IFS= read -r __reply < "$TTY_IN" || __reply=''
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

# ask_secret <variable> <prompt> — no echo, and asked twice so a typo is caught now rather
# than when a backup will not open.
ask_secret() {
  local __var="$1" __prompt="$2" __first='' __second=''
  if [ "$INTERACTIVE" -eq 0 ]; then printf -v "$__var" '%s' ''; return; fi
  while :; do
    printf '%s ' "$__prompt"
    IFS= read -rs __first < "$TTY_IN" || __first=''
    printf '\n'
    [ -z "$__first" ] && { printf -v "$__var" '%s' ''; return; }
    printf 'Repeat it: '
    IFS= read -rs __second < "$TTY_IN" || __second=''
    printf '\n'
    [ "$__first" = "$__second" ] && break
    warn "Those did not match. Again."
  done
  printf -v "$__var" '%s' "$__first"
}

confirm() {
  local __prompt="$1" __default="${2:-n}" __reply=''
  if [ "$INTERACTIVE" -eq 0 ]; then [ "$__default" = "y" ]; return; fi
  local __hint='[y/N]'; [ "$__default" = "y" ] && __hint='[Y/n]'
  printf '%s %s%s%s ' "$__prompt" "$DIM" "$__hint" "$RESET"
  IFS= read -r __reply < "$TTY_IN" || __reply=''
  __reply="${__reply:-$__default}"
  case "$__reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

COMPOSE=''

require_docker() {
  step 'Checking Docker'

  command -v docker >/dev/null 2>&1 || die \
"Docker is not installed.

  macOS / Windows   https://www.docker.com/products/docker-desktop
  Linux             curl -fsSL https://get.docker.com | sh

Install it, then run this script again."

  if ! docker info >/dev/null 2>&1; then
    die \
"Docker is installed but not reachable.

Either the daemon is not running (start Docker Desktop, or:
  sudo systemctl start docker
), or your user is not allowed to talk to it:
  sudo usermod -aG docker \"\$USER\"   # then log out and back in"
  fi

  # The v2 plugin is the supported one. The old standalone binary is accepted because plenty
  # of installations still have it and it can do everything this script asks of it.
  if docker compose version >/dev/null 2>&1; then
    COMPOSE='docker compose'
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE='docker-compose'
    warn 'Using the legacy docker-compose binary. The Compose v2 plugin is recommended.'
  else
    die \
"Docker Compose is not available.

  Linux   sudo apt install docker-compose-plugin   (or the equivalent for your distribution)
  Desktop update Docker Desktop, which bundles it"
  fi

  ok "$(docker --version)"
  ok "$($COMPOSE version | head -1)"
}

compose_cmd() {
  # `--project-name` keeps the volume and container names stable regardless of what the
  # install directory is called, so renaming the directory does not orphan the data.
  ( cd "$INSTALL_DIR" && $COMPOSE --project-name "$PROJECT_NAME" "$@" )
}

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------

fetch_source() {
  local mode="$1" # install | upgrade

  if [ "$mode" = 'install' ]; then
    step "Downloading the source into $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    if command -v git >/dev/null 2>&1; then
      git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
    else
      download_tarball
    fi
    ok 'Source downloaded'
    return
  fi

  step 'Fetching the latest version'
  if [ -d "$INSTALL_DIR/.git" ]; then
    ( cd "$INSTALL_DIR"
      git fetch --depth 1 origin "$REPO_REF"
      # Hard reset rather than merge: this is a deployment checkout, not somewhere to keep
      # local commits, and a merge conflict here would strand somebody mid-upgrade. `.env`
      # is gitignored, so it is untouched by this.
      git reset --hard "origin/$REPO_REF"
      git clean -fd --exclude=.env --exclude=data
    )
  else
    warn 'Not a git checkout — re-downloading the source archive.'
    download_tarball
  fi
  ok "Now at $(installed_version)"
}

download_tarball() {
  local slug archive tmp
  slug="$(printf '%s' "$REPO_URL" | sed -E 's#^https://github.com/##; s#\.git$##')"
  archive="https://codeload.github.com/$slug/tar.gz/refs/heads/$REPO_REF"
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand $tmp now, while it is still set
  trap "rm -rf '$tmp'" RETURN

  command -v curl >/dev/null 2>&1 || die 'Neither git nor curl is available. Install one of them.'
  curl -fsSL "$archive" -o "$tmp/src.tar.gz" || die "Could not download $archive"

  mkdir -p "$INSTALL_DIR"
  # `--strip-components=1` drops GitHub's `<repo>-<ref>/` wrapper directory. `.env` is
  # excluded so an upgrade cannot overwrite the configuration.
  tar -xzf "$tmp/src.tar.gz" -C "$INSTALL_DIR" --strip-components=1 --exclude='*/.env'
}

installed_version() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    ( cd "$INSTALL_DIR" && git describe --tags --always 2>/dev/null || git rev-parse --short HEAD )
  elif [ -f "$INSTALL_DIR/package.json" ]; then
    sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$INSTALL_DIR/package.json" | head -1
  else
    printf 'unknown'
  fi
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
  else
    # 36 bytes is 48 base64 characters, comfortably past the 32-character minimum the server
    # enforces. /dev/urandom is a fine source; openssl is just tidier about the encoding.
    head -c 36 /dev/urandom | base64 | tr -d '\n'
  fi
}

host_timezone() {
  if [ -n "${TZ:-}" ]; then printf '%s' "$TZ"; return; fi
  if command -v timedatectl >/dev/null 2>&1; then
    local tz; tz="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
    [ -n "$tz" ] && { printf '%s' "$tz"; return; }
  fi
  if [ -f /etc/timezone ]; then tr -d '\n' < /etc/timezone; return; fi
  if [ -L /etc/localtime ]; then
    readlink /etc/localtime | sed 's#.*/zoneinfo/##'; return
  fi
  printf 'Etc/UTC'
}

env_value() { # env_value <key> — read a key out of the existing .env
  [ -f "$INSTALL_DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$INSTALL_DIR/.env" | head -1
}

write_env() {
  step 'Configuring'

  local invite port bind tz passphrase behind_proxy public_url cors
  local access_secret refresh_secret encryption_secret
  local smtp_host smtp_port smtp_user smtp_pass smtp_from

  say ''
  say "A few questions. Press Enter to accept the default in ${DIM}grey${RESET}."
  say ''

  ask invite 'Invite code for the first admin account:' "$(gen_secret | tr -dc 'a-zA-Z0-9' | head -c 12)"
  ask port 'Port to serve on:' '8080'

  say ''
  say "Is anything other than this machine going to reach it?"
  say "  ${DIM}Answer no for a laptop or a home server you use locally. Answer yes only if you"
  say "  have a reverse proxy terminating HTTPS in front of it.${RESET}"
  if confirm 'Behind an HTTPS reverse proxy?' 'n'; then
    behind_proxy=1
    ask public_url 'Public URL it will be served at:' 'https://networth.example.com'
    # 0.0.0.0 so a proxy on another host can reach it. On the same host, loopback would do,
    # but the proxy is the thing enforcing TLS either way and this is the case people get
    # wrong in the other direction.
    bind='0.0.0.0'
    cors="$public_url"
  else
    behind_proxy=0
    bind='127.0.0.1'
    cors="http://localhost:$port"
  fi

  say ''
  say "A nightly backup is written encrypted, and only if you set a passphrase."
  say "  ${DIM}Leave it empty to skip — you can add BACKUP_PASSPHRASE to .env later. Store it"
  say "  somewhere other than this machine: it is the only thing that opens a bundle.${RESET}"
  ask_secret passphrase 'Backup passphrase (at least 12 characters, empty to skip):'
  if [ -n "$passphrase" ] && [ "${#passphrase}" -lt 12 ]; then
    warn 'Shorter than 12 characters — the server will reject it. Skipping backups for now.'
    passphrase=''
  fi

  # --- Email ---------------------------------------------------------------
  #
  # Asked rather than assumed, and asked last, because it is the only optional part of this
  # that has a real cost to skipping. Without it nobody can reset a forgotten password and
  # the dead-man switch cannot warn anyone — which matters precisely because that feature
  # is for somebody who has stopped opening the app.
  smtp_host=''; smtp_port='587'; smtp_user=''; smtp_pass=''; smtp_from=''

  say ''
  say "Email lets this send invite codes, password reset links and dead-man switch warnings."
  say "  ${DIM}Skip it and the app still works, but a forgotten password cannot be reset and"
  say "  the dead-man switch's warnings are recorded without being delivered. You can add"
  say "  the SMTP_* lines to .env later and restart.${RESET}"

  if confirm 'Set up email now?' 'n'; then
    say ''
    say "For Gmail you need an ${BOLD}App Password${RESET}, not your account password —"
    say "  ${DIM}Google stopped accepting the latter over SMTP in 2022. Turn on 2-Step"
    say "  Verification, then myaccount.google.com -> Security -> App passwords. It is"
    say "  sixteen characters shown in four groups; paste it with or without the spaces.${RESET}"
    say ''

    ask smtp_host 'SMTP host:' 'smtp.gmail.com'
    ask smtp_port 'SMTP port:' '587'
    ask smtp_user 'Username (your full email address):' ''
    ask_secret smtp_pass 'Password / App Password (empty to skip email):'
    # Spaces stripped here as well as in the server's config: an env file carrying a value
    # with spaces in it is a thing different parsers disagree about, and there is no reason
    # to find out which one is reading it.
    smtp_pass="$(printf '%s' "$smtp_pass" | tr -d '[:space:]')"

    if [ -z "$smtp_user" ] || [ -z "$smtp_pass" ]; then
      warn 'No username or password given — leaving email switched off.'
      smtp_host=''; smtp_user=''; smtp_pass=''
    else
      ask smtp_from 'Send as:' "$smtp_user"
      case "$smtp_host" in
        *gmail.com|*googlemail.com)
          if [ "${#smtp_pass}" -ne 16 ]; then
            warn "That does not look like a Gmail App Password (16 characters). The server"
            warn "will refuse to start with it. Fix SMTP_PASS in .env if it fails."
          fi
          if [ "$smtp_from" != "$smtp_user" ]; then
            warn "Gmail rewrites or refuses a From it has not verified on the account."
            warn "Use $smtp_user unless you have verified $smtp_from as an alias."
          fi
          ;;
      esac
    fi
  fi

  tz="$(host_timezone)"

  access_secret="$(gen_secret)"
  refresh_secret="$(gen_secret)"
  encryption_secret="$(gen_secret)"

  umask 077
  cat > "$INSTALL_DIR/.env" <<EOF
# Net Worth Tracker — written by scripts/deploy.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ').
#
# Keep this file. The three secrets below cannot be regenerated without consequences:
# rotating the JWT pair signs everybody out, and rotating SECRET_ENCRYPTION_KEY makes every
# enrolled second factor unreadable. Back it up alongside your database.
#
# Re-running deploy.sh never overwrites this file.

NETWORTH_DEPLOY_FORMAT=$DEPLOY_FORMAT

# --- Server ---
NODE_ENV=production
CORS_ORIGIN=$cors

# Where the stack is published on this host. Compose reads both.
NETWORTH_BIND=$bind
NETWORTH_HTTP_PORT=$port

# --- Auth ---
# Generated locally by deploy.sh. They have never left this machine.
JWT_ACCESS_SECRET=$access_secret
JWT_REFRESH_SECRET=$refresh_secret
SECRET_ENCRYPTION_KEY=$encryption_secret
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d

# --- Bootstrap ---
# Used exactly once, to create the first admin account. Every account after that comes from
# an invite that admin issues.
BOOTSTRAP_INVITE_CODE=$invite

# --- Backups ---
BACKUP_CRON=0 2 * * *
BACKUP_RETENTION=14
BACKUP_PASSPHRASE=$passphrase

# --- Schedules ---
# Cron is matched against local time, which is why the timezone is pinned here.
TZ=$tz
NAV_REFRESH_CRON=30 20 * * 1-5
AMFI_NAV_URL=https://portal.amfiindia.com/spages/NAVAll.txt
STOCK_PRICE_PROVIDER=manual

# --- Email ---
# Empty SMTP_HOST means this instance sends nothing: invites, password resets and dead-man
# warnings are recorded in the outbox as "not sent" rather than dropped, and the admin
# Email panel says so. For Gmail, SMTP_PASS must be a 16-character App Password.
SMTP_HOST=$smtp_host
SMTP_PORT=$smtp_port
SMTP_USER=$smtp_user
SMTP_PASS=$smtp_pass
SMTP_FROM=$smtp_from
# Follows the port unless set: 465 is implicit TLS, 587 negotiates it with STARTTLS.
SMTP_SECURE=

# --- Public URL ---
# What every link in an outgoing email is built from. It cannot be taken from the request
# that triggered the mail — a dead-man warning is sent by a timer, and trusting a Host
# header would let a caller choose where a password-reset link points.
APP_BASE_URL=$cors
EOF
  chmod 600 "$INSTALL_DIR/.env"

  ok "Wrote $INSTALL_DIR/.env (secrets generated, readable only by you)"
  [ -z "$passphrase" ] && warn 'Scheduled backups are OFF — no BACKUP_PASSPHRASE was set.'
  [ -z "$smtp_host" ] && warn 'Email is OFF — no password resets, and dead-man warnings are recorded but not sent.'

  DEPLOY_MAIL_HOST="$smtp_host"

  DEPLOY_PUBLIC_URL="$cors"
  DEPLOY_INVITE="$invite"
  DEPLOY_BEHIND_PROXY="$behind_proxy"
}

# An upgrade may introduce configuration this installation has never seen. Rather than
# silently running on defaults, add the new keys with their documented values and say so.
reconcile_env() {
  local example="$INSTALL_DIR/.env.example" added=0 missing='' key value
  [ -f "$example" ] || return 0

  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      # Container-shaped values compose pins itself, and dev-only ports. Adding these to a
      # deployment .env would be noise at best and misleading at worst.
      API_HOST|API_PORT|WEB_PORT|DATABASE_PATH|UPLOAD_DIR|BACKUP_DIR|COOKIE_SECURE) continue ;;
    esac
    grep -q "^$key=" "$INSTALL_DIR/.env" 2>/dev/null && continue

    # `.env.example` carries deliberate placeholders for the values nobody may default —
    # the secrets and the bootstrap code. Copying one in would write `replace-me-...` into
    # somebody's live configuration, which the server then refuses to boot on. Name them
    # instead and let a human decide.
    case "$value" in
      *replace-me*|*change-me*)
        missing="$missing $key"
        continue
        ;;
    esac

    if [ "$added" -eq 0 ]; then
      printf '\n# --- Added by deploy.sh on %s ---\n' "$(date -u '+%Y-%m-%d')" >> "$INSTALL_DIR/.env"
    fi
    printf '%s\n' "$line" >> "$INSTALL_DIR/.env"
    warn "New setting added to .env: $key"
    added=$((added + 1))
  done < "$example"

  [ "$added" -gt 0 ] && say "  ${DIM}Review those in $INSTALL_DIR/.env — they are at their defaults.${RESET}"

  if [ -n "$missing" ]; then
    say ''
    warn "This version needs settings your .env does not have, and they have no safe default:"
    for key in $missing; do say "    $key"; done
    say "  ${DIM}Add them to $INSTALL_DIR/.env by hand. Generate a secret with:"
    say "    openssl rand -base64 48${RESET}"
    confirm 'Continue the upgrade anyway? The server will refuse to start without them.' 'n' \
      || die 'Stopped. Nothing has changed.'
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------

build_and_start() {
  step 'Building the images'
  say "${DIM}The first build compiles a native module and takes a few minutes. Later builds reuse"
  say "most of that work and are much quicker.${RESET}"
  compose_cmd build

  step 'Starting'
  compose_cmd up -d --remove-orphans
}

wait_for_health() {
  step 'Waiting for the server to come up'
  local waited=0 limit=180 cid state

  # `docker inspect` rather than `compose ps --format`: custom Go templates are not
  # supported by every Compose version this script accepts, and the legacy v1 binary has no
  # --format at all. Falling back to the plain container state covers the moment before the
  # healthcheck has had its first go.
  while [ "$waited" -lt "$limit" ]; do
    cid="$(compose_cmd ps -q api 2>/dev/null | head -1 || true)"
    # A container that has gone away is not coming back on its own within our patience.
    [ -z "$cid" ] && break

    state="$(docker inspect \
      -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$cid" 2>/dev/null || true)"

    case "$state" in
      healthy)          ok 'The API is healthy'; return 0 ;;
      unhealthy|exited) break ;;
    esac

    sleep 2
    waited=$((waited + 2))
    [ $((waited % 20)) -eq 0 ] && say "  ${DIM}still starting (${waited}s, currently ${state:-unknown})${RESET}"
  done

  printf '\n%serror%s The API did not come up. Its last words:\n\n' "$RED" "$RESET" >&2
  compose_cmd logs --tail 40 api >&2 || true
  cat >&2 <<EOF

${BOLD}What to do${RESET}
  Most failures here are a configuration problem and the log above names the variable.
  Edit  $INSTALL_DIR/.env  and run this script again.
  Full logs:  bash $0 logs
EOF
  exit 1
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

is_installed() { [ -f "$INSTALL_DIR/docker-compose.yml" ] && [ -f "$INSTALL_DIR/.env" ]; }

cmd_install() {
  require_docker

  if is_installed; then
    say ''
    say "An installation already exists in $INSTALL_DIR."
    confirm 'Upgrade it instead?' 'y' || die 'Nothing to do.'
    cmd_upgrade
    return
  fi

  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
      say "Found the source in $INSTALL_DIR but no .env — configuring it."
    else
      die "$INSTALL_DIR exists and is not empty. Move it aside, or set NETWORTH_DIR to somewhere else."
    fi
  else
    fetch_source install
  fi

  write_env
  build_and_start
  wait_for_health

  local url="http://localhost:${NETWORTH_HTTP_PORT:-$(env_value NETWORTH_HTTP_PORT)}"
  [ "${DEPLOY_BEHIND_PROXY:-0}" -eq 1 ] && url="$DEPLOY_PUBLIC_URL"

  cat <<EOF

${GREEN}${BOLD}Net Worth Tracker is running.${RESET}

  Open          ${BOLD}$url${RESET}
  Register with ${BOLD}${DEPLOY_INVITE}${RESET}
                ${DIM}That code works once, to create the admin account. Everyone after that
                needs an invite the admin issues from Settings.${RESET}

EOF
  if [ "${DEPLOY_BEHIND_PROXY:-0}" -eq 1 ]; then
    cat <<EOF
  ${YELLOW}Before you point DNS at this:${RESET} the stack is serving plain HTTP on
  0.0.0.0:$(env_value NETWORTH_HTTP_PORT). Your reverse proxy must terminate TLS in front of it.
  See docs/DEPLOYMENT.md for an nginx block.

EOF
  fi
  if [ -n "${DEPLOY_MAIL_HOST:-}" ]; then
    cat <<EOF
  ${BOLD}Check email works${RESET}
    Sign in, then Administration -> Email -> Send test email. It goes to your own
    address, and if the mail server refuses it you get its exact words back — which
    with Gmail is nearly always "that was an account password, not an App Password".

EOF
  else
    cat <<EOF
  ${YELLOW}Email is off.${RESET} Nobody can reset a forgotten password, and the dead-man
  switch will record its warnings without sending them. To turn it on, add SMTP_HOST,
  SMTP_USER and SMTP_PASS to $INSTALL_DIR/.env and run: bash $0 restart
  ${DIM}For Gmail that is smtp.gmail.com, port 587, and a 16-character App Password.${RESET}

EOF
  fi
  cat <<EOF
  ${BOLD}Keep these two things${RESET}
    $INSTALL_DIR/.env    the secrets. Rotating them signs everyone out.
    Your backup passphrase          nothing else opens a bundle.

  ${BOLD}Everyday commands${RESET}
    bash $0 status     is it running
    bash $0 logs       what it is doing
    bash $0 backup     take a backup now
    bash $0 upgrade    update to the latest version
EOF
}

cmd_upgrade() {
  require_docker
  is_installed || die "Nothing is installed in $INSTALL_DIR. Run this script with no arguments to install."

  local before; before="$(installed_version)"
  say ''
  say "Upgrading the installation in $INSTALL_DIR (currently $before)."

  # A backup before an upgrade, not after. Migrations run at boot and are not reversible, so
  # this is the only moment a bundle can still capture the old shape of the data.
  if [ -n "$(env_value BACKUP_PASSPHRASE)" ]; then
    step 'Taking a backup first'
    if compose_cmd exec -T api node apps/api/dist/cli/backup.js create; then
      ok 'Backup written to the data volume'
    else
      warn 'The backup failed.'
      confirm 'Continue with the upgrade anyway?' 'n' || die 'Stopped. Nothing has changed.'
    fi
  else
    warn 'No BACKUP_PASSPHRASE is set, so no backup can be taken before this upgrade.'
    confirm 'Continue without one?' 'n' || die 'Stopped. Nothing has changed.'
  fi

  fetch_source upgrade
  reconcile_env
  build_and_start
  wait_for_health

  say ''
  ok "Upgraded from $before to $(installed_version)."
  say "  ${DIM}Database migrations ran at boot. Open the app and check it looks right.${RESET}"
}

cmd_status() {
  require_docker
  is_installed || die "Nothing is installed in $INSTALL_DIR."
  say "Installed at $INSTALL_DIR, version $(installed_version)"
  say "Serving on http://localhost:$(env_value NETWORTH_HTTP_PORT)"
  say ''
  compose_cmd ps
}

cmd_logs()    { require_docker; compose_cmd logs -f --tail 100 "${@:-}"; }
cmd_start()   { require_docker; compose_cmd up -d; wait_for_health; }
cmd_stop()    { require_docker; compose_cmd stop; ok 'Stopped. The data is untouched.'; }
# `up -d --force-recreate` rather than `compose restart`, which reuses the containers as
# they were created and so does *not* re-read `.env`. Somebody who edits a setting and runs
# `restart` means "pick that up"; the literal reading would leave them staring at an
# unchanged app, which is the sort of thing that gets blamed on the setting.
cmd_restart() { require_docker; compose_cmd up -d --force-recreate; wait_for_health; }

cmd_backup() {
  require_docker
  is_installed || die "Nothing is installed in $INSTALL_DIR."
  [ -n "$(env_value BACKUP_PASSPHRASE)" ] || die \
"No BACKUP_PASSPHRASE is set in $INSTALL_DIR/.env, and a bundle is never written unencrypted.
Add one of at least 12 characters, then run this again."
  compose_cmd exec -T api node apps/api/dist/cli/backup.js create
  say ''
  say "Copy it off this machine — a backup on the same disk is not a backup:"
  say "  ${BOLD}$COMPOSE --project-name $PROJECT_NAME cp api:/var/lib/networth/backups ./backups${RESET}"
}

cmd_reset() {
  require_docker
  is_installed || die "Nothing is installed in $INSTALL_DIR."

  say ''
  say "${RED}${BOLD}Reset destroys every account, asset, document and backup bundle${RESET}"
  say "in this installation. The data volume is deleted and recreated empty."
  say ''
  say "What survives is the configuration: $INSTALL_DIR/.env is kept, so the same"
  say "secrets and the same bootstrap invite code come back — and with no accounts left,"
  say "that code opens registration again for a new first admin."
  say ''

  if [ "$INTERACTIVE" -eq 0 ]; then
    # `confirm` answers with its default when there is nobody to ask, and a default that can
    # wipe somebody's data is not a default. An explicit variable is the only way through.
    [ "${NETWORTH_CONFIRM_RESET:-}" = 'yes' ] || die \
"Refusing to delete the data without a confirmation, and there is no terminal to ask on.
Re-run with NETWORTH_CONFIRM_RESET=yes if starting fresh is really what you want."
    warn 'Non-interactive: no backup is taken before the wipe.'
  else
    confirm "${RED}Delete all data and start fresh?${RESET}" 'n' || die 'Stopped. Nothing has changed.'
    confirm 'Really? This cannot be undone. Type y again.' 'n' || die 'Stopped. Nothing has changed.'
    reset_backup_first
  fi

  step 'Deleting the data volume'
  compose_cmd down -v
  ok 'Data volume deleted.'

  step 'Starting fresh'
  compose_cmd up -d --remove-orphans
  wait_for_health

  local url="http://localhost:$(env_value NETWORTH_HTTP_PORT)"
  [ "$(env_value COOKIE_SECURE)" = 'true' ] && [ -n "$(env_value APP_BASE_URL)" ] \
    && url="$(env_value APP_BASE_URL)"

  say ''
  ok 'Empty installation running.'
  say ''
  say "  Open          ${BOLD}$url${RESET}"
  say "  Register with ${BOLD}$(env_value BOOTSTRAP_INVITE_CODE)${RESET}"
  say "                ${DIM}The same code as the first install — it works again because there"
  say "                is nobody registered for it to clash with.${RESET}"
}

# A bundle written by `backup create` lands *inside* the volume this command is about to
# delete, so taking one is only half the job: it has to be copied onto the host first or it
# dies with everything else.
reset_backup_first() {
  if [ -z "$(env_value BACKUP_PASSPHRASE)" ]; then
    warn 'No BACKUP_PASSPHRASE is set, so no backup can be taken. Everything in there is gone.'
    confirm 'Continue anyway?' 'n' || die 'Stopped. Nothing has changed.'
    return
  fi

  confirm 'Take a backup and copy it out first?' 'y' || return

  step 'Backing up'
  compose_cmd up -d >/dev/null 2>&1 || true
  wait_for_health

  if ! compose_cmd exec -T api node apps/api/dist/cli/backup.js create; then
    warn 'The backup failed.'
    confirm 'Continue without one?' 'n' || die 'Stopped. Nothing has changed.'
    return
  fi

  local dest="$INSTALL_DIR/backups-before-reset-$(date -u '+%Y%m%dT%H%M%SZ')"
  mkdir -p "$dest"
  if compose_cmd cp api:/var/lib/networth/backups "$dest"; then
    ok "Bundles copied to $dest"
    say "  ${DIM}Copy that off this machine — nothing else opens a bundle but your passphrase.${RESET}"
  else
    rmdir "$dest" 2>/dev/null || true
    warn 'Could not copy the bundles out of the volume, so they will be deleted with it.'
    confirm 'Continue anyway?' 'n' || die 'Stopped. Nothing has changed.'
  fi
}

cmd_uninstall() {
  require_docker
  is_installed || die "Nothing is installed in $INSTALL_DIR."
  say ''
  say "${YELLOW}This stops the containers and removes the images.${RESET}"
  confirm 'Continue?' 'n' || die 'Stopped.'
  compose_cmd down --rmi local
  ok 'Stopped and removed.'
  say ''
  say "${RED}${BOLD}The data volume still exists${RESET} — every account, asset and document is in it."
  say "Take a backup out of it before you even think about the next question."
  say ''
  if confirm "${RED}Delete the data volume too? This cannot be undone.${RESET}" 'n'; then
    if confirm 'Really? Type y again to destroy all data.' 'n'; then
      compose_cmd down -v
      ok 'Data volume deleted.'
    else
      say 'Left alone.'
    fi
  else
    say "Left alone. Reinstalling will pick it back up."
  fi
}

usage() {
  cat <<EOF
${BOLD}Net Worth Tracker — deploy${RESET}

  bash $0 [command]

  ${BOLD}install${RESET}     download, configure and start  (the default)
  ${BOLD}upgrade${RESET}     back up, fetch the latest version, rebuild and restart
  ${BOLD}status${RESET}      what is running
  ${BOLD}logs${RESET}        follow the logs
  ${BOLD}backup${RESET}      take an encrypted backup now
  ${BOLD}start${RESET} / ${BOLD}stop${RESET} / ${BOLD}restart${RESET}   restart also picks up .env changes
  ${BOLD}reset${RESET}       delete all data and start fresh, keeping the configuration
  ${BOLD}uninstall${RESET}   stop and remove; asks separately about the data

  ${BOLD}Environment${RESET}
    NETWORTH_DIR              where to install       (default \$HOME/networth-tracker)
    NETWORTH_REF              branch or tag          (default main)
    NETWORTH_NONINTERACTIVE   accept every default, ask nothing
    NETWORTH_CONFIRM_RESET    set to \`yes\` to allow \`reset\` with no terminal to ask on
EOF
}

main() {
  case "${1:-install}" in
    install|'')      cmd_install ;;
    upgrade|update)  cmd_upgrade ;;
    status|ps)       cmd_status ;;
    logs)            shift; cmd_logs "$@" ;;
    backup)          cmd_backup ;;
    start)           cmd_start ;;
    stop)            cmd_stop ;;
    restart)         cmd_restart ;;
    reset)           cmd_reset ;;
    uninstall)       cmd_uninstall ;;
    -h|--help|help)  usage ;;
    *)               usage; die "Unknown command: $1" ;;
  esac
}

main "$@"
