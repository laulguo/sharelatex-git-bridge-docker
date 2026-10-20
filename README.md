# ShareLaTeX Git Bridge Docker

为旧版 ShareLaTeX 3.4.0 增加 Git clone、pull、push 和远程仓库同步能力的 Docker 扩展。

这是一个独立 addon，不替换 ShareLaTeX、MongoDB 或 Redis。它通过现有 Toolkit Docker network 连接原有服务。

## 这个仓库做什么

在现有 ShareLaTeX 3.4.0 旁边增加两个容器：

```text
ShareLaTeX 3.4.0
    |
    +-- snapshot-adapter       适配旧版 MongoDB/Redis 文档数据
    |
    +-- git-bridge-node        提供 Git HTTP 和远程仓库同步
```

编辑器中会显示 Git 面板，可以获取项目 Git 地址并手动执行 Pull / Push。GitHub 是默认场景，同时支持 Gitee、GitLab、Gitea 和其他 HTTPS `.git` 仓库。

## 主要功能

- Git smart HTTP clone、fetch、push；
- 本地 Git Basic Auth；
- ShareLaTeX 项目所有者和协作者权限检查；
- 项目级 push 串行锁；
- 新增、修改、删除文件同步；
- 同步旧版 ShareLaTeX 的 MongoDB 和 Redis 文档状态；
- 编辑器内手动配置远程仓库；
- 手动 Pull / Push，不执行后台自动同步；
- Docker 方式注入 ShareLaTeX 编辑器 UI。

## 目录说明

### `snapshot-adapter/`

Node.js Snapshot API 适配服务，将 ShareLaTeX 3.4.0 的 `projects`、`docs` 数据转换为 Git Bridge 使用的接口，并在 push 时同步 Redis 文档缓存。

### `git-bridge-node/`

基于 Node.js 和系统 `git-http-backend` 的 Git 服务。每个项目使用独立 bare repository：

```text
/data/repos/<project-id>.git
```

本地默认地址：

```text
http://localhost:18081/<project-id>.git
```

### `git-ui/`

基于 `sharelatex/sharelatex:3.4.0` 的 Docker 派生镜像，通过覆盖旧版编辑器模板注入 Git 面板，不修改上游镜像源码。

## 本地 Docker 启动

本地测试环境使用 ShareLaTeX `3.4.0`、MongoDB `4.4` 和 Redis `6.2`。

```powershell
docker compose -f snapshot-adapter/docker-compose.yml up -d --build
docker compose -f git-bridge-node/docker-compose.yml up -d --build
docker build -t sharelatex-local-ui:3.4.0 git-ui
```

在 Toolkit 的 `config/overleaf.rc` 中设置：

```text
OVERLEAF_IMAGE_NAME=sharelatex-local-ui
```

然后重启 ShareLaTeX Web 容器。

## VPS 一键部署

部署文件位于 `deploy/`：

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.addon.yml up -d --build
```

部署前填写 `SHARELATEX_NETWORK`、`GIT_USER_ID`、`ADAPTER_TOKEN`、`GIT_TOKEN` 和 `INTERNAL_HOOK_TOKEN`。UI 镜像构建为 `sharelatex-local-ui:3.4.0` 后，把 Toolkit 的 `OVERLEAF_IMAGE_NAME` 设置为 `sharelatex-local-ui`。

Addon 不会复制或替换生产 MongoDB、Redis 数据。

## 远程仓库同步

GitHub 是默认示例。创建空仓库后，在编辑器 Git 面板中填写 remote，点击 `Save`，再执行：

```text
Pull from GitHub
Push to GitHub
```

任意 HTTPS 且以 `.git` 结尾的地址都支持：

```text
https://github.com/user/project.git
https://gitee.com/user/project.git
https://git.example.com/team/project.git
```

凭据也可以直接写入 URL：

```text
https://username:token@gitee.com/username/project.git
```

token 中的特殊字符需要 URL 编码。同步是手动的，不会在后台自动 Pull 或 Push。

## 安全注意事项

- 不要提交 `deploy/.env`、运行时数据、MongoDB/Redis 数据、bare repository 或带凭据的 remote URL；
- 远程仓库优先使用 HTTPS；
- token 出现在截图、命令历史、日志或公开 URL 后应立即撤销；
- 接入生产数据前，先使用独立测试数据库完成 clone、pull、push 和失败回滚测试。

## 当前范围

本项目针对 ShareLaTeX 3.4.0 的旧数据结构，是兼容集成 addon，不是现代 Overleaf Git Bridge 的直接替代品。历史版本元数据、附件、OAuth token 交换、跨进程锁和完整 MongoDB 事务仍需要进一步加固。

## English Summary

This repository provides a Docker add-on for ShareLaTeX 3.4.0. It adds a Node.js Snapshot API adapter, a Git smart HTTP bridge, and an editor Git panel. The add-on runs beside the existing ShareLaTeX, MongoDB, and Redis containers and supports manual synchronization with GitHub, Gitee, GitLab, Gitea, and other HTTPS `.git` remotes.

See the Chinese sections above for deployment and security details.

## License

MIT. See [LICENSE](LICENSE).
