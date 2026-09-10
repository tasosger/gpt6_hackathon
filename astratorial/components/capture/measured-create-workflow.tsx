"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Upload } from "tus-js-client";
import { GENERATION_BUDGET_USD, type CaptureAsset, type GenerationJob, type Measurement, type Tutorial } from "@/lib/contracts";
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
const steps = ["Upload", "Confirm", "Create"];
const activeStatuses = ["running", "queued"];
function kindFor(file: File): CaptureAsset["kind"] | null { const type = captureFileMetadata(file).mimeType; if (type.startsWith("video/")) return "video"; if (type.startsWith("image/")) return "image"; if (type.startsWith("audio/")) return "audio"; if (type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return "manual"; return null; }
function lines(value: string) { return value.split("\n").map((line) => line.trim()).filter(Boolean); }

export function MeasuredCreateWorkflow({ initialTutorialId }: { initialTutorialId?: string }) {
  const { config, loading: configLoading, refresh } = useAppConfig();
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
  const [showMeasurements, setShowMeasurements] = useState(false);
  const upload = useRef<Upload | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const generationLock = useRef(false);
  const canSave = !!config?.services.database && !!config.user;
  const canGenerate = !!config?.configured;
  const requiresMeasurements = config?.generationMode !== "illustrated";
  const running = !!job && activeStatuses.includes(job.status);
  const captureAssets = tutorial?.assets ?? [];
  const visualCount = captureAssets.filter((asset) => asset.kind === "image" || asset.kind === "video").length + files.filter((entry) => !entry.asset && (entry.kind === "image" || entry.kind === "video")).length;
  const passDetails = passes.find((item) => item.id === pass)!;
  const acceptTutorial = useCallback((value: Tutorial) => { setTutorial(value); setTitle(value.title); setGoal(value.goal); setConstraints(value.constraints.join("\n")); setReferenceUrls(value.referenceUrls.join("\n")); setMeasurements(value.measurements); }, []);

  useEffect(() => {
    let active = true;
    async function restore() {
      if (initialTutorialId) {
        try { const data = await api<{ tutorial: Tutorial }>(`/api/tutorials/${initialTutorialId}`); if (!active) return; acceptTutorial(data.tutorial); setJob(data.tutorial.job); setStep(data.tutorial.scene || data.tutorial.job?.kind === "generate" ? 2 : data.tutorial.plan || data.tutorial.job?.kind === "analyze" ? 1 : 0);
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
          if (data.job.kind === "analyze") setStep(1);
          setAnswers({});
        }
        if (activeStatuses.includes(data.job.status)) timer = window.setTimeout(poll, 3000);
      } catch (reason) { if (!stopped) { setError(`We couldn’t refresh progress. Your job may still be running. ${errorMessage(reason)}`); timer = window.setTimeout(poll, 7000); } }
    }
    timer = window.setTimeout(poll, 1000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [currentJobId, currentJobStatus, acceptTutorial]);

  function saveLocal() { localStorage.setItem("astratorial-draft-v1", JSON.stringify({ version: 1, goal, title, constraints, referenceUrls })); setSaved(true); }
  async function saveDetails(current = tutorial, includeAnswers = false, serverReady = canSave): Promise<Tutorial | null> {
    for (const reference of lines(referenceUrls)) { try { const parsed = new URL(reference); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); } catch { throw new Error("Add full website links beginning with https://, with one link per line."); } }
    if (!serverReady) { saveLocal(); return null; }
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
      if (file.size > 50_000_000) { setError(`“${file.name}” is over 50 MB. Trim it to a short clip or record a new video here.`); continue; }
      if (kind === "manual" && file.size > 10_000_000) { setError(`“${file.name}” is larger than the 10 MB manual limit.`); continue; }
      const manualBytes = captureAssets.filter((asset) => asset.kind === "manual").reduce((sum, asset) => sum + asset.size, 0) + files.filter((entry) => !entry.asset && entry.kind === "manual").reduce((sum, entry) => sum + entry.file.size, 0) + next.filter((entry) => entry.kind === "manual").reduce((sum, entry) => sum + entry.file.size, 0);
      if (kind === "manual" && manualBytes + file.size > 10_000_000) { setError("Keep all PDF manuals under 10 MB combined. You can also add reference website links."); continue; }
      const existingBytes = captureAssets.reduce((sum, asset) => sum + asset.size, 0) + files.filter((entry) => !entry.asset).reduce((sum, entry) => sum + entry.file.size, 0) + next.reduce((sum, entry) => sum + entry.file.size, 0);
      if (existingBytes + file.size > 2_000_000_000) { setError("Keep the combined captures under 2 GB per tutorial. Short, clear clips work best."); continue; }
      if (files.filter((entry) => !entry.asset).length + captureAssets.length + next.length >= 30) { setError("You can add up to 30 captures per tutorial."); break; }
      next.push({ id: crypto.randomUUID(), file, kind, pass: kind === "manual" || kind === "audio" ? "reference" : pass, progress: 0, recorded });
    }
    setFiles((current) => [...current, ...next]); setSaved(false);
    if (canGenerate && !tutorial?.plan && next.some((entry) => entry.kind === "video" || entry.kind === "image")) void analyze([...files, ...next]);
  }
  async function uploadFiles(current: Tutorial, selectedFiles = files) {
    if (!config?.services.database) throw new Error("The upload service is not connected yet. Your video is still on this device.");
    const tus = await import("tus-js-client");
    let latest = current;
    const pending = await api<{ uploads: PendingUpload[] }>(`/api/uploads?tutorialId=${current.id}`);
    setPendingUploads(pending.uploads);
    for (const entry of selectedFiles.filter((item) => !item.asset)) {
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
  async function analyze(selectedFiles = files) {
    await run("analyze", async () => {
      if (!canGenerate) throw new Error("Video analysis is being connected. Your video is still on this device; try again when the workspace is ready.");
      if (!config?.user) { await post("/api/auth/guest"); await refresh(); }
      let current = await saveDetails(tutorial, true, true);
      if (!current) throw new Error("We couldn’t save your capture. Please try again.");
      if (selectedFiles.some((entry) => !entry.asset)) current = await uploadFiles(current, selectedFiles);
      const result = await post<{ job: GenerationJob }>(`/api/tutorials/${current.id}/analyze`);
      setJob(result.job); setStep(1);
    });
  }
  async function generate() {
    await run("generate", async () => {
      const current = await saveDetails();
      if (!current || !canGenerate) throw new Error("The workspace needs to be connected before creating your tutorial.");
      if (!current.plan) { setStep(1); throw new Error("Your details changed. Update the plan below so your tutorial matches them."); }
      const result = await post<{ job: GenerationJob }>(`/api/tutorials/${current.id}/generate`); setJob(result.job); setStep(2);
      localStorage.removeItem("astratorial-draft-v1");
    });
  }
  async function controlJob(action: "cancel" | "resume") { if (!job) return; await run(action, async () => { const result = await post<{ job: GenerationJob }>(`/api/jobs/${job.id}/${action}`); setJob(result.job); }); }
  function addMeasurement(purpose: Measurement["purpose"]) { setMeasurements((current) => [...current, { id: crypto.randomUUID(), label: purpose === "scale" ? "Work surface width" : "Work surface depth", distanceMeters: 0, purpose, observations: [] }]); }
  const measurementsReady = ["scale", "validation"].every((purpose) => measurements.some((measurement) => measurement.purpose === purpose && measurement.label.trim() && measurement.distanceMeters > 0 && measurement.observations.length >= 2));

  const planChanged = !!tutorial?.plan && (goal.trim() !== tutorial.goal || constraints !== tutorial.constraints.join("\n") || referenceUrls !== tutorial.referenceUrls.join("\n"));
  const needsPlanUpdate = !tutorial?.plan || planChanged || tutorial.plan.questions.some((question) => question.required) || Object.values(answers).some((answer) => answer.trim()) || files.some((entry) => !entry.asset);
  const firstVideo = files.find(entry => entry.kind === "video");

  return <div className="create-page capture-first">
    <div className="page-heading create-heading"><div><span className="eyebrow">YOUR SPACE. YOUR PERSONAL GUIDE.</span><h1>{step === 0 ? "Start with a video." : step === 1 ? "Is this what you had in mind?" : "Your tutorial is taking shape."}</h1><p>{step === 0 ? "Show us what’s around you. Astra will figure out the possibilities." : step === 1 ? "Astra fills in the details. You make it yours." : "Then watch, ask questions, and try it yourself."}</p></div>{tutorial && <span className="draft-status"><Icon name="lock" size={13} />{saved ? "Saved privately" : "Private tutorial"}</span>}</div>
    <nav className="workflow-stepper" aria-label="Create tutorial progress">{steps.map((label, index) => <button key={label} className={step === index ? "active" : index < step ? "completed" : ""} onClick={() => setStep(index)} disabled={!!busy || running || (index === 1 && !tutorial?.plan && job?.kind !== "analyze") || (index === 2 && !tutorial?.scene && job?.kind !== "generate")} aria-current={step === index ? "step" : undefined}><span className="step-number">{index < step ? <Icon name="check" size={12} /> : index + 1}</span>{label}</button>)}</nav>
    {error && <div className="notice notice-error" role="alert"><Icon name="info" size={16} /><span>{error}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setError(null)} style={{ marginLeft: "auto", border: 0 }}><Icon name="close" size={15} /></button></div>}
    <section className="panel capture-panel">{busy === "load" ? <div className="loading-line"><span className="spinner" />Opening your tutorial…</div> : step === 0 ? <>
      <div className={`drop-zone video-drop-zone ${dragging ? "dragging" : ""} ${busy ? "is-uploading" : ""}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy && !running) addFiles(event.dataTransfer.files); }} onClick={() => { if (!busy && !running) fileInput.current?.click(); }} role="button" tabIndex={busy ? -1 : 0} aria-disabled={!!busy || running} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !busy && !running) { event.preventDefault(); fileInput.current?.click(); } }} aria-label="Upload a video or photos">
        <span className="upload-symbol">{busy === "analyze" ? <span className="spinner" /> : <Icon name="upload" size={30} />}</span>
        <strong>{busy === "analyze" ? "Uploading your space…" : "Upload a video"}</strong>
        <p>{busy === "analyze" ? "Astra will look for the things you can use and suggest a tutorial." : <>Drag it here, or choose from your phone.<br />A short, steady look around your work area is perfect.</>}</p>
        {!busy && <span className="button button-primary upload-browse">Choose a video<Icon name="arrow" size={16} /></span>}
        <small>Videos or photos · up to 50 MB per file</small>
        <input ref={fileInput} type="file" multiple accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp,image/heic,audio/*,application/pdf" disabled={!!busy || running} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
      </div>
      <div className="capture-actions"><span>or</span><button className="button button-secondary" onClick={() => setRecordMode(recordMode === "video" ? null : "video")} disabled={!!busy || running}><Icon name="camera" size={17} />Record a video</button></div>
      {recordMode && <ScanRecorder mode={recordMode} onCapture={(file) => { addFiles([file], true); setRecordMode(null); }} onClose={() => setRecordMode(null)} />}
      {pendingUploads.length > 0 && <div className="notice notice-inline"><Icon name="refresh" size={16} /><span><strong>Continue an interrupted upload.</strong><br />Choose the same file to pick up where you left off.<br /><small>{pendingUploads.map(ticket => ticket.asset.name).join(" · ")}</small></span><button className="button button-secondary button-small" disabled={!!busy || running} onClick={() => fileInput.current?.click()}>Reselect files</button></div>}
      {(files.length > 0 || captureAssets.length > 0) && <div className="upload-list" aria-live="polite">{captureAssets.filter((asset) => !files.some((entry) => entry.asset?.id === asset.id)).map((asset) => <div className="upload-item" key={asset.id}><Icon name={asset.kind === "video" ? "camera" : "file"} size={18} /><div className="upload-item-main"><strong>{asset.name}</strong><small>{formatBytes(asset.size)} · Uploaded</small></div><Icon name="check" size={16} /></div>)}{files.map((entry) => <div className="upload-item" key={entry.id}><Icon name={entry.kind === "video" ? "camera" : entry.kind === "audio" ? "mic" : "file"} size={18} /><div className="upload-item-main"><strong>{entry.file.name}</strong><small className={entry.error ? "upload-error" : ""}>{entry.error || `${formatBytes(entry.file.size)} · ${entry.asset ? "Uploaded" : entry.progress > 0 ? `${Math.round(entry.progress)}%` : "Ready on this device"}`}</small>{entry.progress > 0 && !entry.asset && <div className="upload-progress"><span style={{ width: `${entry.progress}%` }} /></div>}</div>{entry.recorded && !entry.asset && <button className="icon-button" aria-label={`Save recording ${entry.file.name}`} title="Save a copy" onClick={() => saveRecording(entry.file)}><Icon name="download" size={15} /></button>}{entry.asset ? <Icon name="check" size={16} /> : <button className="icon-button" aria-label={`Remove ${entry.file.name}`} disabled={!!busy} onClick={() => setFiles((current) => current.filter((item) => item.id !== entry.id))}><Icon name="close" size={15} /></button>}</div>)}</div>}
      {firstVideo && !busy && !tutorial?.plan && <p className="measurement-hint">We’ll use the video’s picture and sound to understand your space.</p>}
      <details className="capture-details"><summary>Have something in mind? <span>Add a hint</span><Icon name="plus" size={14} /></summary><div className="details-content"><label className="field">What would you like to try? <span className="optional-label">Optional</span><textarea value={goal} maxLength={3000} disabled={!!busy} onChange={(event) => { setGoal(event.target.value); setSaved(false); }} placeholder="Make a coffee with what’s on this counter…" /></label><button className="button button-quiet button-small" onClick={() => setRecordMode(recordMode === "audio" ? null : "audio")} disabled={!!busy}><Icon name="mic" size={15} />Say it instead</button></div></details>
      <details className="capture-details"><summary>More context <span>Photos, manuals & extra views</span><Icon name="plus" size={14} /></summary><div className="details-content"><label className="field">Capture type<select value={pass} disabled={!!busy} onChange={(event) => setPass(event.target.value as CaptureAsset["pass"])}>{passes.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><small>{passDetails.description}</small></label><button className="button button-secondary button-small" disabled={!!busy} onClick={() => fileInput.current?.click()}><Icon name="plus" size={14} />Add files</button><p className="measurement-hint">PDF manuals: up to 10 MB combined. Keep each capture still while you move around it.</p></div></details>
      {!configLoading && !canGenerate && <div className="notice notice-inline"><Icon name="info" size={15} /><span>The workspace is being connected. You can choose a video now; it stays on this device until analysis is available.</span><button className="button button-quiet button-small" onClick={() => void refresh()}>Check connection</button></div>}
      <div className="capture-privacy"><Icon name="lock" size={13} /><span>Your original video stays private.</span></div>
      {visualCount > 0 && !busy && <div className="form-actions"><span className="draft-status">{tutorial?.plan ? "Add another angle or return to your plan." : "Your video is ready."}</span><button className="button button-primary" disabled={!canGenerate || !!busy} onClick={() => tutorial?.plan && !files.some(entry => !entry.asset) ? setStep(1) : void analyze()}><Icon name="sparkles" size={16} />{tutorial?.plan && !files.some(entry => !entry.asset) ? "Back to my plan" : error ? "Try analysis again" : "Analyze my video"}</button></div>}
    </> : step === 1 ? <>{running && job?.kind === "analyze" ? <div className="analysis-state"><span className="analysis-orb"><Icon name="sparkles" size={31} /></span><h2 className="subheading">Getting to know your space.</h2><p className="section-description">Finding the tools, the possibilities, and the steps to get you there.</p><div className="loading-line"><span className="spinner" />{job.message || "Looking through your video…"}</div><div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div><button className="button button-quiet button-small" onClick={() => void controlJob("cancel")} disabled={!!busy}>Stop analysis</button></div> : <>
      <div className="section-title-row"><h2 className="subheading">{tutorial?.plan ? "Here’s what we found." : "Let’s take another look."}</h2>{tutorial?.plan && <span className="badge"><Icon name="sparkles" size={12} />Prepared with Astra</span>}</div>
      {job?.kind === "analyze" && ["budget_paused", "cancelled", "failed"].includes(job.status) && <div className="notice notice-inline"><Icon name="info" size={16} /><span>{job.status === "budget_paused" ? `Analysis paused at $${job.spentUsd.toFixed(2)} of the $${job.budgetUsd.toFixed(2)} allowance.` : job.status === "cancelled" ? "Analysis stopped. Your video is saved." : "We couldn’t finish analyzing this video. Your upload is saved; you can try again."}</span></div>}
      <label className="field inferred-goal">Your goal<textarea className="goal-input" value={goal} maxLength={3000} onChange={(event) => { setGoal(event.target.value); setSaved(false); }} placeholder="What would you like to learn?" /><small>Change anything that doesn’t feel right.</small></label>
      {tutorial?.plan && <><h3 className="field">Things in your space</h3><div className="objects-list">{tutorial.plan.objects.map((object) => <span className="object-chip" key={object.id} title={object.notes}><Icon name="box" size={13} />{object.name}{!object.observed && <span className="badge">To confirm</span>}</span>)}</div>{tutorial.plan.questions.map((question) => <div className="question-card" key={question.id}><label className="field">{question.question}<input value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Tell Astra a little more…" /><small>{question.reason}</small></label></div>)}<details className="capture-details" open><summary>Your tutorial <span>{tutorial.plan.steps.length} steps</span><Icon name="plus" size={14} /></summary><div className="plan-summary"><ol>{tutorial.plan.steps.map((item) => <li key={item.id}>{item.title}</li>)}</ol></div></details></>}
      <details className="capture-details"><summary>Make it yours <span>Name, preferences & references</span><Icon name="plus" size={14} /></summary><div className="details-content"><label className="field">Tutorial name<input value={title} maxLength={150} onChange={(event) => { setTitle(event.target.value); setSaved(false); }} /></label><label className="field">Your preferences<textarea value={constraints} onChange={(event) => { setConstraints(event.target.value); setSaved(false); }} placeholder="I’m a beginner. Dairy-free, please. I have 15 minutes…" /></label><label className="field">Helpful links<textarea value={referenceUrls} onChange={(event) => { setReferenceUrls(event.target.value); setSaved(false); }} placeholder="A product page or manual link, one per line." /></label>{!!tutorial?.plan?.sources.length && <ul className="sources-list">{tutorial.plan.sources.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer"><Icon name="file" size={13} />{source.title}<Icon name="arrow" size={12} /></a></li>)}</ul>}</div></details>
      {requiresMeasurements && tutorial?.plan && <details className="capture-details" open={showMeasurements} onToggle={(event) => setShowMeasurements(event.currentTarget.open)}><summary>Set the scene’s scale <span>{measurementsReady ? "Ready" : "Needed for a measured scene"}</span><Icon name="plus" size={14} /></summary><div className="details-content"><p className="section-description">Measure the width and depth of the same flat work surface. Mark each distance in two clear views from different angles.</p>{measurements.map((measurement, index) => <MeasurementEditor key={measurement.id} tutorialId={tutorial.id} assets={captureAssets} measurement={measurement} onChange={(value) => setMeasurements((current) => current.map((item, position) => position === index ? value : item))} onRemove={() => setMeasurements((current) => current.filter((item) => item.id !== measurement.id))} />)}<div className="button-row"><button className="button button-secondary button-small" onClick={() => addMeasurement("scale")}><Icon name="plus" size={13} />Width</button><button className="button button-secondary button-small" onClick={() => addMeasurement("validation")}><Icon name="plus" size={13} />Depth</button></div></div></details>}
      {tutorial?.plan && !needsPlanUpdate && <p className="creation-note">{requiresMeasurements ? "A measured 3D guide using your captured space." : "An illustrated 3D guide based on your video. Objects and distances are approximate."} Generation stays within your ${GENERATION_BUDGET_USD} allowance.</p>}
      <div className="form-actions"><button className="button button-quiet" onClick={() => setStep(0)} disabled={!!busy}><Icon name="arrow-left" size={15} />{tutorial?.plan?.questions.length ? "Add a photo or video" : "My video"}</button><button className="button button-primary" disabled={!canGenerate || !!busy || visualCount === 0 || (!!tutorial?.plan && !goal.trim())} onClick={() => needsPlanUpdate ? void analyze() : requiresMeasurements && !measurementsReady ? setShowMeasurements(true) : void generate()}>{busy ? <span className="spinner" /> : <Icon name="sparkles" size={16} />}{needsPlanUpdate ? tutorial?.plan ? "Update my plan" : "Try analysis again" : requiresMeasurements && !measurementsReady ? "Add scene measurements" : "Create my tutorial"}<Icon name="arrow" size={16} /></button></div>
    </>}</> : <GenerationProgress job={job?.kind === "generate" ? job : null} tutorial={tutorial} busy={!!busy} onCancel={() => void controlJob("cancel")} onResume={() => void controlJob("resume")} onContext={() => setStep(1)} />}</section>
    {step === 0 && <p className="capture-tip"><Icon name="camera" size={15} /><span>Try your espresso machine, ingredients on the counter, or a project you want to build.</span></p>}
  </div>;
}
