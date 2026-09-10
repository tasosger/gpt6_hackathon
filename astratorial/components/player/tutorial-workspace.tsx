"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Clock3, Download, Expand, Eye, Globe2, LockKeyhole, Mic, Pause, Play, RotateCcw, ScanLine, Share2, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import { getExample } from "@/lib/examples";
import type { Tutorial } from "@/lib/contracts";
import { useVoice } from "@/lib/use-voice";
import { useRouter } from "next/navigation";
import { api, ApiError, post, useAppConfig } from "@/lib/client";
import type { CameraMode } from "./scene-viewer";

const SceneViewer = dynamic(() => import("./scene-viewer"), { ssr: false, loading: () => <div className="scene-unavailable">Loading the 3D player…</div> });
const seconds = (time: number) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;

export default function TutorialWorkspace({ id }: { id: string }) {
  const router = useRouter();
  const { config, refresh } = useAppConfig();
  const [tutorial, setTutorial] = useState<Tutorial | null>(() => getExample(id) ?? null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!getExample(id));
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [mode, setMode] = useState<CameraMode>("third");
  const [narration, setNarration] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [playbackEpoch, setPlaybackEpoch] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const loadedSceneUrls = useRef(new Map<string, string>());
  const hydratedRevision = useRef<number | null>(null);
  const lastHydratedAt = useRef(0);
  const markSceneReady = useCallback(() => {
    const asset = (detailed && tutorial?.scene?.assets.find(item => item.kind === "detail")) || tutorial?.scene?.assets.find(item => item.kind === "scene" || item.kind === "sanitized_scene");
    if (asset?.url) loadedSceneUrls.current.set(asset.path, asset.url);
    setSceneReady(true);
  }, [detailed, tutorial?.scene]);
  const [sharePreview, setSharePreview] = useState<Tutorial | null>(null);
  const [shareJob, setShareJob] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const currentTime = useRef(0);
  const [speed, setSpeed] = useState(1);
  const steps = tutorial?.plan?.steps ?? [];
  const timing = tutorial?.scene?.steps ?? steps.map((step, i) => ({ stepId: step.id, startTime: steps.slice(0, i).reduce((sum, s) => sum + s.durationSeconds, 0), endTime: steps.slice(0, i + 1).reduce((sum, s) => sum + s.durationSeconds, 0), clipName: step.id }));
  const duration = tutorial?.scene?.durationSeconds ?? timing.at(-1)?.endTime ?? 1;
  const stepIndex = Math.max(0, timing.findIndex((step, i) => time >= step.startTime && (time < step.endTime || i === timing.length - 1)));
  const step = steps[stepIndex];
  const videoAsset = tutorial?.scene?.assets.find(a => a.kind === "video" || a.kind === "sanitized_video");
  const narrationAssets = tutorial?.scene?.assets.filter(a => a.kind === "narration" || a.kind === "sanitized_narration") ?? [];
  const narrationAsset = narrationAssets.find(a => a.stepId === step?.id) ?? narrationAssets.find(a => !a.stepId);
  const hasDetail = tutorial?.scene?.assets.some(asset => asset.kind === "detail" && asset.url);
  const isOwner = tutorial?.ownerId === config?.user?.id;
  const voice = useVoice(id, undefined, useCallback(() => setPlaying(false), []), step ? { stepId: step.id, cameraMode: mode } : undefined, context => {
    const selected = timing.find(t => t.stepId === context.stepId);
    if (selected && (context.action === "repeat_step" || context.stepId !== step?.id)) {
      currentTime.current = selected.startTime; setTime(selected.startTime); setPlaybackEpoch(value => value + 1);
    }
    if (context.cameraMode) setMode(context.cameraMode);
    setPlaying(context.action === "resume_practice" || context.action === "repeat_step");
  });
  useEffect(() => { currentTime.current = time; }, [time]);

  const stopVoice = voice.stop;
  const acceptHydrated = useCallback((value: Tutorial) => {
    if (hydratedRevision.current !== null && hydratedRevision.current !== value.revision) {
      setPlaying(false); setTime(0); currentTime.current = 0; setPlaybackEpoch(epoch => epoch + 1);
      setDetailed(false); setSceneReady(false); setSharePreview(null); setShareJob(null); loadedSceneUrls.current.clear(); stopVoice();
      setNotice("This tutorial was updated. Start with the refreshed scene when you’re ready.");
    }
    hydratedRevision.current = value.revision; lastHydratedAt.current = Date.now();
    const scene = value.scene ? { ...value.scene, assets: value.scene.assets.map(asset => loadedSceneUrls.current.has(asset.path) ? { ...asset, url: loadedSceneUrls.current.get(asset.path) } : asset) } : null;
    setTutorial({ ...value, scene });
  }, [stopVoice]);
  useEffect(() => {
    if (getExample(id)) return;
    let cancelled = false, inFlight = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try { const result = await api<{ tutorial: Tutorial }>(`/api/tutorials/${encodeURIComponent(id)}`, { signal: controller.signal }); if (!cancelled) acceptHydrated(result.tutorial); }
      catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiError && [401,403,404].includes(cause.status)) { setPlaying(false); stopVoice(); setTutorial(null); setShareOpen(false); setError(cause.message); }
        else if (!hydratedRevision.current) setError(cause instanceof Error ? cause.message : "This tutorial could not load. Please refresh to try again.");
      } finally { inFlight = false; if (!cancelled) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 240_000);
    const visible = () => { if (!document.hidden && Date.now() - lastHydratedAt.current >= 240_000) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [id, acceptHydrated, stopVoice]);
  async function toggleDetail() {
    setPlaying(false);
    if (!detailed && !tutorial?.isExample) {
      const detail = tutorial?.scene?.assets.find(asset => asset.kind === "detail");
      if (detail && !loadedSceneUrls.current.has(detail.path)) {
        setBusy(true);
        try { const result = await api<{tutorial: Tutorial}>(`/api/tutorials/${encodeURIComponent(id)}`); const changed = result.tutorial.revision !== tutorial?.revision; acceptHydrated(result.tutorial); if (changed) return; }
        catch { setNotice("The detailed scene link could not refresh. Please try again in a moment."); return; }
        finally { setBusy(false); }
      }
    }
    setDetailed(value => !value);
  }
  useEffect(() => {
    if (!playing) return;
    let frame = 0, last = performance.now(), cursor = currentTime.current;
    const advance = (now: number) => {
      const delta = Math.min((now - last) / 1000, .1) * speed; last = now;
      cursor = Math.min(duration, cursor + delta); currentTime.current = cursor; setTime(cursor);
      if (cursor >= duration) { setPlaying(false); return; }
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance); return () => cancelAnimationFrame(frame);
  }, [playing, speed, duration, playbackEpoch]);
  useEffect(() => {
    const element = audio.current;
    if (!element || !narrationAsset?.url) return;
    const target = Math.max(0, currentTime.current - (narrationAsset.stepId ? timing[stepIndex]?.startTime ?? 0 : 0));
    element.currentTime = target;
    element.playbackRate = speed;
    if (playing && narration) void element.play().catch(() => setNotice("Tap play to allow narration audio.")); else element.pause();
  }, [playing, narration, speed, narrationAsset?.url, narrationAsset?.stepId, stepIndex, playbackEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const seek = (value: number) => {
    const next = Math.min(duration, Math.max(0, value)); setTime(next);
    setPlaying(false);
    currentTime.current = next; setPlaybackEpoch(value => value + 1);
    const selected = timing.find(t => next >= t.startTime && next < t.endTime);
    if (audio.current && (!narrationAsset?.stepId || narrationAsset.stepId === selected?.stepId)) audio.current.currentTime = narrationAsset?.stepId ? Math.max(0, next - (selected?.startTime ?? 0)) : next;
  };
  useEffect(() => { const visibility = () => { if (document.hidden) setPlaying(false); }; document.addEventListener("visibilitychange", visibility); return () => document.removeEventListener("visibilitychange", visibility); }, []);
  useEffect(() => {
    if (!shareOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setShareOpen(false); return; }
      if (event.key !== "Tab") return;
      const items = focusable(); const first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, [shareOpen]);
  function copyLink() {
    if (!navigator.clipboard?.writeText) { setNotice("Copy the tutorial link from your browser’s address bar."); return; }
    void navigator.clipboard.writeText(window.location.href).then(() => setNotice("Link copied.")).catch(() => setNotice("Copy the tutorial link from your browser’s address bar."));
  }
  async function fullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen?.(); else if (viewport.current?.requestFullscreen) await viewport.current.requestFullscreen(); else setNotice("Fullscreen is not supported in this browser. You can still use the full 3D player here."); }
    catch { setNotice("Fullscreen is not supported in this browser. You can still use the full 3D player here."); }
  }
  const onSceneError = useCallback((message: string) => { setNotice(detailed ? `${message} Switching back to the mobile scene.` : `${message} Refresh this page to renew the scene link if it expired.`); if (detailed) setDetailed(false); }, [detailed]);
  async function adapt() {
    setBusy(true); setNotice("");
    try {
      if (!config?.user) { await post("/api/auth/guest"); await refresh(); }
      const result = await post<{ tutorial: Tutorial }>(`/api/tutorials/${id}/adapt`);
      router.push(`/create?id=${result.tutorial.id}`);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Please try again."); } finally { setBusy(false); }
  }

  async function publish(unpublish = false) {
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/tutorials/${id}/${unpublish ? "unpublish" : "publish"}`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ scope: "task_area", confirm: !!sharePreview }) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : result.error?.message || "Sharing could not be updated.");
      if (result.tutorial) { setTutorial(result.tutorial); if (unpublish) { setSharePreview(null); setShareJob(null); } }
      if (result.preview) { setSharePreview(result.preview); setNotice("Review the task-area preview, then publish when you’re happy with what it includes."); return; }
      if (result.job) setShareJob(result.job.id);
      setNotice(result.job ? "Preparing a separate task-area export. Your original scan remains private. Check your library for its progress." : unpublish ? "This tutorial is private again." : "Your tutorial is now public.");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Sharing could not be updated."); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!shareJob) return;
    let cancelled = false, inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/jobs/${shareJob}`); const result = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Sharing progress could not refresh. Retrying shortly.");
        if (result.job.status === "completed") {
          const previewResponse = await fetch(`/api/tutorials/${id}/publish`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({scope:"task_area"}) });
          const previewResult = await previewResponse.json();
          if (cancelled) return;
          if (!previewResponse.ok) throw new Error(typeof previewResult.error === "string" ? previewResult.error : "The sharing preview could not load. Retrying shortly.");
          if (!previewResult.preview) throw new Error("The publication preview is not available yet. Please wait while we try again.");
          if (previewResult.preview) { setSharePreview(previewResult.preview); setNotice("Review the task-area preview before publishing."); }
          setShareJob(null);
        } else if (["failed","cancelled","budget_paused","needs_context"].includes(result.job.status)) { setNotice(result.job.message); setShareJob(null); }
      } catch (cause) { if (!cancelled) setNotice(cause instanceof Error ? cause.message : "Sharing progress could not refresh. Retrying shortly."); }
      finally { inFlight = false; }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [shareJob, id]);

  if (loading) return <div className="player-page"><div className="scene-unavailable"><span className="spinner" />Opening your tutorial…</div></div>;
  if (!tutorial) return <div className="player-page"><Link href="/library" className="player-back"><ArrowLeft size={16} />Back to library</Link><div className="panel player-empty"><h1>Tutorial unavailable</h1><p>{error || "This tutorial may be private or no longer available."}</p><Link className="button button-primary" href="/explore">Explore tutorials</Link></div></div>;
  return <div className="player-page">
    <div className="player-breadcrumb"><Link href="/library"><ArrowLeft size={15} />Your library</Link><span>/</span><span>{tutorial.category === "coffee" ? "Coffee & drinks" : tutorial.category === "assembly" ? "Make & assemble" : tutorial.category === "cooking" ? "In the kitchen" : "Around the home"}</span></div>
    <header className="tutorial-heading"><div><div className="eyebrow"><span className="live-dot" />{tutorial.isExample ? "INTERACTIVE EXAMPLE" : tutorial.scene?.mode === "illustrated" ? "ILLUSTRATED TUTORIAL" : "MADE FOR YOUR SPACE"}</div><h1>{tutorial.title}</h1><p>{tutorial.description}</p></div><div className="tutorial-heading-actions"><button className="button button-secondary" onClick={() => { setPlaying(false); setShareOpen(true); }}><Share2 size={16} />Share</button>{videoAsset?.url && <a className="icon-button" href={videoAsset.url} download title="Download narrated tutorial"><Download size={18} /></a>}</div></header>
    <div className="tutorial-meta"><span><Clock3 size={14} />{tutorial.plan?.estimatedMinutes ?? 5} min</span><span><ScanLine size={14} />{steps.length} steps</span><span><Sparkles size={14} />{tutorial.plan?.difficulty ?? "Beginner"} friendly</span><span>{tutorial.visibility === "public" ? <Globe2 size={14} /> : <LockKeyhole size={14} />}{tutorial.isExample ? "Example workspace" : tutorial.visibility === "public" ? "Public tutorial" : "Only you"}</span></div>
    <div className="tutorial-grid"><section className="tutorial-stage">
      <div className="scene-viewport" ref={viewport}>
        <div className="scene-toolbar"><span className="scene-live-label"><span />{tutorial.isExample ? "EXAMPLE SCENE" : tutorial.scene?.mode === "illustrated" ? "ILLUSTRATED SCENE" : "YOUR 3D WORKSPACE"}</span><div className="camera-switch">{(["third", "first", "free"] as const).map(view => <button key={view} className={mode === view ? "active" : ""} aria-pressed={mode === view} onClick={() => setMode(view)}>{view === "third" ? "Third person" : view === "first" ? "First person" : "Free view"}</button>)}</div>{hasDetail && <button className="scene-detail-button" disabled={!sceneReady || busy} aria-pressed={detailed} aria-label={detailed ? "Use mobile detail" : "More detail"} title={detailed ? "Use mobile detail" : "Load the more detailed scene"} onClick={() => void toggleDetail()}><Eye size={15} /><span className="scene-detail-label">{detailed ? "Mobile detail" : "More detail"}</span></button>}<button className="scene-expand" aria-label="Fullscreen tutorial" onClick={() => void fullscreen()}><Expand size={17} /></button></div>
        <SceneViewer key={`${tutorial.revision}:${detailed ? "detail" : "mobile"}`} tutorial={tutorial} time={time} mode={mode} detailed={detailed} onReady={markSceneReady} onError={onSceneError} />
        <div className="scene-caption"><span>STEP {stepIndex + 1} OF {steps.length}</span><p>{step?.instruction || "Your scene is being prepared."}</p></div>
        {mode === "free" && <span className="orbit-hint">Drag to orbit · Pinch to zoom</span>}
      </div>
      <div className="player-transport"><button className="transport-play" aria-label={playing ? "Pause tutorial" : "Play tutorial"} onClick={() => { if (time >= duration) seek(0); setPlaying(!playing); }}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><button aria-label="Replay current step" onClick={() => { seek(timing[stepIndex]?.startTime ?? 0); setPlaying(true); }}><RotateCcw size={17} /></button><span className="player-time">{seconds(time)}</span><input aria-label="Tutorial timeline" type="range" min={0} max={duration} step={.1} value={time} onChange={event => seek(Number(event.target.value))} /><span className="player-time">{seconds(duration)}</span><button disabled={!narrationAsset?.url} title={narrationAsset?.url ? undefined : "Narration is included in generated tutorials"} aria-label={narration ? "Mute narration" : "Enable narration"} onClick={() => setNarration(!narration)}>{narration ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><select aria-label="Playback speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={.5}>0.5×</option><option value={.75}>0.75×</option><option value={1}>1×</option><option value={1.5}>1.5×</option></select></div>
      {narrationAsset?.url && <audio ref={audio} src={narrationAsset.url} preload="auto" onLoadedMetadata={() => { if (audio.current) audio.current.currentTime = Math.max(0, currentTime.current - (narrationAsset.stepId ? timing[stepIndex]?.startTime ?? 0 : 0)); }} />}
      <div className="tutor-conversation"><div className="tutor-avatar"><Sparkles size={19} /></div><div><strong>Your tutor is here</strong><p>{voice.transcript || "Ask a question, take it slower, or see that step again."}</p>{(voice.error || notice) && <p className="player-inline-error" role="status">{voice.error || notice}</p>}</div><button className={`button ${voice.status === "connected" ? "voice-active" : "button-secondary"}`} onClick={() => { setPlaying(false); if (tutorial.isExample) { setNotice("Live voice connects to your own saved tutorial. Create one to talk through your workspace with Astra."); return; } if (voice.status === "connected" || voice.status === "connecting") voice.stop(); else void voice.start(); }}><Mic size={16} />{voice.status === "connecting" ? "Cancel connection" : voice.status === "connected" ? "End conversation" : "Talk to tutor"}</button></div>
      {!tutorial.isExample && tutorial.scene?.mode === "illustrated" && <p className="example-disclosure"><Eye size={14} />Illustrated tutorial based on your video. Shapes, gestures, and distances are approximate.</p>}
      {tutorial.isExample && <p className="example-disclosure"><Eye size={14} />An illustrated example of the player. Your tutorial uses your captured room, equipment, and sources.</p>}
    </section><aside className="steps-panel"><div className="steps-panel-header"><span>YOUR TUTORIAL</span><span>{String(stepIndex + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}</span></div><div className="steps-list">{steps.map((item, index) => <button key={item.id} className={`tutorial-step ${index === stepIndex ? "current" : ""} ${index < stepIndex ? "visited" : ""}`} aria-current={index === stepIndex ? "step" : undefined} onClick={() => seek(timing[index]?.startTime ?? 0)}><span className="step-number">{String(index + 1).padStart(2, "0")}</span><span><strong>{item.title}</strong>{index === stepIndex && <small>{item.instruction}</small>}</span>{index === stepIndex && <span className="step-playing-dot" />}</button>)}</div><div className="step-navigation"><button onClick={() => seek(timing[Math.max(0, stepIndex - 1)]?.startTime ?? 0)} disabled={stepIndex === 0}><ChevronLeft size={16} />Previous</button><button onClick={() => seek(timing[Math.min(steps.length - 1, stepIndex + 1)]?.startTime ?? 0)} disabled={stepIndex === steps.length - 1}>Next<ChevronRight size={16} /></button></div><div className="ready-card"><div className="ready-icon"><ScanLine size={24} /></div><h2>Your turn.</h2><p>Bring the guide into your space. We’ll take it one step at a time.</p><>{tutorial.visibility === "public" && !tutorial.isExample && !isOwner ? <button className="button button-primary" disabled={busy} onClick={() => void adapt()}>Adapt to my space<ArrowRight size={17} /></button> : <Link className="button button-primary" href={`/tutorial/${tutorial.id}/${tutorial.slug}/practice`}>Ready to try it?<ArrowRight size={17} /></Link>}</><small>Camera guidance · Go at your pace</small></div></aside></div>
    {tutorial.plan?.sources && tutorial.plan.sources.length > 0 && <section className="tutorial-sources"><div><h2>Grounded in good instructions</h2><p>References used to build this tutorial.</p></div><div>{tutorial.plan.sources.map(source => <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer"><span>{source.title}</span><ArrowRight size={15} /></a>)}</div></section>}
    {shareOpen && <div className="player-modal-backdrop" onClick={() => setShareOpen(false)}><section ref={dialog} tabIndex={-1} className="player-modal" role="dialog" aria-modal="true" aria-label="Share tutorial" onClick={event => event.stopPropagation()}><button className="modal-close" aria-label="Close share dialog" onClick={() => setShareOpen(false)}><X size={20} /></button><div className="eyebrow">PASS IT ON</div><h2>A little help, shared.</h2>{tutorial.isExample || !isOwner ? <><p>Share this tutorial with someone curious.</p><button className="button button-primary" onClick={copyLink}><Share2 size={16} />Copy tutorial link</button></> : <><p>Publishing creates a separate export of your task area. Check the preview first: the room details visible in it will be shared. Your original videos remain private.</p>{sharePreview?.scene?.assets.find(a => a.kind === "sanitized_poster" && a.url) ? <Image unoptimized width={640} height={360} className="share-preview" src={sharePreview.scene.assets.find(a => a.kind === "sanitized_poster")!.url!} alt="Task-area publication preview" /> : <div className="share-preview-placeholder"><ScanLine size={28} /><p>Prepare the task-area preview before publishing.</p></div>}{sharePreview && <><h3 className="share-preview-title">{sharePreview.title}</h3><p>{sharePreview.description}</p><p><strong>Goal:</strong> {sharePreview.goal}</p>{sharePreview.scene?.assets.some(asset => asset.kind === "sanitized_scene" && asset.url) && <><div className="share-scene-preview"><SceneViewer tutorial={sharePreview} time={0} mode="free" onError={setNotice} /></div><p>Drag to inspect the actual task area that will be shared.</p></>}<details className="share-preview-fields"><summary>Review every public step</summary><ol>{sharePreview.plan?.steps.map(item => <li key={item.id}><strong>{item.title}</strong><p>{item.instruction}</p>{item.narration !== item.instruction && <p><strong>Spoken guidance:</strong> {item.narration}</p>}<p><strong>Completion check:</strong> {item.completionCriteria}</p></li>)}</ol></details>{!!sharePreview.plan?.objects.length && <details className="share-preview-fields"><summary>Review included objects</summary><ul>{sharePreview.plan.objects.map(item => <li key={item.id}><strong>{item.name}</strong><p>{item.notes}</p></li>)}</ul></details>}{!!sharePreview.plan?.sources.length && <details className="share-preview-fields"><summary>Review public references</summary><ul>{sharePreview.plan.sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><p>{source.note}</p><p style={{ overflowWrap: "anywhere" }}>{source.url}</p></li>)}</ul></details>}</>}<button className="button button-primary" disabled={busy || !!shareJob || !tutorial.scene} onClick={() => void publish()}>{busy || shareJob ? "Preparing…" : sharePreview ? "Publish task-area tutorial" : "Prepare sharing preview"}</button>{tutorial.visibility === "public" && <><button className="button button-secondary" onClick={copyLink}><Share2 size={15} />Copy public link</button><button className="button button-secondary" disabled={busy} onClick={() => void publish(true)}>Make private</button></>}</>}{notice && <p className="player-inline-error" role="status">{notice}</p>}</section></div>}
  </div>;
}
