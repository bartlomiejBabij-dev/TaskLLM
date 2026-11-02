"use client";
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { CreditCard,KeyRound,UserRound,Bell,Shield,SlidersHorizontal } from 'lucide-react';
import { cn,PageHeader } from '@/components/ui';
const tabs=[['/settings','Profile',UserRound],['/settings/api-keys','API keys',KeyRound],['/settings/billing','Billing',CreditCard],['/settings/notifications','Notifications',Bell],['/settings/preferences','Preferences',SlidersHorizontal],['/settings/security','Security',Shield]] as const;
export default function SettingsLayout({children}:{children:ReactNode}){const path=usePathname();return <><PageHeader eyebrow="MAKE YOURSELF AT HOME" title="Settings" description="Your account, connections and preferences."/><div className="settings-layout"><nav className="settings-nav" aria-label="Settings navigation">{tabs.map(([href,label,Icon])=><Link className={cn(path===href&&'active')} key={href} href={href}><Icon size={16}/>{label}</Link>)}</nav><div className="settings-content">{children}</div></div></>}
