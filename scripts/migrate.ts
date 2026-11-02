import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDb, transaction } from '../src/server/db';

async function main() {
 await getDb().query('create table if not exists public.taskllm_migrations(name text primary key, applied_at timestamptz not null default now())');
 for (const name of (await readdir(resolve('supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()) {
  await transaction(async client => {
   await client.query("select pg_advisory_xact_lock(hashtext('taskllm:migrations'))");
   if ((await client.query('select 1 from public.taskllm_migrations where name=$1',[name])).rowCount) return;
   await client.query(await readFile(resolve('supabase/migrations',name),'utf8'));
   await client.query('insert into public.taskllm_migrations(name) values($1)',[name]);
   console.log(`Applied ${name}`);
  });
 }
 await getDb().end();
}
main().catch(()=>{ console.error('Migration failed. Check database connectivity and SQL schema; no credentials were printed.'); process.exitCode=1; });
