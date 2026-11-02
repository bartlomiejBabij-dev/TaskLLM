import { describe, expect, it, afterEach } from 'vitest';
import type { WorkflowGraph, WorkflowNode, AiRequest } from '../src/lib/contracts';
import { validateGraph } from '../src/lib/workflow/graph';
import { renderVariables } from '../src/lib/workflow/variables';
import { parseCsv, calculateKpis } from '../src/lib/workflow/csv';
import { nextRun } from '../src/lib/workflow/schedule';
import { executePureNode } from '../src/lib/workflow/execute';
import { templates } from '../src/lib/workflow/templates';
import { calculateCost, getModel, estimateMaxCost } from '../src/lib/ai/registry';
import { encryptSecret, decryptSecret } from '../src/lib/security/secrets';

const node = (id: string, type: WorkflowNode['type'], config: Record<string, unknown> = {}): WorkflowNode => ({ id, type, name: id, position: { x: 0, y: 0 }, config });
const graph = (): WorkflowGraph => ({ nodes: [node('start', 'manual'), node('input', 'text', { text: 'hello' }), node('result', 'save', { input: '{{steps.input.output}}' })], edges: [{ id: 'a', source: 'start', target: 'input' }, { id: 'b', source: 'input', target: 'result' }] });

describe('workflow graph validation', () => {
  it('sorts graph dependencies independently of array order', () => {
    const value = graph(); value.nodes.reverse();
    expect(validateGraph(value).map((step) => step.id)).toEqual(['start', 'input', 'result']);
  });
  it('rejects cycles and disconnected steps', () => {
    const value = graph(); value.edges.push({ id: 'c', source: 'result', target: 'input' });
    expect(() => validateGraph(value)).toThrow(/cycle/);
    const disconnected = graph(); disconnected.edges.pop();
    expect(() => validateGraph(disconnected)).toThrow(/connected/);
  });
  it('rejects duplicate ids and missing targets', () => {
    const duplicate = graph(); duplicate.nodes[2].id = 'input';
    expect(() => validateGraph(duplicate)).toThrow(/unique/);
    const missing = graph(); missing.edges[1].target = 'missing';
    expect(() => validateGraph(missing)).toThrow(/missing/);
  });
  it('rejects a variable reference to a sibling and unsafe system interpolation', () => {
    const sibling = graph(); sibling.edges[1].source = 'start';
    expect(() => validateGraph(sibling)).toThrow(/earlier connected/);
    const unsafe = structuredClone(templates[1].graph);
    unsafe.nodes.find((step) => step.type === 'ai')!.config.systemInstruction = '{{steps.brief.output}}';
    expect(() => validateGraph(unsafe)).toThrow(/system instructions/);
  });
  it('rejects secret-bearing config and unsupported model parameters', () => {
    const value = graph(); value.nodes[1].config.api_key = 'not-a-real-secret';
    expect(() => validateGraph(value)).toThrow();
    const unsupported = structuredClone(templates[1].graph);
    unsupported.nodes.find((step) => step.type === 'ai')!.config.temperature = 0.5;
    expect(() => validateGraph(unsupported)).toThrow(/temperature/);
  });
  it('ships six structurally valid, editable template graphs', () => {
    expect(templates).toHaveLength(6);
    for (const template of templates) expect(validateGraph(template.graph).length).toBe(template.graph.nodes.length);
  });
});

describe('step data and variables', () => {
  it('serializes values and never recursively evaluates substituted text', () => {
    expect(renderVariables('Data: {{steps.input.output}}', { input: { amount: 5 } })).toBe('Data: {"amount":5}');
    expect(renderVariables('{{steps.input.output}}', { input: '{{steps.secret.output}}', secret: 'hidden' })).toBe('{{steps.secret.output}}');
  });
  it('rejects missing values, property traversal, inherited properties, and oversize output', () => {
    expect(() => renderVariables('{{steps.input.output}}', {})).toThrow(/not available/);
    expect(() => renderVariables('{{steps.input.output.__proto__}}', {})).toThrow(/Invalid variable/);
    expect(() => renderVariables('{{steps.constructor.output}}', {})).toThrow(/Unsafe/);
    expect(() => renderVariables('{{steps.input.output}}', Object.create({ input: 'inherited' }))).toThrow(/not available/);
    expect(() => renderVariables('{{steps.input.output}}', { input: 'x'.repeat(300000) })).toThrow(/limit/);
  });
  it('passes outputs through a real deterministic chain', () => {
    const outputs: Record<string, unknown> = {};
    const steps = [node('input', 'text', { text: '  hello  ' }), node('trim', 'transform', { input: '{{steps.input.output}}', operation: 'trim' }), node('up', 'transform', { input: '{{steps.trim.output}}', operation: 'uppercase' }), node('result', 'save', { input: '{{steps.up.output}}' })];
    for (const step of steps) outputs[step.id] = executePureNode(step, outputs);
    expect(outputs.result).toBe('HELLO');
  });
  it('reports malformed JSON and refuses side-effect nodes', () => {
    expect(() => executePureNode(node('parse', 'json_parse', { input: '{bad}' }), {})).toThrow(/not valid JSON/);
    expect(() => executePureNode(node('email', 'email'), {})).toThrow(/external service/);
  });
});

