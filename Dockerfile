FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN chmod 0755 /app && chmod 0644 package.json package-lock.json \
    && npm ci --omit=optional --ignore-scripts && npm cache clean --force

COPY src ./src
COPY config.example.json ./config.example.jsonrf
RUN find /app/src -type d -exec chmod 0755 {} + \
    && find /app/src -type f -exec chmod 0644 {} + \
    && chmod 0644 /app/config.example.json \
    && mkdir /app/.private && chown node:node /app/.private

USER node
RUN node --input-type=module -e "\
    import { readFile } from 'node:fs/promises'; \
    await readFile('src/cli.mjs'); \
    await import('./src/http.mjs'); \
    await import('./src/runner.mjs'); \
    await import('./src/lock.mjs'); \
    const { loadConfig } = await import('./src/storage.mjs'); \
    await loadConfig();"
CMD ["node", "src/cli.mjs", "run"]
