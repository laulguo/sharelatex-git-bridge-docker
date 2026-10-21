# ShareLaTeX Git Bridge (Docker add-on)

给旧版 ShareLaTeX **3.4.0** 补上 Git：`clone` / `pull` / `push`、GitHub·Gitee·GitLab 远程同步，
以及编辑器里的 Git 面板。

不是 fork，也不是替换。它作为旁路容器接入现有 Overleaf Toolkit 网络，读写你的 MongoDB / Redis
和 filestore，不动 ShareLaTeX 的业务代码（只覆盖两个模板级别的文件）。

## 背景与目的

### 为什么用旧版 ShareLaTeX 而不是新版 Overleaf

现在的 Overleaf 镜像动辄数 GB，再叠上完整 TeX Live，内存和磁盘占用对低价 VPS 很不友好。
1 核 1G / 1 核 2G、磁盘 20~40G 的机器，要么起不来，要么一编译就 OOM。

所以这个项目选择**仍然能正常工作的 ShareLaTeX 3.4.0** 作底座：镜像小、依赖少、启动快，
小内存机器也能稳定编译。代价是缺少新版的一些功能，官方 Git 集成正是其中之一 —— 本仓库补这块。

### Git 能力移植自 Ayakaleaf Pro

感谢 [ayaka-notes/ayakaleaf-pro](https://github.com/ayaka-notes/ayakaleaf-pro)。

Ayakaleaf Pro 是 Overleaf Community Edition 的增强分支，自带 GitHub / GitLab 双向同步、
Git-Bridge 等 Pro 能力。本项目是它 Git Bridge 思路的**移植（port）**：沿用
「Snapshot API + Git smart HTTP + 编辑器面板」的结构，把数据层重写了一遍，以适配 3.4.0 的
MongoDB / Redis 文档结构、`fileRefs` 附件模型和 filestore 目录布局。

> 目标是**让更低配的机器也能用上 Git 工作流**，不是与上游功能对齐。
> 机器条件允许的话，直接上 Ayakaleaf Pro 更省事。

### 为什么不建议安装完整 TeX Live

3.4.0 镜像自带的是**残缺的 TeX Live 2022**：不仅包不全，连 XeTeX 引擎都没有（UI 镜像里已经补上了）。
补包时**不要**装 `texlive-full` / `scheme-full`，
那会让镜像再膨胀几 GB，与低配目标完全相反。缺什么补什么，见[补充 TeX Live 宏包](#补充-tex-live-宏包)。

## 功能

- Git smart HTTP：`clone` / `fetch` / `pull` / `push`，走系统 `git-http-backend`；
- 每个项目一个独立 bare 仓库，**首次访问自动导入**当前项目内容，无需手工导出；
- 文本与**二进制附件（图片、PDF、字体）双向同步**：ShareLaTeX ↔ Git 仓库；
- `pre-receive` 钩子把提交写回 MongoDB，并同步 Redis 文档缓存，编辑器重新加载即可看到新内容；
- 版本冲突检测：项目在编辑器里被改过就拒绝推送（409），不静默覆盖；
- 单项目推送串行锁，并发 push 不打架；
- 本地访问控制 `AUTH_MODE`：`trusted`（免口令）或 `token`（`git` + 口令）；
- 编辑器内 Git 面板：仓库地址复制、远程地址保存、手动 Pull / Push、状态灯；
- 远程仓库手动同步，不做后台自动 Pull / Push；
- 通过派生镜像注入 UI 和同源反代，不开放额外端口给浏览器。

## 验证状态

在 Toolkit 部署的 `sharelatex/sharelatex:3.4.0` + MongoDB 4.4 + Redis 6.2 上实测通过：

- 编辑器面板同源探测、smart HTTP `clone`；
- 上传附件（图片 / PDF）双向同步；
- 推送到 GitHub（快进合并）；
- `xelatex` 编译产出 PDF；
- `docker build --no-cache` 从零构建。

## 边界

- 只支持 `refs/heads/main`，没有多分支、tag、merge / rebase / 冲突自动解决；
- 一次 push 只能更新一个 ref（钩子会拒绝多条 ref 更新）；
- 快照只导出**当前版本**，`saved_vers` 恒返回 `[]`，历史版本尚未实现；
- 单文件上限 `MAX_FILE_SIZE`（默认 50MB），单次推送上限 2000 个文件；
- 附件只能跟当前 `fileRefs` 走，MongoDB 里没有独立 `files` 集合可查历史；
- Git 侧只有一套共享凭据，没有按 ShareLaTeX 用户细分的 token。

## 架构

```text
                    浏览器（编辑器页面，同源 /git-bridge/）
                              |
                              v
      +-----------------------------------------------+
      |  sharelatex 容器（sharelatex-local-ui:3.4.0）  |
      |  nginx :80  --> /            --> web:3000     |
      |            --> /socket.io    --> :3026        |
      |            --> /git-bridge/  --> bridge:8080  |   ← git-ui/sharelatex.conf
      +-----------------------------------------------+
                              |
                     overleaf_default（Toolkit 网络）
                              |
            +-----------------+------------------+
            v                                    v
   +----------------------+            +-----------------------+
   | git-bridge-node:8080 |  ------>   | snapshot-adapter:8080 |
   | smart HTTP + 远程同步 |            | Mongo / Redis / 附件  |
   +----------------------+            +-----------------------+
            |                                     |
   /data/repos/<id>.git                  MongoDB · Redis · filestore
   （GIT_BRIDGE_DATA_PATH）              （USER_FILES_PATH 只读挂载到 adapter）
```

宿主上还有一条 `127.0.0.1:18081 -> git-bridge-node:8080` 的端口映射，只给本机 `git` CLI 用；
浏览器走的是同源 `/git-bridge/`，不需要开放任何新端口。

## 目录

| 路径 | 说明 |
| --- | --- |
| `snapshot-adapter/` | 快照 API 适配层：读写 MongoDB / Redis，导出与还原附件 |
| `git-bridge-node/` | Git 服务：bare repo、smart HTTP、远程同步、push 钩子 |
| `git-ui/` | 派生镜像：编辑器面板、同源反代、TeX Live 补装 |
| `deploy/` | VPS 部署：compose、安装 / 卸载脚本、环境变量样例、运维工具 |

## 安装

### 前置条件

**先有 ShareLaTeX 3.4.0 在跑，再加本项目。** 版本必须锁定，别升级：

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| ShareLaTeX | `3.4.0` | 必须精确匹配，本项目针对其旧数据结构 |
| MongoDB | `4.4` | Toolkit 默认配套 |
| Redis | `6.2` | Toolkit 默认配套 |

其他要求：

- Docker 与 Docker Compose v2；
- 已有 overleaf-toolkit 部署，`config/version` 为 `3.4.0`；
- 构建 UI 镜像时能访问 TeX Live 2022 归档仓库（默认 Utah 历史归档，可用 `TL2022_REPO` 覆盖）；
- 宿主磁盘预留约 1GB 给新镜像层。

首次搭 ShareLaTeX + MongoDB + Redis 用官方 [Overleaf Toolkit](https://github.com/overleaf/toolkit)
即可：`config/version` 写 `3.4.0`，`config/overleaf.rc` 把镜像和 Mongo / Redis 版本固定到上表。

Toolkit 的配置文件结构会随上游变动，**这一步可以借助 AI 协助修改**：把 `config/version` 和
`config/overleaf.rc` 的内容贴给模型，让它给出 3.4.0 + Mongo 4.4 + Redis 6.2 的对应改法，
比照着过时的博客教程改可靠得多。

> 本项目作者**不负责维护** Overleaf Toolkit，也不保证它的配置格式长期不变；
> Toolkit 自身的问题请参考其官方仓库。

### 一键安装

```bash
git clone https://github.com/<you>/sharelatex-git-bridge-docker.git
cd sharelatex-git-bridge-docker
chmod +x deploy/install.sh deploy/tools/tex-autofix.sh
TOOLKIT_DIR=/root/overleaf-toolkit ./deploy/install.sh
```

脚本做的事：

1. 校验 Toolkit 的 `config/version` 必须是 `3.4.0`；
2. 从 `sharelatex` 容器读取当前 Docker 网络 → `SHARELATEX_NETWORK`；
3. 从 `sharelatex` 容器 `/var/lib/sharelatex` 挂载点推导 filestore 目录 → `USER_FILES_PATH`；
4. 生成 `ADAPTER_TOKEN`、`INTERNAL_HOOK_TOKEN`，写入 `deploy/.env`（`umask 077`）；
5. 构建 `sharelatex-local-ui:3.4.0`；
6. 备份并改写 Toolkit `config/overleaf.rc` 的 `OVERLEAF_IMAGE_NAME`，执行 `bin/up -d`；
7. 启动 `snapshot-adapter` 与 `git-bridge-node`。

同源反代（`/git-bridge/`）已经烤进 UI 镜像，**不需要**再手改 nginx。

### 手工安装

```bash
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
# 必填：SHARELATEX_NETWORK、ADAPTER_TOKEN、INTERNAL_HOOK_TOKEN、USER_FILES_PATH

docker build -t sharelatex-local-ui:3.4.0 git-ui
# 换镜像源：
# docker build --build-arg TL2022_REPO=<tlnet-final 地址> -t sharelatex-local-ui:3.4.0 git-ui

sed -i 's#^OVERLEAF_IMAGE_NAME=.*#OVERLEAF_IMAGE_NAME=sharelatex-local-ui#' \
  /root/overleaf-toolkit/config/overleaf.rc
cd /root/overleaf-toolkit && bin/up -d

cd /root/sharelatex-git-bridge-docker
docker compose --env-file deploy/.env -f deploy/docker-compose.addon.yml up -d --build
```

## 环境变量

真正需要你填的就 `deploy/.env` 里这几个，其余都有默认值：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SHARELATEX_NETWORK` | 必填 | Toolkit 的 Docker 网络，如 `overleaf_default` |
| `MONGO_URL` / `REDIS_URL` | `mongodb://mongo/sharelatex` / `redis://redis:6379` | 容器名直连 |
| `USER_FILES_PATH` | `/root/overleaf-toolkit/data/overleaf/data/user_files` | 宿主 filestore 目录，附件靠它双向同步 |
| `ADAPTER_TOKEN` / `INTERNAL_HOOK_TOKEN` | 必填 | 内部令牌：bridge↔adapter、git 钩子回调 |
| `AUTH_MODE` | `trusted` | `trusted` 免口令；`token` 用 `git` + `GIT_TOKEN` |
| `GITHUB_TOKEN` | 空 | remote URL 未内嵌凭据时的推送令牌 |
| `CORS_ORIGINS` | 空 | 留空反射请求 `Origin`；也可 `*` 或逗号分隔白名单 |
| `MAX_FILE_SIZE` | `52428800` | 单文件字节上限（50MB） |
| `GIT_BRIDGE_BIND` / `GIT_BRIDGE_PORT` | `127.0.0.1` / `18081` | 只给宿主 git CLI 用，浏览器走同源反代 |
| `GIT_BRIDGE_DATA_PATH` | `./runtime/git-bridge` | bare repo 与 remote 配置存放位置 |
| `TL2022_REPO` | Utah TL2022 归档 | 仅构建期参数，换 TeX Live 源用 |

`GIT_USERNAME`（默认 `git`）、`GIT_USER_ID`（可留空，只影响 adapter 的可写校验）以及 compose 里
写死的 `PORT`、`REPO_ROOT`、`SNAPSHOT_API_BASE`、`USER_FILES_DIR`、`MONGO_DATABASE` 一般不用动。

## 面板与同步

### 编辑器里的 Git 面板

刷新编辑器页面后，工具栏右侧出现 `Git` 按钮，点开是面板：

| 控件 | 行为 |
| --- | --- |
| 状态灯 | 依次探测 `window.GIT_BRIDGE_URL` → 同源 `/git-bridge` → `<host>:18081`，第一个 `/health` 返回 `{ok:true}` 的胜出 |
| Repository URL | 上面选中的基址 + `/<project-id>.git`，`Copy` 复制 |
| Git remote | 填 HTTPS 地址（`.git` 结尾），`Save` 保存到项目配置 |
| Pull from remote | `fetch` 远端 `main` → 有变化就写回 ShareLaTeX 并刷新页面 |
| Push to remote | 把本地 `main` 推到远端 |
| Refresh status / Open URL | 重新探活 / 新窗打开仓库地址 |

探测特意校验了响应的 `content-type` 和 `{ok:true}`：登录页重定向也是 200，只看状态码会误判。

本地工作流：

```bash
git clone http://<host>:<editor-port>/git-bridge/<project-id>.git
# 或从宿主机走映射端口
git clone http://127.0.0.1:18081/<project-id>.git
```

`AUTH_MODE=trusted`（默认）不会要口令；`token` 模式下用户名固定 `git`，密码是 `GIT_TOKEN`。

### 私有仓库凭据

面板的 remote 输入框只保存地址，认证靠 URL 内嵌凭据或 `GITHUB_TOKEN`：

```text
https://<username>:<token>@gitee.com/<username>/<project>.git
https://<username>:<token>@github.com/<username>/<project>.git
```

- GitHub 用 Personal Access Token（`repo` 权限），Gitee 用「私人令牌」；
- 用户名写账号名即可（GitHub 也接受 `x-access-token`），口令填 token；
- token 含 `@ : / ? # %` 等字符时先 URL 编码（如 `@` → `%40`）；
- 不想把 token 塞进 URL：在 `deploy/.env` 设 `GITHUB_TOKEN=<token>`。bridge 发现 URL 里
  没有内嵌凭据时，才用 `-c http.extraHeader=Authorization: Basic base64("git:<token>")` 附加，
  地址保持干净。

远程地址会被校验：必须是 `https:`、路径以 `.git` 结尾、不带 query 和 hash。
带凭据的地址以明文存放在 `deploy/runtime/git-bridge/repos/<project-id>.github.json`。

其它接口操作（面板没做按钮）：

```bash
curl -X POST http://127.0.0.1:18081/api/github/<project-id>/forget   # 清除 remote 与 token
curl        http://127.0.0.1:18081/api/github/<project-id>           # 查询配置状态
```

### 一次 push 的完整链路

```text
git push
  → git-http-backend 收到 receive-pack
  → pre-receive 钩子（push-hook.js）POST /internal/push（x-bridge-internal 校验）
  → pushCommit：比对 old/new 树，产出 files[]（新增/修改/删除）
  → adapter POST /api/v0/docs/<id>/snapshots（带 latestVerId 做乐观锁）
  → 文本写 docs 集合，二进制写 filestore，更新 projects.rootFolder/version/lastUpdated
  → 每个文档刷新 Redis：doclines:<docId> / DocHash:<docId> / DocVersion:<docId>
```

`pull` 是反方向：`fetch` 远端 `main` → 若 `lastAppliedCommit` 与远端 tip 不同，就把这棵树
按同样流程写回 ShareLaTeX → `update-ref refs/heads/main`。

## 补充 TeX Live 宏包

**不要装完整 TeX Live。** 3.4.0 自带精简 TL2022，装全套会让镜像再涨几 GB。缺什么补什么：

```bash
# TL2022 的冻结归档（Utah 的历史仓库，只读、不再更新）
TL2022_REPO=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2022/tlnet-final

# 1. 编译日志里的缺失文件
#    ! LaTeX Error: File `caption.sty' not found.

# 2. 反查哪个宏包提供它（容器里要显式指定归档仓库）
docker exec sharelatex tlmgr --verify-repo=none search --global --file '/caption.sty' \
  --repository "$TL2022_REPO"
# caption:
#         texmf-dist/tex/latex/caption/caption.sty

# 3. 只装这一个包（依赖会自动带上）
docker exec sharelatex tlmgr --verify-repo=none install caption \
  --repository "$TL2022_REPO"

# 4. 装完仍提示找不到时，重建文件名索引
docker exec sharelatex mktexlsr
```

常用：`docker exec sharelatex tlmgr info <pkg>` 看是否已装，
`docker exec sharelatex tlmgr list --only-installed` 列已装包。

### 自动版

`deploy/tools/tex-autofix.sh` 会把上面的循环跑完：编译 → 读第一条 `File 'x' not found`
→ 只装提供该文件的包 → 重试，直到产出 PDF。

```bash
./deploy/tools/tex-autofix.sh <project-id> [轮数]     # 默认 20 轮
```

前提是项目在编辑器里编译过一次（CLSI 需要有构建目录）。镜像源不可达时用
`TL2022_REPO=<其它 tlnet-final 地址>` 覆盖。

## 验证清单

逐层验证，哪一层断了就定位到哪个组件：

```bash
# 1. 容器都在
docker compose --env-file deploy/.env -f deploy/docker-compose.addon.yml ps

# 2. adapter 健康（容器网络内）
docker exec sharelatex-git-bridge-node node -e \
  "fetch('http://snapshot-adapter:8080/health').then(r=>r.text()).then(console.log)"

# 3. 同源反代（浏览器实际走的路径）
curl -s http://127.0.0.1:<editor-port>/git-bridge/health        # {"ok":true}

# 4. smart HTTP 端到端
git ls-remote http://127.0.0.1:<editor-port>/git-bridge/<project-id>.git

# 5. 附件确实进了仓库
git --git-dir=deploy/runtime/git-bridge/repos/<project-id>.git \
  ls-tree -r --name-only main | grep -iE '\.(pdf|png|jpg)$'

# 6. 编译引擎
docker exec sharelatex xelatex --version
```

编辑器刷新后工具栏出现 `Git` 按钮，面板状态应为 `Git bridge ready`。

## 故障排查

| 现象 | 定位 | 处理 |
| --- | --- | --- |
| 面板 `Git bridge unavailable` | 浏览器 Network 看 `/git-bridge/health` | 404 → 镜像没带同源配置（重建 UI 镜像并 `bin/up -d`）；502 → bridge 不在同一网络；请求没发出 → 页面是 HTTPS 而地址是 HTTP |
| 编译 `Server Error` | `docker exec sharelatex tail -50 /var/log/sharelatex/web.log` | 报 `file.created.getTime is not a function` 说明 `rootFolder` 被 JSON 序列化过：把 `created` 转回 `Date`、`_id` 转回 `ObjectId` |
| 编译 `no output.pdf generated` | `clsi.log` 与编译目录里的 `output.stdout` | `xelatex: not found` → 镜像缺引擎；`File 'x.xx' not found` → `deploy/tools/tex-autofix.sh <project-id>` 补包 |
| CLSI 报 `files out of sync, please retry` | 同左 | 服务端状态陈旧，web 会自动重试 full sync；持续出现就清 `data/compiles/<project-id>-<user-id>/` 再编 |
| `! [rejected] main -> main (fetch first)` | 本地 `main` 与远端分叉（比如重新导入过仓库） | 把导入结果 rebase 到远端之上：`git fetch github main`，用 `commit-tree <本地tree> -p <远端tip>` 造提交，`update-ref` 后再 `git push github main` |
| push 提示 `Project is out of date` | adapter 返回 409 | 推送期间项目在编辑器里被保存过，先同步最新内容再推 |
| push 被拒 `Only one ref update is supported` | 钩子日志 | 一次只推一个 ref（只有 `main`） |
| PDF / 图片没进仓库 | adapter 日志 + `docker inspect` 挂载 | `USER_FILES_PATH` 没挂进 adapter，或工程本身没有 `fileRefs` |
| push 后编辑器打不开工程 | Mongo 里 `rootFolder` 的 `_id` / `created` 类型 | 见 `Server Error` 一行，恢复 BSON 类型 |
| 面板地址解析到 18081 而不是同源 | 同源探测失败 | 确认 UI 镜像含 `sharelatex.conf`；或用 `window.GIT_BRIDGE_URL` 指定基址 |

## 日常运维

**改了 UI 文件（面板、nginx、Dockerfile）**

```bash
docker build -t sharelatex-local-ui:3.4.0 git-ui
cd "$TOOLKIT_DIR" && bin/up -d
```

**改了 add-on 服务代码（adapter / bridge）**

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.addon.yml up -d --build
```

**补 TeX 包**

```bash
./deploy/tools/tex-autofix.sh <project-id> [轮数]
```

细节与手动 `tlmgr` 写法见[补充 TeX Live 宏包](#补充-tex-live-宏包)；包名要写回
`git-ui/Dockerfile`，否则容器重建后丢失。

**备份**

只有两处需要留：`deploy/.env`（内部密钥）和 `deploy/runtime/`（bare repo、remote 配置、
token）。工程正文在 MongoDB 与 Toolkit 的 `data/overleaf` 里，由 Toolkit 自己管。

**卸载**

```bash
TOOLKIT_DIR=/root/overleaf-toolkit ./deploy/uninstall.sh                # 保留 runtime
TOOLKIT_DIR=/root/overleaf-toolkit ./deploy/uninstall.sh --purge-data   # 连 bare repo 一起删
```

脚本会停掉 add-on、把 `overleaf.rc` 还原成最近一份备份（没有备份就删掉
`OVERLEAF_IMAGE_NAME` 行）、`bin/up -d` 回到原镜像，并删除构建出的镜像。
`--purge-data` 会丢掉 Git 提交历史与远程配置，之后只能从当前版本重新导入。

## 已知限制

- 只支持 `refs/heads/main`，没有分支、tag、合并策略；
- 快照只覆盖当前版本，`saved_vers` 返回空，历史版本元数据未实现；
- push 会整体重写被改动的文档（`docs.rev` 递增）；二进制同名路径会复用原 `fileRef._id`；
- 首次导入生成一个全新提交。远端已有历史时需先把导入结果 rebase 到远端之上再推，
  否则会被判非快进而拒绝（见排障表）；
- UI 镜像构建依赖 TL2022 归档仓库，默认指向 Utah 历史归档，网络不便时用 `TL2022_REPO` 换源；
- 覆盖了上游 `editor.pug` 与 `sharelatex.conf`，上游升级时需重新合并；
- `CORS_ORIGINS` 留空时反射任意 `Origin`，只适合私有部署。

## 安全注意

- `AUTH_MODE=trusted`（默认）下，任何能访问 bridge 的人都能 clone / push 任意项目；
  对外暴露前改成 `token` 模式，或在反代层加认证；
- `token` 模式也只有**一套共享口令**，做不到按用户隔离；需要细分权限得自己加层；
- 面板保存的远程地址（可能含 token）明文落在
  `deploy/runtime/git-bridge/repos/<project-id>.github.json`（`*token` 文件权限 600）；
- 不要提交 `deploy/.env`、`deploy/runtime/`、MongoDB / Redis 数据或带凭据的 URL；
- token 一旦出现在截图、日志或公开 URL 里，立刻撤销重发。

## 关键文件

```text
snapshot-adapter/
  server.js          快照 API：GET /api/v0/docs/:id、/snapshots/:ver、POST /snapshots
git-bridge-node/
  server.js          smart HTTP、/api/github/:id/(configure|pull|push|forget)、/internal/push
  push-hook.js       装到每个 bare repo 的 pre-receive 钩子
git-ui/
  Dockerfile         补 TL2022 引擎 + 覆盖模板 + 烤入 nginx 配置
  editor.pug         上游完整模板，仅加 1 行样式 + 1 行脚本
  sharelatex.conf    nginx：新增 /git-bridge/，其余保持上游
  git-bridge-toolbar.{js,css}
deploy/
  install.sh / uninstall.sh / docker-compose.addon.yml / .env.example
  tools/tex-autofix.sh
```

## English summary

A Docker add-on that gives legacy ShareLaTeX 3.4.0 the Git workflow it never had: a Node
Git smart-HTTP bridge, a Mongo/Redis snapshot adapter that also carries uploaded binaries
through the filestore, and a derived editor image that mounts the bridge on the editor's own
origin and restores the missing XeTeX engine. Manual sync only, single branch (`main`),
HTTPS remotes, attachments included.

It exists because current Overleaf images are too heavy for cheap, low-spec VPS machines, so
it keeps the lighter 3.4.0 base and ports the Git Bridge approach from
[ayaka-notes/ayakaleaf-pro](https://github.com/ayaka-notes/ayakaleaf-pro) onto the old data
model. Do not install a full TeX Live — add missing packages on demand with `tlmgr`.

Tested against `sharelatex/sharelatex:3.4.0` with MongoDB 4.4 and Redis 6.2.

## License

MIT. See [LICENSE](LICENSE).
