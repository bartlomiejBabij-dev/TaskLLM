"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight } from "lucide-react";
import { api } from "./api";
import { Button, ErrorNotice, Field, SuccessNotice } from "./ui";
import { Logo } from "./app-shell";

type Mode = "login" | "signup" | "reset" | "update-password";
const schema = z.object({ email: z.string(), password: z.string(), name: z.string() });
const copy = { login: { title: "Welcome back.", subtitle: "Your workflows are ready when you are.", action: "Log in", next: "New to TaskLLM?", link: "Create an account", href: "/signup" }, signup: { title: "Make room for better work.", subtitle: "Create your workspace and build your first automation.", action: "Create account", next: "Already have an account?", link: "Log in", href: "/login" }, reset: { title: "Reset your password.", subtitle: "We’ll send a reset link to your email address.", action: "Send reset link", next: "Remember your password?", link: "Log in", href: "/login" }, "update-password": { title: "Choose a new password.", subtitle: "Use a strong password to keep your workspace safe.", action: "Update password", next: "Need a new reset link?", link: "Request one", href: "/forgot-password" } };
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter(); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "", name: "" } });
  async function submit(values: z.infer<typeof schema>) { setError(""); setMessage(""); try { const payload = { action: mode, ...(mode !== "update-password" ? { email: values.email } : {}), ...(mode !== "reset" ? { password: values.password } : {}), ...(mode === "signup" ? { name: values.name } : {}) }; const result = await api<{ redirect?: string; message?: string }>("/api/auth", { method: "POST", body: JSON.stringify(payload) }); if (result.redirect) { router.push(result.redirect); router.refresh(); } else { setMessage(result.message || "Check your email for the next step."); } } catch (e) { setError(e instanceof Error ? e.message : "Unable to continue."); } }
  const content = copy[mode];
  return <div className="auth-form-container"><Logo /><p className="eyebrow">YOUR AI WORKSPACE</p><h1>{content.title}</h1><p className="muted">{content.subtitle}</p>{error && <ErrorNotice message={error} />}{message && <SuccessNotice>{message}</SuccessNotice>}<form className="form-stack" onSubmit={handleSubmit(submit)}>{mode === "signup" && <Field label="Full name"><input {...register("name")} required autoComplete="name" placeholder="Alex Morgan" maxLength={120} /></Field>}{mode !== "update-password" && <Field label="Email address"><input {...register("email")} type="email" required autoComplete="email" placeholder="you@company.com" /></Field>}{mode !== "reset" && <Field label={mode === "update-password" ? "New password" : "Password"} hint={mode === "signup" || mode === "update-password" ? "At least 12 characters." : undefined}><input {...register("password")} type="password" required minLength={mode === "login" ? 1 : 12} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="Enter your password" /></Field>}{mode === "login" && <Link href="/forgot-password" className="auth-forgot">Forgot password?</Link>}<Button loading={isSubmitting} type="submit">{content.action}<ArrowRight size={16} /></Button></form><p className="auth-switch">{content.next}<Link href={content.href}>{content.link}</Link></p>{mode === "signup" && <p className="auth-switch">By creating an account, you agree to our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.</p>}<div className="auth-links"><Link href="/">← Back to home</Link><span>TaskLLM</span></div></div>;
}
