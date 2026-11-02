export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Configuration missing: ${name}`);
  return value;
}
export function appOrigin(): string {
  const url = new URL(process.env.APP_URL || 'http://localhost:3000');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('APP_URL requires HTTPS');
  return url.origin;
}
export function hasAuthConfig() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
export function hasAppConfig() { return hasAuthConfig() && Boolean(process.env.DATABASE_URL); }
