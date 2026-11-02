import { NextResponse } from 'next/server';
import { authClient } from '@/server/auth';
import { appOrigin } from '@/server/config';
export async function GET(request:Request) {
  const url=new URL(request.url);const token_hash=url.searchParams.get('token_hash');const type=url.searchParams.get('type');
  if(token_hash && (type==='email'||type==='recovery'||type==='signup')) {const client=await authClient();const {error}=await client.auth.verifyOtp({token_hash,type});if(!error)return NextResponse.redirect(new URL(type==='recovery'?'/reset-password':'/dashboard',appOrigin()));}
  return NextResponse.redirect(new URL('/login?error=link-expired',appOrigin()));
}
