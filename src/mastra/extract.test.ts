import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractFailureKind, extractFailureReason, isDegenerateAnswer } from './extract-reason.ts';
import {
  isItemType,
  scanKind,
  schemaHint,
  visionPrompt,
  visionRequestBody,
} from './extract-schemas.ts';
import {
  collectExtracted,
  hasExtractedValue,
  hasLicenseIdentity,
  normalizeVisionFields,
  recoverItemType,
  recoverLicenseFields,
  toIsoDate,
  usccLooksWrong,
} from './license-fields.ts';

describe('scanKind', () => {
  it('accepts jpeg/png/webp by mime or extension', () => {
    assert.deepEqual(scanKind('scan.JPG', ''), { ok: true, mime: 'image/jpeg', pdf: false });
    assert.deepEqual(scanKind('scan.bin', 'image/png'), { ok: true, mime: 'image/png', pdf: false });
    assert.deepEqual(scanKind('scan.webp', 'image/webp'), { ok: true, mime: 'image/webp', pdf: false });
  });

  it('accepts a pdf and marks it for preparation', () => {
    assert.deepEqual(scanKind('dossier.pdf', 'application/pdf'), {
      ok: true,
      mime: 'application/pdf',
      pdf: true,
    });
    // The cabinet does not always send a content type with the upload.
    assert.deepEqual(scanKind('02-ifu-en-safe-accu.PDF', ''), {
      ok: true,
      mime: 'application/pdf',
      pdf: true,
    });
  });

  it('still rejects office files and tiff', () => {
    assert.deepEqual(scanKind('letter.docx', ''), { ok: false });
    assert.deepEqual(scanKind('scan.tiff', ''), { ok: false });
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

  it('names the formats intake reads when the file is not one of them', () => {
    const reason = extractFailureReason({ code: 'wrong_format', message: 'letter.docx is not a photo or a PDF' });
    assert.match(reason, /pdf/i);
    assert.match(reason, /jpeg/i);
  });
});

describe('isDegenerateAnswer', () => {
  it('catches the empty answer Studio returns on a document it can read', () => {
    assert.equal(isDegenerateAnswer('{"": ""}'), true);
    assert.equal(isDegenerateAnswer('{}'), true);
    assert.equal(isDegenerateAnswer('   '), true);
    assert.equal(isDegenerateAnswer('{"itemType": null, "extracted": null}'), true);
  });

  it('leaves a real answer and a non-JSON answer alone', () => {
    assert.equal(
      isDegenerateAnswer('{"itemType":"business-license","extracted":{"company_name":"杭州信纳智析科技有限公司"}}'),
      false,
    );
    // parseVision reports «did not return JSON»; that is a different failure.
    assert.equal(isDegenerateAnswer('I cannot read this'), false);
  });
});

describe('extractFailureKind', () => {
  it('blames the scan only when another file would help', () => {
    assert.equal(extractFailureKind({ code: 'too_large', message: 'scan is 9 MB' }), 'unreadable');
    assert.equal(extractFailureKind({ code: 'wrong_format', message: 'letter.docx' }), 'unreadable');
  });

  it('blames the service for everything on our side', () => {
    // The 400 on reasoning_options landed here and sent the user hunting for a
    // better photo of a licence that read perfectly well.
    assert.equal(extractFailureKind({ code: 'vision_failed', message: 'Unsupported parameter(s)' }), 'service');
    // An empty answer after the retry is the contour, not the document.
    assert.equal(extractFailureKind({ code: 'vision_empty', message: '{"": ""}' }), 'service');
    assert.equal(extractFailureKind({ code: 'not_configured', message: 'no key' }), 'service');
    assert.equal(extractFailureKind({ code: 'download_failed', message: 'presigned GET 403' }), 'service');
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    assert.equal(extractFailureKind(aborted), 'service');
    assert.equal(extractFailureKind(new Error('network')), 'service');
  });
});

describe('visionRequestBody', () => {
  const body = visionRequestBody({
    model: 'gpt://folder/qwen3.6-35b-a3b',
    hintedType: 'business-license',
    payload: { kind: 'images', mime: 'image/jpeg', pages: [new Uint8Array([1, 2, 3])] },
  });

  it('carries the only thinking switch Studio accepts', () => {
    assert.equal(body.reasoning_effort, 'none');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.temperature, 0);
  });

  it('omits every parameter Studio answers 400 to', () => {
    for (const key of ['reasoning_options', 'enable_thinking', 'extra_body', 'chat_template_kwargs']) {
      assert.equal(key in body, false, `${key} must not reach Studio`);
    }
  });

  it('sends the prompt and the scan as one user message', () => {
    const messages = body.messages as { role: string; content: { type: string; text?: string }[] }[];
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.deepEqual(
      messages[0].content.map((part) => part.type),
      ['text', 'image_url'],
    );
    assert.match(JSON.stringify(messages[0].content[1]), /^{"type":"image_url","image_url":{"url":"data:image\/jpeg;base64,/);
  });

  it('drops /no_think: the model ignores it and it only muddies the prompt', () => {
    assert.equal(visionPrompt('business-license').includes('/no_think'), false);
    assert.match(visionPrompt('business-license'), /company_name/);
  });

  it('sends the pages of a scanned pdf as images, never the pdf itself', () => {
    const pdfPages = visionRequestBody({
      model: 'gpt://folder/qwen3.6-35b-a3b',
      hintedType: 'instruction-cn',
      payload: {
        kind: 'images',
        mime: 'image/jpeg',
        pages: [new Uint8Array([1]), new Uint8Array([2])],
      },
    });
    const messages = pdfPages.messages as { content: { type: string }[] }[];
    assert.deepEqual(
      messages[0].content.map((part) => part.type),
      ['text', 'image_url', 'image_url'],
    );
    // Studio answers 400 to data:application/pdf in image_url.
    assert.equal(JSON.stringify(pdfPages).includes('application/pdf'), false);
  });

  it('sends the text of a digital pdf as text, with no image part', () => {
    const fromText = visionRequestBody({
      model: 'gpt://folder/qwen3.6-35b-a3b',
      hintedType: 'instruction-ru',
      payload: { kind: 'text', text: 'INSTRUCTION FOR USE\nModel: MH-200' },
    });
    const messages = fromText.messages as { content: { type: string; text?: string }[] }[];
    assert.deepEqual(
      messages[0].content.map((part) => part.type),
      ['text'],
    );
    assert.match(messages[0].content[0].text ?? '', /Model: MH-200/);
    // The prompt must not call a text extract a scan.
    assert.match(messages[0].content[0].text ?? '', /You read the text of/);
    assert.equal(JSON.stringify(fromText).includes('image_url'), false);
    assert.equal(JSON.stringify(fromText).includes('application/pdf'), false);
  });
});

describe('extract schemas', () => {
  it('keeps Plane snake_case keys on a business licence', () => {
    assert.equal(isItemType('business-license'), true);
    assert.equal(isItemType('signatory'), true);
    assert.equal(isItemType('bank-account'), true);
    assert.match(schemaHint('business-license'), /company_name/);
    assert.match(schemaHint('signatory'), /legal_representative/);
    assert.match(schemaHint('bank-account'), /account_number/);
    assert.match(schemaHint('other'), /营业执照/);
    assert.match(schemaHint('other'), /iso-13485/);
    assert.match(schemaHint('other'), /授权委托书/);
    assert.match(schemaHint('other'), /生产许可/);
    assert.match(schemaHint('other'), /GSXT/);
    assert.match(visionPrompt('other'), /never from the file name/);
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

  it('prefers 名称 over English company_name on the Andon 营业执照 layout', () => {
    const out = recoverLicenseFields('', {
      company_name: 'Andon Health Co., Ltd.',
      name: 'Andon Health Co., Ltd.',
      英文名称: 'Andon Health Co., Ltd.',
      名称: '天津九安医疗电子股份有限公司',
      unified_social_credit_code: '911200006008904220',
    });
    assert.equal(out.company_name, '天津九安医疗电子股份有限公司');
    assert.equal(out.company_name_en, 'Andon Health Co., Ltd.');
    assert.equal(out.name, null);
  });

  it('does not treat the title 营业执照 as the company name', () => {
    const out = recoverLicenseFields('', {
      company_name: '营业执照',
      name: '营业执照',
      名称: '天津九安医疗电子股份有限公司',
      unified_social_credit_code: '911200006008904220',
    });
    assert.equal(out.company_name, '天津九安医疗电子股份有限公司');
  });

  it('does not let NAME_RE match inside 英文名称 on one OCR line', () => {
    const out = recoverLicenseFields(
      '英文名称 Andon Health Co., Ltd. 名称 天津九安医疗电子股份有限公司',
      { company_name: null },
    );
    assert.equal(out.company_name, '天津九安医疗电子股份有限公司');
  });

  it('does not take 类型 股份有限公司 as the company name', () => {
    const out = recoverLicenseFields(
      ['英文名称 Andon Health Co., Ltd.', '类型 股份有限公司（上市、测试数据）'].join('\n'),
      { company_name: 'Andon Health Co., Ltd.' },
    );
    assert.equal(out.company_name, null);
    assert.equal(out.company_name_en, 'Andon Health Co., Ltd.');
  });
});

describe('usccLooksWrong', () => {
  it('tells apart the two readings of one licence', () => {
    // Both came off the same 营业执照; only the arithmetic knows which is real.
    assert.equal(usccLooksWrong('91330106MAK20KYJ17'), false);
    assert.equal(usccLooksWrong('91330106MA2KXYYJ17'), true);
  });

  it('flags letters the standard leaves out', () => {
    assert.equal(usccLooksWrong('91330106MAI20KYJ17'), true);
    assert.equal(usccLooksWrong('91330106MAO20KYJ17'), true);
  });

  it('leaves an old 15-digit 注册号 alone', () => {
    assert.equal(usccLooksWrong('330106000012345'), false);
    assert.equal(usccLooksWrong(''), false);
  });
});

describe('toIsoDate', () => {
  it('reads the Chinese form and the punctuation variants', () => {
    assert.equal(toIsoDate('2025年11月19日'), '2025-11-19');
    assert.equal(toIsoDate('2025年1月9日'), '2025-01-09');
    assert.equal(toIsoDate('2025.11.19'), '2025-11-19');
    assert.equal(toIsoDate('2025/11/19'), '2025-11-19');
    assert.equal(toIsoDate('2025-11-19'), '2025-11-19');
  });

  it('keeps quiet when there is no date to be sure of', () => {
    assert.equal(toIsoDate('长期'), '');
    assert.equal(toIsoDate('2025年2月30日'), '');
    assert.equal(toIsoDate(''), '');
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

  it('sends the registration date on as ISO and the capital as printed', () => {
    const vision = normalizeVisionFields({
      itemType: 'business-license',
      extracted: {
        company_name: '杭州信纳智析科技有限公司',
        establishment_date: '2025年11月19日',
        registered_capital: '壹拾伍万人民币元',
      },
    });
    assert.equal(vision.extracted.establishment_date, '2025-11-19');
    assert.equal(vision.extracted.registered_capital, '壹拾伍万人民币元');
  });

  it('marks a code that contradicts its check digit', () => {
    const vision = normalizeVisionFields({
      itemType: 'business-license',
      extracted: { unified_social_credit_code: '91330106MA2KXYYJ17' },
    });
    assert.equal(vision.extracted.uscc_checksum, 'invalid');
    // The value survives: a human still has to compare it with the paper.
    assert.equal(vision.extracted.unified_social_credit_code, '91330106MA2KXYYJ17');
  });

  it('says nothing when the code adds up', () => {
    const vision = normalizeVisionFields({
      itemType: 'business-license',
      extracted: { unified_social_credit_code: '91330106MAK20KYJ17' },
    });
    assert.equal('uscc_checksum' in vision.extracted, false);
  });

  it('does not let the flag pass for a read field', () => {
    const vision = normalizeVisionFields({ itemType: 'other', extracted: { company_name: null } });
    assert.equal(vision.unreadable, true);
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

  it('keeps Andon Chinese 名称 when vision filled company_name with 英文名称', () => {
    const vision = normalizeVisionFields({
      itemType: 'business-license',
      extracted: {
        company_name: 'Andon Health Co., Ltd.',
        英文名称: 'Andon Health Co., Ltd.',
        名称: '天津九安医疗电子股份有限公司',
        unified_social_credit_code: '911200006008904220',
      },
    });
    assert.equal(vision.unreadable, false);
    assert.equal(vision.extracted.company_name, '天津九安医疗电子股份有限公司');
    assert.equal(vision.extracted.company_name_en, 'Andon Health Co., Ltd.');
    assert.equal(vision.extracted.unified_social_credit_code, '911200006008904220');
  });
});

describe('recoverItemType', () => {
  it('reads Cofoe 开户许可证 even when the upload was labelled business-license', () => {
    assert.equal(
      recoverItemType(
        'business-license',
        {
          company_name: '可孚医疗科技股份有限公司',
          unified_social_credit_code: '91430111696240992G',
          account_number: '7559000020071119001',
          permit_no: 'TEST-J430111071119',
          bank_name: '中国银行长沙雨花支行',
        },
        'other',
      ),
      'bank-account',
    );
  });

  it('does not type a bank scan from the file name when fields are not a bank permit', () => {
    assert.equal(
      recoverItemType(
        'other',
        {
          company_name: '可孚医疗科技股份有限公司',
          unified_social_credit_code: '91430111696240992G',
          legal_representative: '张敏',
        },
        'other',
        '07-bank-account.jpg',
      ),
      'other',
    );
  });

  it('reads Cofoe 法定代表人身份证明 from 公民身份号码', () => {
    assert.equal(
      recoverItemType(
        'other',
        {
          company_name: '可孚医疗科技股份有限公司',
          legal_representative: '张敏',
          公民身份号码: '00000019800101000X',
        },
        'other',
      ),
      'signatory',
    );
  });

  it('does not type a signatory scan from the file name when fields are not that paper', () => {
    assert.equal(
      recoverItemType(
        'other',
        {
          company_name: '可孚医疗科技股份有限公司',
          legal_representative: '张敏',
          unified_social_credit_code: '91430111696240992G',
        },
        'other',
        '06-signatory.jpg',
      ),
      'other',
    );
  });

  it('does not type a 营业执照 from the file name when fields are not that paper', () => {
    assert.equal(
      recoverItemType(
        'business-license',
        {
          company_name: '可孚医疗科技股份有限公司',
          unified_social_credit_code: '91430111696240992G',
          legal_representative: '张敏',
        },
        'other',
        '01-yingye-zhizhao.jpg',
      ),
      'other',
    );
  });

  it('keeps a real 营业执照 when there is no bank or signatory evidence', () => {
    assert.equal(
      recoverItemType(
        'business-license',
        {
          company_name: '可孚医疗科技股份有限公司',
          unified_social_credit_code: '91430111696240992G',
          注册资本: '贰亿叁仟伍佰捌拾玖万柒仟元整',
          经营范围: '家用医疗器械的研发、生产与销售',
          营业执照: '副本',
        },
        'business-license',
        '01-yingye-zhizhao.jpg',
      ),
      'business-license',
    );
  });

  it('keeps iso-13485 when vision already named it', () => {
    assert.equal(
      recoverItemType('business-license', { certificate_number: 'TEST-ISO' }, 'iso-13485', '03-iso-13485.pdf'),
      'iso-13485',
    );
  });
});
