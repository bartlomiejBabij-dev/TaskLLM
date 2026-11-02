import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';

types.setTypeParser(20, value => { const number=Number(value); if(!Number.isSafeInteger(number)) throw new Error('Database integer exceeds safe range.'); return number; });

let pool: Pool | undefined;
export function getDb(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('Database is not configured. Set DATABASE_URL.');
  if(!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, statement_timeout: 15000, application_name: 'taskllm' });
    pool.on('error',()=>console.error('An idle database connection was closed. New operations will reconnect.'));
  }
  return pool;
}
export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getDb().query<T>(sql, params)).rows;
}
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDb().connect();
  try { await client.query('begin'); const result = await fn(client); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
