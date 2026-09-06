import { describe, expect, it } from "vitest";
import XLSX from "xlsx";
import { parseWhatsAppPhoneWorkbook, validatePhoneImportRows } from "./phone-import.js";

describe("WhatsApp phone import", () => {
  it("accepts Qatar E.164 and 8-digit local, rejects Egypt 01", () => {
    const rows = validatePhoneImportRows([
      { phone: "+974 3311 2233", displayName: "Ahmed", row: 2 },
      { phone: "33114455", displayName: "Sara", row: 3 },
      { phone: "01012345678", displayName: "Cairo", row: 4 },
      { phone: "", displayName: "Missing", row: 5 },
    ]);
    expect(rows[0]).toMatchObject({ ok: true, waId: "97433112233" });
    expect(rows[1]).toMatchObject({ ok: true, waId: "97433114455" });
    expect(rows[2].ok).toBe(false);
    expect(rows[3].ok).toBe(false);
  });

  it("flags duplicate waIds after normalize", () => {
    const rows = validatePhoneImportRows([
      { phone: "97433112233", displayName: "A", row: 2 },
      { phone: "33112233", displayName: "B", row: 3 },
    ]);
    expect(rows[0].ok).toBe(true);
    expect(rows[1].ok).toBe(false);
    expect(rows[1].error).toMatch(/Duplicate of row 2/);
  });

  it("parses the Data sheet from a workbook buffer", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["phone", "display_name"],
      ["97433112233", "Ahmed Al-Kuwari"],
      ["33114455", "Sara"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const rows = parseWhatsAppPhoneWorkbook(buf);
    expect(rows).toHaveLength(2);
    expect(rows[0].ok).toBe(true);
    expect(rows[1].waId).toBe("97433114455");
  });
});
