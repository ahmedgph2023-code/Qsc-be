import XLSX from "xlsx";
import { Response } from "express";

export function sendTemplateExcel(res: Response, filename: string, columns: string[], exampleRows: Record<string, unknown>[]) {
  const data = [columns.reduce((obj, col, i) => ({ ...obj, [col]: columns[i] }), {}), ...exampleRows];
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = columns.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(Buffer.from(buf));
}

export function sendStockPricesTemplate(res: Response) {
  const today = new Date().toISOString().split("T")[0];
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  sendTemplateExcel(res, "stock-price-template.xlsx", ["date", "price"], [
    { date: monthAgo, price: 150.25 },
    { date: today, price: 155.80 },
  ]);
}

export const INDEX_DATA_COLUMNS = [
  "CI_DATE",
  "CI_CURRENT_INDEX",
  "CI_OPEN_INDEX",
  "CI_HIGH_INDEX",
  "CI_LOW_INDEX",
];

export function sendIndexDataTemplate(res: Response) {
  sendTemplateExcel(res, "index-data-template.xlsx", INDEX_DATA_COLUMNS, [
    {
      CI_DATE: "02-Jan-2024",
      CI_CURRENT_INDEX: 10450.25,
      CI_OPEN_INDEX: 10420.1,
      CI_HIGH_INDEX: 10480.5,
      CI_LOW_INDEX: 10390.0,
    },
    {
      CI_DATE: "03-Jan-2024",
      CI_CURRENT_INDEX: 10510.8,
      CI_OPEN_INDEX: 10455.0,
      CI_HIGH_INDEX: 10525.4,
      CI_LOW_INDEX: 10440.2,
    },
    {
      CI_DATE: "04-Jan-2024",
      CI_CURRENT_INDEX: 10490.15,
      CI_OPEN_INDEX: 10505.0,
      CI_HIGH_INDEX: 10530.0,
      CI_LOW_INDEX: 10470.75,
    },
  ]);
}

export function sendTransactionTemplate(res: Response) {
  const headers = ["ticker", "type", "quantity", "date", "price", "amount"];
  const examples: (string | number)[][] = [
    ["MKDM", "SELL", 1500, "10-04-2024", 2.48, ""],
    ["MHAR", "BUY", 1000, "02-07-2024", 1.53, ""],
    ["MKDM", "BUY", 3000, "08-07-2024", 2.41, ""],
    ["MKDM", "SELL", 2000, "15-08-2024", 2.55, ""],
    ["", "TRANSFER", "", "20-08-2024", "", 10000],
    ["MHAR", "CLIENT_TRANSFER", 5000000, "27-01-2025", 2.426, ""],
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...examples]);
  ws["!cols"] = [{ wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 12 }];
  // Keep the date column as text (dd-mm-yyyy) so Excel does not flip day/month.
  const dateCol = "D";
  for (let r = 1; r <= examples.length + 1; r++) {
    const cell = ws[`${dateCol}${r}`];
    if (cell) {
      cell.t = "s";
      cell.z = "@";
      cell.v = String(cell.v ?? "");
    }
  }

  const instructions = XLSX.utils.aoa_to_sheet([
    ["Transaction template — how to fill"],
    [""],
    ["date format", "dd-mm-yyyy  (day-month-year)"],
    ["example", "02-07-2024 means 2 July 2024, NOT 7 February 2024"],
    ["how to type", "Type the date as text exactly like 02-07-2024. Do not let Excel convert it to a date."],
    ["row order", "Rows MUST be sorted by date ascending (oldest first). The upload is rejected if dates go backwards."],
    ["stop rule", "The first row that fails validation stops the upload. Later rows are not processed."],
    [""],
    ["ticker", "QSE ticker (leave blank for cash TRANSFER)"],
    ["type", "BUY, SELL, CLIENT_TRANSFER (in-kind shares, no cash), or TRANSFER (cash withdrawal)"],
    ["quantity", "Shares for BUY/SELL/CLIENT_TRANSFER. Leave blank for cash TRANSFER."],
    ["price", "Fill/cost price. BUY/SELL must sit in that day's QSE low–high unless Bypass. CLIENT_TRANSFER is a booking cost (close or manual). Leave blank for cash TRANSFER."],
    ["amount", "Cash amount for TRANSFER (withdrawal). Leave blank for stock rows."],
  ]);
  instructions["!cols"] = [{ wch: 16 }, { wch: 90 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.utils.book_append_sheet(wb, instructions, "Instructions");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="transaction-template.xlsx"');
  res.send(Buffer.from(buf));
}

export const BULK_STOCK_COLUMNS = [
  "TICKER_ID", "PR_PRICE_DATE", "PR_SHARE_PRICE", "PR_ASK", "PR_OFF",
  "PR_O_NUM", "PR_VOL", "PR_MON", "PR_OP_PRICE", "PR_H_PRICE", "PR_L_PRICE", "PR_C_PRICE"
];

export function sendBulkStockMasterTemplate(res: Response) {
  sendTemplateExcel(res, "stock-master-upload.xlsx", BULK_STOCK_COLUMNS, [
    { TICKER_ID: "MKDM", PR_PRICE_DATE: "24-May-2026", PR_SHARE_PRICE: 2.316, PR_ASK: 2.309, PR_OFF: 2.315, PR_O_NUM: 65, PR_VOL: "149,886", PR_MON: "2026/05", PR_OP_PRICE: 2.293, PR_H_PRICE: 2.318, PR_L_PRICE: 2.293, PR_C_PRICE: 2.316 },
    { TICKER_ID: "MKDM", PR_PRICE_DATE: "21-May-2026", PR_SHARE_PRICE: 2.286, PR_ASK: 2.251, PR_OFF: 2.300, PR_O_NUM: 79, PR_VOL: "287,771", PR_MON: "2026/05", PR_OP_PRICE: 2.277, PR_H_PRICE: 2.297, PR_L_PRICE: 2.267, PR_C_PRICE: 2.286 },
    { TICKER_ID: "QNBK", PR_PRICE_DATE: "24-May-2026", PR_SHARE_PRICE: 15.500, PR_ASK: 15.450, PR_OFF: 15.480, PR_O_NUM: 120, PR_VOL: "500,000", PR_MON: "2026/05", PR_OP_PRICE: 15.300, PR_H_PRICE: 15.600, PR_L_PRICE: 15.250, PR_C_PRICE: 15.500 },
  ]);
}
