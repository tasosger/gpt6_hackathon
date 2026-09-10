"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Tutorial } from "@/lib/contracts";
import { examples } from "@/lib/examples";
import { api, errorMessage, useAppConfig } from "@/lib/client";
import { BrandMark, Icon } from "@/components/shell/icon";
import { TutorialCard, categoryLabels, categoryIcons } from "./tutorial-card";
export function LibraryBrowser({ scope }: { scope: "mine" | "public" }) {
  const { config, loading: configLoading } = useAppConfig();
  const [tutorials, setTutorials] = useState<Tutorial[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!config?.services.database || (scope === "mine" && !config.user)) return;
    setLoading(true);
    try { const data = await api<{ tutorials: Tutorial[] }>(`/api/tutorials?scope=${scope}`); setTutorials(data.tutorials); setError(null); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  }, [config, scope]);
  useEffect(() => {
    if (!config?.services.database || (scope === "mine" && !config.user)) return;
    let active = true;
    api<{ tutorials: Tutorial[] }>(`/api/tutorials?scope=${scope}`).then((data) => { if (active) { setTutorials(data.tutorials); setError(null); } }).catch((reason) => { if (active) setError(errorMessage(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [config, scope]);
  useEffect(() => {
    if (scope !== "mine") return;
    const readDraft = () => { try { const saved = JSON.parse(localStorage.getItem("astratorial-draft-v1") ?? "null"); setDraft(saved?.title || saved?.goal || null); } catch { setDraft(null); } };
    const frame = requestAnimationFrame(readDraft);
    window.addEventListener("storage", readDraft);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("storage", readDraft); };
  }, [scope]);
  const all = scope === "public" ? [...tutorials, ...examples.filter((sample) => !tutorials.some((item) => item.id === sample.id))] : tutorials;
  const filtered = all.filter((tutorial) => (category === "all" || tutorial.category === category) && `${tutorial.title} ${tutorial.description} ${tutorial.goal}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="library-page"><div className="page-heading"><div><span className="eyebrow">{scope === "mine" ? "YOUR GROWING COLLECTION" : "A LITTLE INSPIRATION"}</span><h1>{scope === "mine" ? "Your everyday possibilities." : "There’s always something to try."}</h1><p>{scope === "mine" ? "All the things you’re learning, in a space of your own." : "Explore shared tutorials and curated examples. Find your next little victory."}</p></div><Link href="/create" className="button button-primary"><Icon name="plus" size={17} />Create a tutorial</Link></div>
    <div className="library-tools"><div className="category-filters"><button className={`filter-chip ${category === "all" ? "selected" : ""}`} onClick={() => setCategory("all")}>Everything{all.length > 0 ? ` · ${all.length}` : ""}</button>{(["coffee", "cooking", "assembly", "home"] as const).map((key) => <button key={key} className={`filter-chip ${category === key ? "selected" : ""}`} onClick={() => setCategory(key)}><Icon name={categoryIcons[key]} size={15} />{categoryLabels[key]}</button>)}</div><label className="search-field"><Icon name="search" size={17} /><input aria-label="Search tutorials" placeholder="Search your possibilities" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    {error && <div className="notice notice-error" role="alert">{error}<button className="text-link" onClick={() => void refresh()}>Try again</button></div>}
    {scope === "mine" && draft && <Link href="/create" className="local-draft-card"><span className="feature-icon"><Icon name="file" size={23} /></span><div><span className="eyebrow">DRAFT ON THIS DEVICE</span><h3>{draft}</h3><p>Pick up your idea. Your files will need to be added again.</p></div><span className="text-link">Continue draft <Icon name="arrow" size={17} /></span></Link>}
    {(loading && !!config?.services.database && (scope === "public" || !!config.user)) || configLoading ? <div className="loading-line"><span className="spinner" />Opening your collection…</div> : <><div className="tutorial-grid">{filtered.map((tutorial) => <TutorialCard tutorial={tutorial} key={tutorial.id} />)}</div>{filtered.length === 0 && <div className="empty-state"><span className="empty-illustration"><Icon name={query || category !== "all" ? "search" : "library"} size={39} /><span><BrandMark size={32} /></span></span><h2>{query || category !== "all" ? "Nothing here just yet." : "Your first little victory starts here."}</h2><p>{query || category !== "all" ? "Try another search or explore a different category." : "Show us what you’re working with. We’ll help turn an everyday task into something you can do with confidence."}</p>{query || category !== "all" ? <button className="button button-secondary" onClick={() => { setQuery(""); setCategory("all"); }}>Reset filters</button> : <div className="button-row"><Link href="/create" className="button button-primary"><Icon name="plus" size={17} />Create a tutorial</Link></div>}</div>}</>}
    {scope === "public" && <p className="collection-note"><Icon name="info" size={15} />Curated examples are illustrative walkthroughs. Your personal tutorials are created from your own space.</p>}
  </div>;
}
