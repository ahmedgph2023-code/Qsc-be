import { describe, expect, it } from "vitest";
import {
  applyReplayEvents,
  eventsThroughAsOf,
  currentLotOpenedOn,
  calendarDaysBetween,
  lastTxPrice,
  navAllocation,
  excelHoldingReturn,
  excelAnnualizedReturn,
  excelReturnContribution,
  excelEquityTotals,
  type ReplayEvent,
} from "./holdings-replay.js";

const MHAR = "mhar";
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const avg = (pos: { quantity: number; totalCost: number }) =>
  pos.quantity > 0 ? pos.totalCost / pos.quantity : 0;

function tx(
  date: string,
  type: "BUY" | "SELL" | "CLIENT_TRANSFER",
  quantity: number,
  price: number,
  stockId = MHAR,
): ReplayEvent {
  return { kind: "tx", date, sort: 0, stockId, type, quantity, price };
}

function pos(events: ReplayEvent[], stockId = MHAR) {
  return applyReplayEvents(events).get(stockId) ?? { quantity: 0, totalCost: 0 };
}

/** Live realized P/L contract in getPortfolioMetrics: sellQty × (price − avgCost). */
function realizedFromChain(events: ReplayEvent[], stockId = MHAR): number {
  let realized = 0;
  let quantity = 0;
  let totalCost = 0;
  for (const ev of events) {
    if (ev.kind !== "tx" || ev.stockId !== stockId) continue;
    if (ev.type !== "SELL") {
      quantity += ev.quantity;
      totalCost += ev.quantity * ev.price;
    } else {
      const sellQty = Math.min(ev.quantity, quantity);
      const avgCost = quantity > 0 ? totalCost / quantity : 0;
      realized += sellQty * (ev.price - avgCost);
      quantity -= sellQty;
      totalCost -= sellQty * avgCost;
    }
  }
  return realized;
}

describe("applyReplayEvents — WAC qty/cost (WAVE-1-MAPPING MATCH; HP-W2)", () => {
  const buy1 = tx("2024-07-02", "BUY", 1_000, 1.53);
  const buy2 = tx("2024-07-02", "BUY", 1_993_508, 1.504);
  /** Excel §31 sell value 1,981.40 / 1,130. Live WAC uses qty × price, not a separate proceeds column. */
  const sellQty = 1_130;
  const sellValue = 1_981.4;
  const sellPrice = sellValue / sellQty;
  const sell1 = tx("2024-07-03", "SELL", sellQty, sellPrice);

  it("buy then buy updates shares and average cost (requirements §9 / §31)", () => {
    const first = pos([buy1]);
    expect(first.quantity).toBe(1_000);
    expect(first.totalCost).toBe(1_530);
    expect(avg(first)).toBe(1.53);

    const both = pos([buy1, buy2]);
    expect(both.quantity).toBe(1_994_508);
    expect(both.totalCost).toBe(1_000 * 1.53 + 1_993_508 * 1.504);
    expect(avg(both)).toBeCloseTo(both.totalCost / 1_994_508, 12);
  });

  it("Excel §31 second-buy value 2,998,459.35 is not qty×price (characterization, do not rewrite)", () => {
    const liveBuy2Value = 1_993_508 * 1.504;
    expect(liveBuy2Value).not.toBe(2_998_459.35);
    expect(pos([buy1, buy2]).totalCost).toBe(1_530 + liveBuy2Value);
  });

  it("sell reduces shares and keeps remaining average (requirements §10 / §31)", () => {
    const before = pos([buy1, buy2]);
    const after = pos([buy1, buy2, sell1]);
    expect(after.quantity).toBe(1_994_508 - sellQty);
    expect(avg(after)).toBeCloseTo(avg(before), 10);
    expect(round4(after.totalCost)).toBeCloseTo(round4(after.quantity * avg(before)), 4);
  });

  it("sell realized P/L is sellQty × (price − previous avg) (getPortfolioMetrics contract)", () => {
    const before = pos([buy1, buy2]);
    const expected = sellQty * (sellPrice - avg(before));
    expect(realizedFromChain([buy1, buy2, sell1])).toBeCloseTo(expected, 8);
  });

  it("does not include commission in WAC (HP-CONF-06 / P-COMM; ReplayEvent has no commission field)", () => {
    const lot = pos([tx("2024-01-01", "BUY", 100, 10)]);
    expect(lot.totalCost).toBe(1_000);
    expect(avg(lot)).toBe(10);
    expect(avg(lot)).not.toBe(10.05);
  });

  it("caps sell quantity at shares held", () => {
    const after = pos([buy1, tx("2024-07-04", "SELL", 5_000, 2)]);
    expect(after.quantity).toBe(0);
    expect(after.totalCost).toBeCloseTo(0, 10);
  });

  it("full close then new buy starts a new cost lot (qty/cost only; holding-period date is HP-CONF-04 / Wave 4)", () => {
    const chain = [
      buy1,
      tx("2024-07-04", "SELL", 1_000, 2),
      tx("2024-08-01", "BUY", 50, 3),
    ];
    const after = pos(chain);
    expect(after.quantity).toBe(50);
    expect(avg(after)).toBe(3);
  });

  it("CLIENT_TRANSFER adds qty × price like a buy (HP-CONF-05 characterization; not a product decision)", () => {
    const after = pos([buy1, tx("2024-07-05", "CLIENT_TRANSFER", 100, 2)]);
    expect(after.quantity).toBe(1_100);
    expect(after.totalCost).toBe(1_530 + 200);
  });

  it("bonus/split CA changes qty and leaves total cost unchanged when costDelta is 0", () => {
    const after = applyReplayEvents([
      buy1,
      { kind: "ca", date: "2024-08-01", sort: 1, stockId: MHAR, qtyDelta: 1_000, costDelta: 0 },
    ]).get(MHAR)!;
    expect(after.quantity).toBe(2_000);
    expect(after.totalCost).toBe(1_530);
  });
});

