import { describe, expect, it } from "vitest";
import { mapBenchmarkIndex } from "./benchmark-index.js";
import { parseKbIndexMarkdown, SAMPLE_DSM_LEVEL, SAMPLE_QERI_LEVEL } from "./kb-indices.js";

const SAMPLE = `## Sheet 1
| CI\\_DATE | CIE\\_DESC | CI\\_CURRENT\\_INDEX | CI\\_MRK\\_INDEX\\_CODE |
| --- | --- | --- | --- |
| 2024-12-31 13:14:52 | General Index | 1.00 | 55 |
| 2024-12-31 13:14:52 | Telecoms | 1160.19 | 128 |
| 2024-12-31 18:00:00 | General Index | 10571.09 | 55 |
| 2026-06-21 13:10:12 | QE Al Rayan Islamic Index | 5253.00 | QERI |
`;

describe("mapBenchmarkIndex", () => {
  it("maps QERI code and Al Rayan name", () => {
    expect(mapBenchmarkIndex("QERI", "anything")).toBe("QERI");
    expect(mapBenchmarkIndex("", "QE Al Rayan Islamic Index")).toBe("QERI");
  });

  it("maps General Index code 55 to DSM and skips sector series", () => {
    expect(mapBenchmarkIndex("55", "General Index")).toBe("DSM");
    expect(mapBenchmarkIndex("128", "Telecoms")).toBeNull();
  });
});

describe("parseKbIndexMarkdown", () => {
  it("keeps QERI and DSM last-wins per date and skips other series", () => {
    const parsed = parseKbIndexMarkdown(SAMPLE);
    const dsm = parsed.rows.find((r) => r.benchmark === "DSM" && r.date === "2024-12-31");
    const qeri = parsed.rows.find((r) => r.benchmark === "QERI" && r.date === "2026-06-21");
    expect(dsm?.value).toBe(SAMPLE_DSM_LEVEL);
    expect(qeri?.value).toBe(SAMPLE_QERI_LEVEL);
    expect(parsed.rows.some((r) => /telecom/i.test(r.name))).toBe(false);
    expect(parsed.skippedOtherSeries).toBe(1);
    expect(parsed.rows.filter((r) => r.benchmark === "DSM" && r.date === "2024-12-31")).toHaveLength(1);
  });
});
