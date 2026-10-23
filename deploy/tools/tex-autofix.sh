#!/usr/bin/env bash
# Fill in missing TeX packages for one project, one package at a time.
#
# The ShareLaTeX 3.4.0 image carries an incomplete TeX Live 2022. Rather than
# installing a whole scheme, this script compiles the project, reads the first
# missing-file error, installs only the package that provides it, and repeats
# until a PDF comes out.
#
# Usage:
#   ./tex-autofix.sh <project-id> [max-rounds]
#   ./tex-autofix.sh --all [max-rounds]
#
# The project must have been compiled at least once in the editor, so CLSI has a
# build directory with the sources; a failed compile is enough.
#
# Root document name and compiler are read from MongoDB, so projects whose root
# is not "main.tex", or that compile with pdflatex, work too.
#
# Note: packages installed this way live in the running container and disappear
# when the container is recreated. The package names printed at the end are what
# you would append to the tlmgr line in git-ui/Dockerfile to make them permanent.
set -Eeuo pipefail

CONTAINER="${CONTAINER:-sharelatex}"
REPO="${TL2022_REPO:-https://mirrors.tuna.tsinghua.edu.cn/tex-historic-archive/systems/texlive/2022/tlnet-final}"
TOOL_DIR=/tmp/texfix

# Log parser, run inside the container next to the log file.
install_parser() {
  # -i is required: without it docker exec does not forward stdin and the heredoc
  # silently produces an empty parser, so every "missing file" error is missed.
  docker exec -i "$CONTAINER" sh -c 'cat > /tmp/parse_missing.sh' <<'EOS'
#!/bin/sh
LOG=/tmp/texfix/output.log
[ -f "$LOG" ] || exit 0
line=$(grep -m1 '^! LaTeX Error: File ' "$LOG")
[ -n "$line" ] && { echo "$line" | sed -E "s/.*File .//; s/' not found.*//"; exit 0; }
line=$(grep -m1 "can't find file" "$LOG")
[ -n "$line" ] && { echo "$line" | sed -E "s/.*find file .//; s/'.*//"; exit 0; }
line=$(grep -m1 '^!.*not found' "$LOG")
[ -n "$line" ] && { echo "$line" | sed -E "s/.*File .//; s/' not found.*//"; exit 0; }
exit 0
EOS
  docker exec "$CONTAINER" chmod +x /tmp/parse_missing.sh
}

# Prints "<root-doc-name>|<compiler>"
project_info() {
  docker exec mongo mongo sharelatex --quiet --eval "
    var p = db.projects.findOne({_id: ObjectId('$1')});
    if (!p) { print('NONE|'); quit(); }
    var root = p.rootDoc_id ? db.docs.findOne({_id: p.rootDoc_id}) : null;
    print((root ? root.name : '') + '|' + (p.compiler || 'pdflatex'));" | tr -d '\r'
}

compile_once() {
  local root="$1" compiler="$2" flag
  case "$compiler" in
    xelatex) flag='-xelatex' ;;
    lualatex) flag='-lualatex' ;;
    *) flag='-pdf' ;;
  esac
  # Every round must start from a clean latexmk state. Otherwise a failed first
  # attempt leaves output.fdb_latexmk behind, the next round prints
  # "Nothing to do ... up-to-date", and no further missing package is discovered.
  docker exec "$CONTAINER" sh -c "cd $TOOL_DIR && rm -f output.log output.pdf output.fdb_latexmk output.aux output.fls output.xdv output.nav output.out output.toc output.snm output.synctex.gz *.bbl *.blg && export PATH=/usr/local/bin:/usr/local/texlive/2022/bin/x86_64-linux:\$PATH && rm -f output.log output.pdf && timeout 600 latexmk $flag -interaction=batchmode -synctex=1 -recorder -jobname=output \"$root\" >run.out 2>&1; test -s output.pdf && echo PDF_OK || echo PDF_MISSING"
}

