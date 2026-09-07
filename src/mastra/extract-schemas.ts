/**
 * Field hints for intake OCR. Same English snake_case keys Plane uses so
 * Edge merge_org_draft / merge_product_draft keep working.
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
    'Chinese business licence 营业执照. JSON keys MUST be English snake_case. Extract: company_name from 名称 (legal entity name as printed, keep Chinese; never 法定代表人), company_name_en if present, unified_social_credit_code (统一社会信用代码 / 注册号, 18 characters), legal_representative (法定代表人), registered_capital, establishment_date, registered_address, business_scope. If 名称 is readable, company_name must not be null.',
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
