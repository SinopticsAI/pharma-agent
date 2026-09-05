/**
 * Load Lockbox payloads into env, then start Mastra.
 * Same pattern as pharma-plane: the revision does not use yc --secret
 * (that flag is a separate IAM check serverless-containers.editor lacks).
 */
const METADATA = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";
const PAYLOAD = "https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets";

function textOf(entry) {
  return entry?.textValue ?? entry?.text_value ?? "";
}

function apply(entries, key, envName) {
  if (process.env[envName]) return;
  const hit = (entries ?? []).find((item) => item.key === key);
  const value = textOf(hit);
  if (value) process.env[envName] = value;
}

async function iamToken() {
  const response = await fetch(METADATA, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    throw new Error(`metadata token ${response.status}`);
  }
  const body = await response.json();
  return body.access_token;
}

async function secretEntries(secretId, token) {
  const response = await fetch(`${PAYLOAD}/${secretId}/payload`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`lockbox ${secretId}: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  return body.entries ?? [];
}

async function hydrate() {
  if ((process.env.SECRET_BACKEND ?? "") !== "lockbox") return;
  const pgId = (process.env.LOCKBOX_PG_SECRET_ID || process.env.LOCKBOX_SECRET_ID || "").trim();
  const appId = (process.env.LOCKBOX_APP_SECRET_ID || process.env.LOCKBOX_SECRET_ID || "").trim();
  if (!pgId && !appId) return;

  const token = await iamToken();
  if (pgId) {
    apply(await secretEntries(pgId, token), "pharma_agent_password", "PG_PASSWORD");
  }
  if (appId) {
    const entries = await secretEntries(appId, token);
    apply(entries, "edge_api_key", "EDGE_API_KEY");
    apply(entries, "ai_studio_api_key", "AI_STUDIO_API_KEY");
  }
}

await hydrate();
await import("./.mastra/output/index.mjs");
