# ShareLaTeX Git Bridge (Docker add-on)

English | [中文](README.md)

Gives legacy ShareLaTeX **3.4.0** the Git it never had: `clone` / `pull` / `push`, remote sync with
GitHub · Gitee · GitLab, and a Git panel inside the editor.

It is neither a fork nor a replacement. It attaches as a sidecar container to your existing Overleaf
Toolkit network, reading and writing your MongoDB / Redis and filestore, without touching
ShareLaTeX's business code (it only overrides two template-level files).

## Background and Goals

### Why legacy ShareLaTeX instead of the new Overleaf

Today's Overleaf images run to several GB, and stacking a full TeX Live on top makes memory and disk
usage very unfriendly on cheap VPS machines. On a 1-core/1 GB or 1-core/2 GB box with 20–40 GB of
disk, the stack either won't boot or OOMs the moment it compiles.

So this project uses **ShareLaTeX 3.4.0, which still works**, as its base: small image, few
dependencies, fast startup, stable compilation even on low-memory machines. The cost is missing some
newer features — official Git integration among them — which this repository adds.

### Git capabilities ported from Ayakaleaf Pro

Thanks to [ayaka-notes/ayakaleaf-pro](https://github.com/ayaka-notes/ayakaleaf-pro).

Ayakaleaf Pro is an enhanced fork of Overleaf Community Edition with built-in GitHub / GitLab
two-way sync, Git-Bridge and other Pro features. This project is a **port** of its Git Bridge
approach: it keeps the "Snapshot API + Git smart HTTP + editor panel" structure and rewrites the
data layer to fit 3.4.0's MongoDB / Redis document shapes, its `fileRefs` attachment model and its
filestore directory layout.

> The goal is **to bring the Git workflow to lower-spec machines**, not to match upstream features.
> If your hardware allows it, going straight to Ayakaleaf Pro is less work.

### Why not install a full TeX Live

The 3.4.0 image ships a **partial TeX Live 2022**: packages are incomplete, and even the XeTeX
engine is missing (the UI image adds it back). When filling gaps, do **not** install `texlive-full` /
`scheme-full` — that grows the image by another few GB, the exact opposite of the low-spec goal.
Add only what is missing; see [Additional TeX Live packages](#additional-tex-live-packages).

## Features

- Git smart HTTP: `clone` / `fetch` / `pull` / `push`, through the system `git-http-backend`;
- One bare repository per project, **automatically imported** from the project's current content on
  first access — no manual export needed;
- Two-way sync of text and **binary attachments (images, PDFs, fonts)**: ShareLaTeX ↔ Git repository;
- The `pre-receive` hook writes commits back to MongoDB and refreshes the Redis document cache;
  reload the editor and the new content is there;
- Version-conflict detection: if the project was edited in the editor, the push is rejected (409)
  rather than silently overwritten;
- A per-project serial push lock, so concurrent pushes don't collide;
- Local access control via `AUTH_MODE`: `trusted` (no password) or `token` (`git` + password);
- Git panel in the editor: copy the repository URL, save a remote URL, manual Pull / Push, status
  light;
- Manual remote sync only — no background auto Pull / Push;
- UI and same-origin reverse proxy injected through a derived image; no extra port is opened to the
  browser.

## Verification Status

Verified on a Toolkit deployment of `sharelatex/sharelatex:3.4.0` + MongoDB 4.4 + Redis 6.2:

- same-origin detection by the editor panel and smart HTTP `clone`;
- uploading attachments (images / PDFs) with two-way sync;
- pushing to GitHub (fast-forward);
- `xelatex` producing a PDF;
- `docker build --no-cache` from scratch.

## Boundaries

- Only `refs/heads/main` is supported: no multiple branches, tags, or merge / rebase / automatic
  conflict resolution;
- One push can update only one ref (the hook rejects pushes with multiple ref updates);
- Snapshots export only the **current version**; `saved_vers` always returns `[]`, and history is
  not implemented yet;
- Per-file limit 50 MB; per-push limit of 2000 files;
- Attachments can only follow the current `fileRefs` — MongoDB has no standalone `files` collection
  to query history from;
- The Git side uses a single shared credential; there are no per-ShareLaTeX-user tokens.

## Architecture

```text
                    browser (editor page, same-origin /git-bridge/)
                                   |
                                   v
        +------------------------------------------------------------+
        |  sharelatex container (sharelatex-local-ui:3.4.0)          |
        |  nginx :80  --> /            --> web:3000                  |
        |             --> /socket.io   --> :3026                     |
        |             --> /git-bridge/ --> bridge:8080               |  <- git-ui/sharelatex.conf
        +------------------------------------------------------------+
                                   |
                         overleaf_default (Toolkit network)
                                   |
             +---------------------+---------------------+
             v                                           v
   +----------------------+                  +------------------------+
   | git-bridge-node:8080 |  ------>         | snapshot-adapter:8080  |
   | smart HTTP + remotes |                  | Mongo / Redis / files  |
   +----------------------+                  +------------------------+
             |                                           |
   /data/repos/<id>.git                    MongoDB · Redis · filestore
   (GIT_BRIDGE_DATA_PATH)                  (USER_FILES_PATH mounted read-only into adapter)
```

The host also has a `127.0.0.1:18081 -> git-bridge-node:8080` port mapping, used only by the local
`git` CLI; the browser goes through the same-origin `/git-bridge/` path, so no new port needs to be
exposed.

## Directory Layout

| Path | Description |
| --- | --- |
| `snapshot-adapter/` | Snapshot API adapter: reads and writes MongoDB / Redis, exports and restores attachments |
| `git-bridge-node/` | Git service: bare repos, smart HTTP, remote sync, push hook |
| `git-ui/` | Derived image: editor panel, same-origin reverse proxy, TeX Live add-ons |
| `deploy/` | VPS deployment: compose, install / uninstall scripts, env samples, ops tools |

## Installation

### Prerequisites

**Get ShareLaTeX 3.4.0 running first, then add this project.** Pin the version; do not upgrade:

| Component | Version | Notes |
| --- | --- | --- |
| ShareLaTeX | `3.4.0` | Exact match required; this project targets its legacy data structures |
| MongoDB | `4.4` | Default pairing in the Toolkit |
| Redis | `6.2` | Default pairing in the Toolkit |

Other requirements:

- Docker and Docker Compose v2;
- An existing overleaf-toolkit deployment with `config/version` set to `3.4.0`;
- Access to a TeX Live 2022 archive repository when building the UI image (the Utah historical
  archive by default; override with `TL2022_REPO`);
- About 1 GB of free host disk for the new image layers.

The official [Overleaf Toolkit](https://github.com/overleaf/toolkit) is enough for the first
ShareLaTeX + MongoDB + Redis setup: write `3.4.0` into `config/version`, and pin the image and
Mongo / Redis versions in `config/overleaf.rc` to the table above.

The Toolkit's config layout changes with upstream, so **this step is a reasonable place to get AI
help**: paste the contents of `config/version` and `config/overleaf.rc` into a model and ask for the
corresponding 3.4.0 + Mongo 4.4 + Redis 6.2 adjustments. That is far more reliable than following an
outdated blog tutorial.

> The author **does not maintain** the Overleaf Toolkit and does not guarantee its config format
> stays stable; for Toolkit issues, refer to its official repository.

### One-click install

```bash
git clone https://github.com/<you>/sharelatex-git-bridge-docker.git
cd sharelatex-git-bridge-docker
chmod +x deploy/install.sh deploy/tools/tex-autofix.sh
TOOLKIT_DIR=/root/overleaf-toolkit ./deploy/install.sh
```

What the script does:

1. Checks that the Toolkit's `config/version` is `3.4.0`;
2. Reads the current Docker network from the `sharelatex` container → `SHARELATEX_NETWORK`;
3. Derives the filestore directory from the `sharelatex` container's `/var/lib/sharelatex` mount →
   `USER_FILES_PATH`;
4. Generates `ADAPTER_TOKEN` and `INTERNAL_HOOK_TOKEN` and writes them to `deploy/.env`
   (`umask 077`);
5. Builds `sharelatex-local-ui:3.4.0`;
6. Backs up and rewrites `OVERLEAF_IMAGE_NAME` in the Toolkit's `config/overleaf.rc`, then runs
   `bin/up -d`;
7. Starts `snapshot-adapter` and `git-bridge-node`.

The same-origin reverse proxy (`/git-bridge/`) is baked into the UI image — **no** manual nginx
editing is needed.

The script writes all of these values into `deploy/.env`, so no manual editing is needed after
install. The one exception is switching to `token` mode: set `GIT_TOKEN` yourself, then run
`docker compose --env-file deploy/.env -f deploy/docker-compose.addon.yml up -d` to apply it.

### Manual install

```bash
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
# Required: SHARELATEX_NETWORK, ADAPTER_TOKEN, INTERNAL_HOOK_TOKEN, USER_FILES_PATH

docker build -t sharelatex-local-ui:3.4.0 git-ui
# To switch the mirror:
# docker build --build-arg TL2022_REPO=<tlnet-final URL> -t sharelatex-local-ui:3.4.0 git-ui

sed -i 's#^OVERLEAF_IMAGE_NAME=.*#OVERLEAF_IMAGE_NAME=sharelatex-local-ui#' \
  /root/overleaf-toolkit/config/overleaf.rc
cd /root/overleaf-toolkit && bin/up -d

cd /root/sharelatex-git-bridge-docker
docker compose --env-file deploy/.env -f deploy/docker-compose.addon.yml up -d --build
```

## Panel and Sync

### Git panel in the editor

After reloading the editor page, a `Git` button appears on the right of the toolbar; click it to open
the panel:

| Control | Behavior |
| --- | --- |
| Status light | Probes `window.GIT_BRIDGE_URL` → same-origin `/git-bridge` → `<host>:18081` in order; the first whose `/health` returns `{ok:true}` wins |
| Repository URL | The selected base URL + `/<project-id>.git`; `Copy` copies it |
| Git remote | Enter an HTTPS URL (ending in `.git`); `Save` stores it in the project config |
| Pull from remote | `fetch` the remote `main` → if it changed, write it back to ShareLaTeX and reload the page |
| Push to remote | Push the local `main` to the remote |
| Refresh status / Open URL | Re-probe / open the repository URL in a new window |

Detection deliberately checks the response's `content-type` and `{ok:true}`: a login-page redirect is
also a 200, so status code alone would mislead.

Local workflow:

```bash
git clone http://<host>:<editor-port>/git-bridge/<project-id>.git
# or from the host via the mapped port
git clone http://127.0.0.1:18081/<project-id>.git
```

`AUTH_MODE=trusted` (the default) asks for no password; in `token` mode the username is always `git`
and the password is `GIT_TOKEN` (set it in `deploy/.env` first and recreate the add-on).

### Private repository credentials

The panel's remote field stores only the URL; authentication comes from credentials embedded in the
URL or from `GITHUB_TOKEN`:

```text
https://<username>:<token>@gitee.com/<username>/<project>.git
https://<username>:<token>@github.com/<username>/<project>.git
```

- GitHub uses a Personal Access Token (`repo` scope); Gitee uses a "personal token";
- The username can simply be your account name (GitHub also accepts `x-access-token`); the password
  is the token;
- If the token contains characters such as `@ : / ? # %`, URL-encode it first (e.g. `@` → `%40`);
- To keep the token out of the URL: set `GITHUB_TOKEN=<token>` in `deploy/.env`. Only when the
  bridge finds no embedded credentials in the URL does it add
  `-c http.extraHeader=Authorization: Basic base64("git:<token>")`, keeping the address clean.

Remote URLs are validated: they must be `https:`, the path must end in `.git`, and there must be no
query or fragment. URLs with credentials are stored in plaintext at
`deploy/runtime/git-bridge/repos/<project-id>.github.json`.

Other API operations (there are no buttons for these in the panel):

```bash
curl -X POST http://127.0.0.1:18081/api/github/<project-id>/forget   # clear the remote and token
curl        http://127.0.0.1:18081/api/github/<project-id>           # query the config status
```

### Full chain of a push

```text
git push
  → git-http-backend receives receive-pack
  → pre-receive hook (push-hook.js) POSTs /internal/push (x-bridge-internal check)
  → pushCommit: diffs the old/new trees, produces files[] (added/modified/deleted)
  → adapter POST /api/v0/docs/<id>/snapshots (with latestVerId for optimistic locking)
  → text goes to the docs collection, binaries to the filestore; projects.rootFolder/version/lastUpdated updated
  → each document refreshes Redis: doclines:<docId> / DocHash:<docId> / DocVersion:<docId>
```

`pull` runs the other direction: `fetch` the remote `main` → if `lastAppliedCommit` differs from the
remote tip, write that tree back into ShareLaTeX through the same flow → `update-ref
refs/heads/main`.

## Additional TeX Live Packages

**Do not install a full TeX Live.** 3.4.0 ships a trimmed TL2022; installing the full set adds
several GB to the image. Add only what is missing:

```bash
# TL2022's frozen archive (Utah's historical repository; read-only, no longer updated)
TL2022_REPO=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2022/tlnet-final

# 1. The missing file from the compile log
#    ! LaTeX Error: File `caption.sty' not found.

# 2. Find which package provides it (the archive repo must be given explicitly inside the container)
docker exec sharelatex tlmgr --verify-repo=none search --global --file '/caption.sty' \
  --repository "$TL2022_REPO"
# caption:
#         texmf-dist/tex/latex/caption/caption.sty

# 3. Install just that package (dependencies come along automatically)
docker exec sharelatex tlmgr --verify-repo=none install caption \
  --repository "$TL2022_REPO"

# 4. If it still isn't found after installing, rebuild the filename index
docker exec sharelatex mktexlsr
```

Common commands: `docker exec sharelatex tlmgr info <pkg>` to check whether a package is installed,
and `docker exec sharelatex tlmgr list --only-installed` to list installed packages.

### Automated version

`deploy/tools/tex-autofix.sh` runs the loop above: compile → read the first `File 'x' not found` →
install only the package providing that file → retry, until a PDF is produced.

```bash
./deploy/tools/tex-autofix.sh <project-id> [rounds]     # 20 rounds by default
```

Prerequisite: the project has been compiled once in the editor (CLSI needs a build directory). If
the mirror is unreachable, override it with `TL2022_REPO=<another tlnet-final URL>`.

## Verification Checklist

Verify layer by layer; whichever layer breaks tells you which component to look at:

```bash
# 1. Containers are up
docker compose --env-file deploy/.env -f deploy/docker-compose.addon.yml ps

# 2. adapter healthy (inside the container network)
docker exec sharelatex-git-bridge-node node -e \
  "fetch('http://snapshot-adapter:8080/health').then(r=>r.text()).then(console.log)"

# 3. same-origin reverse proxy (the path the browser actually uses)
curl -s http://127.0.0.1:<editor-port>/git-bridge/health        # {"ok":true}

# 4. smart HTTP end to end
git ls-remote http://127.0.0.1:<editor-port>/git-bridge/<project-id>.git

# 5. attachments really made it into the repository
git --git-dir=deploy/runtime/git-bridge/repos/<project-id>.git \
  ls-tree -r --name-only main | grep -iE '\.(pdf|png|jpg)$'

# 6. compile engine
docker exec sharelatex xelatex --version
```

After reloading the editor, a `Git` button appears in the toolbar and the panel should read `Git
bridge ready`.

## Troubleshooting

| Symptom | Where to look | What to do |
| --- | --- | --- |
| Panel shows `Git bridge unavailable` | Browser Network tab, `/git-bridge/health` | 404 → the image lacks the same-origin config (rebuild the UI image and run `bin/up -d`); 502 → the bridge isn't on the same network; no request at all → the page is HTTPS but the URL is HTTP |
| Compile gives `Server Error` | `docker exec sharelatex tail -50 /var/log/sharelatex/web.log` | `file.created.getTime is not a function` means `rootFolder` was JSON-serialized: convert `created` back to `Date` and `_id` back to `ObjectId` |
| Compile says `no output.pdf generated` | `clsi.log` and `output.stdout` in the compile directory | `xelatex: not found` → the image lacks the engine; `File 'x.xx' not found` → run `deploy/tools/tex-autofix.sh <project-id>` to add packages |
| CLSI says `files out of sync, please retry` | Same as above | Stale server state; web retries a full sync automatically; if it persists, clear `data/compiles/<project-id>-<user-id>/` and compile again |
| `! [rejected] main -> main (fetch first)` | Local `main` diverged from the remote (e.g. after re-importing the repository) | Rebase the import result onto the remote: `git fetch github main`, build a commit with `commit-tree <local tree> -p <remote tip>`, `update-ref`, then `git push github main` |
| Push says `Project is out of date` | The adapter returned 409 | The project was saved in the editor during the push; sync the latest content first, then push |
| Push rejected: `Only one ref update is supported` | hook log | Push one ref at a time (only `main`) |
| PDF / images not in the repository | adapter logs + `docker inspect` mounts | `USER_FILES_PATH` isn't mounted into the adapter, or the project has no `fileRefs` |
| Editor can't open the project after a push | the type of `_id` / `created` in Mongo's `rootFolder` | See the `Server Error` row; restore the BSON types |
| Panel resolves the URL to 18081 instead of same-origin | same-origin probe failed | Confirm the UI image contains `sharelatex.conf`; or set the base URL with `window.GIT_BRIDGE_URL` |

## Day-to-day Operations

**Changed UI files (panel, nginx, Dockerfile)**

```bash
docker build -t sharelatex-local-ui:3.4.0 git-ui
cd "$TOOLKIT_DIR" && bin/up -d
```

**Changed add-on service code (adapter / bridge)**

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.addon.yml up -d --build
```

**Adding TeX packages**

```bash
./deploy/tools/tex-autofix.sh <project-id> [rounds]
```

For details and manual `tlmgr` usage see [Additional TeX Live packages](#additional-tex-live-packages);
package names must be written back into `git-ui/Dockerfile`, or they are lost when the container is
recreated.

**Backup**

Only two things need keeping: `deploy/.env` (internal secrets) and `deploy/runtime/` (bare repos,
remote config, tokens). The project content lives in MongoDB and the Toolkit's `data/overleaf`,
managed by the Toolkit itself.

**Uninstall**

```bash
TOOLKIT_DIR=/root/overleaf-toolkit ./deploy/uninstall.sh                # keep runtime
TOOLKIT_DIR=/root/overleaf-toolkit ./deploy/uninstall.sh --purge-data   # delete bare repos too
```

The script stops the add-on, restores `overleaf.rc` from the most recent backup (or deletes the
`OVERLEAF_IMAGE_NAME` line if there is no backup), runs `bin/up -d` back on the original image, and
removes the built image. `--purge-data` discards Git commit history and remote config; afterwards
you can only re-import from the current version.

## Known Limitations

- Only `refs/heads/main` is supported; no branches, tags, or merge strategies;
- Snapshots cover only the current version; `saved_vers` returns empty and history metadata is not
  implemented;
- A push rewrites the changed documents wholesale (`docs.rev` increments); binaries at the same path
  reuse the original `fileRef._id`;
- The first import creates a brand-new commit. If the remote already has history, rebase the import
  result onto the remote before pushing, otherwise it is rejected as non-fast-forward (see the
  troubleshooting table);
- Building the UI image depends on the TL2022 archive, which points at the Utah historical archive
  by default; use `TL2022_REPO` to switch sources when network access is awkward;
- Overrides upstream `editor.pug` and `sharelatex.conf`; re-merge them when upgrading upstream;
- With `CORS_ORIGINS` empty, any `Origin` is reflected — suitable for private deployments only.

## Security Notes

- Under `AUTH_MODE=trusted` (the default), anyone who can reach the bridge can clone / push any
  project; switch to `token` mode or add authentication at the reverse proxy before exposing it
  publicly;
- `token` mode still offers only **one shared password** — no per-user isolation; add your own layer
  if you need finer permissions;
- Remote URLs saved from the panel (which may contain tokens) land in plaintext at
  `deploy/runtime/git-bridge/repos/<project-id>.github.json` (`*token` files are mode 600);
- Don't commit `deploy/.env`, `deploy/runtime/`, MongoDB / Redis data, or URLs containing
  credentials;
- If a token ever appears in a screenshot, log or public URL, revoke and reissue it immediately.

## Key Files

```text
snapshot-adapter/
  server.js          snapshot API: GET /api/v0/docs/:id, /snapshots/:ver, POST /snapshots
git-bridge-node/
  server.js          smart HTTP, /api/github/:id/(configure|pull|push|forget), /internal/push
  push-hook.js       pre-receive hook installed into every bare repo
git-ui/
  Dockerfile         adds the TL2022 engine + overridden templates + bakes in the nginx config
  editor.pug         upstream template verbatim, plus 1 style line + 1 script line
  sharelatex.conf    nginx: adds /git-bridge/, everything else upstream
  git-bridge-toolbar.{js,css}
deploy/
  install.sh / uninstall.sh / docker-compose.addon.yml / .env.example
  tools/tex-autofix.sh
```

## 中文摘要

给旧版 ShareLaTeX 3.4.0 补上 Git 工作流的 Docker 附加组件：一个 Node 实现的 Git smart-HTTP
bridge、一个把 MongoDB / Redis 快照以及经 filestore 上传的附件打通的 adapter，以及一个把 bridge
挂到编辑器同源路径、并补回缺失的 XeTeX 引擎的派生镜像。只做手动同步，单分支（`main`），HTTPS 远程，
附件一并同步。

它存在的理由是当前的 Overleaf 镜像对低配廉价 VPS 太重，所以保留了更轻的 3.4.0 底座，并把
[ayaka-notes/ayakaleaf-pro](https://github.com/ayaka-notes/ayakaleaf-pro) 的 Git Bridge 思路移植到
旧数据模型上。不要安装完整 TeX Live —— 缺什么就用 `tlmgr` 补什么。

已在 `sharelatex/sharelatex:3.4.0` + MongoDB 4.4 + Redis 6.2 上实测通过。

## License

MIT. See [LICENSE](LICENSE).
