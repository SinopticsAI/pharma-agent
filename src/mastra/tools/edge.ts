/**
 * Tools are the only way the agent touches business data.
 *
 * Every one of them is a thin wrapper over the Edge REST API with the service
 * key and the caller's account. The agent never opens pharma_cabinet directly,
 * never reads Object Storage, and never calls Plane — those checks live in
 * Edge and must not be bypassed just because the cluster is shared.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const EDGE_BASE = process.env.EDGE_API_BASE ?? '';
const EDGE_KEY = process.env.EDGE_API_KEY ?? '';

export class EdgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface CallContext {
  accountId?: string;
  subject?: string;
  actor?: string;
  authorization?: string;
}

async function edge<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  ctx: CallContext = {},
): Promise<T> {
  if (!EDGE_BASE || !EDGE_KEY) {
    throw new EdgeError(503, 'not_configured', 'EDGE_API_BASE and EDGE_API_KEY must be set');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': EDGE_KEY,
    'X-Pharma-Contour': 'cn',
  };
  if (ctx.accountId) headers['X-Pharma-Account'] = ctx.accountId;
  if (ctx.subject) headers['X-Pharma-Subject'] = ctx.subject;
  if (ctx.actor) headers['X-Pharma-Actor'] = ctx.actor;
  // /organizations and the rest of the cabinet routes require Keycloak at the
  // gateway. The service key alone never reaches the function. Replay the
  // caller's Bearer so the authorizer accepts the tool call.
  if (ctx.authorization) headers.Authorization = ctx.authorization;

  const response = await fetch(`${EDGE_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  let parsed: { error?: string; message?: string; data?: T } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: 'edge_error', message: text.slice(0, 300) };
  }
  if (!response.ok) {
    throw new EdgeError(response.status, parsed.error ?? 'edge_error', parsed.message ?? text);
  }
  return parsed.data as T;
}

/** Pulls the caller out of the runtime context Mastra passes to every tool. */
function callerOf(context: unknown): CallContext {
  const runtime = (context as { runtimeContext?: Map<string, unknown> })?.runtimeContext;
  if (!runtime) return {};
  return {
    accountId: runtime.get('accountId') as string | undefined,
    subject: runtime.get('subject') as string | undefined,
    actor: runtime.get('displayName') as string | undefined,
    authorization: runtime.get('authorization') as string | undefined,
  };
}

const L10n = z.object({ ru: z.string(), en: z.string().optional(), zh: z.string().optional() });

// ------------------------------------------------------------------ company --

export const getCompany = createTool({
  id: 'get-company',
  description:
    'Read a company: draft fields with their sources, approved profile, checklist slots and completeness by section.',
  inputSchema: z.object({ organizationId: z.string() }),
  execute: async ({ organizationId }, context) =>
    edge(`/organizations/${organizationId}`, {}, callerOf(context)),
});

export const listCompanies = createTool({
  id: 'list-companies',
  description: 'List the companies of the current account.',
  inputSchema: z.object({}),
  execute: async (_input, context) => edge('/organizations', {}, callerOf(context)),
});

export const createCompany = createTool({
  id: 'create-company',
  description: 'Open an empty company card at the start of the registration dialog.',
  inputSchema: z.object({ name: z.string().optional() }),
  execute: async ({ name }, context) =>
    edge('/organizations', { method: 'POST', body: { name } }, callerOf(context)),
});

export const requestUpload = createTool({
  id: 'request-upload',
  description:
    'Ask for a presigned PUT so the browser can upload a document itself. Pass productId only when the file belongs to one product rather than the company.',
  inputSchema: z.object({
    organizationId: z.string(),
    itemType: z.string(),
    fileName: z.string(),
    contentType: z.string().optional(),
    productId: z.string().optional(),
  }),
  execute: async (input, context) =>
    edge(
      `/organizations/${input.organizationId}/items/upload-url`,
      { method: 'POST', body: input },
      callerOf(context),
    ),
});

export const listDocuments = createTool({
  id: 'list-documents',
  description:
    'Documents of a company and its products, with extraction results. Use it before asking for a file: a company document is never uploaded twice.',
  inputSchema: z.object({ organizationId: z.string() }),
  execute: async ({ organizationId }, context) =>
    edge(`/organizations/${organizationId}/items`, {}, callerOf(context)),
});

export const promoteToCompanyProfile = createTool({
  id: 'promote-to-company-profile',
  description:
    'Raise a document first seen in a product dialog to the company profile so every product of that company inherits it.',
  inputSchema: z.object({ organizationId: z.string(), itemId: z.string() }),
  execute: async ({ organizationId, itemId }, context) =>
    edge(
      `/organizations/${organizationId}/items/${itemId}/promote`,
      { method: 'POST' },
      callerOf(context),
    ),
});

export const patchCompanyDraft = createTool({
  id: 'patch-company-draft',
  description:
    'Correct a recognised field the user disagreed with. Keep the source so the card stays checkable.',
  inputSchema: z.object({
    organizationId: z.string(),
    draft: z.record(
      z.object({
        value: z.string(),
        source: z.string().optional(),
        confidence: z.number().nullable().optional(),
      }),
    ),
  }),
  execute: async ({ organizationId, draft }, context) =>
    edge(`/organizations/${organizationId}`, { method: 'PATCH', body: { draft } }, callerOf(context)),
});

