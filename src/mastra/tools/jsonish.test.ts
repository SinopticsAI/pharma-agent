import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { boolish, jsonish, numish } from './jsonish.ts';

const DraftField = z.object({
  key: z.string(),
  label: z.object({ ru: z.string(), en: z.string().optional(), zh: z.string().optional() }),
  value: z.string(),
  source: z.string(),
});

const Fields = jsonish(z.array(DraftField));
const CanApprove = boolish();
const Draft = jsonish(
  z.record(z.object({ value: z.string(), source: z.string().optional() })),
);

/** The truncated payload from the 16:23 show-draft rejection on prd-xyx3495c. */
const FIELDS_FROM_LOG =
  '[{"key": "name", "label": {"ru": "Название"}, "source": "02-ifu-en-safe-accu.pdf", "value": "Safe-Accu Blood Glucose Meter"}]';

const DRAFT_FROM_LOG =
  '{"name": {"source": "02-ifu-en-safe-accu.pdf", "value": "Safe-Accu Blood Glucose Meter"}, "intendedUse": {"source": "02-ifu-en-safe-accu.pdf", "value": "in vitro diagnostic use only"}}';

describe('jsonish', () => {
  it('parses a fields array that arrived as a JSON string', () => {
    const fields = Fields.parse(FIELDS_FROM_LOG);
    assert.equal(fields.length, 1);
    assert.equal(fields[0]?.key, 'name');
    assert.equal(fields[0]?.value, 'Safe-Accu Blood Glucose Meter');
    assert.equal(fields[0]?.source, '02-ifu-en-safe-accu.pdf');
  });

  it('parses a draft object that arrived as a JSON string', () => {
    const draft = Draft.parse(DRAFT_FROM_LOG);
    assert.equal(draft.name?.value, 'Safe-Accu Blood Glucose Meter');
    assert.equal(draft.intendedUse?.source, '02-ifu-en-safe-accu.pdf');
  });

  it('leaves an already-parsed array alone', () => {
    const fields = Fields.parse([{ key: 'name', label: { ru: 'Название' }, value: 'X', source: 'ifu.pdf' }]);
    assert.equal(fields[0]?.key, 'name');
  });

  it('keeps a garbage string as a Zod error, not an empty list', () => {
    assert.throws(() => Fields.parse('not-json'), /invalid/i);
  });
});

describe('boolish', () => {
  it('reads the capitalised False Qwen sent on the first show-draft', () => {
    assert.equal(CanApprove.parse('False'), false);
    assert.equal(CanApprove.parse('false'), false);
    assert.equal(CanApprove.parse('true'), true);
  });

  it('leaves an already-parsed boolean alone', () => {
    assert.equal(CanApprove.parse(false), false);
    assert.equal(CanApprove.parse(true), true);
  });

  it('keeps a garbage string as a Zod error', () => {
    assert.throws(() => CanApprove.parse('yes'), /boolean/i);
  });
});

describe('showDraft-shaped input', () => {
  const ShowDraft = z.object({
    scope: z.enum(['company', 'product']),
    entityId: z.string(),
    fields: Fields,
    canApprove: CanApprove,
  });

  it('accepts the stringified arguments from the product-intake log', () => {
    const parsed = ShowDraft.parse({
      scope: 'product',
      entityId: 'prd-xyx3495c',
      fields: FIELDS_FROM_LOG,
      canApprove: 'False',
    });
    assert.equal(Array.isArray(parsed.fields), true);
    assert.equal(parsed.fields[0]?.key, 'name');
    assert.equal(parsed.canApprove, false);
  });
});

describe('patchProductDraft-shaped input', () => {
  const PatchDraft = z.object({ productId: z.string().optional(), draft: Draft });

  it('accepts a draft that arrived as a JSON string', () => {
    const parsed = PatchDraft.parse({
      productId: 'prd-xyx3495c',
      draft: DRAFT_FROM_LOG,
    });
    assert.equal(parsed.draft.name?.value, 'Safe-Accu Blood Glucose Meter');
  });
});

describe('numish', () => {
  it('reads a number that arrived as a string', () => {
    assert.equal(numish().parse('12'), 12);
    assert.equal(numish().parse(16), 16);
  });
});

describe('propose-variants-shaped input', () => {
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
  const Propose = z.object({
    productId: z.string().optional(),
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
            reason: L10n.optional(),
            budget: jsonish(
              z.object({
                currency: z.literal('RMB'),
                baskets: jsonish(z.array(z.object({ key: z.string(), amount: numish() }))),
              }),
            ).optional(),
            cycleMonths: jsonish(z.tuple([numish(), numish()])).optional(),
          }),
        )
        .min(2),
    ),
  });
  const variantsFromQwen = JSON.stringify([
    {
      variantType: 'recommended',
      kind: 'device',
      track: 'pp1684',
      riskClass: '2b',
      title: { zh: '国家路径 1684' },
      summary: { zh: '技术检测与临床评价' },
      budget: { currency: 'RMB', baskets: [{ key: 'handling', amount: '12800' }] },
      cycleMonths: '[12, 16]',
    },
    {
      variantType: 'alternative',
      kind: 'device',
      track: 'eaeu46',
      riskClass: '2b',
      title: { zh: '联盟路径 46' },
      summary: { zh: '一张证覆盖联盟' },
      cycleMonths: [14, 20],
    },
    {
      variantType: 'forbidden',
      kind: 'device',
      track: 'pp1684',
      riskClass: '2a',
      title: { zh: '申报 2а' },
      summary: { zh: '低报类别' },
      reason: { zh: '我们不会申报此项。' },
    },
  ]);

  it('accepts stringified variants, zh-only l10n and string cycleMonths', () => {
    const parsed = Propose.parse({
      productId: 'prd-96obrzsz',
      variants: variantsFromQwen,
    });
    assert.equal(parsed.variants.length, 3);
    assert.equal(parsed.variants[0]?.title.ru, '国家路径 1684');
    assert.deepEqual(parsed.variants[0]?.cycleMonths, [12, 16]);
    assert.equal(parsed.variants[0]?.budget?.baskets[0]?.amount, 12800);
    assert.equal(parsed.variants[2]?.variantType, 'forbidden');
  });

  it('rejects a single option', () => {
    assert.throws(
      () =>
        Propose.parse({
          variants: [
            {
              variantType: 'recommended',
              kind: 'device',
              track: 'pp1684',
              riskClass: '2b',
              title: { ru: 'Национальный трек' },
              summary: { ru: 'Испытания' },
            },
          ],
        }),
      /array|min|2/i,
    );
  });
});
