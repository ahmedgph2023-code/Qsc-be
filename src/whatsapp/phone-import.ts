import XLSX from "xlsx";
import { Response } from "express";
import { normalizeWaId } from "./crypto.js";

export const PHONE_IMPORT_COLUMNS = ["phone", "display_name"] as const;

export type PhoneImportRow = {
  row: number;
  phone: string;
  displayName: string;
  waId: string | null;
  ok: boolean;
  error: string | null;
};

const HEADER_ALIASES: Record<string, "phone" | "displayName"> = {
  phone: "phone",
  phonenumber: "phone",
  mobile: "phone",
  waid: "phone",
  wa_id: "phone",
  whatsapp: "phone",
  display_name: "displayName",
  displayname: "displayName",
  name: "displayName",
  label: "displayName",
};

function headerKey(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function cellText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

export function validatePhoneImportRows(
  rows: Array<{ phone?: string; displayName?: string; row?: number }>,
): PhoneImportRow[] {
  const seen = new Map<string, number>();
  return rows.map((raw, index) => {
    const row = raw.row ?? index + 2;
    const phone = cellText(raw.phone);
    const displayName = cellText(raw.displayName);
    if (!phone) {
      return { row, phone, displayName, waId: null, ok: false, error: "Phone is required" };
    }
    const waId = normalizeWaId(phone);
    if (!waId) {
      return {
        row,
        phone,
        displayName,
        waId: null,
        ok: false,
        error: "Invalid phone. Use Qatar country code (10–15 digits), e.g. 97433112233",
      };
    }
    const prev = seen.get(waId);
    if (prev) {
      return {
        row,
        phone,
        displayName,
        waId,
        ok: false,
        error: `Duplicate of row ${prev}`,
      };
    }
    seen.set(waId, row);
    return { row, phone, displayName, waId, ok: true, error: null };
  });
}

export function parseWhatsAppPhoneWorkbook(buffer: Buffer): PhoneImportRow[] {
  const wb = XLSX.read(buffer, { type: "buffer", raw: false });
  const sheetName = wb.SheetNames.includes("Data") ? "Data" : wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });
  if (!matrix.length) return [];

  let headerIndex = 0;
  let phoneCol = 0;
  let nameCol = 1;
  for (let i = 0; i < Math.min(matrix.length, 8); i += 1) {
    const cells = (matrix[i] || []).map(headerKey);
    const p = cells.findIndex((c) => HEADER_ALIASES[c] === "phone");
    if (p >= 0) {
      headerIndex = i;
      phoneCol = p;
      const n = cells.findIndex((c) => HEADER_ALIASES[c] === "displayName");
      nameCol = n >= 0 ? n : p === 0 ? 1 : 0;
      break;
    }
  }

  const incoming: Array<{ phone: string; displayName: string; row: number }> = [];
  for (let i = headerIndex + 1; i < matrix.length; i += 1) {
    const cells = matrix[i] || [];
    const phone = cellText(cells[phoneCol]);
    const displayName = cellText(cells[nameCol]);
    if (!phone && !displayName) continue;
    incoming.push({ phone, displayName, row: i + 1 });
  }
  return validatePhoneImportRows(incoming);
}

export function sendWhatsAppPhoneTemplate(res: Response) {
  const headers = [...PHONE_IMPORT_COLUMNS];
  const examples: (string | number)[][] = [
    ["97433112233", "Ahmed Al-Kuwari"],
    ["33114455", "Sara"],
    ["01012345678", "Invalid example — delete this row"],
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...examples]);
  ws["!cols"] = [{ wch: 22 }, { wch: 28 }];

  const instructions = XLSX.utils.aoa_to_sheet([
    ["WhatsApp phone import — how to fill"],
    [""],
    ["phone", "Required. Qatar E.164 (974…) or 8-digit local starting 3/4/5/6/7. Local numbers become 974…"],
    ["display_name", "Optional contact name shown in the chat list"],
    ["do not use", "Egyptian 01… / +20 numbers are rejected"],
    ["after upload", "The screen lists valid and invalid rows. Edit invalid rows, then Save."],
    [""],
    ["examples on Data", "Keep or replace the sample rows. Delete the invalid example before Save if you do not want it."],
  ]);
  instructions["!cols"] = [{ wch: 18 }, { wch: 96 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.utils.book_append_sheet(wb, instructions, "Instructions");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="whatsapp-phones-template.xlsx"');
  res.send(Buffer.from(buf));
}