export const approveCompanyProfile = createTool({
  id: 'approve-company-profile',
  description:
    'Record that the user approved the company card. Requires human confirmation and must never be called on the user behalf.',
  inputSchema: z.object({ organizationId: z.string() }),
  execute: async ({ organizationId }, context) =>
    edge(
      `/organizations/${organizationId}`,
      { method: 'PATCH', body: { status: 'profile_approved' } },
      callerOf(context),
    ),
});

export const getRiskReport = createTool({
  id: 'get-risk-report',
  description:
    'Risk level and the neutral reasoning for a company. Raw Chinese sources are never returned and must not be requested.',
  inputSchema: z.object({ organizationId: z.string() }),
  execute: async ({ organizationId }, context) =>
    edge(`/organizations/${organizationId}/risk`, {}, callerOf(context)),
});

// ------------------------------------------------------------------ product --

export const createProduct = createTool({
  id: 'create-product',
  description: 'Open a product card. Only possible once the company profile is approved.',
  inputSchema: z.object({
    organizationId: z.string(),
    name: z.string().optional(),
    kind: z.enum(['device', 'drug']).optional(),
  }),
  execute: async ({ organizationId, ...body }, context) =>
    edge(`/organizations/${organizationId}/products`, { method: 'POST', body }, callerOf(context)),
});

export const getProduct = createTool({
  id: 'get-product',
  description:
    'Read a product with its inherited documents, missing fields, completeness and classification options.',
  inputSchema: z.object({ productId: z.string() }),
  execute: async ({ productId }, context) => edge(`/products/${productId}`, {}, callerOf(context)),
});

export const patchProductDraft = createTool({
  id: 'patch-product-draft',
  description:
    'Write recognised or user-supplied product facts. A one-line answer is as valid as a file.',
  inputSchema: z.object({
    productId: z.string(),
    draft: z.record(
      z.object({
        value: z.string(),
        source: z.string().optional(),
        confidence: z.number().nullable().optional(),
      }),
    ),
    name: z.string().optional(),
    kind: z.enum(['device', 'drug']).optional(),
  }),
  execute: async ({ productId, ...body }, context) =>
    edge(`/products/${productId}`, { method: 'PATCH', body }, callerOf(context)),
});

export const approveProductData = createTool({
  id: 'approve-product-data',
  description: 'Record that the user approved the product card. Requires human confirmation.',
  inputSchema: z.object({ productId: z.string() }),
  execute: async ({ productId }, context) =>
    edge(`/products/${productId}`, { method: 'PATCH', body: { status: 'data_approved' } }, callerOf(context)),
});

export const proposeVariants = createTool({
  id: 'propose-variants',
  description:
    'Write classification options. Only allowed at full completeness. Include a forbidden option with a reason whenever a tempting wrong class exists — it is shown as a warning and cannot be selected.',
  inputSchema: z.object({
    productId: z.string(),
    model: z.string().optional(),
    promptVersion: z.string().optional(),
    variants: z
      .array(
        z.object({
          variantType: z.enum(['recommended', 'alternative', 'forbidden']),
          kind: z.enum(['device', 'drug']),
          track: z.enum(['pp1684', 'eaeu46', 'eaeu78']),
          riskClass: z.enum(['1', '2a', '2b', '3']),
          title: L10n,
          summary: L10n,
          pros: z.array(L10n).optional(),
          cons: z.array(L10n).optional(),
          reason: L10n.optional(),
          budget: z
            .object({
              currency: z.literal('RMB'),
              baskets: z.array(z.object({ key: z.string(), amount: z.number() })),
            })
            .optional(),
          cycleMonths: z.tuple([z.number(), z.number()]).optional(),
        }),
      )
      .min(1),
  }),
  execute: async ({ productId, ...body }, context) =>
    edge(`/products/${productId}/variants`, { method: 'POST', body }, callerOf(context)),
});

export const approveClassification = createTool({
  id: 'approve-classification',
  description:
    'Record an approval of the classification. The specialist confirms first and the client second; the case and its node map appear only after both.',
  inputSchema: z.object({
    productId: z.string(),
    as: z.enum(['specialist', 'client']),
    variantId: z.string().optional(),
    checkedAgainst: z.string().optional(),
  }),
  execute: async ({ productId, ...body }, context) =>
    edge(`/products/${productId}/approve`, { method: 'POST', body }, callerOf(context)),
});

// -------------------------------------------------------------------- case ---

export const getCase = createTool({
  id: 'get-case',
  description: 'Case card with the M0-M12 node map and the single critical next action.',
  inputSchema: z.object({ caseId: z.string() }),
  execute: async ({ caseId }, context) => edge(`/cases/${caseId}`, {}, callerOf(context)),
});

// ----------------------------------------------------------------- journal ---

export const appendChatMessage = createTool({
  id: 'append-chat-message',
  description:
    'Write a turn into the case journal. This is the record the client receives with the case, separate from the working memory of the thread.',
  inputSchema: z.object({
    sessionId: z.string(),
    role: z.enum(['user', 'agent', 'system']),
    text: z.string(),
    itemId: z.string().optional(),
    payload: z.unknown().optional(),
  }),
  execute: async ({ sessionId, ...body }, context) =>
    edge(`/intake/sessions/${sessionId}/messages`, { method: 'POST', body }, callerOf(context)),
});

export const edgeTools = {
  listCompanies,
  createCompany,
  getCompany,
  patchCompanyDraft,
  approveCompanyProfile,
  requestUpload,
  listDocuments,
  promoteToCompanyProfile,
  getRiskReport,
  createProduct,
  getProduct,
  patchProductDraft,
  approveProductData,
  proposeVariants,
  approveClassification,
  getCase,
  appendChatMessage,
};
