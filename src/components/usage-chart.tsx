import type { UsageSummary } from "@/lib/contracts";
import { dateTime, money, number } from "./ui";
export function UsageChart({ daily, metric = "requests" }: { daily: UsageSummary["daily"]; metric?: "requests" | "tokens" | "cost_micros" }) {
  if (!daily.length) return <div className="chart-empty">Your first AI request starts the story.</div>;
  const values = daily.slice(-14); const max = Math.max(1, ...values.map(d => d[metric]));
  return <div className="chart" role="img" aria-label={`Daily ${metric.replaceAll("_", " ")} over ${values.length} days`}>{values.map(day => <div key={day.date} className="chart-column" title={`${dateTime(day.date)}: ${metric === "cost_micros" ? money(day[metric]) : number(day[metric])}`}><div className="chart-bar" style={{ height: `${Math.max(2, day[metric] / max * 85)}%` }} /><span className="chart-label">{new Date(day.date).getUTCDate()}</span></div>)}</div>;
}
