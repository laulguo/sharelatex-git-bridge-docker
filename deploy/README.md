# Docker Add-on Deployment

This add-on runs the Node Git Bridge and the read/write Snapshot adapter next to an existing ShareLaTeX 3.4.0 Toolkit deployment.

It does not replace MongoDB or Redis. It joins the existing Toolkit Docker network and uses the existing `mongo` and `redis` service names.

## 一键部署

在 VPS 上执行：

```bash
cd /root
wget -O sharelatex-git-bridge-docker.tar.gz \
  https://github.com/laulguo/sharelatex-git-bridge-docker/archive/refs/heads/main.tar.gz
tar -xzf sharelatex-git-bridge-docker.tar.gz
mv sharelatex-git-bridge-docker-main sharelatex-git-bridge-docker
cd sharelatex-git-bridge-docker
chmod +x deploy/install.sh
TOOLKIT_DIR=/root/overleaf-toolkit ./deploy/install.sh
```

脚本只会询问 ShareLaTeX 登录邮箱和 Toolkit 目录，自动完成：

- 从 `sharelatex` 容器读取 Docker network；
- 从 MongoDB 查询用户 ObjectId；
- 自动生成三个内部随机密钥；
- 构建 UI 镜像；
- 备份并更新 Toolkit 的 `OVERLEAF_IMAGE_NAME`；
- 重启 ShareLaTeX Web 容器；
- 启动 adapter 和 Git bridge 两个容器。

生成的密钥保存在 `deploy/.env`，不会提交到 Git。

## 手动部署

### 1. 准备 network

On the VPS, identify the Toolkit network:

```bash
docker network ls
```

For a Toolkit project named `overleaf`, this is usually `overleaf_default`. Set that value in `deploy/.env`.

### 2. 准备 secrets

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

手动部署时，`GIT_USER_ID` 是 ShareLaTeX 用户的 Mongo ObjectId；`ADAPTER_TOKEN`、`GIT_TOKEN` 和 `INTERNAL_HOOK_TOKEN` 都是本地随机密钥，不来自 GitHub。

Do not commit `.env`, `runtime/`, Mongo data, Redis data, or Git repositories.

### 3. 构建 UI image

The UI is a Docker-derived ShareLaTeX image. Build it on the VPS:

```bash
docker build -t sharelatex-local-ui:3.4.0 git-ui
```

Set the Toolkit `config/overleaf.rc` image override to:

```text
OVERLEAF_IMAGE_NAME=sharelatex-local-ui
```

Keep the Toolkit `config/version` at `3.4.0`.

### 4. 启动 add-on

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.addon.yml up -d --build
```

The bridge listens on `127.0.0.1:18081` by default. Put it behind the same HTTPS reverse proxy as ShareLaTeX before exposing it outside the VPS.

## Git remote credentials

The editor supports an HTTPS remote ending in `.git`. Credentials may be embedded in the URL, for example:

```text
https://username:token@gitee.com/username/project.git
```

URL-encode special characters in the token. Credentials in URLs are visible to anyone who can read the Git remote configuration; use a private VPS and rotate the token if it is exposed.
