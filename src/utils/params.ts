/** Express 5 params may be string | string[] */
export function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** YYYY-MM-DD from query, or undefined if missing/invalid. */
export function queryAsOf(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const s = String(raw ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

const PAGE_SIZES = new Set([10, 20, 25, 50]);

export function queryPagination(query: { page?: unknown; pageSize?: unknown }): { page: number; pageSize: number } {
  const pageRaw = Array.isArray(query.page) ? query.page[0] : query.page;
  const sizeRaw = Array.isArray(query.pageSize) ? query.pageSize[0] : query.pageSize;
  const page = Math.max(1, parseInt(String(pageRaw ?? "1"), 10) || 1);
  const parsedSize = parseInt(String(sizeRaw ?? "10"), 10) || 10;
  const pageSize = PAGE_SIZES.has(parsedSize) ? parsedSize : 10;
  return { page, pageSize };
}

export function querySearchLike(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const s = String(raw ?? "").trim().slice(0, 64).replace(/[%_[\]]/g, "");
  return s ? `%${s}%` : null;
}

export function queryToken(value: unknown, allow: RegExp, max = 16): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const s = String(raw ?? "").trim();
  if (!s || s.length > max || !allow.test(s)) return null;
  return s;
}

export function paginateMeta(total: number, page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  return {
    page: safePage,
    pageSize,
    total,
    totalPages,
    offset: (safePage - 1) * pageSize,
  };
}
