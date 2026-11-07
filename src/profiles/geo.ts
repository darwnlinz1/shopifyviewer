/**
 * Country hint carried by an imported cookie file's name.
 *
 * Cookie exports are commonly named `<account>_<CC>.txt` (ISO 3166-1 alpha-2).
 * When that suffix is present the profile's timezone and locale default to the
 * country's primary values, so a profile imported from a US export is not left
 * on the host machine's timezone. The mapping is a plain lookup table: no
 * network, no database, and an unknown or absent code simply yields `null`.
 */

export interface GeoInfo {
  countryCode: string;
  countryName: string;
  /** IANA timezone of the country's primary population centre. */
  timezone: string;
  /** BCP 47 locale. */
  locale: string;
}

const COUNTRIES: Record<string, Omit<GeoInfo, "countryCode">> = {
  US: { countryName: "United States", timezone: "America/New_York", locale: "en-US" },
  CA: { countryName: "Canada", timezone: "America/Toronto", locale: "en-CA" },
  MX: { countryName: "Mexico", timezone: "America/Mexico_City", locale: "es-MX" },
  BR: { countryName: "Brazil", timezone: "America/Sao_Paulo", locale: "pt-BR" },
  AR: { countryName: "Argentina", timezone: "America/Argentina/Buenos_Aires", locale: "es-AR" },
  CL: { countryName: "Chile", timezone: "America/Santiago", locale: "es-CL" },
  CO: { countryName: "Colombia", timezone: "America/Bogota", locale: "es-CO" },
  GB: { countryName: "United Kingdom", timezone: "Europe/London", locale: "en-GB" },
  IE: { countryName: "Ireland", timezone: "Europe/Dublin", locale: "en-IE" },
  FR: { countryName: "France", timezone: "Europe/Paris", locale: "fr-FR" },
  DE: { countryName: "Germany", timezone: "Europe/Berlin", locale: "de-DE" },
  ES: { countryName: "Spain", timezone: "Europe/Madrid", locale: "es-ES" },
  IT: { countryName: "Italy", timezone: "Europe/Rome", locale: "it-IT" },
  PT: { countryName: "Portugal", timezone: "Europe/Lisbon", locale: "pt-PT" },
  NL: { countryName: "Netherlands", timezone: "Europe/Amsterdam", locale: "nl-NL" },
  BE: { countryName: "Belgium", timezone: "Europe/Brussels", locale: "nl-BE" },
  CH: { countryName: "Switzerland", timezone: "Europe/Zurich", locale: "de-CH" },
  AT: { countryName: "Austria", timezone: "Europe/Vienna", locale: "de-AT" },
  SE: { countryName: "Sweden", timezone: "Europe/Stockholm", locale: "sv-SE" },
  NO: { countryName: "Norway", timezone: "Europe/Oslo", locale: "nb-NO" },
  DK: { countryName: "Denmark", timezone: "Europe/Copenhagen", locale: "da-DK" },
  FI: { countryName: "Finland", timezone: "Europe/Helsinki", locale: "fi-FI" },
  PL: { countryName: "Poland", timezone: "Europe/Warsaw", locale: "pl-PL" },
  CZ: { countryName: "Czechia", timezone: "Europe/Prague", locale: "cs-CZ" },
  GR: { countryName: "Greece", timezone: "Europe/Athens", locale: "el-GR" },
  TR: { countryName: "Turkey", timezone: "Europe/Istanbul", locale: "tr-TR" },
  UA: { countryName: "Ukraine", timezone: "Europe/Kyiv", locale: "uk-UA" },
  RU: { countryName: "Russia", timezone: "Europe/Moscow", locale: "ru-RU" },
  IL: { countryName: "Israel", timezone: "Asia/Jerusalem", locale: "he-IL" },
  AE: { countryName: "United Arab Emirates", timezone: "Asia/Dubai", locale: "ar-AE" },
  SA: { countryName: "Saudi Arabia", timezone: "Asia/Riyadh", locale: "ar-SA" },
  EG: { countryName: "Egypt", timezone: "Africa/Cairo", locale: "ar-EG" },
  ZA: { countryName: "South Africa", timezone: "Africa/Johannesburg", locale: "en-ZA" },
  NG: { countryName: "Nigeria", timezone: "Africa/Lagos", locale: "en-NG" },
  IN: { countryName: "India", timezone: "Asia/Kolkata", locale: "en-IN" },
  PK: { countryName: "Pakistan", timezone: "Asia/Karachi", locale: "en-PK" },
  BD: { countryName: "Bangladesh", timezone: "Asia/Dhaka", locale: "bn-BD" },
  TH: { countryName: "Thailand", timezone: "Asia/Bangkok", locale: "th-TH" },
  VN: { countryName: "Vietnam", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" },
  ID: { countryName: "Indonesia", timezone: "Asia/Jakarta", locale: "id-ID" },
  MY: { countryName: "Malaysia", timezone: "Asia/Kuala_Lumpur", locale: "ms-MY" },
  SG: { countryName: "Singapore", timezone: "Asia/Singapore", locale: "en-SG" },
  PH: { countryName: "Philippines", timezone: "Asia/Manila", locale: "en-PH" },
  CN: { countryName: "China", timezone: "Asia/Shanghai", locale: "zh-CN" },
  HK: { countryName: "Hong Kong", timezone: "Asia/Hong_Kong", locale: "zh-HK" },
  TW: { countryName: "Taiwan", timezone: "Asia/Taipei", locale: "zh-TW" },
  JP: { countryName: "Japan", timezone: "Asia/Tokyo", locale: "ja-JP" },
  KR: { countryName: "South Korea", timezone: "Asia/Seoul", locale: "ko-KR" },
  AU: { countryName: "Australia", timezone: "Australia/Sydney", locale: "en-AU" },
  NZ: { countryName: "New Zealand", timezone: "Pacific/Auckland", locale: "en-NZ" },
};

/**
 * Read a trailing `_CC` country code from a cookie file name or path.
 * `1abc@gmail.com_US.txt` → US. Case-insensitive; returns null when the
 * suffix is missing or the code is not in the table.
 */
export function resolveGeoFromFilename(name: string): GeoInfo | null {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const match = /_([A-Za-z]{2})(?:\.[A-Za-z0-9]+)?$/.exec(base);
  if (!match) return null;
  const code = match[1]!.toUpperCase();
  const entry = COUNTRIES[code];
  return entry ? { countryCode: code, ...entry } : null;
}
