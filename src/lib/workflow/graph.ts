import { z } from 'zod';
import type { WorkflowGraph, WorkflowNode, NodeType } from '../contracts';
import { getModel } from '../ai/registry';
import { variableReferences } from './variables';

const input = z.string().max(256 * 1024);
const nonempty = input.min(1);
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));
const configs: Record<NodeType, z.ZodType> = {
  manual: z.object({}).strict(),
  text: z.object({ text: nonempty }).strict(),
  json: z.object({ json: nonempty }).strict(),
  csv: z.object({ csv: z.string().min(1).max(1024 * 1024), delimiter: z.enum([',', ';', '\t', '|']).optional(), columns: z.record(z.string(), z.string()).optional() }).strict(),
  kpi: z.object({ input: nonempty }).strict(),
  ai: z.object({ provider: z.enum(['openai', 'anthropic']), model: z.string().min(1).max(128), prompt: nonempty, systemInstruction: input.optional(), input: input.optional(), maxOutputTokens: z.number().int().min(64).max(16384), billingMode: z.enum(['managed', 'byok']), temperature: z.number().min(0).max(2).optional(), structuredOutput: z.boolean().optional() }).strict(),
  transform: z.object({ input, operation: z.enum(['uppercase', 'lowercase', 'trim']) }).strict(),
  json_parse: z.object({ input: nonempty }).strict(),
  email: z.object({ to: z.email().max(254), subject: z.string().min(1).max(200), body: nonempty }).strict(),
  save: z.object({ input: nonempty }).strict(),
};

export const graphSchema = z.object({
  nodes: z.array(z.object({ id: identifier, type: z.enum(['manual', 'text', 'json', 'csv', 'kpi', 'ai', 'transform', 'json_parse', 'email', 'save']), name: z.string().min(1).max(100), position: z.object({ x: z.number().finite(), y: z.number().finite() }), config: z.record(z.string(), z.unknown()) }).strict()).min(2).max(50),
  edges: z.array(z.object({ id: z.string().min(1).max(128), source: identifier, target: identifier }).strict()).min(1).max(200),
}).strict();

export function parseGraph(graph: unknown): WorkflowGraph {
  return graphSchema.parse(graph);
}

/** Validates topology, typed configuration, and every variable's dependency path. */
export function validateGraph(graph: unknown): WorkflowNode[] {
  const parsed = parseGraph(graph);
  const nodes = new Map(parsed.nodes.map((node) => [node.id, node]));
  if (nodes.size !== parsed.nodes.length) throw new Error('Every step must have a unique ID.');
  if (new Set(parsed.edges.map((edge) => edge.id)).size !== parsed.edges.length) throw new Error('Every connection must have a unique ID.');
  const triggers = parsed.nodes.filter((node) => node.type === 'manual');
  if (triggers.length !== 1) throw new Error('A workflow must have exactly one start trigger.');
  const outgoing = new Map(parsed.nodes.map((node) => [node.id, [] as string[]]));
  const incoming = new Map(parsed.nodes.map((node) => [node.id, [] as string[]]));
  const links = new Set<string>();
  for (const edge of parsed.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error('A connection points to a missing step.');
    if (edge.source === edge.target) throw new Error('A step cannot connect to itself.');
    const key = `${edge.source}:${edge.target}`;
    if (links.has(key)) throw new Error('Duplicate connection.');
    links.add(key);
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }
  if (incoming.get(triggers[0].id)!.length) throw new Error('The start trigger cannot have incoming connections.');
  const degrees = new Map([...incoming].map(([id, dependencies]) => [id, dependencies.length]));
  const ready = parsed.nodes.filter((node) => degrees.get(node.id) === 0).map((node) => node.id);
  if (ready.length !== 1 || ready[0] !== triggers[0].id) throw new Error('Every step must be connected to the start trigger.');
  const ordered: WorkflowNode[] = [];
  const ancestors = new Map<string, Set<string>>();
  while (ready.length) {
    const id = ready.shift()!;
    const node = nodes.get(id)!;
    const dependencyIds = new Set<string>();
    for (const parent of incoming.get(id)!) {
      dependencyIds.add(parent);
      for (const ancestor of ancestors.get(parent) ?? []) dependencyIds.add(ancestor);
    }
    ancestors.set(id, dependencyIds);
    const configResult = configs[node.type].safeParse(node.config);
    if (!configResult.success) throw new Error(`${node.name}: ${configResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    if (node.type === 'ai') {
      const model = getModel(String(node.config.model), node.config.provider as 'openai' | 'anthropic');
      if (Number(node.config.maxOutputTokens) > model.maxOutputTokens) throw new Error(`${node.name}: output token limit exceeds model capacity.`);
      if (node.config.temperature !== undefined && !model.supportsTemperature) throw new Error(`${node.name}: this model does not support temperature.`);
      if (node.config.structuredOutput && !model.supportsJson) throw new Error(`${node.name}: this model does not support structured output.`);
      if (String(node.config.systemInstruction ?? '').includes('{{')) throw new Error(`${node.name}: system instructions cannot reference external step data. Use the data input field.`);
    }
    // Literal inputs (text, CSV, JSON) may contain braces and are never interpreted as templates.
    const fields = node.type === 'ai' ? ['prompt', 'input'] : node.type === 'email' ? ['subject', 'body'] : ['kpi', 'transform', 'json_parse', 'save'].includes(node.type) ? ['input'] : [];
    for (const field of fields) {
      const value = node.config[field];
      if (typeof value !== 'string') continue;
      for (const reference of variableReferences(value)) {
        if (!dependencyIds.has(reference)) throw new Error(`${node.name}: ${reference} must be an earlier connected step.`);
      }
    }
    if (node.type === 'json') {
      try { JSON.parse(String(node.config.json)); } catch { throw new Error(`${node.name}: invalid JSON input.`); }
    }
    ordered.push(node);
    for (const child of outgoing.get(id)!) {
      degrees.set(child, degrees.get(child)! - 1);
      if (degrees.get(child) === 0) ready.push(child);
    }
  }
  if (ordered.length !== parsed.nodes.length) throw new Error('The workflow contains a cycle or disconnected steps.');
  return ordered;
}
