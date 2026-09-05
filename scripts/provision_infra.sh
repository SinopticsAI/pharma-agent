#!/usr/bin/env bash
# Idempotent SA + folder roles + Container Registry from iam.yml / registry.yml.
# Those YAML files are intent, not applied by yc. This script is the apply step.
set -euo pipefail

YC_FOLDER_ID="${YC_FOLDER_ID:-$(yc config get folder-id)}"
: "${YC_FOLDER_ID:?set YC_FOLDER_ID or yc config set folder-id}"
REGISTRY_NAME="${REGISTRY_NAME:-pharma-agent}"

declare -A SA_MAP=()

ensure_sa() {
  local name="$1" description="$2"
  local existing id
  existing=$(yc iam service-account get --name "$name" --format json 2>/dev/null || true)
  if [[ -n "$existing" ]]; then
    id=$(echo "$existing" | jq -r .id)
    echo "  exists $name ($id)"
  else
    id=$(yc iam service-account create \
      --name "$name" \
      --description "$description" \
      --folder-id "$YC_FOLDER_ID" \
      --format json | jq -r .id)
    echo "  created $name ($id)"
  fi
  SA_MAP["$name"]="$id"
}

ensure_binding() {
  local sa_name="$1" role="$2"
  local sa_id="${SA_MAP[$sa_name]:-}"
  if [[ -z "$sa_id" ]]; then
    echo "ERROR: unknown SA '$sa_name'" >&2
    exit 1
  fi
  if yc resource-manager folder list-access-bindings --id "$YC_FOLDER_ID" --format json \
    | jq -e --arg id "$sa_id" --arg r "$role" \
      '.[] | select(.subject.id==$id and .role_id==$r)' >/dev/null 2>&1; then
    echo "  ok $sa_name $role"
  else
    yc resource-manager folder add-access-binding \
      --id "$YC_FOLDER_ID" --role "$role" --subject "serviceAccount:${sa_id}" >/dev/null
    echo "  bound $sa_name $role"
  fi
}

echo "==> Service accounts (iam.yml)"
ensure_sa pharma-agent-sa "Runtime identity of the Mastra container"
ensure_sa pharma-agent-sa-ci "CI pushes images and deploys revisions"

echo "==> Role bindings"
ensure_binding pharma-agent-sa container-registry.images.puller
ensure_binding pharma-agent-sa lockbox.payloadViewer
ensure_binding pharma-agent-sa kms.keys.encrypterDecrypter
ensure_binding pharma-agent-sa vpc.user

ensure_binding pharma-agent-sa-ci container-registry.images.pusher
ensure_binding pharma-agent-sa-ci serverless-containers.editor
ensure_binding pharma-agent-sa-ci serverless-containers.admin
ensure_binding pharma-agent-sa-ci vpc.user
ensure_binding pharma-agent-sa-ci iam.serviceAccounts.user
ensure_binding pharma-agent-sa-ci lockbox.payloadViewer
ensure_binding pharma-agent-sa-ci kms.keys.encrypterDecrypter

echo "==> Container Registry (registry.yml)"
reg_json=$(yc container registry get --name "$REGISTRY_NAME" --format json 2>/dev/null || true)
if [[ -n "$reg_json" ]]; then
  REGISTRY_ID=$(echo "$reg_json" | jq -r .id)
  echo "  exists $REGISTRY_NAME ($REGISTRY_ID)"
else
  REGISTRY_ID=$(yc container registry create --name "$REGISTRY_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)
  echo "  created $REGISTRY_NAME ($REGISTRY_ID)"
fi

echo ""
echo "Put these into GitHub → SinopticsAI/pharma-agent → Settings → Secrets:"
echo "  REGISTRY_ID=$REGISTRY_ID"
echo "  YC_SA_JSON  = authorized key of pharma-agent-sa-ci (${SA_MAP[pharma-agent-sa-ci]})"
echo ""
echo "Create the key locally (do not commit it):"
echo "  yc iam key create --service-account-name pharma-agent-sa-ci --output sa-ci.json"
echo "  then paste the file contents as YC_SA_JSON"
