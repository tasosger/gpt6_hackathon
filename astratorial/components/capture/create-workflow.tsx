"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Upload } from "tus-js-client";
import type { CaptureAsset, GenerationJob, Tutorial } from "@/lib/contracts";
import { api, errorMessage, formatBytes, post, useAppConfig } from "@/lib/client";
import { Icon } from "@/components/shell/icon";
import { GenerationProgress } from "./generation-progress";
import { MeasuredCreateWorkflow } from "./measured-create-workflow";
import { ScanRecorder } from "./scan-recorder";

type PendingVideo = { id: string; file: File; progress: number; recorded: boolean; asset?: CaptureAsset; error?: string };
type UploadConfig = { uploadId: string; asset: CaptureAsset; endpoint: string; headers: Record<string, string>; metadata: Record<string, string>; chunkSize: number };
type PendingUpload = { uploadId: string; asset: CaptureAsset; clientFingerprint?: string | null };
type CompletedUpload = { completed: true; uploadId: string; tutorial: Tutorial; asset: CaptureAsset };
const activeStatuses = ["running", "queued"];

function captureFileMetadata(file: File) {
  // A saved recording retains its capture identity even if its filesystem date changes.
  const recording = /^guided-scan-(\d{13})\.(webm|mp4)$/.exec(file.name);
  return { mimeType: recording ? `video/${recording[2]}` : file.type.split(";")[0], lastModified: recording ? Number(recording[1]) : file.lastModified };
}

async function fileFingerprint(file: File) {
  const source = captureFileMetadata(file);
  const metadata = new TextEncoder().encode(JSON.stringify([file.name, file.size, source.mimeType, source.lastModified]));
  const sampleSize = 1_048_576;
  const [first, last] = await Promise.all([file.slice(0, sampleSize).arrayBuffer(), file.slice(Math.max(sampleSize, file.size - sampleSize)).arrayBuffer()]);
  const bytes = new Uint8Array(metadata.length + first.byteLength + last.byteLength);
  bytes.set(metadata);
  bytes.set(new Uint8Array(first), metadata.length);
  bytes.set(new Uint8Array(last), metadata.length + first.byteLength);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
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
  const { config } = useAppConfig();
  return config?.generationMode === "measured"
    ? <MeasuredCreateWorkflow initialTutorialId={initialTutorialId} />
    : <SingleVideoWorkflow initialTutorialId={initialTutorialId} />;
}

