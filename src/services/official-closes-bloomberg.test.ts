import { describe, expect, it } from "vitest";
import { bloombergEquityTicker, parseBloombergLastPriceRows } from "./official-closes.js";

describe("Bloomberg AI prices parse", () => {
  it("strips QD Equity suffix", () => {
    expect(bloombergEquityTicker("MHAR QD Equity")).toBe("MHAR");
    expect(bloombergEquityTicker("DSM Index")).toBeNull();
  });

  it("parses Last price matrix from fromDate", () => {
    const rows: unknown[][] = [
      [null, "MHAR QD Equity", "GISS QD Equity", "DSM Index"],
      [null, "PX_LAST", "PX_LAST", "PX_LAST"],
      [new Date("2026-08-18T00:00:00.000Z"), 2.0, 3.0, 100],
      [new Date("2026-08-19T00:00:00.000Z"), 2.14, 3.1, 101],
    ];
    const parsed = parseBloombergLastPriceRows(rows, { fromDate: "2026-08-19" });
    expect(parsed.tickers).toEqual(["MHAR", "GISS"]);
    expect(parsed.rows).toEqual([
      { ticker: "MHAR", date: "2026-08-19", price: 2.14 },
      { ticker: "GISS", date: "2026-08-19", price: 3.1 },
    ]);
  });
});
