/**
 * Input shape for propose-variants. Kept out of edge.ts so tests can load it
 * under Node's strip-only TypeScript mode.
 */

import { z } from 'zod';

import { jsonish, numish } from './jsonish';

const L10n = jsonish(
  z
    .object({
      ru: z.string().optional(),
      en: z.string().optional(),
      zh: z.string().optional(),
    })
    .transform((value) => {
      const ru = (value.ru || value.zh || value.en || '').trim();
      return { ru, en: value.en, zh: value.zh };
    })
    .pipe(z.object({ ru: z.string().min(1), en: z.string().optional(), zh: z.string().optional() })),
);

const CycleMonths = jsonish(z.tuple([numish(), numish()]));

export const proposeVariantsBodySchema = z.object({
  productId: z.string().optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  variants: jsonish(
    z
      .array(
        z.object({
          variantType: z.enum(['recommended', 'alternative', 'forbidden']),
          kind: z.enum(['device', 'drug']),
          track: z.enum(['pp1684', 'eaeu46', 'eaeu78']),
          riskClass: z.enum(['1', '2a', '2b', '3']),
          title: L10n,
          summary: L10n,
          pros: jsonish(z.array(L10n)).optional(),
          cons: jsonish(z.array(L10n)).optional(),
          reason: L10n.optional(),
          budget: jsonish(
            z.object({
              currency: z.literal('RMB'),
              baskets: jsonish(z.array(z.object({ key: z.string(), amount: numish() }))),
            }),
          ).optional(),
          cycleMonths: CycleMonths.optional(),
        }),
      )
      .min(2),
  ),
});
