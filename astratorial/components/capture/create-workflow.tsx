"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DetailedError, Upload } from "tus-js-client";
import type { CaptureAsset, GenerationJob, Tutorial } from "@/lib/contracts";
import { api, errorMessage, formatBytes, post, useAppConfig } from "@/lib/client";
import { Icon } from "@/components/shell/icon";
import { GenerationProgress } from "./generation-progress";
import { ScanRecorder } from "./scan-recorder";

type PendingVideo = { id: string; file: File; progress: number; sent: number; recorded: boolean; asset?: CaptureAsset; error?: string };
type WorkerState = { status: "ready" | "offline" | "unreachable"; message: string };
type UploadConfig = { uploadId: string; asset: CaptureAsset; endpoint: string; headers: Record<string, string>; metadata: Record<string, string>; chunkSize: number };
type PendingUpload = { uploadId: string; asset: CaptureAsset; clientFingerprint?: string | null };
type CompletedUpload = { completed: true; uploadId: string; tutorial: Tutorial; asset: CaptureAsset };
const activeStatuses = ["running", "queued"];
const secureUploadMessage = "Open this app using HTTPS or localhost to upload securely. Your video is still on this device.";

function abortUpload(task: Upload | null) {
  if (task) void task.abort().catch(() => { /* The interrupted request may already be closed. */ });
}

function uploadFailure(reason: Error | DetailedError) {
  const response = "originalResponse" in reason ? reason.originalResponse : null;
  const status = response?.getStatus();
  let accessDenied = false;
  try {
    const body = JSON.parse(response?.getBody() || "null") as { code?: string; error?: string | { code?: string } } | null;
    accessDenied = body?.code === "AccessDenied" || body?.error === "AccessDenied" || typeof body?.error === "object" && body.error?.code === "AccessDenied";
  } catch { /* Only a known error code is inspected; response content is never displayed. */ }
  if (status === 401 || status === 403 || accessDenied) return "Upload permission expired or was denied. Try again to renew the upload connection. Your video is still on this device.";
  if (status === 413) return "This video is too large for the upload service. Choose a shorter video, then try again.";
  if (status === 415) return "The upload service couldn’t accept this video format. Choose an MP4, MOV, or WebM video.";
  if (status === 429) return "The upload service is busy. Wait a moment, then try again; your video is still on this device.";
  return "We couldn’t finish uploading your video. Check your connection and try again; we’ll resume the same upload when possible.";
}

function captureFileMetadata(file: File) {
  // A saved recording retains its capture identity even if its filesystem date changes.
  const recording = /^guided-scan-(\d{13})\.(webm|mp4)$/.exec(file.name);
  const extension = file.name.split(".").pop()?.toLowerCase();
  const inferredType = extension === "mp4" ? "video/mp4" : extension === "mov" ? "video/quicktime" : extension === "webm" ? "video/webm" : "";
  const mimeType = file.type.split(";")[0].trim().toLowerCase() || inferredType;
  return { mimeType: recording ? `video/${recording[2]}` : mimeType, lastModified: recording ? Number(recording[1]) : file.lastModified };
}

async function fileFingerprint(file: File) {
  if (!globalThis.crypto?.subtle) throw new Error(secureUploadMessage);
  try {
    const source = captureFileMetadata(file);
    const metadata = new TextEncoder().encode(JSON.stringify([file.name, file.size, source.mimeType, source.lastModified]));
    const sampleSize = 1_048_576;
    const [first, last] = await Promise.all([file.slice(0, sampleSize).arrayBuffer(), file.slice(Math.max(sampleSize, file.size - sampleSize)).arrayBuffer()]);
    const bytes = new Uint8Array(metadata.length + first.byteLength + last.byteLength);
    bytes.set(metadata);
    bytes.set(new Uint8Array(first), metadata.length);
    bytes.set(new Uint8Array(last), metadata.length + first.byteLength);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new Error("We couldn’t read this video from your device. Choose it again, or save a local copy and select that video.");
  }
}

