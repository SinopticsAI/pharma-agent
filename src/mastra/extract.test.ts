import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractFailureReason } from './extract-reason.ts';
import { imageKind, isItemType, schemaHint } from './extract-schemas.ts';
import {
  collectExtracted,
  hasExtractedValue,
  hasLicenseIdentity,
  normalizeVisionFields,
  recoverLicenseFields,
} from './license-fields.ts';

describe('imageKind', () => {
  it('accepts jpeg/png/webp by mime or extension', () => {
    assert.deepEqual(imageKind('scan.JPG', ''), { ok: true, mime: 'image/jpeg' });
    assert.deepEqual(imageKind('scan.bin', 'image/png'), { ok: true, mime: 'image/png' });
    assert.deepEqual(imageKind('scan.webp', 'image/webp'), { ok: true, mime: 'image/webp' });
  });

  it('rejects pdf and office files', () => {
    assert.deepEqual(imageKind('dossier.pdf', 'application/pdf'), { ok: false });
    assert.deepEqual(imageKind('letter.docx', ''), { ok: false });
    assert.deepEqual(imageKind('scan.tiff', ''), { ok: false });
  });
});

describe('extractFailureReason', () => {
  it('keeps a short reason for vision, size and abort', () => {
    assert.equal(
      extractFailureReason({ code: 'too_large', message: 'scan is 9 MB' }),
      'file too large; send a photo under 4 MB',
    );
    assert.match(extractFailureReason({ code: 'vision_failed', message: 'model down' }), /vision_failed/);
    assert.equal(extractFailureReason(new Error('network')), 'network');
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    assert.match(extractFailureReason(aborted), /vision_timeout/);
  });
});

describe('extract schemas', () => {
  it('keeps Plane snake_case keys on a business licence', () => {
    assert.equal(isItemType('business-license'), true);
    assert.match(schemaHint('business-license'), /company_name/);
    assert.match(schemaHint('other'), /营业执照/);
  });
});

describe('recoverLicenseFields', () => {
  it('copies 名称 and 注册号 onto English keys', () => {
    const out = recoverLicenseFields('', {
      名称: '杭州信纳智析科技有限公司',
      注册号: '91330106MAK20KYJ17',
    });
    assert.equal(out.company_name, '杭州信纳智析科技有限公司');
    assert.equal(out.unified_social_credit_code, '91330106MAK20KYJ17');
    assert.equal(hasLicenseIdentity(out), true);
  });

  it('reads 名称 from dumped OCR when the model left company_name null', () => {
    const text = [
      '统一社会信用代码 91330106MAK20KYJ17',
      '名称 杭州信纳智析科技有限公司',
      '法定代表人 潘银洁',
    ].join('\n');
    const out = recoverLicenseFields(text, {
      company_name: null,
      unified_social_credit_code: null,
    });
    assert.equal(out.company_name, '杭州信纳智析科技有限公司');
    assert.equal(out.unified_social_credit_code, '91330106MAK20KYJ17');
  });

  it('reads a company line even when the 名称 label was dropped', () => {
    const out = recoverLicenseFields(
      ['91330106MAK20KYJ17', '杭州信纳智析科技有限公司', '法定代表人 潘银洁'].join('\n'),
      { company_name: null },
    );
    assert.equal(out.company_name, '杭州信纳智析科技有限公司');
  });
});

describe('normalizeVisionFields', () => {
  it('keeps root-level Chinese keys when extracted is missing', () => {
    const vision = normalizeVisionFields({
      itemType: 'business-license',
      unreadable: true,
      名称: '杭州信纳智析科技有限公司',
      注册号: '91330106MAK20KYJ17',
    });
    assert.equal(vision.extracted.company_name, '杭州信纳智析科技有限公司');
    assert.equal(vision.extracted.unified_social_credit_code, '91330106MAK20KYJ17');
    assert.equal(vision.unreadable, false);
  });

  it('parses when only a USCC survived recover', () => {
    const vision = normalizeVisionFields({
      itemType: 'business-license',
      unreadable: true,
      extracted: { unified_social_credit_code: '91330106MAK20KYJ17', company_name: null },
    });
    assert.equal(vision.unreadable, false);
    assert.equal(vision.extracted.unified_social_credit_code, '91330106MAK20KYJ17');
  });

  it('stays unreadable when recover finds nothing', () => {
    const vision = normalizeVisionFields({
      itemType: 'other',
      unreadable: false,
      extracted: { company_name: null, unified_social_credit_code: null },
    });
    assert.equal(vision.unreadable, true);
    assert.equal(hasExtractedValue(vision.extracted), false);
  });

  it('lets nested extracted win over a root-level empty name', () => {
    const collected = collectExtracted({
      itemType: 'business-license',
      unreadable: true,
      名称: '杭州信纳智析科技有限公司',
      extracted: { company_name: '杭州信纳智析科技有限公司', unified_social_credit_code: '91330106MAK20KYJ17' },
    });
    assert.equal(collected.company_name, '杭州信纳智析科技有限公司');
    assert.equal(collected.unified_social_credit_code, '91330106MAK20KYJ17');
  });
});
