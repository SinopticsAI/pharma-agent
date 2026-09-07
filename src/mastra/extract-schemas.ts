/**
 * What we ask the vision model for, and the body we ask it in. Same English
 * snake_case keys Plane uses so Edge merge_org_draft / merge_product_draft keep
 * working.
 *
 * This module imports nothing on purpose: the test loads it directly, and the
 * request body is worth reading without a network call.
 */

export const ITEM_TYPES = [
  'business-license',
  'company-registry',
  'iso-13485',
  'poa-upp',
  'site-docs',
  'gmp-cn',
  'trademark',
  'nmpa-certificate',
  'instruction-cn',
  'instruction-ru',
  'tech-spec',
  'lab-protocol',
  'regulator-letter',
  'other',
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export const SCHEMA_HINTS: Record<ItemType, string> = {
  'business-license':
    'Chinese business licence 营业执照. JSON keys MUST be English snake_case. Extract: company_name from 名称 (legal entity name as printed, keep Chinese; never 法定代表人; the name is often on the next line under 名称), company_name_en if present, unified_social_credit_code (统一社会信用代码 / 注册号, 18 characters), legal_representative (法定代表人), registered_capital, establishment_date, registered_address, business_scope. If 名称 is readable, company_name must not be null. A code without a name is incomplete, not unreadable.',
  'company-registry':
    'Extract: company_name, unified_social_credit_code, status, checked_on, source.',
  'iso-13485':
    'Extract: certification_body, certificate_number, sites, scope, valid_until.',
  'poa-upp':
    'Extract: principal, attorney, valid_until, apostille, powers.',
  'site-docs':
    'Extract: site_address, ownership, valid_until, issuing_authority, activities.',
  'gmp-cn':
    'Extract: certificate_number, issuing_authority, site_address, valid_until, scope.',
  trademark: 'Extract: trademark, registration_number, classes, holder, valid_until.',
  'nmpa-certificate':
    'Extract: certificate_number, valid_until, manufacturer, model, issuing_authority, issue_date.',
  'instruction-cn':
    'Extract: indications, models, contraindications, composition, language=zh.',
  'instruction-ru':
    'Extract: indications, models, contraindications, composition, language=ru.',
  'tech-spec': 'Extract: voltages, software, accessories, intended_use, models.',
  'lab-protocol': 'Extract: laboratory, test_kind, date, sample_id, result_summary.',
  'regulator-letter':
    'Extract: authority, request_type, due_date, missing_files, letter_date.',
  other:
    'If this is a Chinese business licence 营业执照, treat it as business-license and extract those fields. Otherwise extract the key regulatory fields present.',
};

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/jpg']);

export function imageKind(fileName: string, contentType = ''): { ok: true; mime: string } | { ok: false } {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (IMAGE_MIME.has(mime)) {
    return { ok: true, mime: mime === 'image/jpg' ? 'image/jpeg' : mime };
  }
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT.has(ext)) {
    return { ok: true, mime: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
  }
  return { ok: false };
}

export function isItemType(value: string): value is ItemType {
  return (ITEM_TYPES as readonly string[]).includes(value);
}

export function schemaHint(itemType: string): string {
  const key = itemType.trim().toLowerCase();
  if (isItemType(key)) return SCHEMA_HINTS[key];
  return SCHEMA_HINTS.other;
}

/** A read licence is around 600 characters; the rest is headroom. */
const MAX_TOKENS = 4096;

export function visionPrompt(hintedType: string): string {
  return [
    'You read one scan of a Chinese manufacturer document for MedMost intake.',
    'Return a single JSON object, no markdown.',
    'Keys: itemType, extracted, unreadable, reason.',
    `itemType must be one of: ${ITEM_TYPES.join(', ')}.`,
    `The uploader labelled this file as "${hintedType}". If it is a 营业执照, itemType is business-license even when the label is other.`,
    schemaHint(hintedType),
    'extracted: object of English snake_case keys to string values or null. Do not invent a name or a registration number.',
    'unreadable: true only when nothing usable can be read. A unified social credit code without 名称 is incomplete, not unreadable.',
    'reason: short English note when unreadable or when itemType is other.',
  ].join('\n');
}

/**
 * Thinking must be off. Studio's OpenAI-compatible contour answers 400
 * «Unsupported parameter(s)» to every DashScope/vLLM switch — reasoning_options,
 * enable_thinking, chat_template_kwargs, extra_body — and ignores /no_think in
 * the prompt. Left on, qwen3.6 spends the whole budget on reasoning_content and
 * returns an empty content, which reaches us as «model did not return JSON».
 * reasoning_effort is the only switch this endpoint honours.
 */
export function visionRequestBody(input: {
  model: string;
  mime: string;
  bytes: Uint8Array;
  hintedType: string;
}): Record<string, unknown> {
  const dataUri = `data:${input.mime};base64,${Buffer.from(input.bytes).toString('base64')}`;
  return {
    model: input.model,
    temperature: 0,
    max_tokens: MAX_TOKENS,
    reasoning_effort: 'none',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: visionPrompt(input.hintedType) },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
  };
}
