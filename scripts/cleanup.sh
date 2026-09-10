#!/usr/bin/env bash
#
# Net Worth Tracker — remove what an older installation left outside the install directory.
#
# Up to deploy format 1 the data lived in a Docker named volume, which Docker keeps under
# /var/lib/docker, and a bare-metal install could be pointed at /var/lib/networth. Neither
# is used any more: everything is in `data/` beside docker-compose.yml. This script deletes
# those two leftovers, and nothing else.
#
#     bash cleanup.sh              show what exists, ask before deleting each thing
#     bash cleanup.sh --dry-run    show what exists and stop
#     bash cleanup.sh --yes        delete without asking (for scripts; still prints)
#
# It never touches the current installation's `data/` directory. Use `deploy.sh reset` or
# `deploy.sh uninstall` for that.

set -euo pipefail

PROJECT_NAME="${NETWORTH_PROJECT:-networth}"
VAR_DIR="${NETWORTH_LEGACY_VAR_DIR:-/var/lib/networth}"

# Both the plain name and the name Compose gives a volume it created for this project.
VOLUMES="networth-data ${PROJECT_NAME}_networth-data"

DRY_RUN=0
ASSUME_YES=0

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

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $arg" ;;
  esac
done

# Asks on the terminal rather than stdin, so `curl ... | bash` still gets an answer instead
# of eating the rest of the script.
confirm() {
  local prompt="$1" reply=''
  [ "$ASSUME_YES" -eq 1 ] && return 0
  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    warn 'No terminal to ask on, and --yes was not given. Skipping.'
    return 1
  fi
  printf '%s %s[y/N]%s ' "$prompt" "$DIM" "$RESET"
  if [ -t 0 ]; then IFS= read -r reply; else IFS= read -r reply < /dev/tty; fi
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

COMPOSE=''
if docker compose version >/dev/null 2>&1; then
  COMPOSE='docker compose'
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE='docker-compose'
fi

# ---------------------------------------------------------------------------
# What is still there
# ---------------------------------------------------------------------------

found_volumes=''
found_var=0

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  for volume in $VOLUMES; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      found_volumes="$found_volumes $volume"
    fi
  done
else
  warn 'Docker is not available, so no volume can be inspected or removed.'
fi

[ -e "$VAR_DIR" ] && found_var=1

step 'What is left over'

if [ -n "$found_volumes" ]; then
  for volume in $found_volumes; do
    say "  ${BOLD}docker volume${RESET}  $volume  ${DIM}$(docker volume inspect -f '{{ .Mountpoint }}' "$volume" 2>/dev/null)${RESET}"
  done
else
  say "  ${DIM}no Docker volume from an older install${RESET}"
fi

if [ "$found_var" -eq 1 ]; then
  say "  ${BOLD}directory${RESET}      $VAR_DIR  ${DIM}$(du -sh "$VAR_DIR" 2>/dev/null | cut -f1 || printf 'size unknown')${RESET}"
  find "$VAR_DIR" -maxdepth 2 -mindepth 1 2>/dev/null | head -20 | sed "s/^/      ${DIM}/;s/$/${RESET}/" || true
else
  say "  ${DIM}$VAR_DIR does not exist${RESET}"
fi

if [ -z "$found_volumes" ] && [ "$found_var" -eq 0 ]; then
  say ''
  ok 'Nothing to clean up.'
  exit 0
fi

say ''
say "${RED}${BOLD}Everything listed above is deleted permanently.${RESET}"
say "If an old installation is the only copy of your accounts, assets and documents, take a"
say "backup bundle out of it first — there is no undo, and no other copy."

if [ "$DRY_RUN" -eq 1 ]; then
  say ''
  ok 'Dry run: nothing was deleted.'
  exit 0
fi

# ---------------------------------------------------------------------------
# Removal
# ---------------------------------------------------------------------------

if [ -n "$found_volumes" ]; then
  step 'Docker volume'
  for volume in $found_volumes; do
    if confirm "Delete volume ${BOLD}$volume${RESET}?"; then
      # A volume still attached to a container refuses to go. Stopping the stack first is
      # the honest fix; failing loudly is better than a half-done cleanup.
      if ! docker volume rm "$volume" >/dev/null; then
        warn "Could not remove $volume — a container is probably still using it."
        [ -n "$COMPOSE" ] && say "  ${DIM}Try: $COMPOSE --project-name $PROJECT_NAME down${RESET}"
        continue
      fi
      ok "Removed $volume"
    else
      say "  ${DIM}Left alone.${RESET}"
    fi
  done
fi

if [ "$found_var" -eq 1 ]; then
  step "$VAR_DIR"
  if confirm "Delete ${BOLD}$VAR_DIR${RESET} and everything in it?"; then
    if [ -w "$(dirname "$VAR_DIR")" ]; then
      rm -rf "$VAR_DIR"
    else
      say "  ${DIM}Needs root to remove — running: sudo rm -rf $VAR_DIR${RESET}"
      command -v sudo >/dev/null 2>&1 || die "No write access and no sudo. Remove $VAR_DIR as root."
      sudo rm -rf "$VAR_DIR"
    fi
    ok "Removed $VAR_DIR"
  else
    say "  ${DIM}Left alone.${RESET}"
  fi
fi

say ''
ok 'Done. The current installation keeps its data in the install directory, in data/.'
