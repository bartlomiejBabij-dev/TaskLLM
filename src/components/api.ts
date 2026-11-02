"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { ...(options?.body ? { "Content-Type": "application/json" } : {}), ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body.error?.message || "The request could not be completed. Please try again.");
  return body.data as T;
}
export function useResource<T>(url: string, poll = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try { const result = await api<T>(url); if (alive.current) { setData(result); setError(undefined); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Unable to load data."); }
    finally { if (alive.current) setLoading(false); }
  }, [url]);
  useEffect(() => { alive.current = true; setLoading(true); setData(undefined); void refresh(); const timer = poll ? setInterval(() => void refresh(), poll) : undefined; return () => { alive.current = false; if (timer) clearInterval(timer); }; }, [refresh, poll]);
  return { data, error, loading, refresh, setData };
}
