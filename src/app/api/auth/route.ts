import { z } from 'zod';
import { createHash } from 'node:crypto';
import { authClient } from '@/server/auth';
import { appOrigin, hasAppConfig } from '@/server/config';
import { checkOrigin,failure,HttpError,ok,rateLimit,readBody } from '@/server/http';

const schema=z.object({action:z.enum(['login','signup','reset','update-password','logout']),email:z.email().max(254).optional(),password:z.string().min(12).max(128).optional(),name:z.string().trim().min(1).max(100).optional()});
export async function POST(request:Request) {
  try {
    checkOrigin(request);
    if(!hasAppConfig()) throw new HttpError(503,'Connect Supabase and the database before signing in.');
    const raw=await readBody(request,4096);
    // Existing accounts may have passwords shorter than our sign-up policy.
    const parsed=z.object({action:z.string(),password:z.string().max(128).optional()}).parse(raw);
    const input=parsed.action==='login' ? schema.omit({password:true}).extend({password:z.string().min(1).max(128)}).parse(raw) : schema.parse(raw);
    const identifier=createHash('sha256').update((input.email||'anonymous').toLowerCase()).digest('hex');
    if(input.action!=='logout') await rateLimit(`auth:${input.action}:${identifier}`,10,600);
    const client=await authClient();
    if(input.action==='logout') {const {error}=await client.auth.signOut();if(error)throw new HttpError(400,'Could not sign out.');return ok({redirect:'/login'});}
    if(input.action==='update-password') {
      const {data}=await client.auth.getUser();if(!data.user||!input.password)throw new HttpError(401,'Open a valid password reset link first.');
      const {error}=await client.auth.updateUser({password:input.password});if(error)throw new HttpError(400,'Password could not be updated. Request a new reset link.');
      return ok({redirect:'/dashboard',message:'Password updated.'});
    }
    if(!input.email)throw new HttpError(400,'Email is required.');
    if(input.action==='reset') {
      await client.auth.resetPasswordForEmail(input.email,{redirectTo:`${appOrigin()}/auth/callback?next=/reset-password`});
      return ok({message:'If an account exists for this email, you will receive a password reset link.'});
    }
    if(!input.password)throw new HttpError(400,'Password is required.');
    if(input.action==='signup') {
      const {data,error}=await client.auth.signUp({email:input.email,password:input.password,options:{data:{full_name:input.name||''},emailRedirectTo:`${appOrigin()}/auth/callback`}});
      if(error)throw new HttpError(400,'Account could not be created. Check your details or sign in.');
      return ok(data.session?{redirect:'/dashboard'}:{message:'Check your email to confirm your account before signing in.'});
    }
    const {error}=await client.auth.signInWithPassword({email:input.email,password:input.password});
    if(error)throw new HttpError(401,'Email or password is incorrect, or your email is not confirmed.');
    return ok({redirect:'/dashboard'});
  } catch(error) {return failure(error);}
}
