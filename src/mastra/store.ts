/**
 * Postgres for Mastra storage and agent Memory. The container talks to
 * Odyssey on 6432 (transaction mode): a leftover idle client is dead, and
 * getWorkflowRunById then dies as Connection terminated unexpectedly.
 */
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';

export function connectionString(): string {
  const direct = process.env.PG_DSN;
  if (direct) return direct;
  const host = process.env.PG_HOST ?? '';
  // 6432 is the Odyssey pooler in transaction mode. Not 5432: a serverless
  // caller must not hold a session-pooled connection.
  const port = process.env.PG_PORT ?? '6432';
  const database = process.env.PG_DATABASE ?? 'pharma_agent';
  const user = process.env.PG_USER ?? 'pharma_agent';
  const password = process.env.PG_PASSWORD ?? '';
  const sslmode = process.env.PG_SSLMODE ?? 'verify-full';
  // Node's tls bundle does not include the Yandex MDB CA. Edge passes
  // sslrootcert the same way; without it verify-full dies as SELF_SIGNED_CERT_IN_CHAIN.
  const rootcert = process.env.PGSSLROOTCERT || process.env.PG_SSLROOTCERT || '';
  let dsn = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslmode}&connect_timeout=8`;
  if (rootcert) dsn += `&sslrootcert=${rootcert}`;
  return dsn;
}

export const storage = new PostgresStore({
  id: 'pharma-agent-storage',
  connectionString: connectionString(),
  // Small pool, short idle: Odyssey will have already dropped a 30s leftover.
  max: 2,
  idleTimeoutMillis: 5_000,
});

export const chatMemory = new Memory({
  storage,
  options: { lastMessages: 30 },
});