autofix() {
  local project_id="$1" max_rounds="${2:-20}"
  local info root compiler build_dir
  info="$(project_info "$project_id")" || { echo "  ! 无法查询项目 $project_id"; return 1; }
  root="${info%%|*}"
  compiler="${info##*|}"

  if [ -z "$root" ] || [ "$root" = "NONE" ]; then
    echo "  ! 项目 $project_id 没有根文档，跳过"
    return 1
  fi

  build_dir="$(docker exec "$CONTAINER" sh -c "ls -d /var/lib/sharelatex/data/compiles/${project_id}-*/ 2>/dev/null | head -1" | tr -d '\r')"
  if [ -z "$build_dir" ]; then
    echo "  ! 还没有编译目录：先在编辑器里点一次 Recompile（失败也算）"
    return 1
  fi

  echo "  根文档: $root   编译器: $compiler"
  # Copy the sources but drop CLSI's build artefacts: a copied output.fdb_latexmk
  # makes latexmk believe everything is up to date, so it never runs the engine and
  # no missing-package error ever appears.
  docker exec "$CONTAINER" sh -c "rm -rf $TOOL_DIR && mkdir -p $TOOL_DIR && cp -a '$build_dir'. $TOOL_DIR/ 2>/dev/null;
    rm -f $TOOL_DIR/output.* $TOOL_DIR/.project-sync-state $TOOL_DIR/*.aux $TOOL_DIR/*.bbl $TOOL_DIR/*.blg $TOOL_DIR/*.nav $TOOL_DIR/*.snm $TOOL_DIR/*.toc $TOOL_DIR/*.out $TOOL_DIR/*.synctex.gz"
  install_parser

  local added=() round out missing pkg
  for round in $(seq 1 "$max_rounds"); do
    out="$(compile_once "$root" "$compiler")"
    if [ "$out" = "PDF_OK" ]; then
      echo "  OK 第 $round 轮出 PDF"
      if [ ${#added[@]} -gt 0 ]; then echo "     新增包: ${added[*]}"; else echo "     无需新增包"; fi
      return 0
    fi

    missing="$(docker exec "$CONTAINER" sh /tmp/parse_missing.sh | tr -d '\r')"
    if [ -z "$missing" ]; then
      echo "  FAIL 第 $round 轮失败，且没有'缺文件'错误，真实错误："
      docker exec "$CONTAINER" sh -c "grep -nE '^!' $TOOL_DIR/output.log 2>/dev/null | head -8" || true
      return 1
    fi

    pkg="$(docker exec "$CONTAINER" sh -c "tlmgr --verify-repo=none search --global --file '/$missing' --repository '$REPO' 2>/dev/null | sed -n 's/^\([A-Za-z0-9._+-]*\):\$/\1/p' | head -1" | tr -d '\r')"
    if [ -z "$pkg" ]; then
      echo "  FAIL 缺 $missing，但 TL2022 仓库里没有提供它的包"
      return 1
    fi

    echo "  第 $round 轮: 缺 $missing -> 安装 $pkg"
    added+=("$pkg")
    docker exec "$CONTAINER" sh -c "tlmgr --verify-repo=none install --repository '$REPO' '$pkg' 2>&1 | grep -E 'install:|ERROR' | tail -2" || true
  done

  echo "  FAIL 达到 $max_rounds 轮仍未出 PDF"
  return 1
}

if [ "${1:-}" = "--all" ]; then
  MAX="${2:-20}"
  projects="$(docker exec mongo mongo sharelatex --quiet --eval 'db.projects.find({}).forEach(function(p){ print(p._id.str); })' | tr -d '\r')"
  for p in $projects; do
    echo
    echo "---- $p ----"
    autofix "$p" "$MAX" || true
  done
else
  autofix "${1:?usage: tex-autofix.sh <project-id> [max-rounds]}" "${2:-20}"
fi
