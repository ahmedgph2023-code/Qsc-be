/**
 * Frozen sample numbers from meeting/second_phase/UAT-FREEZE.md.
 * Tests may assert identities. Engines must not treat observed rates as policy.
 */

export const UAT_SAAD = {
  nin: "37808",
  clientCode: "1800101035339",
  accountId: 2041929,
  nameAr: "سعد احمد ابراهيم الحسن المهندى",
} as const;

/** Portfolio01122024.pdf — closing prices as of 2024-12-01 */
export const UAT_PORTFOLIO_2024_12_01 = {
  asOf: "2024-12-01",
  ticker: "MHAR",
  compId: 8037,
  quantity: 1_853_000,
  costValue: 3_555_324.49,
  shareCostPrinted: 1.919,
  breakEvenPrinted: 1.924,
  closePrice: 2.508,
  marketValue: 4_647_324,
  profitPrinted: 1_079_219.37,
  profitPctPrinted: 30.36,
  expectedSellComm: 12_780.14,
  netAfterSellComm: 4_634_543.86,
  drCrBalance: 170_494.61,
  realizedTradingPl: 743_093.12,
  clientNetCash: 2_174_992.23,
  netProfitLoss: 1_822_312.49,
  nav: 4_817_818.61,
  poBox: "60398",
  fax: "97444255227",
  tradingAccountQe: "600370753",
} as const;

/** KB statement 31/12/2024 — layout differs; quantity/NAV checkpoint only */
export const UAT_KB_2024_12_31 = {
  asOf: "2024-12-31",
  ticker: "GISS",
  quantity: 1_300_000,
  costPerShare: 3.236314,
  close: 3.328,
  marketValue: 4_326_400,
  unrealized: 107_293.92,
  cash: 144_708.17,
  nav: 4_471_108.17,
} as const;

/** 37808_RealizedProfitLossSummary.pdf printed 2026-08-26 */
export const UAT_PNL_SUMMARY_2026_08_26 = {
  printedOn: "2026-08-26",
  period: "UNKNOWN" as const,
  mhar: 48_109.42,
  giss: -1_939_349.41,
  mcgs: 198_092.58,
  qfls: -11_837.26,
  tradingTotal: -1_704_984.67,
  commission: 14_160.04,
  endOfPeriodBalance: 5_134_947.42,
  drCrBalance: 4_575_212.77,
  footerTotal: 9_724_320.23,
  expectedPl: -169_390.86,
  netPl: -1_874_375.53,
} as const;

/** First MHAR sell on 37808_RealizedProfitLossTransactionDetails.pdf */
export const UAT_PNL_DETAIL_MHAR_OPENING = {
  date: "2025-12-31",
  qty: 2_000_000,
  book: 4_638_000,
  shareCost: 2.319,
  cumulativePl: 1_330_738.88,
} as const;

export const UAT_PNL_DETAIL_FIRST_SELL = {
  date: "2026-01-13",
  invNo: 7_152_449,
  sellQty: 1_900,
  balanceAfter: 1_998_100,
  pricePrinted: 2.352,
  sellValue: 4_467.88,
  grossSaleCost: 4_406.1,
  dayResult: 61.78,
  shareCost: 2.319,
  cumulativeAfter: 1_330_800.66,
} as const;

/** KB first MHAR sell — dictionary / ledger */
export const UAT_KB_FIRST_MHAR_SELL = {
  date: "2024-07-07",
  invNo: 5_609_547,
  sellQty: 1_130,
  price: 1.753,
  sellValue: 1_981.4,
  shareCost: 1.50413,
  sellCost: 1_699.661,
  dailyResult: 281.73875,
} as const;

export const UAT_ACCOUNT_LAYOUT_ONLY = {
  clientCode: "1800101035367",
  nin: "398235",
  from: "2025-05-11",
  to: "2025-05-12",
  opening: 1.79,
  note: "Different investor than NIN 37808. Layout UAT only.",
} as const;
