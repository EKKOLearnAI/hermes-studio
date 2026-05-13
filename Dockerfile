ARG BASE_IMAGE=nousresearch/hermes-agent:latest
FROM ${BASE_IMAGE}

USER root

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then NODE_ARCH="x64"; else NODE_ARCH="$ARCH"; fi \
    && echo "Downloading Node.js v23.11.0 for ${NODE_ARCH}" \
    && curl -fsSL "https://nodejs.org/dist/v23.11.0/node-v23.11.0-linux-${NODE_ARCH}.tar.gz" \
       -o /tmp/node.tar.gz \
    && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 \
    && rm -f /tmp/node.tar.gz \
    && node --version

WORKDIR /app

# Copy and build web-ui
COPY package*.json ./
# Increase Node.js memory limit to prevent OOM during build
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm install --ignore-scripts && npm rebuild node-pty

COPY . .
RUN npm run build && npm prune --omit=dev

# Copy startup script
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh

# Environment variables
ENV NODE_ENV=production
ENV HOME=/home/agent
ENV HERMES_HOME=/home/agent/.hermes
ENV PORT=6060
ENV HERMES_BIN=/opt/hermes/.venv/bin/hermes
ENV PATH=/opt/hermes/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Expose ports
# 8642-8670: Hermes Agent gateway ports
# 6060: Web UI port
EXPOSE 8642-8670 6060

# Use startup script
ENTRYPOINT ["/start.sh"]
CMD []
