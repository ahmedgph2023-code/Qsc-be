/**
 * Statement JSON contracts (Step 1).
 * Engines fill these later. Fields that the SQL extract cannot source stay null.
 * UI must display these payloads — do not recompute money in React (D-005).
 */

export const STATEMENT_KINDS = [
  "portfolio",
  "account",
  "realized_summary",
  "realized_details",
] as const;

export type StatementKind = (typeof STATEMENT_KINDS)[number];

export type StatementDateControl =
  | { mode: "as_of"; asOf: string }
  | { mode: "range"; from: string; to: string };

/** Why a money field is null or not yet comparable to the trading-system PDF. */
export type StatementFieldSource =
  | "sql"
  | "engine"
  | "official_close"
  | "missing_close"
  | "unknown";

export type StatementMoney = {
  value: number | null;
  source: StatementFieldSource;
  /** Stable code when source is unknown or missing_close. */
  reason?: string;
};

export type StatementCompanyHeader = {
  legalName: string;
  logoPath: string;
};

export type StatementInvestorHeader = {
  nin: string;
  clientCode: string | null;
  accountId: number;
  nameAr: string;
  nameEn: string;
  displayName: string;
  currency: "QAR";
  /** Raw SQL Investors.C_ACCOUNT — do not label as Trade Acc QE until confirmed. */
  cAccount: string | null;
  /** Raw SQL Investors.CL_CLIENT_TYPE — do not label as INV PORT until confirmed. */
  clientType: string | null;
  email: string | null;
  mobile: string | null;
  poBox: string | null;
  tel: string | null;
  fax: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  tradingAccountQe: string | null;
  accountTypePrinted: string | null;
};

export type StatementPrintMeta = {
  printedAtIso: string;
  page?: { current: number; total: number } | null;
};

export type StatementPriceRef = {
  ticker: string;
  closePrice: number | null;
  closeDate: string | null;
  source: Extract<StatementFieldSource, "official_close" | "missing_close">;
};

export type PortfolioStatementLine = {
  lineNo: number;
  companyName: string;
  ticker: string;
  compId: number | null;
  currency: "QAR";
  accountTypePrinted: string | null;
  quantity: number;
  costValue: number;
  shareCost: number;
  closePrice: number | null;
  closeDate: string | null;
  priceSource: StatementPriceRef["source"];
  marketValue: number | null;
  unrealizedGross: number | null;
  profitPctGross: number | null;
  currencyDifference: number;
  sectorCode: string | null;
  sectorName: string;
  breakEven: StatementMoney;
  displayedProfit: StatementMoney;
  displayedProfitPct: StatementMoney;
};

export type PortfolioStatementSector = {
  sectorCode: string | null;
  sectorName: string;
  weightPct: number | null;
  marketValue: number | null;
  costValue: number;
  lines: PortfolioStatementLine[];
};

export type PortfolioStatementFooter = {
  marketValue: StatementMoney;
  expectedProfitLoss: StatementMoney;
  expectedSellCommission: StatementMoney;
  netAfterExpectedSellComm: StatementMoney;
  currencyDifference: StatementMoney;
  drCrBalance: StatementMoney;
  realizedTradingPl: StatementMoney;
  receivedProfits: StatementMoney;
  nonReceivedProfits: StatementMoney;
  realizedTotal: StatementMoney;
  clientNetCashBalance: StatementMoney;
  netProfitLoss: StatementMoney;
  netAssetValue: StatementMoney;
  cashLedgerBalance: StatementMoney;
  /** Client 2026-09: Total Asset = Market Value + Client Balance (cash). Display KPI. */
  totalAsset: StatementMoney;
};

