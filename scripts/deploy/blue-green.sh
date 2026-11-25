#!/usr/bin/env bash
# Blue-green slot management for the staging host (#797).
#
# Runs ON the deploy host (the workflow pipes it over SSH:
#   ssh host "bash -s -- <command> [args]" < scripts/deploy/blue-green.sh).
#
# Commands:
#   active                 Print the live slot (blue|green).
#   idle                   Print the slot that is not live.
#   deploy <tag>           Start <tag> in the idle slot; prints the slot name.
#   smoke <slot>           Smoke-test a slot via its local ports.
#   smoke-url <base_url>   Smoke-test any backend base URL.
#   switch <slot>          Point the reverse proxy at <slot>; old live slot is
#                          kept running as the rollback target.
#   rollback               Smoke-test the previous slot and switch back to it.
#   teardown <slot>        Stop a slot (refuses to stop the live slot).
#
# State lives in $STATE_DIR: active-slot, previous-slot, <slot>.tag.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/remitlend}"
STATE_DIR="${STATE_DIR:-${DEPLOY_DIR}/state}"
SLOT_COMPOSE="${SLOT_COMPOSE:-${DEPLOY_DIR}/deploy/blue-green/docker-compose.slot.yml}"
UPSTREAM_CONF="${UPSTREAM_CONF:-/etc/nginx/conf.d/remitlend-upstream.conf}"
NGINX_RELOAD="${NGINX_RELOAD:-sudo nginx -t && sudo nginx -s reload}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-90}"
# A syntactically valid Stellar public key; the challenge endpoint only signs
# a nonce for it, so no account or funds are involved.
SMOKE_PUBLIC_KEY="${SMOKE_PUBLIC_KEY:-GCJPBXSE6WCQDCEYZW6C3YVZCSSCHC4AE72L5KWKCYL2CLLL7NH5VSCI}"

log() { echo "[blue-green] $*" >&2; }
die() { echo "::error::[blue-green] $*" >&2; exit 1; }

backend_port() { case "$1" in blue) echo 3001 ;; green) echo 3101 ;; *) die "unknown slot '$1'" ;; esac; }
frontend_port() { case "$1" in blue) echo 3000 ;; green) echo 3100 ;; *) die "unknown slot '$1'" ;; esac; }
other_slot() { [ "$1" = "blue" ] && echo green || echo blue; }

active_slot() { cat "${STATE_DIR}/active-slot" 2>/dev/null || echo blue; }
previous_slot() { cat "${STATE_DIR}/previous-slot" 2>/dev/null || true; }

compose() {
  local slot="$1"; shift
  SLOT="$slot" BACKEND_PORT="$(backend_port "$slot")" FRONTEND_PORT="$(frontend_port "$slot")" \
    docker compose -p "remitlend-${slot}" -f "$SLOT_COMPOSE" "$@"
}

is_valid_json_openapi() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '(.openapi // .swagger) and (.paths | type == "object")' >/dev/null
  else
    python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if (d.get("openapi") or d.get("swagger")) and isinstance(d.get("paths"), dict) else 1)'
  fi
}

smoke_url() {
  local base="${1%/}" failures=0 code body
  log "Smoke-testing ${base}"

  # Wait for the process to come up before judging it.
  local deadline=$((SECONDS + SMOKE_TIMEOUT_SECONDS))
  until curl -fsS -o /dev/null --max-time 5 "${base}/health"; do
    [ "$SECONDS" -ge "$deadline" ] && { echo "::error::GET /health never returned 200 within ${SMOKE_TIMEOUT_SECONDS}s"; return 1; }
    sleep 3
  done

  check_status() { # name expected method path [data]
    local name="$1" expected="$2" method="$3" path="$4" data="${5:-}"
    if [ -n "$data" ]; then
      code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X "$method" \
        -H 'content-type: application/json' -d "$data" "${base}${path}" || echo 000)
    else
      code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X "$method" "${base}${path}" || echo 000)
    fi
    if [ "$code" = "$expected" ]; then
      echo "  PASS ${name} (${code})"
    else
      echo "::error::smoke ${name} expected ${expected}, got ${code}"
      failures=$((failures + 1))
    fi
  }

  check_status "GET /health" 200 GET /health
  check_status "GET /healthz/ready" 200 GET /healthz/ready
  check_status "POST /api/auth/challenge" 200 POST /api/auth/challenge "{\"publicKey\":\"${SMOKE_PUBLIC_KEY}\"}"

  if body=$(curl -fsS --max-time 10 "${base}/docs.json") && printf '%s' "$body" | is_valid_json_openapi; then
    echo "  PASS GET /docs.json (valid OpenAPI)"
  else
    echo "::error::smoke GET /docs.json did not return valid OpenAPI JSON"
    failures=$((failures + 1))
  fi

  [ "$failures" -eq 0 ] || { log "${failures} smoke check(s) failed"; return 1; }
  log "All smoke checks passed for ${base}"
}

