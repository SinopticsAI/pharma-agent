#!/usr/bin/env bash
# Deploy the Mastra container. Mirrors pharma-plane/scripts/deploy_containers.sh
# with two differences: a Node image, and a mandatory --network-id so the
# container can reach the managed PostgreSQL cluster.
#
# The container is NOT public. Only the gateway service account invokes it.
set -euo pipefail

YC_FOLDER_ID="${YC_FOLDER_ID:?}"
REGISTRY_ID="${REGISTRY_ID:?}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
LOCKBOX_SECRET_ID="${LOCKBOX_SECRET_ID:?}"
VPC_NETWORK_ID="${VPC_NETWORK_ID:?}"
PG_HOST="${PG_HOST:?}"
EDGE_API_BASE="${EDGE_API_BASE:-https://pharma-edge.sinoptics.ru}"
AGENT_MODEL="${AGENT_MODEL:-yandexgpt/latest}"
SA_GATEWAY_ID="${SA_GATEWAY_ID:-}"

NAME="pharma-agent"
SA_NAME="pharma-agent-sa"
IMAGE_URL="cr.yandex/${REGISTRY_ID}/agent:${IMAGE_TAG}"

echo "==> Deploy $NAME (tag=$IMAGE_TAG)"

sa_id=$(yc iam service-account get --name "$SA_NAME" --format json | jq -r .id)

if ! yc serverless container get --name "$NAME" --format json >/dev/null 2>&1; then
  yc serverless container create --name "$NAME" --folder-id "$YC_FOLDER_ID" >/dev/null
  echo "  created container $NAME"
else
  echo "  exists container $NAME"
fi

# Each --environment is one KEY=VALUE: yc splits a single blob on commas.
yc serverless container revision deploy \
  --container-name "$NAME" \
  --image "$IMAGE_URL" \
  --service-account-id "$sa_id" \
  --memory 1024MB \
  --cores 1 \
  --concurrency 4 \
  --execution-timeout 300s \
  --network-id "$VPC_NETWORK_ID" \
  --secret "environment-variable=PG_PASSWORD,id=${LOCKBOX_SECRET_ID},key=pharma_agent_password" \
  --secret "environment-variable=EDGE_API_KEY,id=${LOCKBOX_SECRET_ID},key=edge_api_key" \
  --secret "environment-variable=AI_STUDIO_API_KEY,id=${LOCKBOX_SECRET_ID},key=ai_studio_api_key" \
  --environment "FOLDER_ID=${YC_FOLDER_ID}" \
  --environment "EDGE_API_BASE=${EDGE_API_BASE}" \
  --environment "PG_HOST=${PG_HOST}" \
  --environment "PG_PORT=6432" \
  --environment "PG_DATABASE=pharma_agent" \
  --environment "PG_USER=pharma_agent" \
  --environment "PG_SSLMODE=verify-full" \
  --environment "AI_STUDIO_BASE_URL=https://llm.api.cloud.yandex.net/v1" \
  --environment "AGENT_MODEL=${AGENT_MODEL}" \
  >/dev/null

container_id=$(yc serverless container get --name "$NAME" --format json | jq -r .id)
echo "  revision deployed $NAME -> $container_id"

# The gateway is the only caller. No allow-unauthenticated-invoke here.
if [[ -n "$SA_GATEWAY_ID" ]]; then
  yc serverless container add-access-binding \
    --name "$NAME" \
    --role serverless-containers.containerInvoker \
    --service-account-id "$SA_GATEWAY_ID" >/dev/null 2>&1 || true
  echo "  invoker binding for gateway SA ensured"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "container_agent_id=$container_id" >> "$GITHUB_OUTPUT"
fi

echo ""
echo "Put this into pharma-edge/infra/account.env so the gateway can route to it:"
echo "  CONTAINER_AGENT_ID=$container_id"