export type PortfolioStatement = {
  kind: "portfolio";
  titleEn: "Unrealized Profit/Loss Summary";
  titleAr: "ملخص الأرباح والخسائر غير المحققة";
  company: StatementCompanyHeader;
  investor: StatementInvestorHeader;
  dates: Extract<StatementDateControl, { mode: "as_of" }>;
  closingPricesAsOf: string;
  sectors: PortfolioStatementSector[];
  grandTotalCost: number;
  grandTotalMarketValue: number | null;
  footer: PortfolioStatementFooter;
  missingCloses: string[];
  print: StatementPrintMeta;
};

export type AccountStatementLine = {
  postDate: string;
  docDate: string;
  transType: string;
  transNo: number | null;
  description: string;
  quantity: number | null;
  securityPrice: StatementMoney;
  securityPriceWithComm: StatementMoney;
  marketFees: StatementMoney;
  commission: StatementMoney;
  debit: number;
  credit: number;
  balance: number;
  status: string;
  isOpening: boolean;
  isUnposted: boolean;
};

export type AccountStatement = {
  kind: "account";
  titleEn: "Statement of Account";
  titleAr: "كشف الحساب";
  company: StatementCompanyHeader;
  investor: StatementInvestorHeader;
  dates: Extract<StatementDateControl, { mode: "range" }>;
  /** Client 2026-09: grouped (default) vs detailed account statement. */
  layout: "grouped" | "detailed";
  openingBalance: number;
  openingDate: string | null;
  lines: AccountStatementLine[];
  unpostedDebit: number;
  unpostedCredit: number;
  closingBalance: number;
  transactionCount: number;
  disclaimerEn: string;
  print: StatementPrintMeta;
};

export type RealizedSummaryLine = {
  companyName: string;
  ticker: string;
  compId: number | null;
  accountTypePrinted: string | null;
  tradingProfit: number;
  distributedDividends: StatementMoney;
  nonReceivedDividends: StatementMoney;
  totalProfit: StatementMoney;
};

export type RealizedSummaryFooter = {
  commission: StatementMoney;
  endOfPeriodBalance: StatementMoney;
  drCrBalance: StatementMoney;
  paidCapital: StatementMoney;
  footerTotal: StatementMoney;
  realizedProfitLoss: StatementMoney;
  expectedProfitLoss: StatementMoney;
  netProfitLoss: StatementMoney;
  profitLossPercentage: StatementMoney;
  receivedProfits: StatementMoney;
  nonReceivedProfits: StatementMoney;
};

export type RealizedSummaryStatement = {
  kind: "realized_summary";
  titleEn: "Realized Profit/loss Summary";
  titleAr: "كشف الأرباح والخسائر المحققة — مختصر";
  company: StatementCompanyHeader;
  investor: StatementInvestorHeader;
  dates: StatementDateControl;
  lines: RealizedSummaryLine[];
  tradingProfitTotal: number;
  footer: RealizedSummaryFooter;
  print: StatementPrintMeta;
};

export type RealizedBlotterSide =
  | "Buy"
  | "Sell"
  | "Balance"
  | "Equity Transfer-In"
  | "Equity Transfer-Out"
  | string;

export type RealizedBlotterLine = {
  date: string;
  invNo: number | null;
  side: RealizedBlotterSide;
  buyQty: number;
  sellQty: number;
  shareBalance: number;
  price: number;
  buyValue: number;
  sellValue: number;
  shareCost: number;
  grossSaleCost: number;
  dayResult: number;
  profitLossCumulative: number;
  isOpening: boolean;
};

export type RealizedDetailsStock = {
  companyName: string;
  ticker: string;
  compId: number | null;
  sectorName?: string | null;
  currency: "QAR";
  lines: RealizedBlotterLine[];
  totals: {
    buyQty: number;
    sellQty: number;
    buyValue: number;
    sellValue: number;
    dayResult: number;
  };
};

export type RealizedDetailsStatement = {
  kind: "realized_details";
  titleEn: "Transactions Details";
  titleAr: "كشف الأرباح والخسائر المحققة — تفصيلي";
  company: StatementCompanyHeader;
  investor: StatementInvestorHeader;
  dates: Extract<StatementDateControl, { mode: "range" }>;
  stocks: RealizedDetailsStock[];
  print: StatementPrintMeta;
};

