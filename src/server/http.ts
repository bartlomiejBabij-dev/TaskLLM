import { NextResponse } from 'next/server';
import { z } from 'zod';
import { appOrigin } from './config';
import { query } from './db';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function ok(data: unknown, status = 200) { return NextResponse.json({data}, {status,headers:{'Cache-Control':'private, no-store'}}); }
export function failure(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json({error:error.message},{status:error.status});
  if (error instanceof z.ZodError) return NextResponse.json({error:error.issues.map(i=>`${i.path.join('.') || 'Input'}: ${i.message}`).join('; ')},{status:400});
  // Service errors use a status/code contract; never echo arbitrary SQL or provider errors.
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
    return NextResponse.json({error:error instanceof Error ? error.message : 'Request rejected'},{status:error.status});
  }
  console.error('Request failed', {type: error instanceof Error ? error.name : 'UnknownError'});
  return NextResponse.json({error:'The request could not be completed. Check the service configuration or try again.'},{status:503});
}
export function checkOrigin(request: Request) {
  if (!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.get('origin') !== appOrigin()) throw new HttpError(403,'Request origin is not allowed.');
}
export async function readBody(request: Request, maxBytes = 1_100_000): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HttpError(415,'Use application/json.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400,'Request body is required.');
  let size = 0; const chunks: Uint8Array[]=[];
  for (;;) { const {value,done}=await reader.read(); if(done) break; size+=value.byteLength; if(size>maxBytes) {await reader.cancel();throw new HttpError(413,'Request is too large.');} chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400,'Invalid JSON.'); }
}
export async function rateLimit(key: string, maximum = 120, seconds = 60) {
  const result = await query<{hits:number}>(`INSERT INTO rate_limits(key,window_start,hits) VALUES($1,now(),1)
    ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.window_start < now()-($2::int * interval '1 second') THEN 1 ELSE rate_limits.hits+1 END,
    window_start=CASE WHEN rate_limits.window_start < now()-($2::int * interval '1 second') THEN now() ELSE rate_limits.window_start END RETURNING hits`,[key,seconds]);
  if (result[0].hits > maximum) throw new HttpError(429,'Too many requests. Please try again shortly.');
}
