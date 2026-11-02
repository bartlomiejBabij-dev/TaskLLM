import type { Template, WorkflowGraph, WorkflowNode, NodeType } from '../contracts';

const reference = (id: string) => `{{steps.${id}.output}}`;
function sequence(nodes: { id: string; type: NodeType; name: string; config: Record<string, unknown> }[]): WorkflowGraph {
  const all = [{ id: 'start', type: 'manual' as const, name: 'Start workflow', config: {} }, ...nodes];
  return {
    nodes: all.map((node, index): WorkflowNode => ({ ...node, position: { x: 120 + index * 280, y: 180 } })),
    edges: all.slice(1).map((node, index) => ({ id: `${all[index].id}-${node.id}`, source: all[index].id, target: node.id })),
  };
}
function ai(id: string, name: string, prompt: string, input: string, provider: 'openai' | 'anthropic' = 'openai') {
  return { id, type: 'ai' as const, name, config: { provider, model: provider === 'openai' ? 'gpt-6-luna' : 'claude-sonnet-5-5', prompt, input, maxOutputTokens: 2048, billingMode: 'byok', systemInstruction: 'Produce a useful, factual response. Distinguish provided evidence from inference. State data limitations.' } };
}
function email(previous: string, subject: string) {
  return { id: 'email', type: 'email' as const, name: 'Email report', config: { to: 'recipient@example.com', subject, body: reference(previous) } };
}
function save(previous: string) { return { id: 'result', type: 'save' as const, name: 'Save result', config: { input: reference(previous) } }; }

