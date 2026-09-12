/**
 * Cabinet language for this turn.
 *
 * The browser cannot send X-Pharma-Locale until the deployed gateway CORS
 * list allows it, so the cabinet puts `data.locale` on the chat body. The
 * header is still accepted for local mastra dev and a future gateway sync.
 * Body wins when both are present: a gateway default must not override the
 * switcher.
 */

export const LOCALES = ['zh', 'en', 'ru'] as const;

export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'ru' || value === 'zh';
}

export function localeOf(value: unknown): Locale {
  return isLocale(value) ? value : 'zh';
}

/** Body (cabinet switcher) beats the request header. */
export function localeFromHints(input: {
  header?: unknown;
  body?: unknown;
  requestContext?: unknown;
}): Locale {
  if (isLocale(input.body)) return input.body;
  if (isLocale(input.requestContext)) return input.requestContext;
  if (isLocale(input.header)) return input.header;
  return 'zh';
}

const LANGUAGE_RULE: Record<Locale, string> = {
  zh: `
## 语言

当前界面语言是简体中文（zh）。你对用户可见的每一句正文都必须用简体中文。
禁止用俄语或英语写正文。

卡片字段（question、label、title、why、reasoning、summary、pros、cons）必须填写 zh。
ru 和 en 是给其他语言界面的译文，不是回复语言：填了 ru 也不等于可以写俄语正文。
字段取值（公司名称、统一社会信用代码 等）保持原文，不要翻译。
不要跟着历史消息或用户输入的语言走，以语言切换器为准。
`.trim(),
  en: `
## Language

The cabinet UI language for this turn is English (en). Every sentence of
user-visible prose must be in English. Do not write Russian or Chinese prose.

Card fields (question, label, title, why, reasoning, summary, pros, cons)
must fill the \`en\` key. \`ru\` and \`zh\` are translations for the other shells,
not the reply language: filling \`ru\` does not allow Russian prose.
Keep extracted field values (company name, USCC, and so on) as they appear
on the paper; do not translate them.
Do not follow the language of earlier turns or of what the user typed: the
switcher is authoritative.
`.trim(),
  ru: `
## Язык

Язык интерфейса кабинета в этом ходе — русский (ru). Каждое предложение
видимой пользователю прозы должно быть на русском. Не пишите прозу по-китайски
или по-английски.

Поля карточки (question, label, title, why, reasoning, summary, pros, cons)
должны заполнять ключ \`ru\`. Ключи \`zh\` и \`en\` — переводы для других оболочек,
не язык ответа.
Значения полей (название компании, USCC и т.д.) оставляйте как на документе,
не переводите.
Не повторяйте язык прошлых ходов и не повторяйте язык ввода пользователя:
переключатель языка — источник истины.
`.trim(),
};

export function languageRule(locale: Locale): string {
  return LANGUAGE_RULE[locale];
}

export function withLanguage(base: string, locale: unknown): string {
  const rule = languageRule(localeOf(locale));
  return `${rule}\n\n${base.trim()}\n\n${rule}`;
}
