#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env"
TOOLKIT_DIR="${TOOLKIT_DIR:-$HOME/overleaf-toolkit}"
PURGE_DATA=false
[[ "${1:-}" == "--purge-data" ]] && PURGE_DATA=true

command -v docker >/dev/null || { echo "ERROR: Docker is required" >&2; exit 1; }
[[ -d "$TOOLKIT_DIR" ]] || { echo "ERROR: Toolkit directory not found: $TOOLKIT_DIR" >&2; exit 1; }

if [[ -f "$ENV_FILE" ]]; then
  docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.addon.yml" down --remove-orphans || true
else
  docker rm -f sharelatex-snapshot-adapter sharelatex-git-bridge-node 2>/dev/null || true
fi

RC_FILE="$TOOLKIT_DIR/config/overleaf.rc"
BACKUP="$(find "$TOOLKIT_DIR/config" -maxdepth 1 -type f -name 'overleaf.rc.bak.*' -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1 {$1=""; sub(/^ /,""); print}')"
if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then
  cp "$BACKUP" "$RC_FILE"
else
  sed -i '/^OVERLEAF_IMAGE_NAME=/d' "$RC_FILE"
fi

"$TOOLKIT_DIR/bin/up" -d

docker image rm sharelatex-local-ui:3.4.0 2>/dev/null || true
docker image rm deploy-snapshot-adapter deploy-git-bridge-node 2>/dev/null || true

if [[ "$PURGE_DATA" == true ]]; then
  rm -rf "$ROOT_DIR/deploy/runtime"
  echo "Addon runtime data removed."
else
  echo "Addon runtime data kept. Use --purge-data to remove it."
fi

echo "ShareLaTeX Git Bridge addon removed. Original ShareLaTeX image restored."
