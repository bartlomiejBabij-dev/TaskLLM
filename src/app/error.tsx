"use client";
import { Button } from "@/components/ui";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <div className="standalone-message"><h1>Something went wrong.</h1><p className="muted">We couldn’t load this page. Your saved workflows are safe.</p><Button onClick={reset}>Try again</Button></div>; }
