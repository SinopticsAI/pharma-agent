import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { imageKind, isItemType, schemaHint } from './extract-schemas.ts';

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

describe('extract schemas', () => {
  it('keeps Plane snake_case keys on a business licence', () => {
    assert.equal(isItemType('business-license'), true);
    assert.match(schemaHint('business-license'), /company_name/);
    assert.match(schemaHint('other'), /营业执照/);
  });
});
