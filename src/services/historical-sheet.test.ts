import { describe, expect, it } from "vitest";
import {
  detectKindFromFilename,
  detectKindFromHeaders,
  extractSheetIdentity,
  findHeaderRow,
  inspectWorkbook,
  mapTradeSide,
  blotterUnitPrice,
  parseCashMatrix,
  parseClients,
  parseTrades,
  previewFromInspect,
  validateHeaders,
} from "./historical-sheet.js";
import { applyReplayEvents } from "./holdings-replay.js";

describe("historical-sheet — kind detection", () => {
  it("maps QSC filenames", () => {
    expect(detectKindFromFilename("CMClientDetails.xls")).toBe("client");
    expect(detectKindFromFilename("PMProfitLossTransaction.xls")).toBe("trades");
    expect(detectKindFromFilename("FMClientAccountSummary.xls")).toBe("cash");
    expect(detectKindFromFilename("CB_PRICES.xls")).toBe("prices");
    expect(detectKindFromFilename("CB_SEC_COMP.xls")).toBe("securities");
    expect(detectKindFromFilename("CH_CURRENT_INDEX.xls")).toBe("indices");
    expect(detectKindFromFilename("ipms-bulk-template.xlsx")).toBeNull();
  });

  it("does not treat a P&L sheet as prices", () => {
    expect(detectKindFromHeaders(["Order Side", "Ticker ID", "Date", "Price", "Buy Qty"])).toBe("trades");
  });

  it("requires broker price column names", () => {
    const ok = validateHeaders("prices", ["TICKER_ID", "PR_PRICE_DATE", "PR_C_PRICE"]);
    expect(ok.ok).toBe(true);
    const missing = validateHeaders("prices", ["Ticker ID", "Date", "Price"]);
    expect(missing.ok).toBe(false);
    expect(missing.missing).toContain("PR_PRICE_DATE");
  });
});

describe("historical-sheet — cash header in column 0", () => {
  it("finds Post Date anywhere in the header row", () => {
    const matrix = [
      ["Post Date", "Status", "Order Side", "Doc. No", "Description", "x", "y", "z", "a", "Debit", "Credit", "Bal."],
      ["2024-01-02", "Posted", "Transfer", "1", "Transfer to Client Investment Account", "", "", "", "", "", "500000", "500000"],
      ["2024-01-03", "Posted", "Buy", "2", "Buy Securities", "", "", "", "", "1000", "", "499000"],
      ["2024-01-04", "Posted", "", "3", "Management fees", "", "", "", "", "250", "", "498750"],
    ];
    const header = findHeaderRow(matrix, ["post date"]);
    expect(header?.index).toBe(0);
    const parsed = parseCashMatrix(matrix);
    expect(parsed.headerIndex).toBe(0);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].type).toBe("deposit");
    expect(parsed.rows[0].amount).toBe(500000);
    expect(parsed.rows[1].type).toBe("fee");
    expect(parsed.rows[1].amount).toBe(250);
  });

  it("still finds Post Date when it is not in column 1", () => {
    const matrix = [
      ["junk", "junk"],
      ["Post Date", "Order Side", "Debit", "Credit"],
      ["15/01/2024", "Deposit", "", "100"],
    ];
    expect(findHeaderRow(matrix, ["post date"])?.index).toBe(1);
    const parsed = parseCashMatrix(matrix);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].type).toBe("deposit");
  });
});

describe("historical-sheet — review grid and identity", () => {
  it("extracts name / email / client code from trade columns", () => {
    const identity = extractSheetIdentity([{
      "Client Name": "سعد احمد",
      "Client Code": "1800101035339",
      Email: "pm@qsc.qa",
      Mobile: "555",
      "Order Side": "Buy",
      "Ticker ID": "GISS",
    }], []);
    expect(identity).toMatchObject({
      name: "سعد احمد",
      accountNumber: "1800101035339",
      email: "pm@qsc.qa",
      mobile: "555",
    });
  });

  it("reads Client Name : value cells and the Client ID / Account ID table", () => {
    const identity = extractSheetIdentity([], [
      ["", "", "", "Client Name : سعد احمد ابراهيم الحسن المهندى"],
      ["", "", "", "From Date : 30/07/2023 To Date : 30/07/2026"],
      [],
      ["Client ID", "Account ID", "Account Name", "Currency", "Account Type", "Actual Balance"],
      [1800101035339, 2041929, "سعد احمد", "Qatari Riyal", "INV PORT", 3101137.69],
      ["", "Post Date", "Debit", "Credit"],
    ]);
    expect(identity.name).toBe("سعد احمد ابراهيم الحسن المهندى");
    expect(identity.accountNumber).toBe("2041929");
    expect(identity.nin).toBe("1800101035339");
    expect(identity.notes).toContain("INV PORT");
    expect(identity.notes).toContain("Qatari Riyal");
  });

  it("ignores masked emails and reads label/value rows above a cash header", () => {
    const identity = extractSheetIdentity([], [
      ["Client Name", "Sample Investor"],
      ["Client Code", "2041929"],
      ["Email", "sxxxxxxx@gmail.com"],
      ["Post Date", "Debit", "Credit"],
    ]);
    expect(identity.name).toBe("Sample Investor");
    expect(identity.accountNumber).toBe("2041929");
    expect(identity.email).toBe("");
  });

  it("returns every sheet column in the preview grid, not a 6-column sample", () => {
    const inspect = inspectWorkbook(
      {
        SheetNames: ["P&L"],
        Sheets: {
          "P&L": {
            "!ref": "A1:G3",
            A1: { t: "s", v: "Order Side" },
            B1: { t: "s", v: "Ticker ID" },
            C1: { t: "s", v: "Date" },
            D1: { t: "s", v: "Price" },
            E1: { t: "s", v: "Buy Qty" },
            F1: { t: "s", v: "Client Code" },
            G1: { t: "s", v: "Invoice No" },
            A2: { t: "s", v: "Buy" },
            B2: { t: "s", v: "GISS" },
            C2: { t: "s", v: "2024-01-15" },
            D2: { t: "n", v: 3.2 },
            E2: { t: "n", v: 1000 },
            F2: { t: "s", v: "1800101035339" },
            G2: { t: "n", v: 99 },
            A3: { t: "s", v: "Sell" },
            B3: { t: "s", v: "QNBK" },
            C3: { t: "s", v: "2024-01-15" },
            D3: { t: "n", v: 10 },
            E3: { t: "n", v: 50 },
            F3: { t: "s", v: "1800101035339" },
            G3: { t: "n", v: 100 },
          },
        },
      } as never,
      "PMProfitLossTransaction.xls",
      "trades",
    );
    const preview = previewFromInspect(inspect);
    expect(preview.grid.headers).toEqual(expect.arrayContaining([
      "Order Side", "Ticker ID", "Date", "Price", "Buy Qty", "Client Code", "Invoice No",
    ]));
    expect(preview.grid.sheetColCount).toBeGreaterThanOrEqual(7);
    expect(preview.grid.rows.length).toBe(2);
    expect(preview.identity.accountNumber).toBe("1800101035339");
    expect(preview.issues.some((issue) => issue.code === "MISSING_KEYS")).toBe(false);
  });
});

