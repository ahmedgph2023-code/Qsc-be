/**
 * Offline UAT-01 reconstruction: P&L + cash workbooks vs KB 31/12/2024 statement.
 * Does not print client names or other PII. Workbooks live under backend/historical-data/
 * (often gitignored). Exit 0 even when files are missing so CI stays green.
 *
 * Usage: npx tsx scripts/reconstruct-uat01.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import {
  applyReplayEvents,
  eventsThroughAsOf,
  type ReplayEvent,
} from "../src/services/holdings-replay.js";
import { sumCashLedgerAsOf } from "../src/services/cash-sign.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HIST = path.resolve(__dirname, "../historical-data");
const ASOF = "2024-12-31";

function findFile(root: string, fileName: string): string | null {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name.toLowerCase() === fileName.toLowerCase()) return full;
    }
  }
  return null;
}

function excelDateToIsoUtc(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + Math.round(value) * 86400000).toISOString().slice(0, 10);
  }
  return null;
}

function excelDateToIsoQatar(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  }
  return excelDateToIsoUtc(value);
}

type SideMap = Record<string, number>;

function parsePnl(pnlPath: string, dateFn: (v: unknown) => string | null) {
  const wb = XLSX.readFile(pnlPath, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], {
    defval: null,
  });
  const sides: SideMap = {};
  const events: ReplayEvent[] = [];
  const lastBal = new Map<string, { date: string; bal: number }>();
  let skipped = 0;
  let transferIn = 0;
  let transferOut = 0;
  let gissQtyPrice = 0;
  let gissExcelBuyValue = 0;
  let gissBuyRows = 0;

  for (const row of rows) {
    const ticker = String(row["Ticker ID"] || "").trim().toUpperCase();
    const sideRaw = String(row["Order Side"] || "").trim().toLowerCase();
    sides[sideRaw] = (sides[sideRaw] || 0) + 1;
    if (!ticker) {
      skipped++;
      continue;
    }
    const date = dateFn(row.Date);
    if (!date) {
      skipped++;
      continue;
    }
    let type: "BUY" | "SELL" | "CLIENT_TRANSFER" | null = null;
    let qty = 0;
    if (sideRaw === "buy") {
      type = "BUY";
      qty = Number(row["Buy Qty"] || 0);
    } else if (sideRaw === "sell") {
      type = "SELL";
      qty = Number(row["Sell Qty"] || 0);
    } else if (sideRaw === "equity transfer-in") {
      type = "CLIENT_TRANSFER";
      qty = Number(row["Buy Qty"] || 0);
      transferIn++;
    } else if (sideRaw === "equity transfer-out") {
      type = "SELL";
      qty = Number(row["Sell Qty"] || 0);
      transferOut++;
    } else {
      skipped++;
      continue;
    }
    const price = Number(row.Price || 0);
    if (!type || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
      skipped++;
      continue;
    }
    events.push({ kind: "tx", date, sort: events.length, stockId: ticker, type, quantity: qty, price });
    if (date <= ASOF) {
      lastBal.set(ticker, { date, bal: Number(row["Share Balance"] || 0) });
      if (ticker === "GISS" && (type === "BUY" || type === "CLIENT_TRANSFER")) {
        gissQtyPrice += qty * price;
        gissExcelBuyValue += Number(row["Buy Value"] || 0);
        gissBuyRows++;
      }
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.sort - b.sort);
  const clipped = eventsThroughAsOf(events, ASOF);
  const pos = applyReplayEvents(clipped);
  const holdings: Record<
    string,
    {
      engineQty: number;
      engineCost: number;
      engineAvg: number;
      excelShareBal: number | null;
      excelBalDate: string | null;
      qtyDelta: number | null;
    }
  > = {};
  const tickers = new Set([...pos.keys(), ...lastBal.keys()]);
  for (const t of [...tickers].sort()) {
    const p = pos.get(t) || { quantity: 0, totalCost: 0 };
    const excel = lastBal.get(t);
    holdings[t] = {
      engineQty: p.quantity,
      engineCost: Math.round(p.totalCost * 10000) / 10000,
      engineAvg: p.quantity > 0 ? Math.round((p.totalCost / p.quantity) * 1e8) / 1e8 : 0,
      excelShareBal: excel?.bal ?? null,
      excelBalDate: excel?.date ?? null,
      qtyDelta: excel != null ? p.quantity - excel.bal : null,
    };
  }

  return {
    rowCount: rows.length,
    eventCount: events.length,
    clipped: clipped.length,
    skipped,
    transferIn,
    transferOut,
    gissBuysThroughAsOf: {
      rows: gissBuyRows,
      qtyPrice: Math.round(gissQtyPrice * 10000) / 10000,
      excelBuyValue: Math.round(gissExcelBuyValue * 10000) / 10000,
      delta: Math.round((gissExcelBuyValue - gissQtyPrice) * 10000) / 10000,
    },
    sides,
    holdings,
    events,
  };
}

function parseStatement(stmtPath: string) {
  const wb = XLSX.readFile(stmtPath, { cellDates: true });
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
    header: 1,
    defval: "",
  });
  const labels: Record<string, unknown> = {};
  for (const row of matrix) {
    const a = String(row[0] ?? "").trim().toUpperCase();
    if (a === "CASH" || a === "NAV") labels[a] = row[1];
  }
  const equityRows = matrix
    .filter((row) => String(row[1] ?? "").includes("QA000"))
    .map((row) => ({
      isin: String(row[1]),
      qty: Number(row[4]),
      value: Number(row[7]),
      cost: Number(row[9]),
      eqPrice: Number(row[11]),
      close: Number(row[12]),
      mv: Number(row[15]),
      pl: Number(row[17]),
    }));
  return { labels, equityRows, sheetRows: matrix.length };
}

function cellStr(row: unknown[], i: number | undefined): string {
  if (i == null) return "";
  return String(row[i] ?? "").trim();
}

function parseDmy(value: unknown): string | null {
  const s = String(value ?? "").trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
  return null;
}

function parseCash(cashPath: string, dateFn: (v: unknown) => string | null) {
  const wb = XLSX.readFile(cashPath, { cellDates: true });
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
    header: 1,
    defval: "",
  });
  let headerIdx = -1;
  for (let i = 0; i < matrix.length; i++) {
    const joined = matrix[i].map((c) => String(c).toLowerCase()).join("|");
    if (joined.includes("post date")) {
      headerIdx = i;
      break;
    }
  }
  const allCash: Array<{ type: string; amount: number; tradeDate: string }> = [];
  const seedNonTrade: Array<{ type: string; amount: number; tradeDate: string }> = [];
  let lastBalAsOf: number | null = null;
  const seedLooksAtCol1 = headerIdx >= 0 && String(matrix[headerIdx][1]).toLowerCase().includes("post date");

  if (headerIdx < 0) {
    return { headerIdx, seedLooksAtCol1, allCash, seedNonTrade, lastBalAsOf };
  }

  const headers = matrix[headerIdx].map((c) => String(c).toLowerCase().replace(/\s+/g, " ").trim());
  const idx = (name: string) => headers.findIndex((h) => h.includes(name));
  const iDate = idx("post date");
  const iSide = idx("order side");
  const iDesc = idx("description");
  const iDebit = idx("debit");
  const iCredit = idx("credit");
  const iBal = headers.findIndex((h) => h === "bal." || h === "bal" || h.includes("bal."));

  if (iDate < 0 || iDebit < 0 || iCredit < 0) {
    return { headerIdx, seedLooksAtCol1, allCash, seedNonTrade, lastBalAsOf };
  }

  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const row = matrix[i];
    const postDate = dateFn(row[iDate]) || parseDmy(row[iDate]);
    const orderSide = cellStr(row, iSide).toLowerCase();
    const desc = cellStr(row, iDesc);
    const debit = Number(row[iDebit] || 0);
    const credit = Number(row[iCredit] || 0);
    const balRaw = String(row[iBal] ?? "").replace(/,/g, "").trim();
    const bal = balRaw === "" ? null : Number(balRaw);
    if (!postDate) continue;
    if (!desc && !debit && !credit && bal == null) continue;
    if (postDate <= ASOF && bal != null && Number.isFinite(bal)) lastBalAsOf = bal;

    if (credit > 0 && debit <= 0) {
      let type = "deposit";
      if (/dividend|توزيع/i.test(desc)) type = "dividend";
      else if (/fee|charge|عمولة/i.test(desc)) type = "fee";
      allCash.push({ type, amount: credit, tradeDate: postDate });
    } else if (debit > 0 && credit <= 0) {
      let type = "withdrawal";
      if (/fee|charge|عمولة/i.test(desc)) type = "fee";
      if (orderSide === "buy") type = "trade_buy";
      else if (orderSide === "sell") type = "trade_sell";
      allCash.push({ type, amount: debit, tradeDate: postDate });
    }

    if (orderSide === "buy" || orderSide === "sell") continue;
    if (/starting balance/i.test(desc)) continue;
    if (credit > 0 && debit <= 0) {
      let type = "deposit";
      if (/dividend|توزيع/i.test(desc)) type = "dividend";
      else if (/fee|charge|عمولة/i.test(desc)) type = "fee";
      seedNonTrade.push({ type, amount: credit, tradeDate: postDate });
    } else if (debit > 0 && credit <= 0) {
      let type = "withdrawal";
      if (/fee|charge|عمولة/i.test(desc)) type = "fee";
      seedNonTrade.push({ type, amount: debit, tradeDate: postDate });
    }
  }

  return { headerIdx, seedLooksAtCol1, allCash, seedNonTrade, lastBalAsOf };
}

function main() {
  const identity = {
    qty: 1_300_000,
    close: 3.328,
    cash: 144_708.17,
    mv: 1_300_000 * 3.328,
    nav: 1_300_000 * 3.328 + 144_708.17,
    targetNav: 4_471_108.17,
  };
  const mhar = {
    qty: 1_993_508,
    price: 1.504,
    qtyPrice: 1_993_508 * 1.504,
    excelBuyValue: 2_998_459.35,
    delta: 2_998_459.35 - 1_993_508 * 1.504,
  };

  const pnlPath = findFile(HIST, "PMProfitLossTransaction.xls");
  const cashPath = findFile(HIST, "FMClientAccountSummary.xls");
  const stmtPath = findFile(HIST, "Portfolio31122024.xls");
  const workbookPath = findFile(HIST, "investment portfolio.xlsx");

  if (!pnlPath || !cashPath || !stmtPath) {
    console.log(
      JSON.stringify(
        {
          status: "files_missing",
          found: { pnl: !!pnlPath, cash: !!cashPath, statementXls: !!stmtPath, investmentPortfolioXlsx: !!workbookPath },
          identity,
          mhar,
        },
        null,
        2,
      ),
    );
    return;
  }

  const utc = parsePnl(pnlPath, excelDateToIsoUtc);
  const qatar = parsePnl(pnlPath, excelDateToIsoQatar);
  const stmt = parseStatement(stmtPath);
  const cash = parseCash(cashPath, excelDateToIsoUtc);

  const tradeCashFromPnl = utc.events
    .filter((ev): ev is Extract<ReplayEvent, { kind: "tx" }> => ev.kind === "tx" && ev.date <= ASOF)
    .map((ev) => ({
      type: ev.type === "SELL" ? "trade_sell" : "trade_buy",
      amount: ev.quantity * ev.price,
      tradeDate: ev.date,
    }));

  const report = {
    status: "ok",
    asOf: ASOF,
    found: { pnl: true, cash: true, statementXls: true, investmentPortfolioXlsx: !!workbookPath },
    identity,
    mhar,
    pnl: {
      rowCount: utc.rowCount,
      sides: utc.sides,
      transferIn: utc.transferIn,
      transferOut: utc.transferOut,
      gissBuysThroughAsOf: utc.gissBuysThroughAsOf,
      utcHoldings: utc.holdings,
      qatarHoldings: qatar.holdings,
    },
    statementXls: stmt,
    cash: {
      headerIdx: cash.headerIdx,
      seedLooksAtCol1: cash.seedLooksAtCol1,
      lastWorkbookBalAsOf: cash.lastBalAsOf,
      excelFileSignedAsOf: sumCashLedgerAsOf(cash.allCash, ASOF),
      seedNonTradeAsOf: sumCashLedgerAsOf(cash.seedNonTrade, ASOF),
      liveLikeSeedPlusQtyPrice: sumCashLedgerAsOf([...cash.seedNonTrade, ...tradeCashFromPnl], ASOF),
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
