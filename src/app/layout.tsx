import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TaskLLM — Put your AI workflows on autopilot", template: "%s · TaskLLM" },
  description: "Build AI workflows, connect your models, schedule your prompts, and turn repeatable tasks into reliable automations.",
  applicationName: "TaskLLM",
  openGraph: { title: "TaskLLM — AI workflows on autopilot", description: "Your best work, running automatically. Visual AI workflows with transparent usage and control." },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en" suppressHydrationWarning><body><Providers>{children}</Providers></body></html>; }
