/**
 * Approximate Meta Cloud API per-message rates (USD), public rate-card summaries.
 * Final Meta invoice may differ (taxes, volume tiers, partner markups, credits).
 */

export type MetaPricingCategory =
  | "MARKETING"
  | "UTILITY"
  | "AUTHENTICATION"
  | "SERVICE"
  | "UNKNOWN";

export type MetaRateRow = {
  market: string;
  label: string;
  marketing: number;
  utility: number;
  authentication: number;
  service: number;
};

const CALLING_CODE_TO_MARKET: Array<{ prefix: string; market: string }> = [
  { prefix: "974", market: "QATAR" },
  { prefix: "971", market: "UAE" },
  { prefix: "966", market: "SAUDI" },
  { prefix: "965", market: "KUWAIT" },
  { prefix: "973", market: "BAHRAIN" },
  { prefix: "968", market: "OMAN" },
  { prefix: "20", market: "EGYPT" },
  { prefix: "1", market: "NORTH_AMERICA" },
];

export const RATE_CARD_USD: Record<string, MetaRateRow> = {
  QATAR: {
    market: "QATAR",
    label: "Qatar",
    marketing: 0.0472,
    utility: 0.0157,
    authentication: 0.0157,
    service: 0,
  },
  UAE: {
    market: "UAE",
    label: "United Arab Emirates",
    marketing: 0.0499,
    utility: 0.0157,
    authentication: 0.0157,
    service: 0,
  },
  SAUDI: {
    market: "SAUDI",
    label: "Saudi Arabia",
    marketing: 0.0456,
    utility: 0.0116,
    authentication: 0.0116,
    service: 0,
  },
  KUWAIT: {
    market: "KUWAIT",
    label: "Kuwait",
    marketing: 0.0472,
    utility: 0.0157,
    authentication: 0.0157,
    service: 0,
  },
  BAHRAIN: {
    market: "BAHRAIN",
    label: "Bahrain",
    marketing: 0.048,
    utility: 0.0157,
    authentication: 0.0157,
    service: 0,
  },
  OMAN: {
    market: "OMAN",
    label: "Oman",
    marketing: 0.0521,
    utility: 0.0157,
    authentication: 0.0157,
    service: 0,
  },
  EGYPT: {
    market: "EGYPT",
    label: "Egypt",
    marketing: 0.0604,
    utility: 0.0077,
    authentication: 0.0077,
    service: 0,
  },
  NORTH_AMERICA: {
    market: "NORTH_AMERICA",
    label: "USA & Canada",
    marketing: 0.025,
    utility: 0.0034,
    authentication: 0.0034,
    service: 0,
  },
  OTHER: {
    market: "OTHER",
    label: "Rest of World",
    marketing: 0.0604,
    utility: 0.0077,
    authentication: 0.0077,
    service: 0,
  },
};

/** QAR is pegged at 3.64 per USD. */
export const USD_TO_QAR = 3.64;

export function marketFromWaId(waId: string | null | undefined): string {
  const digits = String(waId || "").replace(/\D/g, "");
  if (!digits) return "OTHER";
  const sorted = [...CALLING_CODE_TO_MARKET].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const row of sorted) {
    if (digits.startsWith(row.prefix)) return row.market;
  }
  return "OTHER";
}

export function countryCodeFromMarket(market: string): string {
  const map: Record<string, string> = {
    QATAR: "QA",
    UAE: "AE",
    SAUDI: "SA",
    KUWAIT: "KW",
    BAHRAIN: "BH",
    OMAN: "OM",
    EGYPT: "EG",
    NORTH_AMERICA: "US",
    OTHER: "XX",
  };
  return map[market] || "XX";
}

export function rateFor(market: string, category: string) {
  const row = RATE_CARD_USD[market] || RATE_CARD_USD.OTHER;
  const cat = String(category || "UNKNOWN").toUpperCase();
  let rate = 0;
  if (cat === "MARKETING") rate = row.marketing;
  else if (cat === "UTILITY") rate = row.utility;
  else if (cat === "AUTHENTICATION") rate = row.authentication;
  else if (cat === "SERVICE") rate = row.service;
  return { rate, market: row.market, label: row.label };
}

export function categorizeMessage(input: {
  messageType?: string | null;
  templateName?: string | null;
  pricingCategory?: string | null;
}): MetaPricingCategory {
  const explicit = String(input.pricingCategory || "").toUpperCase();
  if (["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE"].includes(explicit)) {
    return explicit as MetaPricingCategory;
  }
  const type = String(input.messageType || "").toLowerCase();
  if (type === "template") return "UTILITY";
  if (type === "text" || type === "image" || type === "audio" || type === "voice" || type === "document" || type === "video") {
    return "SERVICE";
  }
  return "UNKNOWN";
}
