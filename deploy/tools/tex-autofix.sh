#!/usr/bin/env bash
# Fill in missing TeX packages for one project, one package at a time.
#
# The ShareLaTeX 3.4.0 image carries an incomplete TeX Live 2022. Rather than
# installing a whole scheme, this script compiles the project, reads the first
# "File `<name>' not found" error, installs only the package that provides it,
# and repeats until a PDF comes out.
#
# Usage:
#   ./tex-autofix.sh <project-id> [max-rounds]
#
# The project must have been compiled at least once in the editor, so that CLSI
# has a build directory with the sources; a failed compile is enough.
#
# Note: packages installed this way live in the running container. Add the
# printed list to the tlmgr line in git-ui/Dockerfile to make it permanent.
set -Eeuo pipefail

PROJECT_ID="${1:?usage: tex-autofix.sh <project-id> [max-rounds]}"
MAX_ROUNDS="${2:-20}"
CONTAINER="${CONTAINER:-sharelatex}"
REPO="${TL2022_REPO:-https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2022/tlnet-final}"

BUILD_DIR="$(docker exec "$CONTAINER" sh -c "ls -d /var/lib/sharelatex/data/compiles/${PROJECT_ID}-*/ 2>/dev/null | head -1" | tr -d '\r')"
[[ -n "$BUILD_DIR" ]] || { echo "ERROR: no build directory for $PROJECT_ID. Open the project and compile once." >&2; exit 1; }

# Log parser runs inside the container next to the log file.
docker exec "$CONTAINER" sh -c 'cat > /tmp/parse_missing.sh' <<'EOS'
#!/bin/sh
LOG=/tmp/texfix/output.log
[ -f "$LOG" ] || exit 0
line=$(grep -m1 '^! LaTeX Error: File ' "$LOG")
[ -n "$line" ] && { echo "$line" | sed -E "s/.*File .//; s/' not found.*//"; exit 0; }
line=$(grep -m1 "can't find file" "$LOG")
[ -n "$line" ] && { echo "$line" | sed -E "s/.*find file .//; s/'.*//"; exit 0; }
exit 0
EOS

docker exec "$CONTAINER" sh -c "rm -rf /tmp/texfix && mkdir -p /tmp/texfix && cp -a $BUILD_DIR. /tmp/texfix/ 2>/dev/null; rm -f /tmp/texfix/output.pdf /tmp/texfix/output.log /tmp/texfix/output.xdv"
docker exec "$CONTAINER" chmod +x /tmp/parse_missing.sh

ADDED=()
for round in $(seq 1 "$MAX_ROUNDS"); do
  result=$(docker exec "$CONTAINER" sh -c 'cd /tmp/texfix && export PATH=/usr/local/bin:$PATH && rm -f output.log output.xdv output.pdf && timeout 300 xelatex -no-pdf -synctex=1 -interaction=batchmode -recorder --jobname=output main.tex >run.out 2>&1; if [ -f output.xdv ]; then timeout 120 xdvipdfmx -E -o output.pdf output.xdv >xdv.out 2>&1; fi; test -s output.pdf && echo PDF_OK || echo PDF_MISSING')
  echo "[round $round] $result"
  if [[ "$result" == "PDF_OK" ]]; then
    docker exec "$CONTAINER" sh -c 'ls -la /tmp/texfix/output.pdf'
    echo
    echo "Compiles now. Make it permanent by adding to git-ui/Dockerfile:"
    echo "  ${ADDED[*]:-<nothing new>}"
    exit 0
  fi

  missing=$(docker exec "$CONTAINER" sh /tmp/parse_missing.sh | tr -d '\r')
  if [[ -z "$missing" ]]; then
    echo "--- no missing-file error left; hard errors: ---"
    docker exec "$CONTAINER" sh -c "grep -nE '^!' /tmp/texfix/output.log 2>/dev/null | head -10"
    exit 1
  fi
  echo "    missing: $missing"

  pkg=$(docker exec "$CONTAINER" sh -c "tlmgr --verify-repo=none search --global --file '/$missing' --repository '$REPO' 2>/dev/null | sed -n 's/^\([A-Za-z0-9._+-]*\):\$/\1/p' | head -1" | tr -d '\r')
  if [[ -z "$pkg" ]]; then
    echo "    no package in the TL2022 repository provides $missing" >&2
    exit 1
  fi
  echo "    installing: $pkg"
  ADDED+=("$pkg")
  docker exec "$CONTAINER" sh -c "tlmgr --verify-repo=none install --repository '$REPO' '$pkg' 2>&1 | grep -E 'install:|ERROR' | tail -3"
done

echo "Reached $MAX_ROUNDS rounds without a PDF." >&2
exit 1
