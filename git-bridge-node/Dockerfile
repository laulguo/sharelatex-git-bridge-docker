FROM node:18-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js push-hook.js ./
RUN mkdir -p /data/repos
EXPOSE 8080
CMD ["node", "server.js"]
