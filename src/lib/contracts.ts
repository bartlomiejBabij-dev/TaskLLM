export type Provider = 'openai' | 'anthropic';
export type BillingMode = 'managed' | 'byok';
export type NodeType = 'manual' | 'text' | 'json' | 'csv' | 'kpi' | 'ai' | 'transform' | 'json_parse' | 'email' | 'save';
export interface WorkflowNode {
  id: string; type: NodeType; name: string; position: { x: number; y: number }; config: Record<string, unknown>;
}
export interface WorkflowEdge { id: string; source: string; target: string }
export interface WorkflowGraph { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
export interface Workflow { id: string; user_id: string; name: string; description: string; status: 'draft' | 'active' | 'paused'; graph: WorkflowGraph; current_version_id: string | null; created_at: string; updated_at: string }
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Execution { id: string; workflow_id: string; workflow_name?: string; status: ExecutionStatus; created_at: string; started_at: string | null; finished_at: string | null; error: string | null; cost_micros: number; input_tokens: number; output_tokens: number; result: unknown }
export interface ExecutionStep { node_id: string; status: string; output: unknown; error: string | null; started_at: string | null; finished_at: string | null; attempts: number; provider: string | null; model: string | null; input_tokens: number; output_tokens: number; cost_micros: number }
export interface Schedule { id: string; workflow_id: string; workflow_name?: string; cron: string | null; timezone: string; next_run_at: string | null; enabled: boolean; ends_at: string | null; created_at: string }
export interface Profile { id: string; email: string; full_name: string; timezone: string; default_provider: Provider; default_model: string; notify_completed: boolean; notify_failed: boolean; is_admin: boolean; suspended: boolean; spending_cap_micros: number }
export interface ApiKeySummary { id: string; provider: Provider; last_four: string; status: string; created_at: string }
export interface Plan { id: string; name: string; price_cents: number; max_workflows: number; max_nodes: number; monthly_executions: number; monthly_ai_micros: number; concurrency: number; max_duration_seconds: number; max_file_bytes: number }
export interface UsageSummary { input_tokens: number; output_tokens: number; managed_cost_micros: number; byok_cost_micros: number; requests: number; daily: {date: string; requests: number; cost_micros: number; tokens: number}[]; by_model: {model: string; requests: number; cost_micros: number; tokens: number}[]; by_workflow: {name: string; requests: number; cost_micros: number; tokens: number}[] }
export interface DashboardData { total_workflows: number; active_workflows: number; monthly_executions: number; success_rate: number | null; recent_executions: Execution[]; upcoming_runs: Schedule[]; usage: UsageSummary; plan: Plan }
export interface Template { id: string; name: string; description: string; category: string; requirements: string[]; instructions: string; graph: WorkflowGraph }
export interface Notification { id: string; title: string; body: string; read_at: string | null; created_at: string }
export interface ModelDefinition { id: string; provider: Provider; name: string; inputMicrosPerToken: number; outputMicrosPerToken: number; maxOutputTokens: number; supportsTemperature: boolean; supportsJson: boolean }
export interface AiRequest { provider: Provider; model: string; prompt: string; systemInstruction?: string; input?: unknown; maxOutputTokens: number; temperature?: number; structuredOutput?: boolean }
export interface AiResult { text: string; structuredData?: unknown; model: string; inputTokens: number; outputTokens: number; costMicros: number; durationMs: number }
