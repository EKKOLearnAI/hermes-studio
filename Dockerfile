ARG BASE_IMAGE=nousresearch/hermes-agent:latest
FROM ${BASE_IMAGE}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    python3 \
    python3-yaml \
    make \
    g++ \
    && curl -fsSL https://deb.nodesource.com/setup_23.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV HOME=/home/agent
ENV HERMES_HOME=/home/agent/.hermes

EXPOSE 6060

# 强制覆盖基础镜像的默认启动脚本，让镜像本身具备独立运行的能力
ENTRYPOINT ["node", "dist/server/index.js"]
CMD []
