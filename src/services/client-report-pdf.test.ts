import { describe, expect, it } from "vitest";
import { generateClientReportPdf, resolveClientReportLogoPath } from "./client-report-pdf.js";
import type { ClientReportPayload } from "./client-report-engine.js";

describe("client-report-pdf", () => {
  it("resolves the dashboard brand logo when present", () => {
    const logo = resolveClientReportLogoPath();
    expect(logo).toBeTruthy();
    expect(logo).toMatch(/logo/i);
  });

  it("builds a non-empty PDF with %PDF header", async () => {
    const payload: ClientReportPayload = {
      title: "Client Report — Test Client",
      generatedAt: "2026-09-03T12:00:00.000Z",
      asOf: "2026-09-03",
      from: "2026-09-03",
      to: "2026-09-03",
      client: { id: 1, name: "Test Client", email: "a@b.c", phone: "+97450000000" },
      sections: {
        performance: {
          asOf: "2026-09-03",
          nav: 1000,
          marketValue: 900,
          cost: 800,
          cash: 100,
          netPl: 200,
        },
        transactions: [
          {
            postDate: "2026-09-01",
            transType: "BUY",
            description: "Sample",
            debit: 100,
            credit: 0,
            balance: 100,
          },
        ],
      },
      sectionLabels: {
        portfolio_statement: "Portfolio statement",
        account_statement: "Account statement",
        realized_summary: "Realized P&L summary",
        realized_details: "Realized P&L details",
        balance_snapshot: "Balance reconciliation",
        transactions: "Transactions",
        performance: "Performance summary",
      },
    };

    const pdf = await generateClientReportPdf(payload);
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.filename).toContain("2026-09-03");
    expect(pdf.buffer.length).toBeGreaterThan(500);
    expect(pdf.buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });
});
