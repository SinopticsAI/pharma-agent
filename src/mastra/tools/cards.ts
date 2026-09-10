/**
 * Cards the cabinet renders instead of prose.
 *
 * These tools produce no side effects: calling one is how the agent says
 * "show this". The cabinet draws a read-only component. The user answers,
 * approves and attaches files only in the composer — never on the card.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { boolish, jsonish } from './jsonish';

const L10n = jsonish(z.object({ ru: z.string(), en: z.string().optional(), zh: z.string().optional() }));

export const askDocument = createTool({
  id: 'ask-document',
  description:
    'Ask for one specific thing. The card shows the question only: the user replies in the composer or attaches a file with the paperclip — never a form on the card, never a questionnaire.',
  inputSchema: z.object({
    itemType: z.string().describe('business-license, instruction-cn, tech-spec, and so on'),
    question: L10n,
    acceptsText: boolish().default(false).describe('true when one line of text closes the gap'),
    why: L10n.optional().describe('what breaks without it, in the user language'),
  }),
  outputSchema: z.object({ shown: z.literal(true) }),
  execute: async () => ({ shown: true as const }),
});

export const showDraft = createTool({
  id: 'show-draft',
  description:
    'Show the recognised card for review. Every field carries the document it came from; a field without a source cannot be checked and must not be shown as fact. The user approves or corrects it in the composer, not on the card.',
  inputSchema: z.object({
    scope: z.enum(['company', 'product']),
    entityId: z.string(),
    fields: jsonish(
      z.array(
        z.object({
          key: z.string(),
          label: L10n,
          value: z.string(),
          source: z.string(),
          confidence: z.number().nullable().optional(),
        }),
      ),
    ),
    missing: jsonish(z.array(z.string())).default([]),
    canApprove: boolish(),
  }),
  outputSchema: z.object({ shown: z.literal(true) }),
  execute: async () => ({ shown: true as const }),
});

export const showVariants = createTool({
  id: 'show-variants',
  description:
    'Show classification options side by side with budget baskets in RMB. Always carry the planning-frame disclaimer, and include the forbidden option when the fork exists. The user names the chosen option in the composer.',
  inputSchema: z.object({
    productId: z.string(),
    variants: jsonish(
      z.array(
        z.object({
          id: z.string(),
          variantType: z.enum(['recommended', 'alternative', 'forbidden']),
          title: L10n,
          summary: L10n,
          pros: jsonish(z.array(L10n)).default([]),
          cons: jsonish(z.array(L10n)).default([]),
          reason: L10n.optional(),
          budget: jsonish(
            z.object({
              currency: z.literal('RMB'),
              baskets: z.array(z.object({ key: z.string(), amount: z.number() })),
            }),
          ).optional(),
          cycleMonths: z.tuple([z.number(), z.number()]).optional(),
        }),
      ),
    ),
  }),
  outputSchema: z.object({ shown: z.literal(true) }),
  execute: async () => ({ shown: true as const }),
});

export const showRiskReport = createTool({
  id: 'show-risk-report',
  description:
    'Show the company risk level with its reasoning in plain words. A traffic light without an explanation is not acceptable, and raw sources are never shown.',
  inputSchema: z.object({
    organizationId: z.string(),
    level: z.enum(['low', 'medium', 'high', 'unknown']),
    verdict: z.enum(['pending', 'accepted', 'rejected']),
    reasoning: L10n,
    checks: jsonish(
      z.array(z.object({ name: z.string(), result: z.string(), detail: z.string().optional() })),
    ).default([]),
  }),
  outputSchema: z.object({ shown: z.literal(true) }),
  execute: async () => ({ shown: true as const }),
});

export const showNodeMap = createTool({
  id: 'show-node-map',
  description:
    'Show the M0-M12 map of the case. Nodes after filing stay visible with status later so the horizon is a year, not a dossier.',
  inputSchema: z.object({
    caseId: z.string(),
    nodes: jsonish(
      z.array(
        z.object({
          code: z.string(),
          title: L10n,
          status: z.enum(['done', 'in_progress', 'planned', 'later', 'goal']),
          owner: z.enum(['you', 'us', 'contractor', 'gov']),
          dueHint: L10n.optional(),
          critical: boolish().default(false),
        }),
      ),
    ),
  }),
  outputSchema: z.object({ shown: z.literal(true) }),
  execute: async () => ({ shown: true as const }),
});

export const offerProductWindow = createTool({
  id: 'offer-product-window',
  description:
    'Show a hint that a product can be entered in another cabinet window. Use it after the company card is approved. This chat does not collect the product and does not open that window.',
  inputSchema: z.object({
    organizationId: z.string().optional(),
  }),
  outputSchema: z.object({ shown: z.literal(true) }),
  execute: async () => ({ shown: true as const }),
});

export const escalateToCounsel = createTool({
  id: 'escalate-to-counsel',
  description:
    'Stop and hand a borderline qualification to a lawyer. Use it whenever the mode of action could make the product a medicine rather than a device, or the class is genuinely contested.',
  inputSchema: z.object({
    productId: z.string(),
    reason: L10n,
  }),
  outputSchema: z.object({ escalated: z.literal(true) }),
  execute: async () => ({ escalated: true as const }),
});

export const cardTools = {
  askDocument,
  showDraft,
  showVariants,
  showRiskReport,
  showNodeMap,
  offerProductWindow,
  escalateToCounsel,
};
