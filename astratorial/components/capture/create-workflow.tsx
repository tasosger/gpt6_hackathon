"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Upload } from "tus-js-client";
import { GENERATION_BUDGET_USD, type CaptureAsset, type GenerationJob, type Measurement, type Tutorial, tutorialHref } from "@/lib/contracts";
import { api, errorMessage, formatBytes, post, useAppConfig } from "@/lib/client";
import { Icon } from "@/components/shell/icon";
import { MeasurementEditor } from "./measurement-editor";
import { ScanRecorder } from "./scan-recorder";
import { GenerationProgress } from "./generation-progress";
type PendingFile = { id: string; file: File; kind: CaptureAsset["kind"]; pass: CaptureAsset["pass"]; progress: number; recorded?: boolean; asset?: CaptureAsset; error?: string };
type UploadConfig = { uploadId: string; asset: CaptureAsset; endpoint: string; headers: Record<string, string>; metadata: Record<string, string>; chunkSize: number };
type PendingUpload = { uploadId: string; asset: CaptureAsset; revision: number; createdAt: string; clientFingerprint?: string | null };
type CompletedUpload = { completed: true; uploadId: string; tutorial: Tutorial; asset: CaptureAsset };
function captureFileMetadata(file: File) {
  // Downloaded browser recordings keep their capture timestamp in the filename.
  // Use it when reselected, because saving a copy changes its filesystem mtime.
  const recording = /^(guided-scan|voice-context)-(\d{13})\.(webm|mp4|ogg)$/.exec(file.name);
  return { mimeType: recording ? `${recording[1] === "voice-context" ? "audio" : "video"}/${recording[3]}` : file.type.split(";")[0], lastModified: recording ? Number(recording[2]) : file.lastModified };
}
async function fileFingerprint(file: File) {
  const source = captureFileMetadata(file);
  const metadata = new TextEncoder().encode(JSON.stringify([file.name, file.size, source.mimeType, source.lastModified]));
  const sampleSize = 1_048_576;
  const [first, last] = await Promise.all([file.slice(0, sampleSize).arrayBuffer(), file.slice(Math.max(sampleSize, file.size - sampleSize)).arrayBuffer()]);
  const bytes = new Uint8Array(metadata.length + first.byteLength + last.byteLength);
  bytes.set(metadata); bytes.set(new Uint8Array(first), metadata.length); bytes.set(new Uint8Array(last), metadata.length + first.byteLength);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
function saveRecording(file: File) { const url = URL.createObjectURL(file); const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000); }
const passes: { id: CaptureAsset["pass"]; title: string; description: string }[] = [{ id: "room", title: "Around the room", description: "Walk slowly around the space with overlapping views. Keep the objects still and capture corners at different heights." }, { id: "work_area", title: "Your work area", description: "Move around your counter or table. Show the working surfaces, controls, and every object you will use." }, { id: "object", title: "A closer look at an object", description: "Keep the object still and move around it. Show every side, its label, and the surfaces you will touch." }, { id: "empty_surface", title: "The empty surface", description: "Set movable items aside and scan the surface underneath. Keep the surrounding room unchanged." }, { id: "open_closed", title: "Open and closed positions", description: "Capture a door, lid, or moving part in each position. Hold it still for each pass." }, { id: "reference", title: "A manual or reference", description: "Add product labels, assembly diagrams, PDF manuals, or a voice note with helpful context." }];
const steps = ["The idea", "Your space", "The details", "Your tutorial"];
const activeStatuses = ["running", "queued"];
function kindFor(file: File): CaptureAsset["kind"] | null { const type = captureFileMetadata(file).mimeType; if (type.startsWith("video/")) return "video"; if (type.startsWith("image/")) return "image"; if (type.startsWith("audio/")) return "audio"; if (type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return "manual"; return null; }
function lines(value: string) { return value.split("\n").map((line) => line.trim()).filter(Boolean); }

export function CreateWorkflow({ initialTutorialId }: { initialTutorialId?: string }) {
  const { config, loading: configLoading } = useAppConfig();
  const [step, setStep] = useState(0);
  const [tutorial, setTutorial] = useState<Tutorial | null>(null);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [constraints, setConstraints] = useState("");
  const [referenceUrls, setReferenceUrls] = useState("");
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [pass, setPass] = useState<CaptureAsset["pass"]>("room");
  const [recordMode, setRecordMode] = useState<"video" | "audio" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(initialTutorialId ? "load" : null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const upload = useRef<Upload | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const generationLock = useRef(false);
  const canSave = !!config?.services.database && !!config.user;
  const canGenerate = !!config?.configured && !!config.user;
  const running = !!job && activeStatuses.includes(job.status);
  const captureAssets = tutorial?.assets ?? [];
  const visualCount = captureAssets.filter((asset) => asset.kind === "image" || asset.kind === "video").length + files.filter((entry) => !entry.asset && (entry.kind === "image" || entry.kind === "video")).length;
  const passDetails = passes.find((item) => item.id === pass)!;
  const acceptTutorial = useCallback((value: Tutorial) => { setTutorial(value); setTitle(value.title); setGoal(value.goal); setConstraints(value.constraints.join("\n")); setReferenceUrls(value.referenceUrls.join("\n")); setMeasurements(value.measurements); }, []);

  useEffect(() => {
    let active = true;
    async function restore() {
      if (initialTutorialId) {
        try { const data = await api<{ tutorial: Tutorial }>(`/api/tutorials/${initialTutorialId}`); if (!active) return; acceptTutorial(data.tutorial); setJob(data.tutorial.job); setStep(data.tutorial.scene || data.tutorial.job?.kind === "generate" ? 3 : data.tutorial.plan ? 2 : 1);
          const pending = await api<{ uploads: PendingUpload[] }>(`/api/uploads?tutorialId=${data.tutorial.id}`); if (active) setPendingUploads(pending.uploads); }
        catch (reason) { if (active) setError(errorMessage(reason)); }
        finally { if (active) setBusy(null); }
      } else {
        try { const draft = JSON.parse(localStorage.getItem("astratorial-draft-v1") ?? "null"); if (draft?.goal && active) { setGoal(draft.goal); setTitle(draft.title ?? ""); setConstraints(draft.constraints ?? ""); setReferenceUrls(draft.referenceUrls ?? ""); } } catch { /* Ignore an obsolete draft. */ }
      }
    }
    void restore();
    return () => { active = false; void upload.current?.abort(); };
  }, [initialTutorialId, acceptTutorial]);

  const currentJobId = job?.id;
  const currentJobStatus = job?.status;
  useEffect(() => {
    if (!currentJobId || !currentJobStatus || !activeStatuses.includes(currentJobStatus)) return;
    const id = currentJobId;
    let stopped = false;
    let timer: number;
    async function poll() {
      try {
        const data = await api<{ job: GenerationJob; tutorial?: Tutorial }>(`/api/jobs/${id}`);
        if (stopped) return;
        setJob(data.job);
        if (data.job.status === "failed") setError(data.job.error || data.job.message || "This job could not finish. Your captures have been saved.");
        if (data.tutorial) acceptTutorial(data.tutorial);
        if (data.job.status === "completed" || data.job.status === "needs_context") {
          if (data.job.kind === "analyze") setStep(2);
          setAnswers({});
        }
        if (activeStatuses.includes(data.job.status)) timer = window.setTimeout(poll, 3000);
      } catch (reason) { if (!stopped) { setError(`We couldn’t refresh progress. Your job may still be running. ${errorMessage(reason)}`); timer = window.setTimeout(poll, 7000); } }
    }
    timer = window.setTimeout(poll, 1000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [currentJobId, currentJobStatus, acceptTutorial]);

  function saveLocal() { localStorage.setItem("astratorial-draft-v1", JSON.stringify({ version: 1, goal, title, constraints, referenceUrls })); setSaved(true); }
  async function saveDetails(current = tutorial, includeAnswers = false): Promise<Tutorial | null> {
    if (!goal.trim()) throw new Error("Tell us what you would like to learn first.");
    for (const reference of lines(referenceUrls)) { try { const parsed = new URL(reference); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); } catch { throw new Error("Add full website links beginning with https://, with one link per line."); } }
    if (!canSave) { saveLocal(); return null; }
    if (!current) {
      const result = await post<{ tutorial: Tutorial }>("/api/tutorials", { goal: goal.trim(), ...(title.trim() ? { title: title.trim() } : {}), constraints: lines(constraints), referenceUrls: lines(referenceUrls) });
      acceptTutorial(result.tutorial); const draftUrl = new URL(window.location.href); draftUrl.searchParams.delete("tutorial"); draftUrl.searchParams.set("id", result.tutorial.id); window.history.replaceState(window.history.state, "", draftUrl); setSaved(true); return result.tutorial;
    }
    const proposed = { goal: goal.trim(), title: title.trim() || current.title, constraints: lines(constraints), referenceUrls: lines(referenceUrls), measurements };
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(proposed)) if (JSON.stringify(value) !== JSON.stringify(current[key as keyof Tutorial])) changes[key] = value;
    if (includeAnswers && Object.values(answers).some((answer) => answer.trim())) changes.answers = answers;
    if (Object.keys(changes).length === 0) { setSaved(true); return current; }
    const result = await api<{ tutorial: Tutorial }>(`/api/tutorials/${current.id}`, { method: "PATCH", body: JSON.stringify({ ...changes, expectedRevision: current.revision }) });
    acceptTutorial(result.tutorial); if (includeAnswers) setAnswers({}); setSaved(true); return result.tutorial;
  }
  async function run(name: string, action: () => Promise<void>) { if (generationLock.current) return; generationLock.current = true; setBusy(name); setError(null); try { await action(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(null); generationLock.current = false; } }
  function addFiles(items: FileList | File[], recorded = false) {
    const next: PendingFile[] = [];
    for (const file of Array.from(items)) {
      if ([...files, ...next].some(entry => entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified && entry.file.type === file.type)) continue;
      const kind = kindFor(file);
      if (!kind) { setError(`“${file.name}” is not a supported video, photo, audio file, or PDF.`); continue; }
      if (file.size > 600_000_000) { setError(`“${file.name}” is larger than 600 MB. Please use a shorter capture.`); continue; }
      if (kind === "manual" && file.size > 10_000_000) { setError(`“${file.name}” is larger than the 10 MB manual limit.`); continue; }
      const manualBytes = captureAssets.filter((asset) => asset.kind === "manual").reduce((sum, asset) => sum + asset.size, 0) + files.filter((entry) => !entry.asset && entry.kind === "manual").reduce((sum, entry) => sum + entry.file.size, 0) + next.filter((entry) => entry.kind === "manual").reduce((sum, entry) => sum + entry.file.size, 0);
      if (kind === "manual" && manualBytes + file.size > 10_000_000) { setError("Keep all PDF manuals under 10 MB combined. You can also add reference website links."); continue; }
      const existingBytes = captureAssets.reduce((sum, asset) => sum + asset.size, 0) + files.filter((entry) => !entry.asset).reduce((sum, entry) => sum + entry.file.size, 0) + next.reduce((sum, entry) => sum + entry.file.size, 0);
      if (existingBytes + file.size > 2_000_000_000) { setError("Keep the combined captures under 2 GB per tutorial. Short, clear clips work best."); continue; }
      if (files.filter((entry) => !entry.asset).length + captureAssets.length + next.length >= 30) { setError("You can add up to 30 captures per tutorial."); break; }
      next.push({ id: crypto.randomUUID(), file, kind, pass: kind === "manual" || kind === "audio" ? "reference" : pass, progress: 0, recorded });
    }
    setFiles((current) => [...current, ...next]); setSaved(false);
  }
  async function uploadFiles(current: Tutorial) {
    if (!canSave) throw new Error("Sign in after connecting the workspace to upload your captures.");
    const tus = await import("tus-js-client");
    let latest = current;
    const pending = await api<{ uploads: PendingUpload[] }>(`/api/uploads?tutorialId=${current.id}`);
    setPendingUploads(pending.uploads);
    for (const entry of files.filter((item) => !item.asset)) {
      setFiles((all) => all.map((item) => item.id === entry.id ? { ...item, error: undefined } : item));
      try {
        const clientFingerprint = await fileFingerprint(entry.file);
        const previousTicket = pending.uploads.find(ticket => ticket.clientFingerprint === clientFingerprint && ticket.asset.name === entry.file.name && ticket.asset.size === entry.file.size);
        const configuration = previousTicket
          ? await post<UploadConfig | CompletedUpload>(`/api/uploads/${previousTicket.uploadId}/renew`)
          : await post<UploadConfig>("/api/uploads", { tutorialId: latest.id, name: entry.file.name, mimeType: captureFileMetadata(entry.file).mimeType || (entry.kind === "manual" ? "application/pdf" : "application/octet-stream"), size: entry.file.size, kind: entry.kind, pass: entry.pass, clientFingerprint });
        if ("completed" in configuration) {
          latest = configuration.tutorial; acceptTutorial(latest);
          setFiles(all => all.map(item => item.id === entry.id ? { ...item, kind: configuration.asset.kind, pass: configuration.asset.pass, progress: 100, asset: configuration.asset } : item));
          setPendingUploads(all => all.filter(ticket => ticket.uploadId !== configuration.uploadId));
          continue;
        }
        const destination = configuration;
        setFiles(all => all.map(item => item.id === entry.id ? { ...item, kind: destination.asset.kind, pass: destination.asset.pass } : item));
        await new Promise<void>((resolve, reject) => {
          const task = new tus.Upload(entry.file, { endpoint: destination.endpoint, headers: destination.headers, metadata: destination.metadata, chunkSize: destination.chunkSize, retryDelays: [0, 1000, 3000, 5000], removeFingerprintOnSuccess: true, uploadDataDuringCreation: true, fingerprint: async () => `astratorial-${destination.uploadId}-${entry.file.size}-${entry.file.lastModified}`, onError: reject, onSuccess: () => resolve(), onProgress: (sent, total) => setFiles((all) => all.map((item) => item.id === entry.id ? { ...item, progress: total ? sent / total * 100 : 0 } : item)) });
          upload.current = task;
          task.findPreviousUploads().then((previous) => { if (previous.length) task.resumeFromPreviousUpload(previous[0]); task.start(); }).catch(reject);
        });
        const completed = await post<{ tutorial: Tutorial; asset: CaptureAsset }>("/api/uploads/complete", { uploadId: destination.uploadId });
        latest = completed.tutorial; acceptTutorial(latest);
        setPendingUploads(all => all.filter(ticket => ticket.uploadId !== destination.uploadId));
        setFiles((all) => all.map((item) => item.id === entry.id ? { ...item, progress: 100, kind: completed.asset.kind, pass: completed.asset.pass, asset: completed.asset } : item));
      } catch (reason) { setFiles((all) => all.map((item) => item.id === entry.id ? { ...item, error: errorMessage(reason) } : item)); throw reason; }
    }
    upload.current = null;
    return latest;
  }
  async function analyze() {
    await run("analyze", async () => {
      let current = await saveDetails(tutorial, true);
      if (!current || !canGenerate) throw new Error("Connect the workspace services and sign in to analyze your space. Your draft is saved on this device.");
      if (files.some((entry) => !entry.asset)) current = await uploadFiles(current);
      const result = await post<{ job: GenerationJob }>(`/api/tutorials/${current.id}/analyze`);
      setJob(result.job); setStep(2);
    });
  }
  async function generate() {
    await run("generate", async () => {
      const current = await saveDetails();
      if (!current || !canGenerate) throw new Error("Connect the workspace services and sign in to generate this tutorial.");
      if (!current.plan) { setStep(2); throw new Error("Your idea changed. Analyze your captures again to refresh the tutorial plan."); }
      const result = await post<{ job: GenerationJob }>(`/api/tutorials/${current.id}/generate`); setJob(result.job); setStep(3);
      localStorage.removeItem("astratorial-draft-v1");
    });
  }
  async function controlJob(action: "cancel" | "resume") { if (!job) return; await run(action, async () => { const result = await post<{ job: GenerationJob }>(`/api/jobs/${job.id}/${action}`); setJob(result.job); }); }
  function addMeasurement(purpose: Measurement["purpose"]) { setMeasurements((current) => [...current, { id: crypto.randomUUID(), label: purpose === "scale" ? "Work surface width" : "Work surface depth", distanceMeters: 0, purpose, observations: [] }]); }
  const measurementsReady = ["scale", "validation"].every((purpose) => measurements.some((measurement) => measurement.purpose === purpose && measurement.label.trim() && measurement.distanceMeters > 0 && measurement.observations.length >= 2));

  return <div className="create-page"><div className="page-heading create-heading"><div><span className="eyebrow">LET’S MAKE SOMETHING POSSIBLE</span><h1>A tutorial, made for your world.</h1><p>Show us your space. Tell us what you have in mind. We&apos;ll take it one step at a time.</p></div><button className="button button-secondary" disabled={!!busy || running || !goal.trim()} onClick={() => void run("save", async () => { await saveDetails(); })}>{busy === "save" ? <span className="spinner" /> : <Icon name="file" size={15} />}{saved ? "Draft saved" : "Save draft"}</button></div>
    {!configLoading && !canGenerate && <div className="notice"><Icon name="info" size={16} /><span>{!config?.configured ? "You can prepare an idea here. Connect the workspace to upload captures and create a personal 3D tutorial." : "Sign in to upload your captures and save a tutorial of your own."}</span><Link href={!config?.configured ? "/settings" : "/login"} className="text-link">{!config?.configured ? "Workspace setup" : "Sign in"}</Link></div>}
    <nav className="workflow-stepper" aria-label="Create tutorial progress">{steps.map((label, index) => <button key={label} className={step === index ? "active" : index < step ? "completed" : ""} onClick={() => setStep(index)} disabled={!!busy || running || (index > step && !goal.trim())} aria-current={step === index ? "step" : undefined}><span className="step-number">{index < step ? <Icon name="check" size={12} /> : index + 1}</span>{label}</button>)}</nav>
    {error && <div className="notice notice-error" role="alert"><Icon name="info" size={16} /><span>{error}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setError(null)} style={{ marginLeft: "auto", border: 0 }}><Icon name="close" size={15} /></button></div>}
    <div className="create-columns"><section className="panel">{busy === "load" ? <div className="loading-line"><span className="spinner" />Opening your tutorial…</div> : step === 0 ? <><h2 className="subheading">What have you been meaning to try?</h2><p className="section-description">Big project or small everyday moment. Start with what you want to do.</p><label className="field"><span className="field-label-row">Your idea<span>Required</span></span><textarea className="goal-input" value={goal} maxLength={3000} onChange={(event) => { setGoal(event.target.value); setSaved(false); }} placeholder="I’d love to learn how to make an espresso with the machine in my kitchen…" /></label><div className="idea-chips">{["Make my morning espresso", "Cook with what’s in my fridge", "Assemble my new side table"].map((idea) => <button className="idea-chip" key={idea} onClick={() => { setGoal(idea); setSaved(false); }}>{idea}</button>)}</div><label className="field"><span className="field-label-row">Anything we should know?<span>Optional</span></span><textarea value={constraints} onChange={(event) => { setConstraints(event.target.value); setSaved(false); }} placeholder="I’m a beginner. I only have 15 minutes. I’d like to keep it dairy-free…" /><small>One preference per line helps keep things clear.</small></label><label className="field"><span className="field-label-row">A helpful link<span>Optional</span></span><textarea value={referenceUrls} onChange={(event) => { setReferenceUrls(event.target.value); setSaved(false); }} placeholder="https://manufacturer.com/your-product-manual" rows={2} style={{ minHeight: 70 }} /><small>Product pages, manuals, or tutorials. One full link per line.</small></label><div className="form-actions"><span className="draft-status"><Icon name="lock" size={13} />Only you can see your captures</span><button className="button button-primary" disabled={!!busy || !goal.trim()} onClick={() => void run("save", async () => { await saveDetails(); setStep(1); })}>{busy === "save" ? <span className="spinner" /> : "Show us your space"}<Icon name="arrow" size={16} /></button></div></> : step === 1 ? <><h2 className="subheading">Let us see what you’re working with.</h2><p className="section-description">A steady scan brings your space into the tutorial. Add close-ups and a manual if you have one. Keep each video under 10 minutes.</p><label className="field">What are you capturing?<select value={pass} onChange={(event) => setPass(event.target.value as CaptureAsset["pass"])}>{passes.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><small>{passDetails.description}</small></label><div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy && !running) addFiles(event.dataTransfer.files); }} onClick={() => fileInput.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.current?.click(); } }} aria-label="Choose videos, photos, audio notes, or PDF manuals"><Icon name="upload" size={28} /><strong>Drop your captures here, or browse</strong><p>Videos, photos, voice notes & PDF manuals<br />Up to 600 MB each · 30 files total<br />PDF manuals, up to 10 MB combined</p><input ref={fileInput} type="file" multiple accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp,image/heic,audio/*,application/pdf" disabled={!!busy || running} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} /></div>{pendingUploads.length > 0 && <div className="notice notice-inline"><Icon name="refresh" size={16} /><span><strong>Continue an interrupted upload.</strong><br />Reselect the original {pendingUploads.length === 1 ? "file" : "files"}, then continue. We’ll restore the capture type and resume the saved transfer.<br /><small>{pendingUploads.map(ticket => ticket.asset.name).join(" · ")}</small></span><button className="button button-secondary button-small" disabled={!!busy || running} onClick={() => fileInput.current?.click()}>Reselect files</button></div>}<div className="capture-actions"><button className="button button-secondary button-small" onClick={() => setRecordMode(recordMode === "video" ? null : "video")} disabled={!!busy || running}><Icon name="camera" size={16} />Record a scan</button><span>or</span><button className="button button-quiet button-small" onClick={() => setRecordMode(recordMode === "audio" ? null : "audio")} disabled={!!busy || running}><Icon name="mic" size={15} />Add a voice note</button></div>{recordMode && <ScanRecorder mode={recordMode} onCapture={(file) => { addFiles([file], true); setRecordMode(null); }} onClose={() => setRecordMode(null)} />}{(files.length > 0 || captureAssets.length > 0) && <div className="upload-list">{captureAssets.filter((asset) => !files.some((entry) => entry.asset?.id === asset.id)).map((asset) => <div className="upload-item" key={asset.id}><Icon name={asset.kind === "video" ? "camera" : "file"} size={18} /><div className="upload-item-main"><strong>{asset.name}</strong><small>{formatBytes(asset.size)} · {passes.find((item) => item.id === asset.pass)?.title}</small></div><Icon name="check" size={16} /></div>)}{files.map((entry) => <div className="upload-item" key={entry.id}><Icon name={entry.kind === "video" ? "camera" : entry.kind === "audio" ? "mic" : "file"} size={18} /><div className="upload-item-main"><strong>{entry.file.name}</strong><small className={entry.error ? "upload-error" : ""}>{entry.error || `${formatBytes(entry.file.size)} · ${passes.find((item) => item.id === entry.pass)?.title} · ${entry.asset ? "Uploaded" : entry.progress > 0 ? `${Math.round(entry.progress)}%` : "On this device"}`}</small>{entry.progress > 0 && !entry.asset && <div className="upload-progress"><span style={{ width: `${entry.progress}%` }} /></div>}</div>{entry.recorded && !entry.asset && <button className="icon-button" aria-label={`Save recording ${entry.file.name}`} title="Save a copy so you can resume after closing this page" onClick={() => saveRecording(entry.file)}><Icon name="download" size={15} /></button>}{entry.asset ? <Icon name="check" size={16} /> : <button className="icon-button" aria-label={`Remove ${entry.file.name}`} disabled={!!busy} onClick={() => setFiles((current) => current.filter((item) => item.id !== entry.id))}><Icon name="close" size={15} /></button>}</div>)}</div>}{files.some(entry => entry.recorded && !entry.asset) && <p className="measurement-hint">Recorded here? Save a copy with the download button before closing this page. Your browser will ask you to reselect the file if an upload is interrupted.</p>}<div className="capture-checklist">{[{ label: "A clear view of the room and work area", pass: "room" }, { label: "Close-ups of things you will use", pass: "object" }, { label: "An empty view beneath movable objects", pass: "empty_surface" }].map((item) => { const done = captureAssets.some((asset) => asset.pass === item.pass) || files.some((entry) => entry.pass === item.pass); return <div className={done ? "done" : ""} key={item.pass}><Icon name={done ? "check" : "camera"} size={14} />{item.label}</div>; })}</div><div className="form-actions"><button className="button button-quiet" onClick={() => setStep(0)} disabled={!!busy}><Icon name="arrow-left" size={15} />Back</button>{canGenerate ? <button className="button button-primary" onClick={() => void analyze()} disabled={!!busy || visualCount === 0}>{busy ? <span className="spinner" /> : <Icon name="sparkles" size={16} />}{busy === "analyze" ? "Preparing your captures…" : "Get to know my space"}</button> : <button className="button button-primary" onClick={() => { saveLocal(); setStep(2); }}>Review my draft<Icon name="arrow" size={16} /></button>}</div></> : step === 2 ? <>{running && job?.kind === "analyze" ? <><h2 className="subheading">Getting to know your space.</h2><p className="section-description">We’re looking at your captures and finding the details that make this tutorial yours.</p><div className="loading-line"><span className="spinner" />{job.message || "Looking through your captures…"}</div><div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div><p className="generation-message">This continues in the background. You can come back through My tutorials.</p><button className="button button-secondary" onClick={() => void controlJob("cancel")} disabled={!!busy}>Stop analysis</button></> : <><div className="section-title-row"><h2 className="subheading">A little more about your idea.</h2>{tutorial?.plan && <span className="badge"><Icon name="sparkles" size={12} />Prepared with Astra</span>}</div><p className="section-description">{tutorial?.plan ? "Here’s what we gathered from your space. Review the details and help fill in anything we’re missing." : "Your draft is ready to shape. AI suggestions will appear here after your captures have been analyzed."}</p>{job?.kind === "analyze" && ["budget_paused", "cancelled", "failed"].includes(job.status) && <div className="notice notice-inline"><Icon name="info" size={16} /><span>{job.status === "budget_paused" ? `Analysis paused at $${job.spentUsd.toFixed(2)} spent against the $${job.budgetUsd.toFixed(2)} allowance. Additional spending is not authorized.` : job.status === "cancelled" ? "Analysis was stopped. Your captures are saved." : "Analysis needs another try. Review the message above and your captures."}</span></div>}<label className="field">Give it a name<input value={title} maxLength={150} placeholder="My little home project" onChange={(event) => { setTitle(event.target.value); setSaved(false); }} /></label><label className="field">What you’d like to do<textarea value={goal} maxLength={3000} onChange={(event) => { setGoal(event.target.value); setSaved(false); }} /></label><label className="field">Your preferences<textarea value={constraints} onChange={(event) => { setConstraints(event.target.value); setSaved(false); }} placeholder="Time, tools, experience, or anything else that matters." /></label>{tutorial?.plan && <><h3 className="field">Things in your space</h3><div className="objects-list">{tutorial.plan.objects.map((object) => <span className="object-chip" key={object.id} title={object.notes}><Icon name="box" size={13} />{object.name}{!object.observed && <span className="badge">To confirm</span>}</span>)}</div>{tutorial.plan.questions.map((question) => <div className="question-card" key={question.id}><label className="field">{question.question}{question.required && <small>Needed before generation</small>}<input value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="A little more context…" /><small>{question.reason}</small></label></div>)}<div className="plan-summary"><h3>Your walkthrough at a glance</h3><ol>{tutorial.plan.steps.map((item) => <li key={item.id}>{item.title}</li>)}</ol></div>{tutorial.plan.sources.length > 0 && <><h3 className="field">References for your tutorial</h3><ul className="sources-list">{tutorial.plan.sources.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer"><Icon name="file" size={13} />{source.title}<Icon name="arrow" size={12} /></a></li>)}</ul></>}</>}
      <div style={{ marginTop: 26, borderTop: "1px solid var(--line)", paddingTop: 23 }}><h3 className="subheading" style={{ fontSize: 23 }}>Help us get the proportions right.</h3><p className="section-description">Measure the width and depth of the same flat, horizontal work surface. Choose nonparallel edges, then mark each distance in two clear views from different angles.</p>{captureAssets.some((asset) => asset.kind === "video" || asset.kind === "image") ? <>{measurements.map((measurement, index) => <MeasurementEditor key={measurement.id} tutorialId={tutorial!.id} assets={captureAssets} measurement={measurement} onChange={(value) => setMeasurements((current) => current.map((item, position) => position === index ? value : item))} onRemove={() => setMeasurements((current) => current.filter((item) => item.id !== measurement.id))} />)}<div className="button-row" style={{ marginTop: 14 }}><button className="button button-secondary button-small" onClick={() => addMeasurement("scale")}><Icon name="plus" size={13} />Scale measurement</button><button className="button button-secondary button-small" onClick={() => addMeasurement("validation")}><Icon name="plus" size={13} />Independent check</button></div></> : <div className="notice"><Icon name="ruler" size={16} />Upload a room scan or photos to mark your measurements.</div>}</div><div className="form-actions"><button className="button button-quiet" onClick={() => setStep(1)} disabled={!!busy}><Icon name="arrow-left" size={15} />Captures</button>{!tutorial?.plan || tutorial.plan.questions.some((question) => question.required) || Object.values(answers).some((answer) => answer.trim()) ? <button className="button button-primary" disabled={!canGenerate || !!busy || visualCount === 0} onClick={() => void analyze()}>{busy ? <span className="spinner" /> : <Icon name="sparkles" size={15} />}{tutorial?.plan ? "Update my tutorial plan" : "Analyze my captures"}</button> : <button className="button button-primary" disabled={!!busy || !measurementsReady} onClick={() => void run("save", async () => { await saveDetails(); setStep(3); })}>Review & create<Icon name="arrow" size={16} /></button>}</div>{!canGenerate && <p className="measurement-hint">Your draft stays on this device. Connect services and sign in to analyze captures and continue.</p>}</> }</> : <><GenerationProgress job={job?.kind === "generate" ? job : null} tutorial={tutorial} busy={!!busy} onCancel={() => void controlJob("cancel")} onResume={() => void controlJob("resume")} onContext={() => setStep(2)} />{(!job || job.kind !== "generate") && <><div className="plan-summary"><h3>{title || "Your personal tutorial"}</h3><p className="section-description" style={{ marginBottom: 10 }}>{goal || "Add your idea and a capture to get started."}</p><div className="card-meta"><span><Icon name="camera" size={14} />{captureAssets.length} captures</span><span>·</span><span>{tutorial?.plan?.steps.length ?? 0} steps</span></div></div><div className="notice"><Icon name="info" size={16} /><span>Generation uses up to ${GENERATION_BUDGET_USD} for AI and rendering. It pauses before authorizing additional work. Live voice and ongoing hosting are separate.</span></div>{!measurementsReady && <p className="measurement-hint">Add the width and depth of one horizontal work surface, with each distance marked in at least two different views, before creating your scene.</p>}<div className="form-actions"><button className="button button-quiet" onClick={() => setStep(2)}><Icon name="arrow-left" size={15} />Back to details</button><button className="button button-primary" disabled={!canGenerate || !!busy || !tutorial?.plan || !measurementsReady || tutorial.plan.questions.some((question) => question.required)} onClick={() => void generate()}>{busy ? <span className="spinner" /> : <Icon name="sparkles" size={16} />}Create my tutorial</button></div></>}{tutorial?.status === "ready" && !job && <Link href={tutorialHref(tutorial)} className="button button-primary">Open tutorial <Icon name="arrow" size={16} /></Link>}</> }</section>
      <aside className="create-aside"><Icon name={step === 1 ? "camera" : step === 2 ? "ruler" : "sparkles"} size={26} /><h3>{["Small beginnings. Real possibilities.", "The more we see, the more it feels like home.", "The little details make it yours.", "A guide that’s right there with you."][step]}</h3><p>{["You don’t need the perfect words. Tell us what you’re trying to do, and we’ll help shape the rest.", "Steady, overlapping views help rebuild your room. Keep the room and objects still while you move around them.", "Measure two nonparallel distances on the same flat, horizontal work surface, such as its width and depth. Mark the same endpoints in two views for each measurement.", "Explore from different angles, pause any time, and ask a question. When you’re ready, switch to your camera and try it yourself."][step]}</p><div className="aside-tip"><strong>{step === 1 ? "A little tip" : "Your space stays yours"}</strong><p>{step === 1 ? "Natural, even light works best. If a shiny or hidden surface is unclear, we may ask for another view." : "Your recordings and room are private. Sharing a finished tutorial is always your choice."}</p></div><div className="aside-tip"><strong>Made one step at a time</strong><p>We’ll ask if something needs a closer look. Clear context makes a better guide.</p></div></aside>
    </div>
  </div>;
}
