# Mastra intake agents. Built by `mastra build` into .mastra/output.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx mastra build

FROM node:20-slim
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
ENV PG_SSLROOTCERT=/usr/local/share/ca-certificates/yandex-root.crt

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
ENV PORT=8080
CMD ["node", ".mastra/output/index.mjs"]
