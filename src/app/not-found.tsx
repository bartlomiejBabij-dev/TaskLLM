import Link from "next/link";
export default function NotFound() { return <div className="standalone-message"><p className="eyebrow">404</p><h1>This page took a different path.</h1><p className="muted">The page may have moved or no longer exists.</p><Link href="/dashboard" className="button button-primary">Back to overview</Link></div>; }
