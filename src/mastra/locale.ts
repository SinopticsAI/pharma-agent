/**
 * Cabinet language for this turn.
 *
 * The browser cannot send X-Pharma-Locale until the deployed gateway CORS
 * list allows it, so the cabinet puts `data.locale` on the chat body. The
 * header is still accepted for local mastra dev and a future gateway sync.
 */

export const LOCALES = ['zh', 'en', 'ru'] as const;

export type Locale = (typeof LOCALES)[number];

const LOCALE_NAME: Record<Locale, string> = {
  zh: 'Simplified Chinese',
  en: 'English',
  ru: 'Russian',
};

export function localeOf(value: unknown): Locale {
  return value === 'en' || value === 'ru' || value === 'zh' ? value : 'zh';
}

export function languageRule(locale: Locale): string {
  const name = LOCALE_NAME[locale];
  return `
## Language

The cabinet UI language for this turn is ${locale} (${name}). Reply in that
language only — every sentence of prose and the \`${locale}\` key on every
card field (question, label, title, why, reasoning, summary, pros, cons).
Keep the required \`ru\` key filled as well. Do not follow the language of
earlier turns or of what the user typed: the switcher is authoritative.
`.trim();
}

export function withLanguage(base: string, locale: unknown): string {
  return `${base.trim()}\n\n${languageRule(localeOf(locale))}`;
}
