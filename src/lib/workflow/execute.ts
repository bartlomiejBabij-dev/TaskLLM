import type { WorkflowNode } from '../contracts';
import { parseCsv, calculateKpis, type CsvData } from './csv';
import { renderVariables, assertValueSize } from './variables';

export function executePureNode(node: WorkflowNode, outputs: Record<string, unknown>): unknown {
  const config = node.config;
  const rendered = () => renderVariables(String(config.input ?? ''), outputs);
  let output: unknown;
  switch (node.type) {
    case 'manual': output = { triggered: true }; break;
    case 'text': output = String(config.text ?? ''); break;
    case 'json':
      try { output = JSON.parse(String(config.json)); } catch { throw new Error(`${node.name}: invalid JSON input.`); }
      break;
    case 'csv': {
      const data = parseCsv(String(config.csv), config.delimiter as string | undefined);
      const columns = config.columns as Record<string, string> | undefined;
      if (columns && Object.keys(columns).length) {
        for (const original of Object.values(columns)) if (!data.columns.includes(original)) throw new Error(`Mapped CSV column ${original} was not found.`);
        output = { ...data, rows: data.rows.map((row) => ({ ...row, ...Object.fromEntries(Object.entries(columns).map(([alias, original]) => [alias, row[original]])) })) };
      } else output = data;
      break;
    }
    case 'kpi': {
      let data: CsvData | Record<string, unknown>[];
      try { data = JSON.parse(rendered()); } catch { throw new Error(`${node.name}: KPI input must be JSON from a CSV step.`); }
      output = calculateKpis(data); break;
    }
    case 'transform': {
      const text = rendered();
      if (config.operation === 'uppercase') output = text.toUpperCase();
      else if (config.operation === 'lowercase') output = text.toLowerCase();
      else if (config.operation === 'trim') output = text.trim();
      else throw new Error('Unknown text operation.');
      break;
    }
    case 'json_parse':
      try { output = JSON.parse(rendered()); } catch { throw new Error(`${node.name}: input is not valid JSON.`); }
      break;
    case 'save': output = rendered(); break;
    default: throw new Error(`Step ${node.type} must run through its external service adapter.`);
  }
  assertValueSize(output);
  return output;
}
