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
import { localeOf, type Locale } from './locale';

type ChatHints = { locale: Locale; organizationId: string; productId: string };

function asId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function chatHintsFromRequest(c: {
  req: { method: string; header: (name: string) => string | undefined; raw: Request };
}): Promise<ChatHints> {
  let locale: Locale | undefined;
  let organizationId = '';
  let productId = '';
  const header = c.req.header('X-Pharma-Locale');
  if (header === 'zh' || header === 'en' || header === 'ru') locale = header;
  if (c.req.method === 'POST') {
    try {
      const body = (await c.req.raw.clone().json()) as {
        data?: { locale?: unknown; organizationId?: unknown; productId?: unknown };
        requestContext?: { locale?: unknown; organizationId?: unknown; productId?: unknown };
      };
      const data = body.data ?? {};
      const rc = body.requestContext ?? {};
      if (locale === undefined && (data.locale ?? rc.locale) !== undefined) {
        locale = localeOf(data.locale ?? rc.locale);
      }
      organizationId = asId(data.organizationId) || asId(rc.organizationId);
      productId = asId(data.productId) || asId(rc.productId);
    } catch {
      // Chat route still needs the original body; a non-JSON POST is not ours.
    }
  }
  return { locale: locale ?? 'zh', organizationId, productId };
}

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
      chatRoute({
        path: '/chat/:agentId',
        defaultOptions: { maxSteps: 5 },
      }),
      registerApiRoute('/health', {
        method: 'GET',
        handler: async (c) => c.json({ ok: true, service: 'pharma-agent' }),
      }),
    ],
    middleware: [
      // Carry the verified identity into every tool call. Tools read accountId
      // and the caller's Bearer from here and pass them to Edge; nothing
      // trusts a value from the body.
      async (c, next) => {
        const runtime = c.get('requestContext');
        const hints = await chatHintsFromRequest(c);
        const locale = hints.locale;
        const caller = callerFrom(
          {
            requestContext: (c.req.raw as unknown as { requestContext?: never }).requestContext,
            headers: Object.fromEntries(c.req.raw.headers.entries()),
          },
          locale,
        );
        const authorization = c.req.header('Authorization');
        if (authorization) runtime?.set('authorization', authorization);
        // Cabinet still sends the tenant on /chat (JWT has no account). Read it
        // even when authorizer claims did not land in requestContext — that
        // shape is for Cloud Functions, not this container.
        const accountId = c.req.header('X-Pharma-Account') ?? caller?.accountId;
        if (accountId) runtime?.set('accountId', accountId);
        if (caller) {
          runtime?.set('subject', caller.subject);
          runtime?.set('role', caller.role);
          runtime?.set('displayName', caller.displayName);
          runtime?.set('locale', caller.locale);
        } else {
          runtime?.set('locale', locale);
        }
        if (hints.organizationId) runtime?.set('organizationId', hints.organizationId);
        if (hints.productId) runtime?.set('productId', hints.productId);
        await next();
      },
    ],
  },
});
