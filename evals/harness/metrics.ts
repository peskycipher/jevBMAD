// Metrics for golden-set evals (implementation.md §7.2).
//
// All metrics operate over per-question records:
//   {qid, primitive, label, prediction, confidence, correct}
// Supports choice (top-1), noul (probability + binary label), score (fractional
// vs level), plus calibration (ECE), Brier, and per-confidence-band accuracy.
import { neumaierSum } from "./jev_policy.ts";

export type MetricRecord = {
  id: string;
  qid: string;
  primitive: "choice" | "noul" | "score";
  label: number | string;
  prediction: number | string;
  confidence: number | null;
  correct: boolean;
};

// Python round(): banker's rounding, half to even.
export function pythonRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

const BANDS: Array<[number, number, string]> = [
  [0.0, 0.75, "low"],
  [0.75, 0.9, "medium"],
  [0.9, 1.01, "high"],
];

export function accuracy(records: MetricRecord[]): number | null {
  if (!records.length) return null;
  return neumaierSum(records.map((r) => (r.correct ? 1 : 0))) / records.length;
}

export function brierScore(records: MetricRecord[]): number | null {
  const recs = records.filter((r) => r.primitive === "noul");
  if (!recs.length) return null;
  return neumaierSum(recs.map((r) => { const d = (r.prediction as number) - (r.label as number); return d * d; })) / recs.length;
}

export function ece(records: MetricRecord[], nBins = 10): number | null {
  const recs = records.filter((r) => r.confidence !== null && r.confidence !== undefined);
  if (!recs.length) return null;
  const bins = new Map<number, [number, number, number]>(); // conf_sum, count, correct
  for (const r of recs) {
    const b = Math.min(Math.trunc((r.confidence as number) * nBins), nBins - 1);
    let acc: number = r.correct ? 1 : 0;
    if (r.primitive === "noul") {
      // calibration of the *probability* for noul: use |label - pred| correctness
      acc = 1 - Math.abs((r.prediction as number) - (r.label as number));
    }
    const cur = bins.get(b) ?? [0, 0, 0];
    cur[0] += r.confidence as number;
    cur[1] += 1;
    cur[2] += acc;
    bins.set(b, cur);
  }
  const total = neumaierSum([...bins.values()].map((b) => b[1]));
  const terms: number[] = [];
  for (const [cs, c, ok] of bins.values()) {
    if (!c) continue;
    terms.push((c / total) * Math.abs(ok / c - cs / c));
  }
  return neumaierSum(terms) || 0.0;
}

export function bandReport(records: MetricRecord[]): Record<string, { n: number; accuracy: number }> {
  const out: Record<string, { n: number; accuracy: number }> = {};
  for (const [lo, hi, name] of BANDS) {
    const recs = records.filter(
      (r) => r.confidence !== null && r.confidence !== undefined && (r.confidence as number) >= lo && (r.confidence as number) < hi,
    );
    if (recs.length) {
      out[name] = {
        n: recs.length,
        accuracy: neumaierSum(recs.map((r) => (r.correct ? 1 : 0))) / recs.length,
      };
    }
  }
  return out;
}

export function latencyStats(latenciesMs: number[]): Record<string, number> {
  if (!latenciesMs.length) return {};
  const s = [...latenciesMs].sort((a, b) => a - b);
  const pct = (p: number): number => s[Math.min(Math.trunc(s.length * p), s.length - 1)];
  return { p50: pythonRound(pct(0.5)), p95: pythonRound(pct(0.95)), min: pythonRound(s[0]), max: pythonRound(s[s.length - 1]) };
}

export function scoreMae(records: MetricRecord[]): number | null {
  const recs = records.filter((r) => r.primitive === "score");
  if (!recs.length) return null;
  return neumaierSum(recs.map((r) => Math.abs((r.prediction as number) - (r.label as number)))) / recs.length;
}

export function otherRate(records: MetricRecord[]): number | null {
  const recs = records.filter((r) => r.primitive === "choice");
  if (!recs.length) return null;
  return neumaierSum(recs.map((r) => ((r.prediction as string) === "other" ? 1 : 0))) / recs.length;
}
