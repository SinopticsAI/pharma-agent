/**
 * Mastra server for the MedMost cabinet.
 *
 * Runs as a Yandex Serverless Container behind the Edge API gateway. The
 * gateway verified the Keycloak token before this process was reached, so the
 * container reads the identity from requestContext and never checks a
 * signature itself.
 *
 * One property of the platform shapes the whole design: a serverless container
 * cannot stream. It has to finish the turn before returning, which is why the
 * cabinet shows an explicit "reading the document" state instead of a typing
 * effect, and why tool payloads stay small — the whole response must fit in
 * 3.5 MB including headers.
 */

import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { chatRoute } from '@mastra/ai-sdk';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';

import { companyIntake } from './agents/company';
import { productIntake } from './agents/product';
import { callerFrom } from './auth/claims';

function connectionString(): string {
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
  const rootcert =
    process.env.PGSSLROOTCERT || process.env.PG_SSLROOTCERT || '';
  let dsn = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslmode}`;
  if (rootcert) dsn += `&sslrootcert=${rootcert}`;
  return dsn;
}

const storage = new PostgresStore({
  id: 'pharma-agent-storage',
  connectionString: connectionString(),
});

export const mastra = new Mastra({
  agents: { companyIntake, productIntake },
  storage,
  memory: {
    chatMemory: new Memory({ options: { lastMessages: 30 } }),
  },
  server: {
    // Same origin as the rest of the cabinet: the browser only ever talks to
    // the Edge gateway, so CORS here is a local-development convenience.
    cors: {
      origin: (process.env.AGENT_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5175').split(','),
      credentials: true,
    },
    apiRoutes: [
      chatRoute({ path: '/chat/:agentId' }),
      registerApiRoute('/health', {
        method: 'GET',
        handler: async (c) => c.json({ ok: true, service: 'pharma-agent' }),
      }),
    ],
    middleware: [
      // Carry the verified identity into every tool call. Tools read accountId
      // from here and pass it to Edge; nothing trusts a value from the body.
      async (c, next) => {
        const caller = callerFrom(
          {
            requestContext: (c.req.raw as unknown as { requestContext?: never }).requestContext,
            headers: Object.fromEntries(c.req.raw.headers.entries()),
          },
          c.req.header('X-Pharma-Locale') ?? 'zh',
        );
        if (caller) {
          const runtime = c.get('runtimeContext');
          runtime?.set('subject', caller.subject);
          runtime?.set('role', caller.role);
          runtime?.set('displayName', caller.displayName);
          runtime?.set('locale', caller.locale);
          // accountId is resolved by Edge from the subject; the header is the
          // only place it is allowed to come from for service calls.
          const accountId = c.req.header('X-Pharma-Account') ?? caller.accountId;
          if (accountId) runtime?.set('accountId', accountId);
        }
        await next();
      },
    ],
  },
});
