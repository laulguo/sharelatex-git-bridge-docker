#!/usr/bin/env bash
# Import the current ShareLaTeX content of one project into its bare repo, as a
# new commit on top of the existing main, so `git pull` on the client picks up
# editor changes.
#
# Why this is needed: git-bridge-node only reads a snapshot in
# bootstrapRepository(), which runs once, when the bare repo does not exist yet.
# After that the repo only changes through `git push`. Editor edits therefore
# never reach it on their own.
#
# Usage: ./import-from-editor.sh <project-id>
#
# Steps: flush document-updater (so Mongo has the newest text) -> fetch snapshot
# from the adapter -> write a tree -> commit it on top of main in the bare repo.
# Nothing outside deploy/runtime and Redis' doc cache is touched.
set -Eeuo pipefail

BRIDGE="${BRIDGE:-sharelatex-git-bridge-node}"
DOCUP="${DOCUP:-sharelatex}"
REPO_ROOT="${REPO_ROOT:-/data/repos}"
PROJECT_ID="${1:?usage: import-from-editor.sh <project-id>}"

die() { echo "ERROR: $*" >&2; exit 1; }

# 1. Flush every doc of the project through document-updater, so Mongo holds the
#    text the editor currently shows. Docs that are not loaded are a no-op.
echo "=== 1/4 落盘编辑器内容（document-updater flush）==="
doc_ids=$(docker exec mongo mongo sharelatex --quiet --eval "
    db.docs.find({project_id: ObjectId('$PROJECT_ID')}).forEach(function(d){ print(d._id.str); })" | tr -d '\r')
[ -n "$doc_ids" ] || die "项目 $PROJECT_ID 没有文档"
ok=0
for id in $doc_ids; do
  code=$(docker exec "$DOCUP" sh -c "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3003/project/$PROJECT_ID/doc/$id/flush" | tr -d '\r')
  [ "$code" = "204" ] || [ "$code" = "200" ] || echo "  flush $id -> $code"
  ok=$((ok+1))
done
echo "  已请求 flush: $ok 篇"

# 2. Fetch the snapshot through the bridge container, which already has the
#    adapter URL and token in its environment.
echo "=== 2/4 从 adapter 取快照并写入临时树 ==="
docker exec -i "$BRIDGE" sh -c 'cat > /tmp/import_snapshot.js' <<'EOS'
const fs = require('fs')
const path = require('path')

const projectId = process.argv[2]
const outDir = process.argv[3]
const base = (process.env.SNAPSHOT_API_BASE || 'http://snapshot-adapter:8080').replace(/\/$/, '')
const token = process.env.ADAPTER_TOKEN || ''

function safe(rel) {
  return Boolean(rel && !rel.startsWith('/') && !path.posix.normalize(rel).startsWith('../') && !rel.split('/').includes('..'))
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

;(async () => {
  const doc = await getJson(`${base}/api/v0/docs/${projectId}`)
  const snapshot = await getJson(`${base}/api/v0/docs/${projectId}/snapshots/${doc.latestVerId}`)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  let files = 0
  for (const [contents, relativePath] of snapshot.srcs || []) {
    if (!safe(relativePath)) throw new Error(`unsafe path ${relativePath}`)
    const target = path.join(outDir, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
    files++
  }
  for (const att of snapshot.atts || []) {
    if (!safe(att.path)) throw new Error(`unsafe attachment path ${att.path}`)
    const target = path.join(outDir, ...att.path.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(att.content || '', 'base64'))
    files++
  }
  console.log(JSON.stringify({ version: doc.latestVerId, files }))
})().catch(err => { console.error('IMPORT_FAIL', err.message); process.exit(1) })
EOS
snapshot_info=$(docker exec "$BRIDGE" node /tmp/import_snapshot.js "$PROJECT_ID" "/tmp/import-$PROJECT_ID")
echo "  快照: $snapshot_info"

# 3. Commit the tree on top of the existing main, preserving pushed history.
echo "=== 3/4 在 bare repo 的 main 之上生成新提交 ==="
result=$(docker exec "$BRIDGE" sh -c "
  set -e
  cd /tmp/import-$PROJECT_ID
  git init -q .
  git config user.name 'ShareLaTeX Import'
  git config user.email 'import@localhost'
  git add -A
  git commit -q -m 'Import from ShareLaTeX (auto)' || true
  REPO=$REPO_ROOT/$PROJECT_ID.git
  [ -d \"\$REPO\" ] || { echo 'NO_REPO'; exit 0; }
  # The tree object only exists in this temporary repo, so fetch it into the bare
  # repo first; commit-tree cannot reference an object the target does not have.
  git --git-dir=\"\$REPO\" fetch -q --no-tags /tmp/import-$PROJECT_ID HEAD:refs/import/tmp
  WORK_TREE=\$(git --git-dir=\"\$REPO\" rev-parse 'refs/import/tmp^{tree}')
  OLD=\$(git --git-dir=\"\$REPO\" rev-parse main)
  OLD_TREE=\$(git --git-dir=\"\$REPO\" rev-parse 'main^{tree}')
  if [ \"\$WORK_TREE\" = \"\$OLD_TREE\" ]; then
    git --git-dir=\"\$REPO\" update-ref -d refs/import/tmp || true
    echo \"UNCHANGED \$OLD\"
    exit 0
  fi
  NEW=\$(GIT_AUTHOR_NAME='ShareLaTeX Import' GIT_AUTHOR_EMAIL='import@localhost' \
        GIT_COMMITTER_NAME='ShareLaTeX Import' GIT_COMMITTER_EMAIL='import@localhost' \
        git --git-dir=\"\$REPO\" commit-tree \"\$WORK_TREE\" -p \"\$OLD\" -m 'Import from ShareLaTeX (auto)')
  git --git-dir=\"\$REPO\" update-ref refs/heads/main \"\$NEW\"
  git --git-dir=\"\$REPO\" update-ref -d refs/import/tmp || true
  echo \"UPDATED \$OLD \$NEW\"
")
echo "  $result"

# 4. Report
echo "=== 4/4 结果 ==="
docker exec "$BRIDGE" sh -c "rm -rf /tmp/import-$PROJECT_ID /tmp/import_snapshot.js; git --git-dir=$REPO_ROOT/$PROJECT_ID.git log -1 --format='%h %ci %s'"
echo "本地执行: git pull    # 或重新 clone: http://<host>:<port>/git-bridge/$PROJECT_ID.git"
