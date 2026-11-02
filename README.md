# TaskLLM

AI workflow automation SaaS built with Next.js, React, TypeScript, Supabase PostgreSQL/Auth, XYFlow, BullMQ and Redis. This repository contains the application, standalone worker, database migration, tests and deployment configuration.

## Start

Use Node.js 24. Copy `.env.example` to `.env.local`, configure Supabase/PostgreSQL, Redis and a random encryption key, then run:

```sh
npm ci
npm run db:migrate
npm run dev
# Separate terminal:
npm run worker
```

Without service credentials, the public site runs and private routes show setup instructions. No production demo login or fabricated usage data is enabled.

## Implemented

- Registration/login/reset/confirmation through Supabase; protected workspace and tenant RLS.
- Visual workflow editor, graph validation, variables, immutable versions, manual execution, checkpointed steps, cancellation and history.
- Text/JSON/CSV/KPI/AI/transform/parser/email/save nodes and six editable templates.
- Dedicated worker, durable PostgreSQL outbox, retries with bounds, schedules with timezones and DST.
- OpenAI/Anthropic adapters, encrypted BYOK, managed AI, token/cost accounting and budget reservations.
- Stripe Checkout/Portal, signed idempotent webhooks, plan limits, settings, notifications and aggregate admin view.
- Responsive light/dark interface and deployment files.

External integrations require your accounts and keys. Passing mocked tests is not evidence of live provider delivery or production readiness. See [TESTING.md](TESTING.md), [DEPLOYMENT.md](DEPLOYMENT.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [STATUS.md](STATUS.md).

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The E2E harness uses a real embedded PostgreSQL engine and real application execution logic, with explicit Auth/AI fixtures. It is confined to `tests/`; it is not a production authentication bypass.
