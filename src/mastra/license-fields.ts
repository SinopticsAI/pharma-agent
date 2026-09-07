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

const ESTABLISHMENT_DATE_KEYS = ['establishment_date', 'established_on', 'registration_date', '成立日期'];

/** 2025年11月19日, and the same date written with dots, slashes or dashes. */
const DATE_RE = /(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/;

/** 18 characters of a 31-letter alphabet with a check digit: GB 32100-2015. */
const USCC_ALPHABET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

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

/**
 * Whether a registration number contradicts its own check digit.
 *
 * Two scans of one licence gave two different codes and only this arithmetic
 * told them apart. A wrong registration number is worse than an empty field
 * here, because nothing downstream questions a number once it is on the card.
 */
export function usccLooksWrong(code: string): boolean {
  const value = asText(code).toUpperCase();
  // An old 15-digit 注册号 is not a USCC and must pass untouched.
  if (value.length !== 18) return false;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    const position = USCC_ALPHABET.indexOf(value[index] ?? '');
    // Letters the standard leaves out — I, O, S, V, Z — mean a misread, not a code.
    if (position < 0) return true;
    sum += position * (USCC_WEIGHTS[index] ?? 0);
  }
  const remainder = 31 - (sum % 31);
  return USCC_ALPHABET[remainder === 31 ? 0 : remainder] !== value[17];
}

/** 2025年11月19日 → 2025-11-19. Empty when there is no date to be sure of. */
export function toIsoDate(text: string): string {
  const match = DATE_RE.exec(asText(text));
  if (!match) return '';
  const iso = `${match[1]}-${(match[2] ?? '').padStart(2, '0')}-${(match[3] ?? '').padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  // A rolled-over date (2025-02-30 becomes March) is a misread, so keep the original.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return '';
  return iso;
}

/**
 * The registration date goes into a Russian dossier, so it travels as ISO.
 * The capital stays as printed: `壹拾伍万人民币元` is what the licence says, and
 * a human checks the card against that paper.
 */
function isoDateInPlace(extracted: ExtractedFields): void {
  for (const [key, value] of Object.entries(extracted)) {
    if (!ESTABLISHMENT_DATE_KEYS.includes(key.trim().toLowerCase())) continue;
    const iso = toIsoDate(value ?? '');
    if (iso) extracted[key] = iso;
  }
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
  // Before the flags below, so a note about the code cannot pass for a read field.
  const unreadable = !hasExtractedValue(extracted);
  isoDateInPlace(extracted);
  const code = filled(extracted, USCC_KEYS);
  // Present only when it fails: the agent and the log need the problem, not the all-clear.
  if (code && usccLooksWrong(code)) extracted.uscc_checksum = 'invalid';
  return { extracted, unreadable };
}
