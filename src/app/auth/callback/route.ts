import { NextResponse } from 'next/server';
import { authClient } from '@/server/auth';
import { appOrigin } from '@/server/config';
export async function GET(request:Request) {
  const url=new URL(request.url); const code=url.searchParams.get('code');
  const next=url.searchParams.get('next')==='/reset-password'?'/reset-password':'/dashboard';
  if(code) { const client=await authClient();const {error}=await client.auth.exchangeCodeForSession(code);if(!error)return NextResponse.redirect(new URL(next,appOrigin())); }
  return NextResponse.redirect(new URL('/login?error=link-expired',appOrigin()));
}
