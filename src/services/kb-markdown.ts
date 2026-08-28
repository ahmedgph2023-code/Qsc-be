/** Parse pipe markdown tables used in KB market-data dumps. */

export function normalizeMarkdownHeader(raw: string): string {
  return raw.replace(/\\/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  return trimmed.split("|").slice(1, -1).map((c) => c.trim());
}

export function parseKbMarkdownTable(markdown: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let headers: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = splitMarkdownRow(line);
    if (cells.length === 0) continue;
    if (cells.every((c) => /^[-:]+$/.test(c))) continue;
    if (headers.length === 0) {
      headers = cells.map(normalizeMarkdownHeader);
      continue;
    }
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] ?? "";
    });
    objects.push(obj);
  }
  return objects;
}
