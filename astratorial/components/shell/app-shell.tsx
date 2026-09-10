"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { AppConfig } from "@/lib/contracts";
import { api, ConfigContext, errorMessage } from "@/lib/client";
import { BrandMark, Icon, type IconName } from "./icon";
const links: { href: string; label: string; icon: IconName }[] = [{ href: "/", label: "Home", icon: "home" }, { href: "/library", label: "My tutorials", icon: "library" }, { href: "/explore", label: "Explore", icon: "compass" }];
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const refresh = useCallback(async () => { try { setConfig(await api<AppConfig>("/api/config")); setError(null); } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); } }, []);
  useEffect(() => { let active = true; api<AppConfig>("/api/config").then((value) => { if (active) { setConfig(value); setError(null); } }).catch((reason) => { if (active) setError(errorMessage(reason)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const title = pathname.startsWith("/create") ? "Create a tutorial" : pathname.startsWith("/tutorial") ? "Your next little victory" : pathname.startsWith("/practice") ? "Let's try it together" : pathname.startsWith("/settings") ? "Your space, your settings" : pathname.startsWith("/login") ? "Make yourself at home" : "A little more possible, every day";
  return <ConfigContext value={{ config, loading, error, refresh }}>
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside id="app-navigation" className={`sidebar ${menuOpen ? "is-open" : ""}`}>
      <Link href="/" className="brand" aria-label="astratorial home" onClick={() => setMenuOpen(false)}><BrandMark /><span>astratorial<span className="brand-period">.</span></span></Link>
      <div className="sidebar-caption">MAKE YOURSELF CAPABLE</div>
      <nav className="main-nav" aria-label="Main navigation">{links.map(({ href, label, icon }) => <Link key={href} href={href} className={`nav-link ${pathname === href ? "active" : ""}`} onClick={() => setMenuOpen(false)} aria-current={pathname === href ? "page" : undefined}><Icon name={icon} /><span>{label}</span>{pathname === href && <span className="nav-dot" />}</Link>)}</nav>
      <Link href="/create" className="button button-primary sidebar-create" onClick={() => setMenuOpen(false)}><Icon name="upload" size={18} /> Upload a video</Link>
      <div className="sidebar-note"><div className="sidebar-note-icon"><Icon name="sparkles" size={21} /></div><strong>Made for your real life.</strong><p>Your space. Your things.<br />A guide that gets it.</p><Link href="/create" onClick={() => setMenuOpen(false)}>See what&apos;s possible <Icon name="arrow" size={14} /></Link></div>
      <div className="sidebar-bottom"><Link className={`nav-link ${pathname === "/settings" ? "active" : ""}`} href="/settings" onClick={() => setMenuOpen(false)}><Icon name="settings" /><span>Settings</span>{!loading && !config?.configured && <span className="service-dot" />}</Link><Link className="profile-link" href={config?.user ? "/settings" : "/login"} onClick={() => setMenuOpen(false)}><span className="avatar">{config?.user?.email?.slice(0, 1).toUpperCase() || <Icon name="user" size={18} />}</span><span><strong>{config?.user ? config.user.email.split("@")[0] || "My workspace" : "Your personal space"}</strong><small>{config?.user ? config.user.email ? "Account settings" : "Saved in this browser" : "Your tutorials, ready when you are"}</small></span><Icon name="chevron" size={15} /></Link></div>
    </aside>
    {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <div className="app-body"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} aria-controls="app-navigation" onClick={() => setMenuOpen(!menuOpen)}><Icon name={menuOpen ? "close" : "menu"} /></button><span className="topbar-symbol"><BrandMark size={16} /></span><span className="topbar-title">{title}</span><Link href="/" className="mobile-brand" aria-label="astratorial home"><BrandMark size={18} /><span>astratorial.</span></Link></div><div className="topbar-right"><span className="powered-by"><span className="status-dot" /> Powered by Astra</span><Link href={config?.user ? "/library" : "/login"} className="topbar-avatar" aria-label={config?.user ? "My tutorials" : "Sign in"}>{config?.user?.email?.slice(0, 1).toUpperCase() || <Icon name="user" size={17} />}</Link></div></header><main className="app-main" id="main-content">{children}</main><footer className="app-footer"><span>A little guidance goes a long way.</span><Link href="/settings">{loading ? "Checking services…" : config?.configured ? "Your workspace is connected" : error ? "Check service connection" : "Preview workspace · connect services"}<Icon name="arrow" size={13} /></Link></footer></div>
  </ConfigContext>;
}