describe("eventsThroughAsOf — as-of clip (getPortfolioHoldings contract)", () => {
  it("drops events with date after asOf; keeps same-day events", () => {
    const events: ReplayEvent[] = [
      tx("2024-07-01", "BUY", 10, 1),
      tx("2024-07-02", "BUY", 5, 2),
      tx("2024-07-02", "SELL", 1, 3),
    ];
    expect(eventsThroughAsOf(events, "2024-07-01")).toEqual([events[0]]);
    expect(eventsThroughAsOf(events, "2024-07-02")).toEqual(events);
    expect(applyReplayEvents(eventsThroughAsOf(events, "2024-07-01")).get(MHAR)?.quantity).toBe(10);
  });

  it("without asOf returns the same array reference", () => {
    const events = [tx("2024-07-01", "BUY", 1, 1)];
    expect(eventsThroughAsOf(events)).toBe(events);
  });
});

describe("currentLotOpenedOn / calendarDaysBetween — current lot only (HP-CONF-04 / §21)", () => {
  it("keeps the first buy of the open lot when later buys add", () => {
    expect(currentLotOpenedOn([
      tx("2024-07-02", "BUY", 1_000, 1.53),
      tx("2024-07-02", "BUY", 1_993_508, 1.504),
    ], MHAR)).toBe("2024-07-02");
  });

  it("resets after a full close then a new buy", () => {
    expect(currentLotOpenedOn([
      tx("2024-07-02", "BUY", 1_000, 1.53),
      tx("2024-07-04", "SELL", 1_000, 2),
      tx("2024-08-01", "BUY", 50, 3),
    ], MHAR)).toBe("2024-08-01");
  });

  it("matches Excel DATEDIF day count", () => {
    expect(calendarDaysBetween("2024-08-01", "2024-08-01")).toBe(0);
    expect(calendarDaysBetween("2024-08-01", "2024-08-11")).toBe(10);
  });
});

describe("navAllocation — cash + sector weights vs NAV (HP-W4)", () => {
  it("puts cash on NAV and groups sectors by equity MV", () => {
    const a = navAllocation(
      [
        { sector: "Banks", currentValue: 70 },
        { sector: "Banks", currentValue: 10 },
        { sector: "Industry", currentValue: 20 },
      ],
      100,
    );
    expect(a.nav).toBe(200);
    expect(a.cash.weight).toBe(0.5);
    expect(a.sectors[0]).toMatchObject({ sector: "Banks", value: 80, weight: 0.4 });
  });
});

describe("excel workbook metrics — HP-W5 (not CFA / not GOV-02)", () => {
  it("holding return is equity ÷ cost − 1 (§22)", () => {
    expect(excelHoldingReturn(110, 100)).toBeCloseTo(0.1, 12);
    expect(excelHoldingReturn(100, 0)).toBeNull();
  });

  it("annualized uses (1+R)^(days/365)−1 not (1+R)^(365/days)−1 (§23 / HP-CONF-02)", () => {
    expect(excelAnnualizedReturn(0.1, 365)).toBeCloseTo(0.1, 12);
    const excel = excelAnnualizedReturn(0.1, 30);
    const cfa = 1.1 ** (365 / 30) - 1;
    expect(excel).toBeCloseTo(1.1 ** (30 / 365) - 1, 12);
    expect(excel).not.toBeCloseTo(cfa, 5);
  });

  it("contribution is null when total P/L is zero (§24)", () => {
    expect(excelReturnContribution(10, 40)).toBe(0.25);
    expect(excelReturnContribution(10, 0)).toBeNull();
  });

  it("portfolio growth/gain include cash like Table1 (§18–§19)", () => {
    const t = excelEquityTotals([
      { currentValue: 120, totalCost: 100 },
      { currentValue: 80, totalCost: 50 },
    ], 25);
    expect(t.equityValue).toBe(225);
    expect(t.totalCost).toBe(175);
    expect(t.gain).toBe(50);
    expect(t.growth).toBeCloseTo(225 / 175 - 1, 12);
  });
});

describe("lastTxPrice — sheet-preview fallback when no official close", () => {
  it("uses the last blotter price for that stock", () => {
    const events = [
      tx("2024-07-02", "BUY", 1_000, 1.53),
      tx("2024-07-03", "BUY", 500, 1.61),
      tx("2024-07-03", "BUY", 200, 9.9, "other"),
    ];
    expect(lastTxPrice(events, MHAR)).toBe(1.61);
    expect(lastTxPrice(events, "other")).toBe(9.9);
    expect(lastTxPrice(events, "missing")).toBe(0);
  });
});

describe("UAT-01 KB statement 31/12/2024 — HP-W6 identity (no DB)", () => {
  it("NAV = 1,300,000 × 3.328 + 144,708.17 (TESTING_STRATEGY / sample statement)", () => {
    const qty = 1_300_000;
    const close = 3.328;
    const cash = 144_708.17;
    const mv = qty * close;
    const nav = mv + cash;
    expect(mv).toBe(4_326_400);
    expect(nav).toBeCloseTo(4_471_108.17, 2);
  });

  it("statement Cost × qty matches Value column; P/L column is not MV − Value", () => {
    const qty = 1_300_000;
    const cost = 3.2363142154;
    const value = 4_207_208.48;
    const mv = 4_326_400;
    const statedPl = 107_293.92;
    expect(qty * cost).toBeCloseTo(value, 2);
    expect(mv - value).toBeCloseTo(119_191.52, 2);
    expect(statedPl).not.toBeCloseTo(mv - value, 0);
  });
});