function saveRecording(file: File) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function CreateWorkflow({ initialTutorialId }: { initialTutorialId?: string }) {
  return <SingleVideoWorkflow initialTutorialId={initialTutorialId} />;
}

function SingleVideoWorkflow({ initialTutorialId }: { initialTutorialId?: string }) {
  const { config, loading: configLoading, error: configError, refresh } = useAppConfig();
  const [tutorial, setTutorial] = useState<Tutorial | null>(null);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [video, setVideo] = useState<PendingVideo | null>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [recording, setRecording] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(initialTutorialId ? "load" : null);
  const [error, setError] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [sceneUnavailable, setSceneUnavailable] = useState(false);
  const [sceneRetry, setSceneRetry] = useState(0);
  const sceneChecks = useRef({ jobId: "", count: 0 });
  const [restored, setRestored] = useState(!initialTutorialId);
  const [reload, setReload] = useState(0);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [worker, setWorker] = useState<WorkerState | null>(null);
  const lastUploadActivity = useRef(0);
  const cancellingUpload = useRef(false);
  const upload = useRef<Upload | null>(null);
  const rejectUpload = useRef<((reason: Error) => void) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const generationLock = useRef(false);
  const autoAttempted = useRef(new Set<string>());
  const tutorialRef = useRef<Tutorial | null>(null);
  const mounted = useRef(true);
  const canGenerate = !!config?.configured && !configError;
  const running = !!job && activeStatuses.includes(job.status);
  const ready = tutorial?.status === "ready" && !!tutorial.scene;
  const savedVideo = tutorial?.assets.find(asset => asset.kind === "video");
  const showingProgress = !!job || ready;
  const hasCapture = !!video || !!savedVideo;
  const missingServices = config ? [!config.services.database && "video storage", !config.services.openai && "AI", !config.services.worker && "local processing"].filter(Boolean).join(", ") : "your workspace";
  const connectionMessage = configError
    ? "We couldn’t reach the app to check its connection. Check that the server is running, then try again."
    : `Connect ${missingServices || "your workspace"} before we can upload and analyze your video. The app owner can check the server setup, then use Check connection here.`;

  const acceptTutorial = useCallback((value: Tutorial) => {
    tutorialRef.current = value;
    setTutorial(value);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortUpload(upload.current);
      rejectUpload.current?.(new Error("Upload interrupted. Choose the same video to continue."));
    };
  }, []);

  useEffect(() => {
    if (!initialTutorialId) return;
    let active = true;
    async function restore() {
      setBusy("load");
      setError(null);
      try {
        const [data, pending] = await Promise.all([
          api<{ tutorial: Tutorial }>(`/api/tutorials/${initialTutorialId}`),
          api<{ uploads: PendingUpload[] }>(`/api/uploads?tutorialId=${initialTutorialId}`),
        ]);
        if (!active) return;
        acceptTutorial(data.tutorial);
        setJob(data.tutorial.job);
        setPendingUploads(pending.uploads);
        setRestored(true);
      } catch (reason) {
        if (active) setError(errorMessage(reason));
      } finally {
        if (active) setBusy(null);
      }
    }
    void restore();
    return () => { active = false; };
  }, [initialTutorialId, reload, acceptTutorial]);

  const currentJobId = job?.id;
  const currentJobStatus = job?.status;
  const awaitingFinishedTutorial = job?.kind === "generate" && job.status === "completed" && !ready;
  useEffect(() => {
    if (!currentJobId || !currentJobStatus || sceneUnavailable || (!activeStatuses.includes(currentJobStatus) && !awaitingFinishedTutorial)) return;
    let stopped = false;
    let timer: number;
    async function poll() {
      try {
        const data = await api<{ job: GenerationJob; tutorial?: Tutorial }>(`/api/jobs/${currentJobId}`);
        // Some workers return only the job; fetch the finished tutorial before stopping polling.
        const finishedTutorial = data.job.status === "completed" && (!data.tutorial || !data.tutorial.scene)
          ? (await api<{ tutorial: Tutorial }>(`/api/tutorials/${data.job.tutorialId}`)).tutorial
          : data.tutorial ?? null;
        if (stopped) return;
        setJob(data.job);
        setProgressError(null);
        if (finishedTutorial) acceptTutorial(finishedTutorial);
        const missingScene = data.job.kind === "generate" && data.job.status === "completed" && !(finishedTutorial?.status === "ready" && finishedTutorial.scene);
        if (missingScene) {
          sceneChecks.current = { jobId: data.job.id, count: sceneChecks.current.jobId === data.job.id ? sceneChecks.current.count + 1 : 1 };
          if (sceneChecks.current.count >= 3) { setSceneUnavailable(true); return; }
        } else sceneChecks.current = { jobId: data.job.id, count: 0 };
        if (activeStatuses.includes(data.job.status) || missingScene) timer = window.setTimeout(poll, 3000);
      } catch (reason) {
        if (!stopped) {
          setProgressError(`We couldn’t refresh progress. The last update is shown below; processing may continue on your computer. ${errorMessage(reason)}`);
          timer = window.setTimeout(poll, 7000);
        }
      }
    }
    timer = window.setTimeout(poll, 1000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [currentJobId, currentJobStatus, awaitingFinishedTutorial, sceneUnavailable, sceneRetry, acceptTutorial]);

  // Runtime health is separate from configuration: an idle worker never blocks a private upload.
  useEffect(() => {
    if (!hasCapture && !currentJobId) return;
    let stopped = false;
    let timer: number;
    async function checkWorker() {
      try {
        const result = await api<{ worker?: WorkerState }>("/api/runtime");
        if (!stopped && result?.worker && ["ready", "offline", "unreachable"].includes(result.worker.status)) setWorker(result.worker);
      } catch { /* Older servers may not expose runtime health; generation polling remains authoritative. */ }
      if (!stopped) timer = window.setTimeout(checkWorker, 10_000);
    }
    void checkWorker();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [hasCapture, currentJobId]);

  useEffect(() => {
    if (busy !== "upload") return;
    const timer = window.setInterval(() => {
      const stalledFor = Date.now() - lastUploadActivity.current;
      if (stalledFor >= 90_000 && upload.current) {
        abortUpload(upload.current);
        rejectUpload.current?.(new Error("The upload stopped responding. Your video is still on this device. Try again to resume it."));
      } else if (stalledFor >= 15_000) {
        setUploadNotice("No new upload progress yet. Large clips or a slow connection can take longer. Keep this page open, or pause and retry.");
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const uploadVideo = useCallback(async (current: Tutorial, selected: PendingVideo) => {
    setBusy("prepare");
    setUploadNotice(null);
    const tus = await import("tus-js-client");
    setVideo(value => value?.id === selected.id ? { ...value, error: undefined } : value);
    const pending = await api<{ uploads: PendingUpload[] }>(`/api/uploads?tutorialId=${current.id}`);
    setPendingUploads(pending.uploads);
    const clientFingerprint = await fileFingerprint(selected.file);
    const previousTicket = pending.uploads.find(ticket => ticket.clientFingerprint === clientFingerprint && ticket.asset.name === selected.file.name && ticket.asset.size === selected.file.size);
    const destination = previousTicket
      ? await post<UploadConfig | CompletedUpload>(`/api/uploads/${previousTicket.uploadId}/renew`)
      : await post<UploadConfig>("/api/uploads", { tutorialId: current.id, name: selected.file.name, mimeType: captureFileMetadata(selected.file).mimeType, size: selected.file.size, kind: "video", pass: "room", clientFingerprint });
    if (!mounted.current) throw new Error("Upload interrupted. Choose the same video to continue.");
    if ("completed" in destination) {
      acceptTutorial(destination.tutorial);
      setVideo(value => value?.id === selected.id ? { ...value, progress: 100, sent: selected.file.size, asset: destination.asset } : value);
      setPendingUploads(all => all.filter(ticket => ticket.uploadId !== destination.uploadId));
      return destination.tutorial;
    }
    setBusy("upload");
    lastUploadActivity.current = Date.now();
    await new Promise<void>((resolve, reject) => {
      rejectUpload.current = reject;
      const task = new tus.Upload(selected.file, {
        endpoint: destination.endpoint,
        headers: destination.headers,
        metadata: destination.metadata,
        chunkSize: destination.chunkSize,
        retryDelays: [0, 1000, 3000, 5000],
        removeFingerprintOnSuccess: true,
        uploadDataDuringCreation: true,
        fingerprint: async () => `astratorial-${destination.uploadId}-${selected.file.size}-${captureFileMetadata(selected.file).lastModified}`,
        onError: reason => reject(new Error(uploadFailure(reason))),
        onShouldRetry: (reason, attempt) => {
          const status = reason.originalResponse?.getStatus();
          const retryable = !status || status === 408 || status === 409 || status === 423 || status === 429 || status >= 500;
          if (retryable) setUploadNotice(`The connection was interrupted. Reconnecting automatically (attempt ${attempt + 1} of 4)…`);
          return retryable;
        },
        onSuccess: () => resolve(),
        onProgress: (sent, total) => {
          lastUploadActivity.current = Date.now();
          setUploadNotice(null);
          setVideo(value => value?.id === selected.id ? { ...value, sent, progress: total ? sent / total * 100 : 0 } : value);
        },
      });
      upload.current = task;
      task.findPreviousUploads().then(previous => {
        if (!mounted.current) { reject(new Error("Upload interrupted. Choose the same video to continue.")); return; }
        if (previous.length) task.resumeFromPreviousUpload(previous[0]);
        task.start();
      }).catch(() => reject(new Error("We couldn’t prepare the upload connection. Your video is still on this device. Try again.")));
    });
    upload.current = null;
    rejectUpload.current = null;
    setBusy("confirm");
    setUploadNotice(null);
    const completed = await post<{ tutorial: Tutorial; asset: CaptureAsset }>("/api/uploads/complete", { uploadId: destination.uploadId });
    acceptTutorial(completed.tutorial);
    setPendingUploads(all => all.filter(ticket => ticket.uploadId !== destination.uploadId));
    setVideo(value => value?.id === selected.id ? { ...value, progress: 100, sent: selected.file.size, asset: completed.asset } : value);
    return completed.tutorial;
  }, [acceptTutorial]);

  const startGeneration = useCallback(async () => {
    if (generationLock.current) return;
    if (!canGenerate) {
      setError(connectionMessage);
      return;
    }
    if (!globalThis.crypto?.subtle) {
      setError(secureUploadMessage);
      return;
    }
    generationLock.current = true;
    setBusy("session");
    cancellingUpload.current = false;
    setUploadNotice(null);
    setError(null);
    try {
      if (!config?.user) { await post("/api/auth/guest"); await refresh(); }
      let current = tutorialRef.current;
      if (!current) {
        const created = await post<{ tutorial: Tutorial }>("/api/tutorials");
        current = created.tutorial;
        acceptTutorial(current);
        const draftUrl = new URL(window.location.href);
        draftUrl.searchParams.delete("tutorial");
        draftUrl.searchParams.set("id", current.id);
        window.history.replaceState(window.history.state, "", draftUrl);
      }
      if (video && !video.asset && !current.assets.some(asset => asset.kind === "video")) current = await uploadVideo(current, video);
      if (!mounted.current) return;
      if (!current.assets.some(asset => asset.kind === "video")) throw new Error("Choose a video showing your space and saying what you want to do.");
      setBusy("generate");
      const result = await post<{ job: GenerationJob }>(`/api/tutorials/${current.id}/generate`);
      if (mounted.current) setJob(result.job);
    } catch (reason) {
      if (mounted.current) {
        const message = errorMessage(reason);
        setUploadNotice(null);
        setError(message);
        setVideo(value => value && !value.asset ? { ...value, error: message } : value);
      }
    } finally {
      upload.current = null;
      rejectUpload.current = null;
      if (mounted.current) setBusy(null);
      generationLock.current = false;
    }
  }, [canGenerate, config, connectionMessage, video, refresh, acceptTutorial, uploadVideo]);

  const autoStartKey = video?.id ?? (savedVideo && tutorial ? `saved:${tutorial.id}` : null);
  useEffect(() => {
    // A running or finished generation is restored, never submitted again on page load.
    const canStartFromJob = !job || (job.kind === "analyze" && ["completed", "needs_context"].includes(job.status));
    if (!restored || !canGenerate || checkingConnection || busy || ready || !canStartFromJob || !autoStartKey || autoAttempted.current.has(autoStartKey)) return;
    autoAttempted.current.add(autoStartKey);
    void startGeneration();
  }, [restored, canGenerate, checkingConnection, busy, ready, job, autoStartKey, startGeneration]);

  function chooseVideo(items: FileList | File[], recorded = false) {
    if (generationLock.current || running || savedVideo) return;
    const files = Array.from(items);
    if (files.length !== 1) { setError("Choose one video that shows your space and includes your goal in its audio."); return; }
    const file = files[0];
    if (!/^video\/(mp4|quicktime|webm)$/.test(captureFileMetadata(file).mimeType)) { setError(`“${file.name}” isn’t a supported video. Choose an MP4, MOV, or WebM video with your goal in its audio.`); return; }
    if (!file.size) { setError("This video is empty. Choose another video or record one here."); return; }
    if (file.size > 50_000_000) { setError(`“${file.name}” is over 50 MB. Trim it to a short clip or record a new video here.`); return; }
    setError(null);
    setVideo({ id: globalThis.crypto?.randomUUID?.() ?? `selected-${Date.now()}-${file.name}`, file, progress: 0, sent: 0, recorded });
    setUploadNotice(null);
    setRecording(false);
  }

  async function checkConnection() {
    if (checkingConnection) return;
    setCheckingConnection(true);
    setError(null);
    setVideo(value => value ? { ...value, error: undefined } : value);
    // This is an explicit retry. Automatic retries after a failed request remain disabled.
    if (autoStartKey) autoAttempted.current.delete(autoStartKey);
    try { await refresh(); }
    finally { setCheckingConnection(false); }
  }

  function pauseUpload() {
    if (!upload.current || cancellingUpload.current) return;
    cancellingUpload.current = true;
    abortUpload(upload.current);
    rejectUpload.current?.(new Error("Upload paused. Your video is still on this device. Try again to resume it."));
  }

  async function controlJob(action: "cancel" | "resume") {
    if (!job || generationLock.current) return;
    if (action === "resume" && job.kind !== "generate") { await startGeneration(); return; }
    generationLock.current = true;
    setBusy(action);
    setError(null);
    try {
      const result = await post<{ job: GenerationJob }>(`/api/jobs/${job.id}/${action}`);
      setJob(result.job);
      setProgressError(null);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(null); generationLock.current = false; }
  }

  const inputDisabled = !!busy || running || !!savedVideo || !restored;
  const phaseTitle = configLoading || checkingConnection ? "Checking your connection…"
    : !canGenerate ? configError ? "Couldn’t check your connection." : "Your video is ready."
    : error ? "Your video needs attention."
    : busy === "session" ? "Starting your private workspace…"
    : busy === "prepare" ? "Preparing your upload…"
    : busy === "upload" ? "Uploading your video…"
    : busy === "confirm" ? "Confirming your video is saved…"
    : busy === "generate" ? "Starting your tutorial…"
    : "Your video is ready.";
  const phaseMessage = configLoading || checkingConnection ? "We’ll start automatically as soon as your workspace is connected. Your video is on this device."
    : !canGenerate ? connectionMessage
    : error ? (video?.asset || savedVideo ? "Your uploaded video is saved. Try again to continue." : "Your video is still on this device. Try again below, or choose another video.")
    : busy === "session" ? "Opening a private place for your video."
    : busy === "prepare" ? "Checking for an earlier upload and getting a secure connection ready."
    : busy === "upload" ? "Keep this page open. Astro starts parsing your video after it is uploaded and saved."
    : busy === "confirm" ? "The transfer finished. We’re checking that your video arrived before starting analysis."
    : busy === "generate" ? "Your video is saved. Sending it to the queue for analysis, planning, and animation."
    : "Analysis will start automatically. You don’t need to press another button.";
  const pageTitle = ready ? "Your animation is ready."
    : job?.status === "queued" ? "Your tutorial is queued."
    : sceneUnavailable || job?.status === "failed" || job?.status === "needs_context" ? "Your tutorial needs attention."
    : job?.status === "cancelled" ? "Your tutorial is stopped."
    : job?.status === "budget_paused" ? "Your tutorial is paused."
    : job?.status === "completed" ? "Opening your tutorial…"
    : showingProgress ? "Your animation is taking shape." : "Start with a video.";
  return <div className="create-page capture-first">
    <div className="page-heading create-heading"><div>
      <span className="eyebrow">YOUR SPACE. YOUR PERSONAL GUIDE.</span>
      <h1>{pageTitle}</h1>
      <p>{showingProgress ? "Follow each stage here. Your tutorial stays in My tutorials." : "Show your space and say what you want to do. Astro starts building your animation automatically."}</p>
    </div></div>
    <section className="panel capture-panel">
      {(error || progressError) && <div className="notice notice-error capture-feedback-error" role="alert"><Icon name="info" size={16} /><span>{error || progressError}</span></div>}
      {busy === "load" ? <div className="loading-line" role="status"><span className="spinner" />Opening your tutorial…</div> : !restored ? <button className="button button-secondary" onClick={() => setReload(value => value + 1)}><Icon name="refresh" size={16} />Try again</button> : sceneUnavailable ? <div className="capture-status-card needs-attention">
        <div role="alert"><h2 className="subheading">The playable scene isn’t available yet.</h2><p>Processing reported completion, but the finished scene could not be retrieved. {savedVideo || video?.asset ? "Your uploaded video is saved. " : ""}Check again to reload the result.</p></div>
        <div className="capture-feedback-actions"><button className="button button-primary" onClick={() => { sceneChecks.current.count = 0; setSceneUnavailable(false); setProgressError(null); setSceneRetry(value => value + 1); }}><Icon name="refresh" size={16} />Check again</button></div>
      </div> : showingProgress ? <GenerationProgress job={job} tutorial={tutorial} busy={!!busy} onCancel={() => void controlJob("cancel")} onResume={() => void controlJob("resume")} worker={worker} /> : <>
        <input ref={fileInput} type="file" accept="video/*" aria-label="Video file" className="capture-file-input" disabled={inputDisabled} onChange={event => { if (event.target.files?.length) chooseVideo(event.target.files); event.target.value = ""; }} />
        {hasCapture ? <div className={`capture-status-card ${error || !canGenerate && !configLoading ? "needs-attention" : ""}`} role="status" aria-live="polite" aria-atomic="true">
          <span className="capture-status-icon">{busy || configLoading || checkingConnection ? <span className="spinner" /> : <Icon name={error || !canGenerate ? "info" : "check"} size={25} />}</span>
          <h2 className="subheading">{phaseTitle}</h2>
          <p>{phaseMessage}</p>
        </div> : <div className={`drop-zone video-drop-zone ${dragging ? "dragging" : ""}`}
          onDragOver={event => { event.preventDefault(); if (!inputDisabled) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); if (!inputDisabled) chooseVideo(event.dataTransfer.files); }}
          onClick={() => { if (!inputDisabled) fileInput.current?.click(); }}
          onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && !inputDisabled) { event.preventDefault(); fileInput.current?.click(); } }}
          role="button" tabIndex={inputDisabled ? -1 : 0} aria-disabled={inputDisabled} aria-label="Upload a video">
          <span className="upload-symbol"><Icon name="upload" size={30} /></span>
          <strong>Upload a video</strong>
          <p>Pan around your space and say what you want to do.<br />Then drop your video here, or choose it from your device.</p>
          <span className="button button-primary upload-browse">Choose a video<Icon name="arrow" size={16} /></span>
          <small>One video with audio · up to 50 MB</small>
        </div>}
        {!busy && !savedVideo && !video && <div className="capture-actions"><span>or</span><button className="button button-secondary" onClick={() => setRecording(value => !value)} disabled={inputDisabled}><Icon name="camera" size={17} />Record a video</button></div>}
        {recording && <ScanRecorder mode="video" autoGenerate onCapture={file => chooseVideo([file], true)} onClose={() => setRecording(false)} />}
        {pendingUploads.length > 0 && !busy && !video && <div className="notice notice-inline"><Icon name="refresh" size={16} /><span><strong>Continue your interrupted upload.</strong><br />Choose the same video to pick up where you left off.<br /><small>{pendingUploads.map(ticket => ticket.asset.name).join(" · ")}</small></span><button className="button button-secondary button-small" disabled={inputDisabled} onClick={() => fileInput.current?.click()}>Reselect video</button></div>}
      </>}
      {hasCapture && <div className="upload-list"><div className="upload-item"><Icon name="camera" size={18} /><div className="upload-item-main"><strong>{video?.file.name ?? savedVideo?.name}</strong><small>{video?.asset || savedVideo ? `${formatBytes(video?.file.size ?? savedVideo?.size ?? 0)} · Uploaded and saved` : busy === "upload" ? `${formatBytes(video?.sent ?? 0)} of ${formatBytes(video?.file.size ?? 0)} · ${Math.round(video?.progress ?? 0)}% uploaded` : busy === "confirm" ? "Transfer complete · confirming it is saved" : `${formatBytes(video?.file.size ?? 0)} · On this device`}</small>{video && !video.asset && (busy === "upload" || busy === "confirm" || video.progress > 0) && <div className="upload-progress" role="progressbar" aria-label="Video upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(video.progress)} aria-valuetext={`${Math.round(video.progress)}% uploaded`}><span style={{ width: `${video.progress}%` }} /></div>}</div>{video?.recorded && !video.asset && <button className="icon-button" aria-label={`Save recording ${video.file.name}`} title="Save a copy" onClick={() => saveRecording(video.file)}><Icon name="download" size={15} /></button>}{(video?.asset || savedVideo) && <Icon name="check" size={16} />}</div></div>}
      {uploadNotice && <p className="upload-connection-note" role="status">{uploadNotice}</p>}
      {busy === "upload" && <div className="capture-feedback-actions"><button className="button button-quiet" onClick={pauseUpload}>Pause upload</button></div>}
      {!showingProgress && !busy && hasCapture && (error || !canGenerate) && <div className="capture-feedback-actions">
        {canGenerate && error && <button className="button button-primary" onClick={() => void startGeneration()}><Icon name="refresh" size={16} />Try again</button>}
        {!savedVideo && !video?.asset && <button className="button button-secondary" onClick={() => fileInput.current?.click()}>Choose another video</button>}
      </div>}
      {!configLoading && !canGenerate && !showingProgress && <div className="notice notice-inline capture-connection-notice"><Icon name="info" size={15} /><span>{!hasCapture ? connectionMessage : "Your selected video will start automatically after this connection is restored."}</span><button className="button button-secondary button-small" disabled={checkingConnection} onClick={() => void checkConnection()}>{checkingConnection ? <><span className="spinner" />Checking connection…</> : "Check connection"}</button></div>}
      {worker && worker.status !== "ready" && !ready && <div className="notice notice-inline capture-worker-notice" role="status"><Icon name="info" size={15} /><span>{worker.message}<br />{job?.status === "queued" ? "Your uploaded video is saved. Analysis will start when the local worker is running." : "You can still upload your video. Analysis will wait until local processing is available."}</span></div>}
      {!showingProgress && <div className="capture-privacy"><Icon name="lock" size={13} /><span>Your original video stays private.</span></div>}
    </section>
    {!showingProgress && <p className="capture-tip"><Icon name="mic" size={15} /><span>“I want to make pasta.” Show the ingredients, pan, sink, and stove as you speak.</span></p>}
  </div>;
}
