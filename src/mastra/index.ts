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

import { companyIntake } from './agents/company';
import { productIntake } from './agents/product';
import { callerFrom } from './auth/claims';
import { extractDocument } from './extract';
import { localeOf, type Locale } from './locale';
import { chatMemory, storage } from './store';
import { EdgeError } from './tools/edge';

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
      organizationId =
        asId(data.organizationId) || asId(rc.organizationId) || asId((body as { organizationId?: unknown }).organizationId);
      productId = asId(data.productId) || asId(rc.productId);
    } catch {
      // Chat route still needs the original body; a non-JSON POST is not ours.
    }
  }
  return { locale: locale ?? 'zh', organizationId, productId };
}

export const mastra = new Mastra({
  agents: { companyIntake, productIntake },
  storage,
  memory: {
    chatMemory,
  },
  // Reading a PDF needs a native page renderer and PDF.js with its own worker
  // and font assets. Bundling either breaks it, so they stay external and are
  // resolved from node_modules, which the runtime image already carries. They
  // are imported lazily, hence dynamicPackages as well.
  bundler: {
    externals: ['unpdf', '@napi-rs/canvas'],
    dynamicPackages: ['unpdf', '@napi-rs/canvas'],
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
      registerApiRoute('/extract', {
        method: 'POST',
        handler: async (c) => {
          const runtime = c.get('requestContext');
          let body: { organizationId?: unknown; itemId?: unknown } = {};
          try {
            body = (await c.req.json()) as { organizationId?: unknown; itemId?: unknown };
          } catch {
            return c.json({ error: 'invalid_json', message: 'JSON body required' }, 400);
          }
          const organizationId = asId(body.organizationId) || asId(runtime?.get('organizationId'));
          const itemId = asId(body.itemId);
          try {
            const data = await extractDocument({
              organizationId,
              itemId,
              caller: {
                accountId: asId(runtime?.get('accountId')),
                subject: asId(runtime?.get('subject')),
                actor: asId(runtime?.get('displayName')),
                authorization: asId(runtime?.get('authorization')) || c.req.header('Authorization') || '',
              },
            });
            return c.json({ data });
          } catch (error) {
            if (error instanceof EdgeError) {
              return c.json({ error: error.code, message: error.message }, error.status as 400);
            }
            const message = error instanceof Error ? error.message : 'extract failed';
            return c.json({ error: 'extract_failed', message }, 500);
          }
        },
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
