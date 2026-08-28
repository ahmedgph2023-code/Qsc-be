/** Maps CH_CURRENT_INDEX rows onto the two IPMS benchmarks. Sector series are ignored. */

export type BenchmarkIndexName = "QERI" | "DSM";

export function mapBenchmarkIndex(code: string, name: string): BenchmarkIndexName | null {
  const c = code.trim().toUpperCase();
  const n = name.trim();
  if (c === "QERI" || /al rayan islamic/i.test(n) || /^qeri$/i.test(n)) return "QERI";
  if (c === "QETN" || c === "55" || /^general index$/i.test(n) || /^dsm$/i.test(n)) return "DSM";
  return null;
}