write_upstream() {
  local slot="$1" tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<CONF
# Managed by scripts/deploy/blue-green.sh — live slot: ${slot}
upstream remitlend_backend { server 127.0.0.1:$(backend_port "$slot"); keepalive 16; }
upstream remitlend_frontend { server 127.0.0.1:$(frontend_port "$slot"); keepalive 16; }
CONF
  sudo install -m 0644 "$tmp" "$UPSTREAM_CONF"
  rm -f "$tmp"
}

switch_to() {
  local target="$1" current
  current="$(active_slot)"
  [ "$target" = "$current" ] && { log "${target} is already live"; return 0; }
  compose "$target" ps --status running --quiet backend | grep -q . || die "slot ${target} is not running"

  local backup
  backup="$(mktemp)"
  sudo cp "$UPSTREAM_CONF" "$backup" 2>/dev/null || true
  write_upstream "$target"
  if ! eval "$NGINX_RELOAD"; then
    log "proxy reload failed; restoring previous upstream"
    [ -s "$backup" ] && sudo install -m 0644 "$backup" "$UPSTREAM_CONF" && eval "$NGINX_RELOAD" || true
    rm -f "$backup"
    die "traffic switch to ${target} failed; ${current} remains live"
  fi
  rm -f "$backup"

  mkdir -p "$STATE_DIR"
  echo "$current" > "${STATE_DIR}/previous-slot"
  echo "$target" > "${STATE_DIR}/active-slot"
  log "traffic switched ${current} -> ${target}; ${current} kept as rollback target"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  active) active_slot ;;
  idle) other_slot "$(active_slot)" ;;
  deploy)
    tag="${1:?usage: deploy <tag>}"
    target="$(other_slot "$(active_slot)")"
    log "deploying ${tag} to idle slot ${target} (live: $(active_slot))"
    TAG="$tag" compose "$target" pull
    TAG="$tag" compose "$target" up -d --remove-orphans
    mkdir -p "$STATE_DIR"
    echo "$tag" > "${STATE_DIR}/${target}.tag"
    echo "$target"
    ;;
  smoke) slot="${1:?usage: smoke <slot>}"; smoke_url "http://127.0.0.1:$(backend_port "$slot")" ;;
  smoke-url) smoke_url "${1:?usage: smoke-url <base_url>}" ;;
  switch) switch_to "${1:?usage: switch <slot>}" ;;
  rollback)
    prev="$(previous_slot)"
    [ -n "$prev" ] || die "no previous slot recorded; nothing to roll back to"
    log "rolling back $(active_slot) -> ${prev} ($(cat "${STATE_DIR}/${prev}.tag" 2>/dev/null || echo unknown tag))"
    smoke_url "http://127.0.0.1:$(backend_port "$prev")" || die "rollback target ${prev} failed smoke tests; not switching"
    switch_to "$prev"
    ;;
  teardown)
    slot="${1:?usage: teardown <slot>}"
    [ "$slot" = "$(active_slot)" ] && die "refusing to tear down live slot ${slot}"
    compose "$slot" down --remove-orphans
    ;;
  *) die "usage: $0 {active|idle|deploy <tag>|smoke <slot>|smoke-url <url>|switch <slot>|rollback|teardown <slot>}" ;;
esac
