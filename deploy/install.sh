#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env"
TOOLKIT_DIR="${TOOLKIT_DIR:-$HOME/overleaf-toolkit}"

die() { echo "ERROR: $*" >&2; exit 1; }
command -v docker >/dev/null || die "Docker is required"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

# Some older VPS Docker/BuildKit combinations can stall while exporting
# provenance metadata. The addon does not need attestations to run.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1

if [[ ! -d "$TOOLKIT_DIR" ]]; then
  read -r -p "Toolkit directory [$TOOLKIT_DIR]: " input
  [[ -n "$input" ]] && TOOLKIT_DIR="$input"
fi
[[ -d "$TOOLKIT_DIR" ]] || die "Toolkit directory not found: $TOOLKIT_DIR"
[[ "$(head -n 1 "$TOOLKIT_DIR/config/version")" == "3.4.0" ]] || die "This addon requires ShareLaTeX image version 3.4.0"

SHARELATEX_NETWORK="${SHARELATEX_NETWORK:-$(docker inspect sharelatex --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' 2>/dev/null | grep -v '^bridge$' | head -n 1 || true)}"
if [[ -z "$SHARELATEX_NETWORK" ]]; then
  read -r -p "Existing ShareLaTeX Docker network: " SHARELATEX_NETWORK
fi
[[ -n "$SHARELATEX_NETWORK" ]] || die "Docker network is required"

rand_secret() { openssl rand -hex 32 2>/dev/null || od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
ADAPTER_TOKEN="$(rand_secret)"
INTERNAL_HOOK_TOKEN="$(rand_secret)"

# Uploaded binaries live outside MongoDB, in the filestore "fs" directory that
# backs /var/lib/sharelatex. The adapter has to mount that host path to carry
# images and PDFs through Git.
SHARELATEX_DATA_PATH="$(docker inspect sharelatex --format '{{range .Mounts}}{{if eq .Destination "/var/lib/sharelatex"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
SHARELATEX_DATA_PATH="${SHARELATEX_DATA_PATH:-$TOOLKIT_DIR/data/overleaf}"
USER_FILES_PATH="$SHARELATEX_DATA_PATH/data/user_files"
[[ -d "$USER_FILES_PATH" ]] || echo "WARNING: user_files directory not found at $USER_FILES_PATH"

umask 077
cat > "$ENV_FILE" <<EOF
SHARELATEX_NETWORK=$SHARELATEX_NETWORK
MONGO_URL=mongodb://mongo/sharelatex
REDIS_URL=redis://redis:6379
AUTH_MODE=trusted
ADAPTER_TOKEN=$ADAPTER_TOKEN
GIT_TOKEN=
INTERNAL_HOOK_TOKEN=$INTERNAL_HOOK_TOKEN
GITHUB_TOKEN=
CORS_ORIGINS=
USER_FILES_PATH=$USER_FILES_PATH
EOF

docker build -t sharelatex-local-ui:3.4.0 "$ROOT_DIR/git-ui"
RC_FILE="$TOOLKIT_DIR/config/overleaf.rc"
cp "$RC_FILE" "$RC_FILE.bak.$(date +%Y%m%d%H%M%S)"
if grep -q '^OVERLEAF_IMAGE_NAME=' "$RC_FILE"; then
  sed -i 's#^OVERLEAF_IMAGE_NAME=.*#OVERLEAF_IMAGE_NAME=sharelatex-local-ui#' "$RC_FILE"
else
  printf '\nOVERLEAF_IMAGE_NAME=sharelatex-local-ui\n' >> "$RC_FILE"
fi
"$TOOLKIT_DIR/bin/up" -d
docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.addon.yml" up -d --build

echo
echo "Addon deployed."
echo "Environment file: $ENV_FILE"
echo "Toolkit image override applied: OVERLEAF_IMAGE_NAME=sharelatex-local-ui"
echo
echo "The editor panel talks to the bridge on its own origin, at /git-bridge/."
echo "That route is baked into the UI image (git-ui/sharelatex.conf), so no extra"
echo "nginx work is needed. Verify with:"
echo "  curl -s http://127.0.0.1:<editor-port>/git-bridge/health"
echo "  docker exec sharelatex xelatex --version"
