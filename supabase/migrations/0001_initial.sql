-- TaskLLM: immutable graphs, tenant isolation and durable execution accounting.
create table public.plans (
 id text primary key, name text not null, price_cents integer not null check(price_cents>=0),
 max_workflows integer not null check(max_workflows>0), max_nodes integer not null check(max_nodes>0),
 monthly_executions integer not null check(monthly_executions>0), monthly_ai_micros bigint not null check(monthly_ai_micros>=0),
 concurrency integer not null check(concurrency>0), max_duration_seconds integer not null check(max_duration_seconds>0),
 max_file_bytes integer not null check(max_file_bytes>0)
);
insert into public.plans values
 ('trial','Trial',0,3,10,25,0,1,120,1048576),
 ('starter','Starter',2900,15,25,500,5000000,2,300,2097152),
 ('pro','Pro',6900,100,75,3000,20000000,5,900,5242880),
 ('byok','BYOK',1900,50,50,2000,0,3,600,5242880);
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 email text not null default '', full_name text not null default '', timezone text not null default 'UTC',
 default_provider text not null default 'openai' check(default_provider in ('openai','anthropic')),
 default_model text not null default '', notify_completed boolean not null default true, notify_failed boolean not null default true,
 is_admin boolean not null default false, suspended boolean not null default false,
 spending_cap_micros bigint not null default 20000000 check(spending_cap_micros>=0), created_at timestamptz not null default now()
);
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,email,full_name) values(new.id,coalesce(new.email,''),coalesce(new.raw_user_meta_data->>'full_name',''));
 return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
