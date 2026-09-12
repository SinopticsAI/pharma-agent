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
  'signatory',
  'bank-account',
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
    'Chinese business licence 营业执照. JSON keys MUST be English snake_case. Extract: company_name from 名称 only (legal entity name as printed, keep Chinese; never 法定代表人, never the title 营业执照, never 英文名称). The English line 英文名称 is company_name_en, never company_name. unified_social_credit_code (统一社会信用代码 / 注册号, 18 characters), legal_representative (法定代表人), registered_capital, establishment_date, registered_address, business_scope. If 名称 is readable, company_name must not be null. A code without a name is incomplete, not unreadable.',
  'company-registry':
    'Extract: company_name, unified_social_credit_code, status, checked_on, source.',
  'iso-13485':
    'Extract: certification_body, certificate_number, sites, scope, valid_until.',
  'poa-upp':
    'Extract: principal, attorney, valid_until, apostille, powers.',
  signatory:
    'Chinese legal-representative proof 法定代表人身份证明, or a TEST schematic 身份证 of that person. Extract: legal_representative (姓名 / 法定代表人), company_name, unified_social_credit_code, valid_until if present. Never invent a real 身份证 number.',
  'bank-account':
    'Chinese basic deposit account permit 开户许可证. Extract: account_name, account_number, bank_name, permit_no, currency, legal_representative, unified_social_credit_code, company_name.',
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
    'Decide itemType from the scan, never from the file name. 营业执照 → business-license: company_name from 名称 (Chinese), company_name_en from 英文名称, unified_social_credit_code, legal_representative, registered_address, registered_capital, business_scope, establishment_date. ISO 13485 / 医疗器械质量管理体系 → iso-13485: certification_body, certificate_number, sites, scope, valid_until. 授权委托书 appointing an authorized representative → poa-upp. 法定代表人身份证明 or 身份证 of that person → signatory. 开户许可证 or RMB bank details → bank-account. 生产许可证 / manufacturing site papers → site-docs. GSXT / 国家企业信用信息公示 / 企业信用 → company-registry. Otherwise extract the key regulatory fields and keep itemType=other.',
};

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/jpg']);
const PDF_MIME = 'application/pdf';

/**
 * What intake will read. A PDF passes, but it never reaches the model as
 * bytes: Studio answers 400 to `data:application/pdf` in image_url and to the
 * `file` / `input_file` parts, so a PDF is turned into text or into rendered
 * pages first. Office files and TIFF still stop here.
 */
export function scanKind(
  fileName: string,
  contentType = '',
): { ok: true; mime: string; pdf: boolean } | { ok: false } {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (IMAGE_MIME.has(mime)) {
    return { ok: true, mime: mime === 'image/jpg' ? 'image/jpeg' : mime, pdf: false };
  }
  if (mime === PDF_MIME) return { ok: true, mime: PDF_MIME, pdf: true };
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT.has(ext)) {
    return {
      ok: true,
      mime: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
      pdf: false,
    };
  }
  if (ext === 'pdf') return { ok: true, mime: PDF_MIME, pdf: true };
  return { ok: false };
}

export function isItemType(value: string): value is ItemType {
  return (ITEM_TYPES as readonly string[]).includes(value);
}

function unwrapItemType(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    for (const key of ['value', 'zh', 'en', 'ru'] as const) {
      if (typeof rec[key] === 'string' && rec[key].trim()) return rec[key];
    }
  }
  return '';
}

/** Edge allowlist. A draft field name (expectedUse) or an l10n object becomes other. */
export function itemTypeOf(value: unknown): ItemType {
  const key = unwrapItemType(value).trim().toLowerCase();
  return isItemType(key) ? key : 'other';
}

export function schemaHint(itemType: string): string {
  const key = itemType.trim().toLowerCase();
  if (isItemType(key)) return SCHEMA_HINTS[key];
  return SCHEMA_HINTS.other;
}

/** A read licence is around 600 characters; the rest is headroom. */
const MAX_TOKENS = 4096;

export type VisionSource = 'scan' | 'text';

/**
 * What actually reaches Studio. Only these two shapes exist there: a data URI
 * that starts with `data:image/`, and plain text. A photo is one page; a PDF
 * arrives here already turned into its text or into rendered pages.
 */
export type VisionPayload =
  | { kind: 'images'; mime: string; pages: Uint8Array[] }
  | { kind: 'text'; text: string };

export function visionPrompt(hintedType: string, source: VisionSource = 'scan'): string {
  return [
    source === 'text'
      ? 'You read the text of a Chinese manufacturer document for MedMost intake.'
      : 'You read one scan of a Chinese manufacturer document for MedMost intake.',
    'Return a single JSON object, no markdown.',
    'Keys: itemType, extracted, unreadable, reason.',
    `itemType must be one of: ${ITEM_TYPES.join(', ')}.`,
    `The uploader labelled this file as "${hintedType}". Decide itemType from the scan, never from the file name. 营业执照 → business-license even when the label is other. Same for ISO 13485 → iso-13485, 授权委托书 → poa-upp, 法定代表人身份证明 → signatory, 开户许可证 → bank-account, 生产许可 / site papers → site-docs, GSXT / 国家企业信用 → company-registry.`,
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
  hintedType: string;
  payload: VisionPayload;
}): Record<string, unknown> {
  const { payload } = input;
  const prompt = visionPrompt(input.hintedType, payload.kind === 'text' ? 'text' : 'scan');
  const content =
    payload.kind === 'text'
      ? [{ type: 'text', text: `${prompt}\n\nDOCUMENT TEXT:\n${payload.text}` }]
      : [
          { type: 'text', text: prompt },
          ...payload.pages.map((bytes) => ({
            type: 'image_url',
            image_url: { url: `data:${payload.mime};base64,${Buffer.from(bytes).toString('base64')}` },
          })),
        ];
  return {
    model: input.model,
    temperature: 0,
    max_tokens: MAX_TOKENS,
    reasoning_effort: 'none',
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content }],
  };
}
