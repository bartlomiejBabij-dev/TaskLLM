import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { hasAppConfig, requiredEnv } from './config';

export async function authClient() {
  const jar = await cookies();
  return createServerClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'), {
    cookieOptions: { sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' },
    cookies: {
      getAll: () => jar.getAll(),
      setAll(values) { try { values.forEach(({name,value,options}) => jar.set(name,value,options)); } catch { /* Server Components refresh through proxy. */ } },
    },
  });
}
export function authAdmin() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } });
}
export async function authenticatedUser() {
  if (!hasAppConfig()) return null;
  const client = await authClient();
  // Remote verification also detects revoked sessions and deleted accounts.
  const {data,error} = await client.auth.getUser();
  return error ? null : data.user;
}
export async function requireUser() {
  if (!hasAppConfig()) redirect('/setup');
  const user = await authenticatedUser();
  if (!user) redirect('/login');
  return {id: user.id, email: user.email || ''};
}