create table public.subscriptions (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 plan_id text not null default 'trial' references public.plans(id),
 stripe_customer_id text unique, stripe_subscription_id text unique,
 status text not null default 'inactive', current_period_end timestamptz,
 cancel_at_period_end boolean not null default false,
 updated_at timestamptz not null default now(), last_event_created bigint not null default 0
);
create table public.api_keys (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
 provider text not null check(provider in ('openai','anthropic')), encrypted_key text not null,
 last_four text not null check(length(last_four)=4), status text not null default 'untested',
 created_at timestamptz not null default now(), unique(user_id,provider)
);
create table public.workflows (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
 name text not null check(length(name) between 1 and 100), description text not null default '',
 status text not null default 'draft' check(status in ('draft','active','paused')),
 current_version_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id)
);
create table public.workflow_versions (
 id uuid primary key default gen_random_uuid(), workflow_id uuid not null, user_id uuid not null,
 version integer not null check(version>0), graph jsonb not null check(jsonb_typeof(graph)='object' and octet_length(graph::text)<=1048576),
 created_at timestamptz not null default now(), unique(workflow_id,version), unique(id,workflow_id,user_id),
 foreign key(workflow_id,user_id) references public.workflows(id,user_id) on delete cascade
);
alter table public.workflows add constraint current_version_ownership foreign key(current_version_id,id,user_id) references public.workflow_versions(id,workflow_id,user_id) deferrable initially deferred;
create function public.immutable_version() returns trigger language plpgsql as $$begin raise exception 'Workflow versions are immutable'; end$$;
create trigger immutable_workflow_version before update on public.workflow_versions for each row execute function public.immutable_version();
create table public.schedules (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, workflow_id uuid not null,
 cron text, timezone text not null default 'UTC', next_run_at timestamptz, enabled boolean not null default true, ends_at timestamptz,
 created_at timestamptz not null default now(), foreign key(workflow_id,user_id) references public.workflows(id,user_id) on delete cascade,
 check(ends_at is null or next_run_at is null or ends_at>=next_run_at)
);
create table public.executions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, workflow_id uuid not null, version_id uuid not null,
 status text not null default 'queued' check(status in ('queued','running','completed','failed','cancelled')),
 idempotency_key text not null, created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
 heartbeat_at timestamptz, cancel_requested boolean not null default false, error text, result jsonb,
 input_tokens bigint not null default 0, output_tokens bigint not null default 0, cost_micros bigint not null default 0,
 max_duration_seconds integer not null, usage_month date not null, worker_attempts integer not null default 0 check(worker_attempts>=0), unique(user_id,idempotency_key), unique(id,user_id),
 foreign key(workflow_id,user_id) references public.workflows(id,user_id) on delete cascade,
 foreign key(version_id,workflow_id,user_id) references public.workflow_versions(id,workflow_id,user_id)
);
create table public.execution_steps (
 execution_id uuid not null, user_id uuid not null, node_id text not null, status text not null check(status in ('running','completed','failed','uncertain')),
 output jsonb, error text, started_at timestamptz not null default now(), finished_at timestamptz, attempts integer not null default 1,
 provider text, model text, input_tokens bigint not null default 0, output_tokens bigint not null default 0, cost_micros bigint not null default 0,
 billing_mode text check(billing_mode in ('managed','byok')), reserved_micros bigint not null default 0 check(reserved_micros>=0),
 primary key(execution_id,node_id), foreign key(execution_id,user_id) references public.executions(id,user_id) on delete cascade
);
create table public.execution_logs (
 id bigint generated always as identity primary key, user_id uuid not null, execution_id uuid not null,
 level text not null check(level in ('info','warn','error')), message text not null, created_at timestamptz not null default now(),
 foreign key(execution_id,user_id) references public.executions(id,user_id) on delete cascade
);
create table public.ai_usage (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, execution_id uuid not null, node_id text not null,
 workflow_id uuid not null, provider text not null, model text not null, billing_mode text not null check(billing_mode in ('managed','byok')),
 input_tokens bigint not null check(input_tokens>=0), output_tokens bigint not null check(output_tokens>=0), cost_micros bigint not null check(cost_micros>=0),
 created_at timestamptz not null default now(), unique(execution_id,node_id),
 foreign key(execution_id,user_id) references public.executions(id,user_id) on delete cascade,
 foreign key(workflow_id,user_id) references public.workflows(id,user_id) on delete cascade
);
create table public.usage_limits (
 user_id uuid not null references public.profiles(id) on delete cascade, month date not null,
 executions integer not null default 0 check(executions>=0), managed_spent_micros bigint not null default 0 check(managed_spent_micros>=0),
 byok_spent_micros bigint not null default 0 check(byok_spent_micros>=0), managed_reserved_micros bigint not null default 0 check(managed_reserved_micros>=0),
 byok_reserved_micros bigint not null default 0 check(byok_reserved_micros>=0), primary key(user_id,month)
);
create table public.workflow_templates (id text primary key, name text not null, category text not null, description text not null, graph jsonb not null, requirements jsonb not null default '[]', instructions text not null default '');
create table public.notifications (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
 dedupe_key text not null, title text not null, body text not null, read_at timestamptz, created_at timestamptz not null default now(), unique(user_id,dedupe_key)
);
create table public.uploaded_files (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
 storage_path text not null unique, name text not null, size_bytes integer not null check(size_bytes>0), mime_type text not null,
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '30 days'
);
create table public.payment_events (id text primary key, type text not null, created bigint not null, processed_at timestamptz not null default now());
create table public.audit_events (
 id bigint generated always as identity primary key, user_id uuid references public.profiles(id) on delete set null,
 action text not null, resource_id text, metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
create table public.job_outbox (
 execution_id uuid primary key references public.executions(id) on delete cascade,
 created_at timestamptz not null default now(), dispatched_at timestamptz, attempts integer not null default 0
);
create table public.rate_limits (key text primary key, window_start timestamptz not null, hits integer not null check(hits>=0));
create index workflows_user_updated on public.workflows(user_id,updated_at desc);
create index executions_user_created on public.executions(user_id,created_at desc);
create index executions_running on public.executions(user_id,heartbeat_at) where status='running';
create index schedules_due on public.schedules(next_run_at) where enabled;
create index ai_usage_user_created on public.ai_usage(user_id,created_at desc);
create index notifications_user_created on public.notifications(user_id,created_at desc);
create index outbox_pending on public.job_outbox(created_at) where dispatched_at is null;
create index execution_logs_execution on public.execution_logs(execution_id,id);
create index uploaded_files_expiry on public.uploaded_files(expires_at);

-- Clients only read their own data. All writes are authenticated server services.
do $$ declare t text; begin
 foreach t in array array['profiles','subscriptions','workflows','workflow_versions','schedules','executions','execution_steps','execution_logs','ai_usage','usage_limits','notifications','uploaded_files'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('revoke insert,update,delete,truncate,references,trigger on public.%I from anon,authenticated',t);
 execute format('create policy tenant_read on public.%I for select to authenticated using (%I = (select auth.uid()))',t,case when t='profiles' then 'id' else 'user_id' end);
 end loop;
 foreach t in array array['api_keys','payment_events','audit_events','job_outbox','rate_limits'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 end loop;
end$$;
alter table public.plans enable row level security;
alter table public.workflow_templates enable row level security;
create policy plans_read on public.plans for select to anon,authenticated using(true);
create policy templates_read on public.workflow_templates for select to anon,authenticated using(true);
grant select on public.plans, public.workflow_templates to anon,authenticated;
create view public.workflow_nodes with (security_invoker=true) as select v.id as version_id,v.workflow_id,v.user_id,n.value as node from public.workflow_versions v cross join lateral jsonb_array_elements(v.graph->'nodes') n;
create view public.workflow_edges with (security_invoker=true) as select v.id as version_id,v.workflow_id,v.user_id,e.value as edge from public.workflow_versions v cross join lateral jsonb_array_elements(v.graph->'edges') e;
grant select on public.workflow_nodes,public.workflow_edges to authenticated;
revoke all on function public.handle_new_user() from public;