describe('CSV and KPI analysis', () => {
  it('parses separators, quoted commas, UTF8 BOM, and missing cells', () => {
    const csv = parseCsv('\uFEFFname;review\nAlice;"Useful, fast"\nBob;');
    expect(csv.rows[0]).toEqual({ name: 'Alice', review: 'Useful, fast' });
    expect(csv.missingValues).toBe(1);
  });
  it('computes weighted aggregate KPI ratios from supplied values', () => {
    const parsed = parseCsv('impressions,clicks,cost,conversions,revenue\n1000,100,40,10,200\n3000,50,60,5,300');
    expect(calculateKpis(parsed)).toMatchObject({ impressions: 4000, clicks: 150, cost: 100, ctr: 3.75, cpc: 100 / 150, cpa: 100 / 15, roas: 5 });
  });
  it('does not turn missing values or division by zero into invented figures', () => {
    const kpis = calculateKpis(parseCsv('impressions,clicks,cost\n0,0,\n0,0,10'));
    expect(kpis.cost).toBeNull(); expect(kpis.ctr).toBeNull(); expect(kpis.cpc).toBeNull();
    expect(kpis.limitations.length).toBeGreaterThan(0);
  });
  it('rejects duplicate headers, invalid numeric cells and malformed data', () => {
    expect(() => parseCsv('a,a\n1,2', ',')).toThrow(/unique/);
    expect(() => calculateKpis(parseCsv('cost\nnot-a-number'))).toThrow(/invalid non-negative/);
    expect(() => parseCsv('a,b\n1,2,3', ',')).toThrow(/malformed/);
    expect(() => parseCsv('a,b\n1,2,3')).toThrow(/malformed/);
    expect(() => parseCsv('x'.repeat(1024 * 1024 + 1))).toThrow(/limit/);
  });
});

describe('schedule timezone semantics', () => {
  it('uses the selected IANA timezone across summer time', () => {
    expect(nextRun('0 9 * * *', 'Europe/Warsaw', new Date('2026-03-28T09:00:00Z')).toISOString()).toBe('2026-03-29T07:00:00.000Z');
    expect(nextRun('0 9 * * *', 'Europe/Warsaw', new Date('2026-10-24T09:00:00Z')).toISOString()).toBe('2026-10-25T08:00:00.000Z');
  });
  it('rejects unknown zones and second-frequency schedules', () => {
    expect(() => nextRun('* * * * *', 'Not/AZone')).toThrow(/timezone/);
    expect(() => nextRun('* * * * * *', 'UTC')).toThrow(/five-field/);
    expect(() => nextRun('61 * * * *', 'UTC')).toThrow(/Invalid CRON/);
  });
});

describe('integer micro-dollar cost accounting', () => {
  it('rounds fractional micro-dollars upward and fails closed on unknown rates', () => {
    expect(calculateCost(getModel('gpt-6-luna'), 1, 1)).toBe(1);
    expect(calculateCost(getModel('claude-sonnet-5-5'), 1000, 200)).toBe(4000);
    expect(() => getModel('unknown')).toThrow(/not enabled/);
    expect(() => calculateCost(getModel('gpt-6-luna'), -1, 0)).toThrow(/Invalid/);
  });
  it('reserves a conservative bound and rejects oversize paid inputs', () => {
    const request: AiRequest = { provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', maxOutputTokens: 1000 };
    expect(estimateMaxCost(request)).toBeGreaterThan(calculateCost(getModel(request.model), 10, 1000));
    expect(() => estimateMaxCost({ ...request, prompt: 'x'.repeat(140000) })).toThrow(/128 KiB/);
  });
});

describe('API key encryption', () => {
  const previous = process.env.ENCRYPTION_KEY;
  afterEach(() => { if (previous) process.env.ENCRYPTION_KEY = previous; else delete process.env.ENCRYPTION_KEY; });
  it('uses randomized encryption bound to account and provider', () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const first = encryptSecret('sk-test-only-not-a-real-key', 'alice:openai');
    const second = encryptSecret('sk-test-only-not-a-real-key', 'alice:openai');
    expect(first).not.toBe(second); expect(first).not.toContain('sk-test');
    expect(decryptSecret(first, 'alice:openai')).toBe('sk-test-only-not-a-real-key');
    expect(() => decryptSecret(first, 'bob:openai')).toThrow(/decrypt/);
    expect(() => decryptSecret(first, 'alice:anthropic')).toThrow(/decrypt/);
    const parts = first.split('.'); parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join('.'), 'alice:openai')).toThrow(/decrypt/);
  });
  it('fails closed when the master key is absent or malformed', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret('sk-test-only', 'alice:openai')).toThrow(/not configured/);
    process.env.ENCRYPTION_KEY = 'invalid';
    expect(() => encryptSecret('sk-test-only', 'alice:openai')).toThrow(/32 random bytes/);
  });
});
