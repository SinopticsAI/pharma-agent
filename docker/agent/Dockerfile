# Mastra intake agents. Built by `mastra build` into .mastra/output.
# Current @mastra/* packages require Node >=22.13; on Node 20 the bundler
# resolves @mastra/ai-sdk@^1.0.0 to the stale 1.0.1 (peer core 0.21–0.24).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx mastra build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# The container must answer within its execution timeout; it cannot stream, so
# a turn that runs long is a turn the user waits for in full.
ENV NODE_OPTIONS=--max-old-space-size=768

# Yandex root certificate for sslmode=verify-full against the managed cluster.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /usr/local/share/ca-certificates/yandex-root.crt \
      https://storage.yandexcloud.net/cloud-certs/CA.pem \
 && update-ca-certificates \
 && apt-get purge -y curl \
 && rm -rf /var/lib/apt/lists/*
ENV PGSSLROOTCERT=/usr/local/share/ca-certificates/yandex-root.crt
ENV PG_SSLROOTCERT=/usr/local/share/ca-certificates/yandex-root.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/yandex-root.crt

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/package.json ./package.json
COPY docker/agent/entry.mjs ./entry.mjs

EXPOSE 8080
ENV PORT=8080
CMD ["node", "entry.mjs"]