function SingleVideoWorkflow({ initialTutorialId }: { initialTutorialId?: string }) {
  const { config, loading: configLoading, refresh } = useAppConfig();
  const [tutorial, setTutorial] = useState<Tutorial | null>(null);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [video, setVideo] = useState<PendingVideo | null>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [recording, setRecording] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(initialTutorialId ? "load" : null);
  const [error, setError] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [restored, setRestored] = useState(!initialTutorialId);
  const [reload, setReload] = useState(0);
  const upload = useRef<Upload | null>(null);
  const rejectUpload = useRef<((reason: Error) => void) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const generationLock = useRef(false);
  const autoAttempted = useRef(new Set<string>());
  const tutorialRef = useRef<Tutorial | null>(null);
  const mounted = useRef(true);
  const canGenerate = !!config?.configured;
  const running = !!job && activeStatuses.includes(job.status);
  const ready = tutorial?.status === "ready" && !!tutorial.scene;
  const savedVideo = tutorial?.assets.find(asset => asset.kind === "video");
  const showingProgress = !!job || ready || busy === "generate";

  const acceptTutorial = useCallback((value: Tutorial) => {
    tutorialRef.current = value;
    setTutorial(value);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void upload.current?.abort();
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
  const awaitingFinishedTutorial = job?.kind === "generate" && job.status === "completed" && tutorial?.status !== "ready";
  useEffect(() => {
    if (!currentJobId || !currentJobStatus || (!activeStatuses.includes(currentJobStatus) && !awaitingFinishedTutorial)) return;
    let stopped = false;
    let timer: number;
    async function poll() {
      try {
        const data = await api<{ job: GenerationJob; tutorial?: Tutorial }>(`/api/jobs/${currentJobId}`);
        // Some workers return only the job; fetch the finished tutorial before stopping polling.
        const finishedTutorial = data.tutorial ?? (data.job.status === "completed"
          ? (await api<{ tutorial: Tutorial }>(`/api/tutorials/${data.job.tutorialId}`)).tutorial
          : null);
        if (stopped) return;
        setJob(data.job);
        setProgressError(null);
        if (finishedTutorial) acceptTutorial(finishedTutorial);
        if (activeStatuses.includes(data.job.status) || (data.job.kind === "generate" && data.job.status === "completed" && finishedTutorial?.status !== "ready")) timer = window.setTimeout(poll, 3000);
      } catch (reason) {
        if (!stopped) {
          setProgressError(`We couldn’t refresh progress. Your animation may still be building. ${errorMessage(reason)}`);
          timer = window.setTimeout(poll, 7000);
        }
      }
    }
    timer = window.setTimeout(poll, 1000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [currentJobId, currentJobStatus, awaitingFinishedTutorial, acceptTutorial]);

  const uploadVideo = useCallback(async (current: Tutorial, selected: PendingVideo) => {
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
      setVideo(value => value?.id === selected.id ? { ...value, progress: 100, asset: destination.asset } : value);
      setPendingUploads(all => all.filter(ticket => ticket.uploadId !== destination.uploadId));
      return destination.tutorial;
    }
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
        onError: reject,
        onSuccess: () => resolve(),
        onProgress: (sent, total) => setVideo(value => value?.id === selected.id ? { ...value, progress: total ? sent / total * 100 : 0 } : value),
      });
      upload.current = task;
      task.findPreviousUploads().then(previous => {
        if (!mounted.current) { reject(new Error("Upload interrupted. Choose the same video to continue.")); return; }
        if (previous.length) task.resumeFromPreviousUpload(previous[0]);
        task.start();
      }).catch(reject);
    });
    upload.current = null;
    rejectUpload.current = null;
    const completed = await post<{ tutorial: Tutorial; asset: CaptureAsset }>("/api/uploads/complete", { uploadId: destination.uploadId });
    acceptTutorial(completed.tutorial);
    setPendingUploads(all => all.filter(ticket => ticket.uploadId !== destination.uploadId));
    setVideo(value => value?.id === selected.id ? { ...value, progress: 100, asset: completed.asset } : value);
    return completed.tutorial;
  }, [acceptTutorial]);

  const startGeneration = useCallback(async () => {
    if (generationLock.current || !canGenerate) return;
    generationLock.current = true;
    setBusy(video && !video.asset ? "upload" : "generate");
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
        setError(message);
        setVideo(value => value && !value.asset ? { ...value, error: message } : value);
      }
    } finally {
      upload.current = null;
      rejectUpload.current = null;
      if (mounted.current) setBusy(null);
      generationLock.current = false;
    }
  }, [canGenerate, config, video, refresh, acceptTutorial, uploadVideo]);

  const autoStartKey = video?.id ?? (savedVideo && tutorial ? `saved:${tutorial.id}` : null);
  useEffect(() => {
    // A running or finished generation is restored, never submitted again on page load.
    const canStartFromJob = !job || (job.kind === "analyze" && ["completed", "needs_context"].includes(job.status));
    if (!restored || !canGenerate || busy || ready || !canStartFromJob || !autoStartKey || autoAttempted.current.has(autoStartKey)) return;
    autoAttempted.current.add(autoStartKey);
    void startGeneration();
  }, [restored, canGenerate, busy, ready, job, autoStartKey, startGeneration]);

  function chooseVideo(items: FileList | File[], recorded = false) {
    if (generationLock.current || running || savedVideo) return;
    const files = Array.from(items);
    if (files.length !== 1) { setError("Choose one video that shows your space and includes your goal in its audio."); return; }
    const file = files[0];
    if (!captureFileMetadata(file).mimeType.startsWith("video/")) { setError(`“${file.name}” isn’t a video. Choose a video with your goal in its audio.`); return; }
    if (!file.size) { setError("This video is empty. Choose another video or record one here."); return; }
    if (file.size > 50_000_000) { setError(`“${file.name}” is over 50 MB. Trim it to a short clip or record a new video here.`); return; }
    setError(null);
    setVideo({ id: crypto.randomUUID(), file, progress: 0, recorded });
    setRecording(false);
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
  return <div className="create-page capture-first">
    <div className="page-heading create-heading"><div>
      <span className="eyebrow">YOUR SPACE. YOUR PERSONAL GUIDE.</span>
      <h1>{ready || job?.status === "completed" && job.kind === "generate" ? "Your animation is ready." : showingProgress ? "Your animation is taking shape." : "Start with a video."}</h1>
      <p>{showingProgress ? "Astro turns what you show and say into a step-by-step animation." : "Show your space and say what you want to do. Astro starts building your animation automatically."}</p>
    </div></div>
    {(error || progressError) && <div className="notice notice-error" role="alert"><Icon name="info" size={16} /><span>{error || progressError}</span></div>}
    <section className="panel capture-panel">
      {busy === "load" ? <div className="loading-line"><span className="spinner" />Opening your tutorial…</div> : !restored ? <button className="button button-secondary" onClick={() => setReload(value => value + 1)}><Icon name="refresh" size={16} />Try again</button> : showingProgress ? <GenerationProgress job={job} tutorial={tutorial} busy={!!busy} onCancel={() => void controlJob("cancel")} onResume={() => void controlJob("resume")} /> : <>
        <div className={`drop-zone video-drop-zone ${dragging ? "dragging" : ""} ${busy ? "is-uploading" : ""}`}
          onDragOver={event => { event.preventDefault(); if (!inputDisabled) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); if (!inputDisabled) chooseVideo(event.dataTransfer.files); }}
          onClick={() => { if (!inputDisabled) fileInput.current?.click(); }}
          onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && !inputDisabled) { event.preventDefault(); fileInput.current?.click(); } }}
          role="button" tabIndex={inputDisabled ? -1 : 0} aria-disabled={inputDisabled} aria-label="Upload a video">
          <span className="upload-symbol">{busy ? <span className="spinner" /> : <Icon name="upload" size={30} />}</span>
          <strong>{busy ? "Uploading your video…" : "Upload a video"}</strong>
          <p>{busy ? "Your animation starts as soon as the upload finishes." : <>Pan around your space and say what you want to do.<br />Then drop your video here, or choose it from your device.</>}</p>
          {!busy && <span className="button button-primary upload-browse">Choose a video<Icon name="arrow" size={16} /></span>}
          <small>One video with audio · up to 50 MB</small>
          <input ref={fileInput} type="file" accept="video/*" aria-label="Video file" disabled={inputDisabled} onChange={event => { if (event.target.files?.length) chooseVideo(event.target.files); event.target.value = ""; }} />
        </div>
        {!busy && !savedVideo && <div className="capture-actions"><span>or</span><button className="button button-secondary" onClick={() => setRecording(value => !value)} disabled={inputDisabled}><Icon name="camera" size={17} />Record a video</button></div>}
        {recording && <ScanRecorder mode="video" autoGenerate onCapture={file => chooseVideo([file], true)} onClose={() => setRecording(false)} />}
        {pendingUploads.length > 0 && !busy && <div className="notice notice-inline"><Icon name="refresh" size={16} /><span><strong>Continue your interrupted upload.</strong><br />Choose the same video to pick up where you left off.<br /><small>{pendingUploads.map(ticket => ticket.asset.name).join(" · ")}</small></span><button className="button button-secondary button-small" disabled={inputDisabled} onClick={() => fileInput.current?.click()}>Reselect video</button></div>}
        {(video || savedVideo) && <div className="upload-list" aria-live="polite"><div className="upload-item"><Icon name="camera" size={18} /><div className="upload-item-main"><strong>{video?.file.name ?? savedVideo?.name}</strong><small className={video?.error ? "upload-error" : ""}>{video?.error ?? `${formatBytes(video?.file.size ?? savedVideo?.size ?? 0)} · ${video?.asset || savedVideo ? "Uploaded" : busy ? `${Math.round(video?.progress ?? 0)}% uploaded` : "Ready on this device"}`}</small>{video && !video.asset && video.progress > 0 && <div className="upload-progress"><span style={{ width: `${video.progress}%` }} /></div>}</div>{video?.recorded && !video.asset && <button className="icon-button" aria-label={`Save recording ${video.file.name}`} title="Save a copy" onClick={() => saveRecording(video.file)}><Icon name="download" size={15} /></button>}{(video?.asset || savedVideo) && <Icon name="check" size={16} />}</div></div>}
        {error && (video || savedVideo) && !busy && <div className="form-actions"><button className="button button-primary" disabled={!canGenerate} onClick={() => void startGeneration()}><Icon name="refresh" size={16} />Try again</button></div>}
        {!configLoading && !canGenerate && <div className="notice notice-inline"><Icon name="info" size={15} /><span>The workspace is being connected. Your video stays on this device and will start automatically when it’s ready.</span><button className="button button-quiet button-small" onClick={() => void refresh()}>Check connection</button><Link href="/settings" className="text-link">Connection status</Link></div>}
        <div className="capture-privacy"><Icon name="lock" size={13} /><span>Your original video stays private.</span></div>
      </>}
    </section>
    {!showingProgress && <p className="capture-tip"><Icon name="mic" size={15} /><span>“I want to make pasta.” Show the ingredients, pan, sink, and stove as you speak.</span></p>}
  </div>;
}
