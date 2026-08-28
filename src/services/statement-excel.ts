import XLSX from "xlsx";
import type {
  AccountStatement,
  ClientStatement,
  PortfolioStatement,
  RealizedDetailsStatement,
  RealizedSummaryStatement,
  StatementMoney,
} from "./statement-types.js";

function money(m: StatementMoney): number | "" {
  return m.value == null ? "" : m.value;
}

function filenameFor(stmt: ClientStatement): string {
  const nin = stmt.investor.nin || String(stmt.investor.accountId);
  if (stmt.kind === "portfolio") return `${nin}_PortfolioStatement.xlsx`;
  if (stmt.kind === "account") return `${nin}_StatementOfAccounts.xlsx`;
  if (stmt.kind === "realized_summary") return `${nin}_RealizedProfitLossSummary.xlsx`;
  return `${nin}_RealizedProfitLossTransactionDetails.xlsx`;
}

function sheet(name: string) {
  return name.replace(/[\\/?*[\]]/g, "-").slice(0, 31);
}

function portfolioRows(stmt: PortfolioStatement) {
  return stmt.sectors.flatMap((sector) =>
    sector.lines.map((l) => ({
      Sector: sector.sectorName,
      Company: l.companyName,
      Currency: l.currency,
      Code: l.compId,
      Type: l.accountTypePrinted,
      Shares: l.quantity,
      SharesValue: l.costValue,
      ShareCost: l.shareCost,
      BreakEven: money(l.breakEven),
      ClosePrice: l.closePrice,
      CloseDate: l.closeDate,
      PriceSource: l.priceSource,
      MarketValue: l.marketValue,
      DisplayedProfit: money(l.displayedProfit),
      DisplayedProfitPct: money(l.displayedProfitPct),
      CurrencyDifference: l.currencyDifference,
    })),
  );
}

function accountRows(stmt: AccountStatement) {
  return stmt.lines.map((l) => ({
    PostDate: l.postDate,
    DocDate: l.docDate,
    TransType: l.transType,
    TransNo: l.transNo,
    Description: l.description,
    Quantity: l.quantity,
    SecurityPrice: money(l.securityPrice),
    SecurityPriceWithComm: money(l.securityPriceWithComm),
    MarketFees: money(l.marketFees),
    Commission: money(l.commission),
    Debit: l.debit,
    Credit: l.credit,
    Balance: l.balance,
    Status: l.status,
    Opening: l.isOpening ? "Y" : "",
    Unposted: l.isUnposted ? "Y" : "",
  }));
}

function summaryRows(stmt: RealizedSummaryStatement) {
  return stmt.lines.map((l) => ({
    Company: l.companyName,
    Ticker: l.ticker,
    Code: l.compId,
    Type: l.accountTypePrinted,
    TradingProfit: l.tradingProfit,
    DistributedDividends: money(l.distributedDividends),
    NonReceivedDividends: money(l.nonReceivedDividends),
    TotalProfit: money(l.totalProfit),
  }));
}

function detailsRows(stmt: RealizedDetailsStatement) {
  return stmt.stocks.flatMap((stock) =>
    stock.lines.map((l) => ({
      Company: stock.companyName,
      Ticker: stock.ticker,
      Code: stock.compId,
      Date: l.date,
      InvNo: l.invNo,
      Side: l.side,
      BuyQty: l.buyQty,
      SellQty: l.sellQty,
      ShareBalance: l.shareBalance,
      Price: l.price,
      BuyValue: l.buyValue,
      SellValue: l.sellValue,
      ShareCost: l.shareCost,
      GrossSaleCost: l.grossSaleCost,
      DayResult: l.dayResult,
      ProfitLossCumulative: l.profitLossCumulative,
      Opening: l.isOpening ? "Y" : "",
    })),
  );
}

function headerRows(stmt: ClientStatement) {
  const dates =
    stmt.dates.mode === "as_of"
      ? { AsOf: stmt.dates.asOf, From: "", To: "" }
      : { AsOf: "", From: stmt.dates.from, To: stmt.dates.to };
  return [
    {
      Company: stmt.company.legalName,
      TitleEn: stmt.titleEn,
      TitleAr: stmt.titleAr,
      NIN: stmt.investor.nin,
      ClientNo: stmt.investor.clientCode,
      AccountId: stmt.investor.accountId,
      Name: stmt.investor.displayName,
      ...dates,
      PrintedAt: stmt.print.printedAtIso,
    },
  ];
}

export function statementWorkbook(stmt: ClientStatement): { filename: string; buffer: Buffer } {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(headerRows(stmt)), sheet("Header"));
  if (stmt.kind === "portfolio") {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(portfolioRows(stmt)), sheet("Holdings"));
  } else if (stmt.kind === "account") {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(accountRows(stmt)), sheet("Movements"));
  } else if (stmt.kind === "realized_summary") {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows(stmt)), sheet("Summary"));
  } else {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailsRows(stmt)), sheet("Details"));
  }
  const buffer = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  return { filename: filenameFor(stmt), buffer };
}
