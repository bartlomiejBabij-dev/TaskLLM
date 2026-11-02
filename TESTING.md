# Testing

`npm test` runs domain, adapter, HTTP/auth, billing and database/engine tests. PGlite executes the real SQL migration and ownership/accounting constraints. Provider, Stripe, Supabase Auth and Resend calls are mocked where external credentials would be required. Stripe webhook signatures use the SDK's actual signing/verification code.

`npm run build` compiles the production application. `npm run test:e2e` requires that build plus Chromium (`npx playwright install chromium`). The Playwright harness runs on localhost:3001, temporary PostgreSQL on 55432 and fixture Auth on 54321. It creates ephemeral test accounts and data. AI responses are explicitly labelled fixtures. The real execution engine processes jobs directly; this does not validate BullMQ/Redis network behavior. Stop any other services using these test ports first.

The browser scenarios cover signup/login, visual AI configuration, save, run, result/history/usage and schedule persistence; mobile overflow and unauthenticated API access are checked too. Scheduling is additionally covered at the dispatcher/domain level. A real scheduled wakeup through Redis still needs deployment smoke testing.

Before release test real Supabase confirmation/recovery and cross-account access, provider model availability and token usage, Resend delivery, Stripe test-mode lifecycle, database/Redis outages, process crashes and budget reconciliation. PGlite is not a substitute for multi-connection PostgreSQL concurrency/load testing. No live external integration has been certified by the local test suite.
