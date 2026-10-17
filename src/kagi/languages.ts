// Language codes supported by Kagi Universal Summarizer.
// Ported from kagi-ken@1.3.0 src/summarize.js.
export const SUPPORTED_LANGUAGES = [
  "BG", "CS", "DA", "DE", "EL", "EN", "ES", "ET", "FI", "FR",
  "HU", "ID", "IT", "JA", "KO", "LT", "LV", "NB", "NL", "PL",
  "PT", "RO", "RU", "SK", "SL", "SV", "TR", "UK", "ZH", "ZH-HANT",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(code: string): code is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(code);
}
