"use client";

import Link from "next/link";
import { LoaderCircle, AlertCircle, ArrowUpRight, Workflow, Inbox } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: Parameters<typeof clsx>) => twMerge(clsx(...inputs));
export function Button({ variant = "primary", loading, children, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; loading?: boolean }) {
  return <button {...props} disabled={props.disabled || loading} className={cn("button", `button-${variant}`, className)}>{loading && <LoaderCircle size={16} className="spin" />}{children}</button>;
}
export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>{action && <div className="header-actions">{action}</div>}</header>;
}
export function Card({ children, className }: { children: ReactNode; className?: string }) { return <section className={cn("card", className)}>{children}</section>; }
export function Status({ value }: { value: string }) { return <span className={cn("status", `status-${value}`)}><i />{value.replaceAll("_", " ")}</span>; }
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) { return <div role="alert" className="error-notice"><AlertCircle size={18} /><span>{message}</span>{retry && <Button variant="ghost" onClick={retry}>Try again</Button>}</div>; }
export function SuccessNotice({ children }: { children: ReactNode }) { return <div className="success-notice" role="status">{children}</div>; }
export function Skeleton({ rows = 3 }: { rows?: number }) { return <div className="skeleton-wrap" aria-label="Loading" role="status">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" />)}</div>; }
export function EmptyState({ title, description, action, icon = "workflow" }: { title: string; description: string; action?: ReactNode; icon?: "workflow" | "inbox" }) { const Icon = icon === "workflow" ? Workflow : Inbox; return <div className="empty-state"><span className="empty-icon"><Icon size={27} /></span><h3>{title}</h3><p className="muted">{description}</p>{action}</div>; }
export function TextLink({ href, children }: { href: string; children: ReactNode }) { return <Link className="text-link" href={href}>{children}<ArrowUpRight size={15} /></Link>; }
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>; }
export const number = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
export const money = (micros: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(micros / 1_000_000);
export const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
export function duration(start: string | null, end: string | null) { if (!start || !end) return "—"; const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000; return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`; }
