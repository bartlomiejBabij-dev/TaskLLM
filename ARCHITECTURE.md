# Architecture

The Next.js web process authenticates requests with Supabase, checks origin and user ownership, validates payloads and invokes server services. It never runs long workflows in an HTTP request. PostgreSQL is the source of truth; BullMQ/Redis dispatches durable execution intent to a separate worker. This is one application and one worker, without unnecessary microservices.

SQL migrations are used directly with parameterized `pg` queries rather than an additional ORM. This keeps row locks, composite ownership constraints, advisory locks and accounting transactions explicit. Versioned JSONB graphs are immutable. `workflow_nodes` and `workflow_edges` are security-invoker views over graph snapshots, avoiding two conflicting representations.

Enqueue locks the account, enforces monthly quotas and writes an execution plus an outbox entry atomically. The dispatcher can reconstruct jobs after Redis loss. Schedule slots have deterministic idempotency keys; missed slots coalesce into one run. The worker enforces per-account concurrency, duration limits and per-step checkpoints. Completed steps are reused after restart.

External effects cannot be made universally exactly-once. Explicit rate limits may be retried; ambiguous paid AI requests stop and retain their budget reservation for reconciliation. Email uses Resend idempotency keys; uncertain delivery is not blindly repeated. Integer microdollars track costs. Maximum request cost is reserved before dispatch; managed and BYOK usage stay separate. Pricing lives in `src/lib/ai/models.json`; review it whenever changing models or rates.

RLS restricts tenant reads, while browser writes and encrypted-key access are denied. Server SQL uses a trusted connection and must always filter the authenticated owner. API keys use AES-256-GCM with account/provider associated data. The master key belongs in the hosting secret manager. Rotating it requires decrypting and re-encrypting stored keys; losing it makes saved credentials unusable.

Checkout does not grant privileges. Verified webhooks serialize per customer, retrieve current Stripe state and synchronize entitlement records transactionally. Duplicate events are recorded once. Production operators must configure Stripe prices and portal options consistently with database plans.

The implemented nodes make requests only to fixed AI/email endpoints. Arbitrary HTTP and outgoing webhook nodes are intentionally absent until DNS/IP pinning and SSRF protections are implemented. External data is separated from system instructions; this reduces prompt-injection exposure but is not a guarantee that model output is trustworthy.

Primary integration references: [Supabase SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [OpenAI Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Claude models](https://platform.claude.com/docs/en/models/overview), [Stripe webhooks](https://docs.stripe.com/webhooks), [BullMQ idempotency](https://docs.bullmq.io/patterns/idempotent-jobs).
