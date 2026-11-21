/**
 * Country Code to IANA Timezone and Locale Mapping.
 * 
 * Automatically infers geographic context (timezone, locale, country name)
 * from file naming conventions, e.g. `<email>_US.txt`, `cookie_GB.json`, etc.
 */

export interface GeoInfo {
  countryCode: string;
  countryName: string;
  timezone: string;
  locale: string;
}

export const COUNTRY_GEO_MAP: Record<string, GeoInfo> = {
  US: { countryCode: "US", countryName: "United States", timezone: "America/New_York", locale: "en-US" },
  GB: { countryCode: "GB", countryName: "United Kingdom", timezone: "Europe/London", locale: "en-GB" },
  UK: { countryCode: "UK", countryName: "United Kingdom", timezone: "Europe/London", locale: "en-GB" },
  CA: { countryCode: "CA", countryName: "Canada", timezone: "America/Toronto", locale: "en-CA" },
  AU: { countryCode: "AU", countryName: "Australia", timezone: "Australia/Sydney", locale: "en-AU" },
  FR: { countryCode: "FR", countryName: "France", timezone: "Europe/Paris", locale: "fr-FR" },
  DE: { countryCode: "DE", countryName: "Germany", timezone: "Europe/Berlin", locale: "de-DE" },
  ES: { countryCode: "ES", countryName: "Spain", timezone: "Europe/Madrid", locale: "es-ES" },
  IT: { countryCode: "IT", countryName: "Italy", timezone: "Europe/Rome", locale: "it-IT" },
  JP: { countryCode: "JP", countryName: "Japan", timezone: "Asia/Tokyo", locale: "ja-JP" },
  KR: { countryCode: "KR", countryName: "South Korea", timezone: "Asia/Seoul", locale: "ko-KR" },
  MX: { countryCode: "MX", countryName: "Mexico", timezone: "America/Mexico_City", locale: "es-MX" },
  NZ: { countryCode: "NZ", countryName: "New Zealand", timezone: "Pacific/Auckland", locale: "en-NZ" },
  PL: { countryCode: "PL", countryName: "Poland", timezone: "Europe/Warsaw", locale: "pl-PL" },
  SE: { countryCode: "SE", countryName: "Sweden", timezone: "Europe/Stockholm", locale: "sv-SE" },
  NL: { countryCode: "NL", countryName: "Netherlands", timezone: "Europe/Amsterdam", locale: "nl-NL" },
  RO: { countryCode: "RO", countryName: "Romania", timezone: "Europe/Bucharest", locale: "ro-RO" },
  DK: { countryCode: "DK", countryName: "Denmark", timezone: "Europe/Copenhagen", locale: "da-DK" },
  BE: { countryCode: "BE", countryName: "Belgium", timezone: "Europe/Brussels", locale: "fr-BE" },
  AT: { countryCode: "AT", countryName: "Austria", timezone: "Europe/Vienna", locale: "de-AT" },
  CH: { countryCode: "CH", countryName: "Switzerland", timezone: "Europe/Zurich", locale: "de-CH" },
  IE: { countryCode: "IE", countryName: "Ireland", timezone: "Europe/Dublin", locale: "en-IE" },
  PT: { countryCode: "PT", countryName: "Portugal", timezone: "Europe/Lisbon", locale: "pt-PT" },
  IL: { countryCode: "IL", countryName: "Israel", timezone: "Asia/Jerusalem", locale: "he-IL" },
  BR: { countryCode: "BR", countryName: "Brazil", timezone: "America/Sao_Paulo", locale: "pt-BR" },
  SG: { countryCode: "SG", countryName: "Singapore", timezone: "Asia/Singapore", locale: "en-SG" },
  NO: { countryCode: "NO", countryName: "Norway", timezone: "Europe/Oslo", locale: "nb-NO" },
  KW: { countryCode: "KW", countryName: "Kuwait", timezone: "Asia/Kuwait", locale: "ar-KW" },
  AE: { countryCode: "AE", countryName: "United Arab Emirates", timezone: "Asia/Dubai", locale: "ar-AE" },
  SA: { countryCode: "SA", countryName: "Saudi Arabia", timezone: "Asia/Riyadh", locale: "ar-SA" },
  TR: { countryCode: "TR", countryName: "Turkey", timezone: "Europe/Istanbul", locale: "tr-TR" },
  IN: { countryCode: "IN", countryName: "India", timezone: "Asia/Kolkata", locale: "en-IN" },
  ZA: { countryCode: "ZA", countryName: "South Africa", timezone: "Africa/Johannesburg", locale: "en-ZA" },
  TH: { countryCode: "TH", countryName: "Thailand", timezone: "Asia/Bangkok", locale: "th-TH" },
  PH: { countryCode: "PH", countryName: "Philippines", timezone: "Asia/Manila", locale: "en-PH" },
  MY: { countryCode: "MY", countryName: "Malaysia", timezone: "Asia/Kuala_Lumpur", locale: "ms-MY" },
  ID: { countryCode: "ID", countryName: "Indonesia", timezone: "Asia/Jakarta", locale: "id-ID" },
  VN: { countryCode: "VN", countryName: "Vietnam", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" },
  HK: { countryCode: "HK", countryName: "Hong Kong", timezone: "Asia/Hong_Kong", locale: "zh-HK" },
  TW: { countryCode: "TW", countryName: "Taiwan", timezone: "Asia/Taipei", locale: "zh-TW" },
  FI: { countryCode: "FI", countryName: "Finland", timezone: "Europe/Helsinki", locale: "fi-FI" },
  CZ: { countryCode: "CZ", countryName: "Czech Republic", timezone: "Europe/Prague", locale: "cs-CZ" },
  GR: { countryCode: "GR", countryName: "Greece", timezone: "Europe/Athens", locale: "el-GR" },
  HU: { countryCode: "HU", countryName: "Hungary", timezone: "Europe/Budapest", locale: "hu-HU" },
  AR: { countryCode: "AR", countryName: "Argentina", timezone: "America/Argentina/Buenos_Aires", locale: "es-AR" },
  CL: { countryCode: "CL", countryName: "Chile", timezone: "America/Santiago", locale: "es-CL" },
  CO: { countryCode: "CO", countryName: "Colombia", timezone: "America/Bogota", locale: "es-CO" },
};

/**
 * Extract ISO 2-letter country code from filename or path.
 * Supports patterns like:
 * - `1dbeachamm@gmail.com_US.txt` -> `US`
 * - `account_US_cookies.json` -> `US`
 * - `UK.txt` -> `UK`
 */
export function detectCountryFromFilename(filenameOrPath: string): string | null {
  if (!filenameOrPath || typeof filenameOrPath !== "string") return null;
  const clean = filenameOrPath.trim().replace(/\\/g, "/").split("/").pop() || "";
  
  // 1. Match trailing `_XX.txt` or `-XX.txt` or `.XX.txt` before extension
  const m1 = /[-_.]([A-Za-z]{2})(?:\.[a-zA-Z0-9]+)?$/i.exec(clean);
  if (m1 && m1[1]) {
    const code = m1[1].toUpperCase();
    if (COUNTRY_GEO_MAP[code]) return code;
  }

  // 2. Match `_XX_` inside filename
  const m2 = /[-_.]([A-Za-z]{2})[-_.]/i.exec(clean);
  if (m2 && m2[1]) {
    const code = m2[1].toUpperCase();
    if (COUNTRY_GEO_MAP[code]) return code;
  }

  // 3. Match exact 2-letter filename like `US.txt`
  const m3 = /^([A-Za-z]{2})\.[a-zA-Z0-9]+$/i.exec(clean);
  if (m3 && m3[1]) {
    const code = m3[1].toUpperCase();
    if (COUNTRY_GEO_MAP[code]) return code;
  }

  return null;
}

/**
 * Lookup Geo info for a given country code or filename.
 */
export function resolveGeoFromFilename(filenameOrPath: string): GeoInfo | null {
  const code = detectCountryFromFilename(filenameOrPath);
  if (!code) return null;
  return COUNTRY_GEO_MAP[code] ?? null;
}
