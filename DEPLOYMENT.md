# Deployment

## Supabase and database

1. Create a Supabase project. Put its URL and publishable key in the two NEXT_PUBLIC variables. Keep the service-role key server-only; it is used for account deletion.
2. Set DATABASE_URL to a direct or session-pooler PostgreSQL connection with certificate-validated TLS. The worker uses session advisory locks, so transaction pooling is unsuitable. Keep the database private to trusted services.
3. Run `npm run db:migrate` once from a trusted deployment environment. The migration creates tables, auth profile trigger, constraints, indexes, RLS and initial plans. Use a separate migration credential if applying least-privilege runtime roles.
4. Configure Auth Site URL and redirect allowlist for `/auth/callback`. For cross-device email confirmation use the token-hash template URL `/auth/confirm?token_hash={{ .TokenHash }}&type=email`; recovery uses type=recovery. Configure production SMTP and email confirmation. Verify signup/reset delivery on the real project.

## Secrets and AI

Generate 32 random bytes encoded as base64 for ENCRYPTION_KEY, for example `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Store it in the deployment secret manager; use the same value in web and worker. Never commit generated secrets. Back up the encryption key separately from the database.

Set managed OpenAI/Anthropic keys if selling managed AI. Users can instead add BYOK keys. Review `src/lib/ai/models.json` against current provider availability/pricing and your account permissions before enabling billing. Test each model with a small output cap. Provider APIs are billed separately from consumer ChatGPT/Claude subscriptions.

## Web and worker

- Web: import this repository into Vercel, set Node 24 and environment variables, build with `npm run build`. Set APP_URL to the exact HTTPS origin. Attach your domain and configure DNS in the hosting panel.
- Worker: deploy Dockerfile.worker on an always-on container host. Supply DATABASE_URL, REDIS_URL, ENCRYPTION_KEY and provider/email secrets. The worker must remain running while browsers are closed.
- Redis: use durable persistence and noeviction, private networking and TLS. `docker compose up -d` provides local Redis plus worker when Docker is installed. The compose file is local infrastructure, not a public Redis deployment.
- Health: `/api/health` checks web configuration/database availability. Also monitor worker process liveness, Redis connectivity, pending jobs, failed executions and uncertain AI reservations. A healthy web endpoint alone does not prove worker health.

## Stripe and email

Create monthly USD prices matching plans (initial hypotheses: Starter $29, Pro $69, BYOK $19). Set STRIPE_PRICE_STARTER/PRO/BYOK and server Stripe keys. Configure the Customer Portal for allowed upgrades/downgrades/cancellations. Register `/api/webhooks/stripe` for customer.subscription.created/updated/deleted and invoice.paid/payment_failed using snapshot events. Store the endpoint signing secret. Test duplicate, reordered, cancellation and payment-failure events using Stripe test mode before live mode.

For email nodes configure RESEND_API_KEY and RESEND_FROM with a verified sending domain. Confirm DNS and test delivery to an address you own. The code never marks an accepted message as confirmed inbox delivery.

## Before accepting customers

Run CI and real integration smoke tests, exercise restart/cancellation with actual Redis, review database permissions, enable backups and monitoring, reconcile uncertain provider charges, define retention and processor agreements, and replace preliminary privacy/terms with operator-specific reviewed text. Configure administrator status only through trusted database administration; never expose role elevation to signup metadata. No deployment or legal compliance is implied by the included configuration.
