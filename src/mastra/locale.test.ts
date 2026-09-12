import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  languageRule,
  localeFromHints,
  localeOf,
  withLanguage,
} from './locale.ts';

describe('localeOf', () => {
  it('keeps zh, en, ru and falls back to zh', () => {
    assert.equal(localeOf('zh'), 'zh');
    assert.equal(localeOf('en'), 'en');
    assert.equal(localeOf('ru'), 'ru');
    assert.equal(localeOf('fr'), 'zh');
    assert.equal(localeOf(undefined), 'zh');
  });
});

describe('localeFromHints', () => {
  it('prefers the chat body over the request header', () => {
    assert.equal(localeFromHints({ header: 'ru', body: 'zh' }), 'zh');
    assert.equal(localeFromHints({ header: 'en', body: 'ru', requestContext: 'zh' }), 'ru');
  });

  it('uses requestContext when the body has no locale', () => {
    assert.equal(localeFromHints({ header: 'en', requestContext: 'zh' }), 'zh');
  });

  it('falls back to the header, then zh', () => {
    assert.equal(localeFromHints({ header: 'en' }), 'en');
    assert.equal(localeFromHints({ header: 'fr', body: 'de' }), 'zh');
    assert.equal(localeFromHints({}), 'zh');
  });
});

describe('languageRule', () => {
  it('requires Simplified Chinese for zh and does not treat ru as the reply language', () => {
    const rule = languageRule('zh');
    assert.match(rule, /简体中文/);
    assert.match(rule, /禁止用俄语或英语写正文/);
    assert.doesNotMatch(rule, /keep the required `ru` key filled as well/i);
    assert.doesNotMatch(rule, /Keep the required `ru` key filled as well/);
  });
});

describe('withLanguage', () => {
  it('puts the language block first and last', () => {
    const rule = languageRule('zh');
    const wrapped = withLanguage('You register a manufacturer.', 'zh');
    assert.equal(wrapped.startsWith(rule), true);
    assert.equal(wrapped.endsWith(rule), true);
    assert.ok(wrapped.indexOf('You register a manufacturer.') > 0);
  });
});