export type ClientStatement =
  | PortfolioStatement
  | AccountStatement
  | RealizedSummaryStatement
  | RealizedDetailsStatement;

export const QSC_STATEMENT_COMPANY: StatementCompanyHeader = {
  legalName: "Qatar Securities Co. (P.Q.S.C)",
  logoPath: "/logo.png",
};

export const ACCOUNT_STATEMENT_DISCLAIMER_EN =
  "This is a computer generated confirmation and does not require signature. Unless you bring to our notice any discrepancies in the above statement within 5 business days from the date of the statement, all entries in this statement will be considered as confirmed and in Compliance with your instructions";

export function unknownMoney(reason: string): StatementMoney {
  return { value: null, source: "unknown", reason };
}

export function engineMoney(value: number): StatementMoney {
  return { value, source: "engine" };
}

export function sqlMoney(value: number): StatementMoney {
  return { value, source: "sql" };
}

/** Fields still absent from Investors + InvestorsDetails (see dbSchema.md). */
export const INVESTOR_HEADER_SQL_GAPS = [
  "tel",
  "country",
  "tradingAccountQe",
  "accountTypePrinted",
] as const;

/**
 * Print fields for reconstruction NIN 37808 only.
 * Address: KB/Portfolio/Sample-Investor-Client-Details.md
 * Account type: KB year-end statement Account Type = INV PORT
 * Fax / QE account: observed on this investor's 01/12/2024 portfolio PDF (UAT freeze) — not SQL.
 * Do not copy onto other NINs. Do not use redacted KB mobile/email.
 */
export const KB_SAMPLE_INVESTOR_37808 = {
  nin: "37808",
  poBox: "60398",
  city: "DOHA",
  country: "QATAR",
  accountTypePrinted: "INV PORT",
  fax: "97444255227",
  tradingAccountQe: "600370753",
} as const;

export function applySampleInvestorKbHeader(header: StatementInvestorHeader): StatementInvestorHeader {
  if (header.nin.trim() !== KB_SAMPLE_INVESTOR_37808.nin) return header;
  return {
    ...header,
    poBox: header.poBox || KB_SAMPLE_INVESTOR_37808.poBox,
    city: header.city || KB_SAMPLE_INVESTOR_37808.city,
    country: header.country || KB_SAMPLE_INVESTOR_37808.country,
    accountTypePrinted: header.accountTypePrinted || KB_SAMPLE_INVESTOR_37808.accountTypePrinted,
    fax: header.fax || KB_SAMPLE_INVESTOR_37808.fax,
    tradingAccountQe: header.tradingAccountQe || KB_SAMPLE_INVESTOR_37808.tradingAccountQe,
  };
}

export function buildInvestorHeader(input: {
  accountId: number;
  nin: string;
  nameEn?: string;
  nameAr?: string;
  displayName: string;
  clientCode?: string | null;
  cAccount?: string | null;
  clientType?: string | null;
  email?: string | null;
  mobile?: string | null;
  poBox?: string | null;
  tel?: string | null;
  fax?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  tradingAccountQe?: string | null;
  accountTypePrinted?: string | null;
}): StatementInvestorHeader {
  return {
    nin: input.nin,
    clientCode: input.clientCode ?? null,
    accountId: input.accountId,
    nameAr: input.nameAr || "",
    nameEn: input.nameEn || "",
    displayName: input.displayName,
    currency: "QAR",
    cAccount: input.cAccount ?? null,
    clientType: input.clientType ?? null,
    email: input.email ?? null,
    mobile: input.mobile ?? null,
    poBox: input.poBox ?? null,
    tel: input.tel ?? null,
    fax: input.fax ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    country: input.country ?? null,
    tradingAccountQe: input.tradingAccountQe ?? null,
    accountTypePrinted: input.accountTypePrinted ?? null,
  };
}
