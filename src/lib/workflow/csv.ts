import { parse } from 'csv-parse/sync';
import { assertValueSize } from './variables';

export const MAX_CSV_BYTES = 1024 * 1024;
export const MAX_CSV_ROWS = 10000;
const metrics = ['impressions', 'clicks', 'cost', 'conversions', 'revenue'] as const;
type Metric = typeof metrics[number];
export interface CsvData { columns: string[]; rows: Record<string, string>[]; rowCount: number; missingValues: number; }

export function parseCsv(csv: string, delimiter?: string): CsvData {
  assertValueSize(csv, MAX_CSV_BYTES);
  if (csv.includes('\0')) throw new Error('CSV contains an invalid null character.');
  if (!csv.trim()) throw new Error('CSV is empty.');
  const separators = delimiter ? [delimiter] : [',', ';', '\t', '|'];
  if (separators.some((separator) => ![',', ';', '\t', '|'].includes(separator))) throw new Error('Unsupported CSV separator.');
  let selected = separators[0];
  let widestHeader = 0;
  for (const separator of separators) {
    try {
      const header = parse(csv, { bom: true, delimiter: separator, skip_empty_lines: true, trim: true, max_record_size: 65536, to: 1 }) as string[][];
      if ((header[0]?.length ?? 0) > widestHeader) { widestHeader = header[0].length; selected = separator; }
    } catch { /* The complete parse below reports malformed headers. */ }
  }
  let matrix: string[][];
  try { matrix = parse(csv, { bom: true, delimiter: selected, skip_empty_lines: true, trim: true, max_record_size: 65536, to: MAX_CSV_ROWS + 2 }) as string[][]; }
  catch { throw new Error('CSV is malformed. Check quotes, separators, and row lengths.'); }
  if (!matrix?.length) throw new Error('CSV is malformed. Check quotes, separators, and row lengths.');
  const [columns, ...rows] = matrix;
  if (rows.length > MAX_CSV_ROWS) throw new Error(`CSV exceeds ${MAX_CSV_ROWS} rows.`);
  if (columns.length > 100) throw new Error('CSV exceeds 100 columns.');
  if (columns.some((column) => !column || column.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(column))) throw new Error('CSV has an empty, unsafe, or overly long column name.');
  if (new Set(columns).size !== columns.length) throw new Error('CSV column names must be unique.');
  if (!rows.length) throw new Error('CSV needs at least one data row.');
  if (rows.some((row) => row.length !== columns.length)) throw new Error('CSV rows have inconsistent column counts.');
  return {
    columns,
    rows: rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
    rowCount: rows.length,
    missingValues: rows.reduce((count, row) => count + row.filter((value) => value === '').length, 0),
  };
}

export function calculateKpis(data: CsvData | Record<string, unknown>[], mapping: Partial<Record<Metric, string>> = {}) {
  const rows = Array.isArray(data) ? data : data.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_CSV_ROWS) throw new Error('KPI input must contain CSV rows.');
  const totals: Record<Metric, number | null> = { impressions: null, clicks: null, cost: null, conversions: null, revenue: null };
  const limitations: string[] = [];
  for (const metric of metrics) {
    const column = mapping[metric] ?? Object.keys(rows[0]).find((name) => name.toLowerCase() === metric);
    if (!column || !Object.hasOwn(rows[0], column)) { limitations.push(`Missing ${metric} column.`); continue; }
    let total = 0;
    let valid = true;
    for (const row of rows) {
      const raw = row[column];
      if (raw === null || raw === undefined || String(raw).trim() === '') { valid = false; limitations.push(`Missing ${metric} values; total and derived metrics omitted.`); break; }
      const normalized = String(raw).trim();
      if (!/^-?\d+(?:\.\d+)?$/.test(normalized) || !Number.isFinite(Number(normalized)) || Number(normalized) < 0) throw new Error(`Column ${column} contains an invalid non-negative number. Use a dot decimal separator without currency signs.`);
      total += Number(normalized);
      if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) throw new Error(`Column ${column} exceeds the numeric precision limit.`);
    }
    if (valid) totals[metric] = total;
  }
  const ratio = (numerator: number | null, denominator: number | null, scale = 1) => numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator * scale;
  return { rows: rows.length, ...totals, ctr: ratio(totals.clicks, totals.impressions, 100), cpc: ratio(totals.cost, totals.clicks), cpa: ratio(totals.cost, totals.conversions), roas: ratio(totals.revenue, totals.cost), limitations };
}
