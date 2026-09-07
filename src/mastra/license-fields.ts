/**
 * Deterministic recovery of 营业执照 fields the model left null or under 名称.
 * Same rules as pharma-plane license_fields.py so Edge merge_org_draft still
 * sees company_name / unified_social_credit_code.
 */

const USCC_RE = /(?<![0-9A-Za-z])([0-9A-Z]{18})(?![0-9A-Za-z])/;
const NAME_RE =
  /(?:名称|企业名称|公司名称|单位名称)\s*[:：]?\s*([^\n]{2,80}?(?:有限公司|公司|集团|厂|中心))/;
const COMPANY_LINE_RE =
  /(?:^|\n)\s*([\u4e00-\u9fffA-Za-z0-9·（）()]{2,40}(?:有限责任公司|股份有限公司|有限公司))/;
const NAME_NOISE_RE = /法定代表人|经营范围|统一社会|注册资本|成立日期|住所|营业期限/;

const COMPANY_NAME_KEYS = ['company_name', '名称', '企业名称', '公司名称', '单位名称'] as const;
const USCC_KEYS = [
  'unified_social_credit_code',
  'uscc',
  'registration_number',
  '统一社会信用代码',
  '社会信用代码',
  '注册号',
] as const;

/** Envelope keys from the vision JSON — not document fields. */
export const VISION_META_KEYS = new Set(['itemType', 'item_type', 'extracted', 'unreadable', 'reason']);

export type ExtractedFields = Record<string, string | null>;

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    for (const key of ['value', 'zh', 'en', 'ru', 'name'] as const) {
      const text = asText(rec[key]);
      if (text) return text;
    }
    return '';
  }
  return String(value).trim();
}

function filled(extracted: ExtractedFields, keys: readonly string[]): string {
  const lowered = new Map<string, string | null>();
  for (const [key, value] of Object.entries(extracted)) {
    lowered.set(key.trim().toLowerCase(), value);
  }
  for (const key of keys) {
    const text = asText(lowered.get(key.toLowerCase()) ?? extracted[key]);
    if (text && text.toLowerCase() !== 'null' && text.toLowerCase() !== 'none') return text;
  }
  return '';
}

function fieldValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = asText(value);
  return text || null;
}

/** Merge `extracted` with root-level fields the model put beside the envelope. */
export function collectExtracted(parsed: Record<string, unknown>): ExtractedFields {
  const out: ExtractedFields = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (VISION_META_KEYS.has(key)) continue;
    out[key] = fieldValue(value);
  }
  const nested = parsed.extracted;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      out[key] = fieldValue(value);
    }
  }
  return out;
}

/** All string values, so a dumped OCR blob can still feed the 名称 / USCC regex. */
export function extractedAsOcrText(extracted: ExtractedFields): string {
  return Object.entries(extracted)
    .map(([key, value]) => (value ? `${key} ${value}` : ''))
    .filter(Boolean)
    .join('\n');
}

export function recoverLicenseFields(ocrText: string, extracted: unknown): ExtractedFields {
  const out: ExtractedFields =
    extracted && typeof extracted === 'object' && !Array.isArray(extracted)
      ? { ...(extracted as ExtractedFields) }
      : {};

  let name = filled(out, COMPANY_NAME_KEYS);
  if (!name) {
    const match = NAME_RE.exec(ocrText || '');
    if (match?.[1]) name = match[1].replace(/[ 、,;；]+$/g, '').replace(/^[ 、,;；]+/g, '');
  }
  if (!name) {
    const match = COMPANY_LINE_RE.exec(ocrText || '');
    const candidate = (match?.[1] ?? '').trim();
    if (candidate && !NAME_NOISE_RE.test(candidate)) name = candidate;
  }
  if (name) out.company_name = name;

  let code = filled(out, USCC_KEYS);
  if (!code) {
    const match = USCC_RE.exec(ocrText || '');
    if (match?.[1]) code = match[1];
  }
  if (code) out.unified_social_credit_code = code;

  return out;
}

function isFilledValue(value: string | null | undefined): boolean {
  const text = asText(value);
  return Boolean(text && text.toLowerCase() !== 'null' && text.toLowerCase() !== 'none');
}

export function hasLicenseIdentity(extracted: ExtractedFields): boolean {
  return isFilledValue(extracted.company_name) || isFilledValue(extracted.unified_social_credit_code);
}

/** After recover: reject only when nothing usable landed. */
export function hasExtractedValue(extracted: ExtractedFields): boolean {
  return Object.values(extracted).some((value) => isFilledValue(value));
}

/** Collect root + extracted, recover English keys, decide unreadable. */
export function normalizeVisionFields(parsed: Record<string, unknown>): {
  extracted: ExtractedFields;
  unreadable: boolean;
} {
  const collected = collectExtracted(parsed);
  const extracted = recoverLicenseFields(extractedAsOcrText(collected), collected);
  return { extracted, unreadable: !hasExtractedValue(extracted) };
}