describe("historical-sheet — client and trades", () => {
  it("parses client keys from CMClientDetails-style rows", () => {
    const parsed = parseClients([{
      "Client Name": "Sample Investor",
      Email: "sxxxxxxx@gmail.com",
      "Creation Date": "2023-11-07",
      "Client Code": "1800101035339",
      NIN: "37808",
      "Contract No.": "C-1",
      "Risk Management": "Medium",
    }]);
    expect(parsed.rows[0].accountNumber).toBe("1800101035339");
    expect(parsed.rows[0].nin).toBe("37808");
    expect(parsed.rows[0].email).toBe("client.37808@qsc.local");
  });

  it("maps equity transfer-in to CLIENT_TRANSFER and transfer-out to SELL", () => {
    expect(mapTradeSide("equity transfer-in")?.type).toBe("CLIENT_TRANSFER");
    expect(mapTradeSide("equity transfer-out")?.type).toBe("SELL");
    const parsed = parseTrades([{
      "Order Side": "Buy",
      "Ticker ID": "GISS",
      "Buy Qty": 1000,
      Price: 3.2,
      Date: "2024-01-15",
      "Invoice No": 99,
    }]);
    expect(parsed.rows[0]).toMatchObject({ ticker: "GISS", type: "BUY", qty: 1000, price: 3.2, date: "2024-01-15" });
  });

  it("books unit price from Buy/Sell Value so qty×price matches Gross (HP-WAC-BLOTTER)", () => {
    expect(blotterUnitPrice({
      type: "BUY", qty: 1_993_508, listedPrice: 1.504, buyValue: 2_998_459.35,
    })).toBeCloseTo(2_998_459.35 / 1_993_508, 12);
    expect(blotterUnitPrice({
      type: "SELL", qty: 1_130, listedPrice: 1.753, sellValue: 1_981.4,
    })).toBeCloseTo(1_981.4 / 1_130, 12);
    expect(blotterUnitPrice({
      type: "BUY", qty: 1_000, listedPrice: 1.53,
    })).toBe(1.53);

    const parsed = parseTrades([
      {
        "Order Side": "Buy", "Ticker ID": "MHAR", "Buy Qty": 1000,
        Price: 1.53, "Buy Value": 1530, Date: "2024-07-02",
      },
      {
        "Order Side": "Buy", "Ticker ID": "MHAR", "Buy Qty": 1_993_508,
        Price: 1.504, "Buy Value": 2_998_459.35, Date: "2024-07-02",
      },
      {
        "Order Side": "Sell", "Ticker ID": "MHAR", "Sell Qty": 1130,
        Price: 1.753, "Sell Value": 1981.4, Date: "2024-07-03",
      },
    ]);
    expect(parsed.rows[1].price).toBeCloseTo(2_998_459.35 / 1_993_508, 12);
    expect(parsed.rows[2].price).toBeCloseTo(1_981.4 / 1_130, 12);

    const events = parsed.rows.map((r) => ({
      kind: "tx" as const,
      date: r.date,
      sort: 0,
      stockId: "MHAR",
      type: r.type,
      quantity: r.qty,
      price: r.price,
    }));
    const afterBuys = applyReplayEvents(events.slice(0, 2)).get("MHAR")!;
    expect(afterBuys.quantity).toBe(1_994_508);
    expect(afterBuys.totalCost).toBeCloseTo(2_999_989.35, 4);
    expect(afterBuys.totalCost / afterBuys.quantity).toBeCloseTo(1.50413, 5);
  });
});
