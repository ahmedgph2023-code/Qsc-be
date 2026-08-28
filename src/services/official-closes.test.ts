import { describe, expect, it } from "vitest";
import { parseKbPriceMarkdown } from "./official-closes.js";

const SAMPLE = `## Sheet 1
| TICKER\\_ID | PR\\_PRICE\\_DATE | PR\\_SHARE\\_PRICE | PR\\_ASK | PR\\_OFF | PR\\_O\\_NUM | PR\\_VOL | PR\\_MON | PR\\_OP\\_PRICE | PR\\_H\\_PRICE | PR\\_L\\_PRICE | PR\\_C\\_PRICE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UDCD | 2015-07-22 | 24.620 | 24.650 | 24.900 | 10 | 13513 | 2015/07 | 24.980 | 24.980 | 24.600 | 24.620 |
| MHAR | 2024-12-01 | 2.508 | 2.507 | 2.508 | 14 | 139684 | 2024/12 | 2.575 | 2.575 | 2.500 | 2.508 |
| R008 | 2026-07-27 | 1.000 | 1.000 | 1.000 | 0 | 0 | 2026/07 | 1.000 | 1.000 | 1.000 | 1.000 |
`;

describe("parseKbPriceMarkdown", () => {
  it("reads CB_PRICES markdown including MHAR 2024-12-01 close 2.508", () => {
    const parsed = parseKbPriceMarkdown(SAMPLE);
    const mhar = parsed.rows.find((r) => r.ticker === "MHAR" && r.date === "2024-12-01");
    expect(mhar?.price).toBe(2.508);
    expect(parsed.rows.some((r) => r.ticker === "UDCD")).toBe(true);
    expect(parsed.rows.some((r) => r.ticker.startsWith("R0"))).toBe(false);
  });
});