export const templates: Template[] = [
  {
    id: 'marketing-report', name: 'Marketing report', category: 'Analytics',
    description: 'Calculate campaign KPIs, interpret the results, and deliver a concise executive report.',
    requirements: ['Campaign CSV with impressions, clicks, cost, conversions, revenue', 'OpenAI API key or Managed AI budget', 'Verified email sending domain and recipient'],
    instructions: 'Upload your campaign CSV in the CSV step. Map columns if their names differ. Select your billing mode in both AI steps and replace recipient@example.com. KPI calculations are deterministic; missing data is reported, not invented.',
    graph: sequence([
      { id: 'campaigns', type: 'csv', name: 'Campaign CSV', config: { csv: 'impressions,clicks,cost,conversions,revenue\n' } },
      { id: 'metrics', type: 'kpi', name: 'Calculate KPIs', config: { input: reference('campaigns') } },
      ai('analysis', 'Analyze performance', 'Interpret these programmatically calculated KPIs. Include Executive Summary, Key Performance Indicators, Biggest Changes (only if comparison data exists), Potential Problems, Actionable Recommendations, and Data Limitations. Never invent numeric values.', reference('metrics')),
      ai('summary', 'Executive summary', 'Create a clear executive summary with priorities and data limitations. Preserve the numeric facts exactly.', reference('analysis')),
      email('summary', 'Your marketing performance report'),
    ]),
  },
  {
    id: 'content-pipeline', name: 'AI content pipeline', category: 'Content',
    description: 'Turn a topic and source notes into an outline, a draft, and an editorial review.',
    requirements: ['Topic, target audience, and any source material', 'OpenAI API key or Managed AI budget'],
    instructions: 'Replace the input text with your brief and source notes. This template does not browse the web; provide sources for factual research. Choose your AI billing mode, then run.',
    graph: sequence([
      { id: 'brief', type: 'text', name: 'Content brief', config: { text: 'Replace this text with your topic, audience, goals, and source notes.' } },
      ai('outline', 'Create outline', 'Create a content outline from the supplied brief. List research gaps separately and do not claim to have searched the web.', reference('brief')),
      ai('draft', 'Write draft', 'Write an engaging, useful draft from this outline. Do not fabricate facts, statistics, quotes, or references.', reference('outline')),
      ai('review', 'Editorial review', 'Review the draft for clarity and unsupported claims. Return a revised draft followed by a brief verification checklist.', reference('draft')),
      save('review'),
    ]),
  },
  {
    id: 'feedback-analyzer', name: 'Customer feedback analyzer', category: 'Research',
    description: 'Read customer reviews, identify sentiment and recurring themes, and share findings.',
    requirements: ['CSV with a review column', 'OpenAI API key or Managed AI budget', 'Verified email sending domain and recipient'],
    instructions: 'Upload a review CSV, remove unnecessary personal data, choose your AI billing mode, and set the recipient. Findings are estimates from the supplied sample, not population statistics.',
    graph: sequence([
      { id: 'reviews', type: 'csv', name: 'Customer reviews', config: { csv: 'review\n' } },
      ai('sentiment', 'Analyze sentiment', 'Assess each review as positive, neutral, negative, or uncertain. Preserve row references. Do not infer personal or sensitive attributes.', reference('reviews')),
      ai('topics', 'Extract themes', 'Identify recurring topics supported by the review analysis. Distinguish one-off observations from themes; do not invent exact counts.', reference('sentiment')),
      ai('summary', 'Summarize findings', 'Summarize the strongest themes, sample limitations, and three practical improvements.', reference('topics')),
      email('summary', 'Customer feedback insights'),
    ]),
  },
  {
    id: 'seo-planner', name: 'SEO content planner', category: 'Marketing',
    description: 'Group your keywords and build a focused editorial plan without invented search metrics.',
    requirements: ['Keyword list and target audience', 'OpenAI API key or Managed AI budget'],
    instructions: 'Add your keywords and audience to the input step. Supply volume or competition data if needed; this template does not fetch search metrics. Configure your AI billing mode.',
    graph: sequence([
      { id: 'keywords', type: 'text', name: 'Keyword list', config: { text: 'Replace this text with your target keywords, audience, and any verified search metrics.' } },
      ai('clusters', 'Group keywords', 'Group the supplied keywords by search intent and topic. Use only the provided keywords and metrics.', reference('keywords')),
      ai('ideas', 'Generate content ideas', 'Suggest content ideas for each keyword cluster with search intent and an outline. Do not invent search volume.', reference('clusters')),
      ai('plan', 'Editorial plan', 'Build a four-week editorial plan based on these ideas. State prioritization assumptions and suggested ownership.', reference('ideas')),
      save('plan'),
    ]),
  },
  {
    id: 'scheduled-summary', name: 'Scheduled AI summary', category: 'Productivity',
    description: 'Summarize your source text and email it on the schedule you choose.',
    requirements: ['Source text', 'OpenAI API key or Managed AI budget', 'Verified email sending domain and recipient', 'A workflow schedule'],
    instructions: 'Replace the source text and email recipient. Choose your AI billing mode, save the workflow, activate it, and add a schedule with your timezone. Each run uses the latest saved workflow version.',
    graph: sequence([
      { id: 'source', type: 'text', name: 'Source material', config: { text: 'Replace this text with the material you want summarized.' } },
      ai('summary', 'Summarize material', 'Write a concise summary with key points, decisions, and open questions. State if the source contains insufficient information.', reference('source')),
      email('summary', 'Your scheduled AI summary'),
    ]),
  },
  {
    id: 'multi-model-analysis', name: 'Multi-model analysis', category: 'Research',
    description: 'Use OpenAI for the first analysis and Claude for an independent critique.',
    requirements: ['Question and source material', 'OpenAI and Anthropic API keys, or Managed AI access to both'],
    instructions: 'Provide the question and sources. Configure billing in all three AI steps. The critique is another model assessment, not external fact checking.',
    graph: sequence([
      { id: 'source', type: 'text', name: 'Question and sources', config: { text: 'Replace this text with your question, context, and supporting source material.' } },
      ai('analysis', 'OpenAI analysis', 'Analyze the supplied question and sources. Explain assumptions and uncertainties.', reference('source')),
      ai('review', 'Claude critique', 'Critically assess this analysis against the original source. Identify unsupported claims, alternatives, and limitations.', `Original source:\n${reference('source')}\n\nAnalysis:\n${reference('analysis')}`, 'anthropic'),
      ai('summary', 'Final synthesis', 'Synthesize the analysis and critique. Preserve disagreements and uncertainty rather than manufacturing consensus.', `Analysis:\n${reference('analysis')}\n\nCritique:\n${reference('review')}`),
      save('summary'),
    ]),
  },
];
