"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, CameraOff, Check, CircleCheck, Crosshair, Mic, Pause, Play, RotateCcw, ScanLine, Sparkles } from "lucide-react";
import { Plane, Raycaster, PerspectiveCamera, Vector2, Vector3 } from "three";
import { getExample } from "@/lib/examples";
import type { PracticeSession, StepCheck, Tutorial } from "@/lib/contracts";
import { calibrateCamera, type Calibration, type Correspondence } from "@/lib/calibration";
import { cameraMoved, capturePatches, type FramePatch } from "@/lib/camera-motion";
import { useVoice } from "@/lib/use-voice";
import { api, ApiError } from "@/lib/client";

const SceneViewer = dynamic(() => import("./scene-viewer"), { ssr: false });
async function request(path: string, method: string, body?: unknown) {
  return api<{session: PracticeSession; tutorial: Tutorial; check: StepCheck}>(path, { method, body: body ? JSON.stringify(body) : undefined });
}

export default function PracticeWorkspace({ id }: { id: string }) {
  const [tutorial, setTutorial] = useState<Tutorial | null>(() => getExample(id) ?? null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const sessionRef = useRef<PracticeSession | null>(null);
  const [error, setError] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [points, setPoints] = useState<Correspondence[]>([]);
  const [dimensions, setDimensions] = useState({ width: 1280, height: 720 });
  const [overlayBox, setOverlayBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [autoCheck, setAutoCheck] = useState(true);
  const [feedback, setFeedback] = useState<StepCheck | null>(null);
  const [opacity, setOpacity] = useState(.65);
  const [time, setTime] = useState(0);
  const [animationEpoch, setAnimationEpoch] = useState(0);
  const animationTime = useRef(0);
  const animationKey = useRef("");
  const cameraGeneration = useRef(0);
  const visualCheck = useRef<(() => Promise<void>) | null>(null);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const cameraBox = useRef<HTMLDivElement>(null);
  const media = useRef<MediaStream | null>(null);
  const requestInFlight = useRef(false);
  const patches = useRef<FramePatch[]>([]);
  const cameraSettings = useRef("");
  const active = session?.status === "active";
  const steps = tutorial?.plan?.steps ?? [];
  const index = session?.currentStepIndex ?? 0;
  const step = steps[index];
  const landmarks = tutorial?.scene?.landmarks.slice(0, 8) ?? [];
  const movable = tutorial?.scene?.objects.filter(object => object.movable && step?.objectIds.includes(object.id)) ?? [];
  const objectAnchors = session?.calibration?.objectAnchors as Record<string, {position: [number, number, number]; stepId: string}> | undefined;
  const anchorsConfirmed = movable.every(object => objectAnchors?.[object.id]?.stepId === step?.id);
  const voiceNavigation = useCallback((context: { action?: string }) => { if (context.action === "repeat_step") { setFeedback(null); setAnimationEpoch(value => value + 1); } if (context.action === "request_visual_check") void visualCheck.current?.(); }, []);
  const voice = useVoice(id, session?.id, undefined, step ? { stepId: step.id, cameraMode: "first" } : undefined, voiceNavigation);
  const updateSession = useCallback((next: PracticeSession) => {
    const current = sessionRef.current;
    if (current?.id === next.id && current.version > next.version) return;
    sessionRef.current = next; setSession(next);
    if (!next.calibration) setCalibration(null);
  }, []);

  useEffect(() => {
    if (!session?.id || session.status === "completed" || !cameraOn) return;
    let cancelled = false, inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await request(`/api/practice/${session.id}`, "GET");
        if (!cancelled) updateSession(result.session);
      } catch (cause) {
        if (!cancelled && cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) { setAutoCheck(false); setCalibration(null); setError(cause.message); }
      } finally { inFlight = false; }
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session?.id, session?.status, cameraOn, updateSession]);

  const action = useCallback(async (name: string, extra: Record<string, unknown> = {}) => {
    const current = sessionRef.current;
    if (!current) return null;
    const result = await request(`/api/practice/${current.id}`, "PATCH", { action: name, version: current.version, ...extra });
    updateSession(result.session); return result.session as PracticeSession;
  }, [updateSession]);
  const invalidate = useCallback((reason: string) => {
    setCalibration(null); setPoints([]); patches.current = []; setError(reason);
    if (sessionRef.current && sessionRef.current.status !== "calibrating") void action("invalidate").catch(() => {});
  }, [action]);

  useEffect(() => {
    if (getExample(id)) return;
    let cancelled = false;
    request(`/api/tutorials/${id}`, "GET").then(result => { if (!cancelled) setTutorial(result.tutorial); }).catch(cause => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [id]);
  useEffect(() => {
    const element = cameraBox.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const scale = Math.min(element.clientWidth / dimensions.width, element.clientHeight / dimensions.height);
      setOverlayBox({ width: dimensions.width * scale, height: dimensions.height * scale, left: (element.clientWidth - dimensions.width * scale) / 2, top: (element.clientHeight - dimensions.height * scale) / 2 });
    });
    observer.observe(element); return () => observer.disconnect();
  }, [dimensions, tutorial]);
  useEffect(() => {
    const change = () => invalidate("The phone orientation changed. Align the workspace again.");
    window.addEventListener("orientationchange", change);
    return () => window.removeEventListener("orientationchange", change);
  }, [invalidate]);
  useEffect(() => {
    const cancelPendingCamera = () => { cameraGeneration.current++; };
    const hide = () => { if (document.hidden) { cancelPendingCamera(); media.current?.getTracks().forEach(track => track.stop()); media.current = null; setCameraOn(false); invalidate("Camera paused while the page was in the background. Restart and realign when you’re ready."); } };
    document.addEventListener("visibilitychange", hide);
    return () => { cancelPendingCamera(); document.removeEventListener("visibilitychange", hide); media.current?.getTracks().forEach(track => track.stop()); if (sessionRef.current?.status === "active") void fetch(`/api/practice/${sessionRef.current.id}`, { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({action:"pause",version:sessionRef.current.version}), keepalive:true }).catch(() => {}); };
  }, [invalidate]);
  useEffect(() => {
    if (!active || !calibration || !anchorsConfirmed) return;
    let frame = 0, last = performance.now();
    const timing = tutorial?.scene?.steps[index];
    const start = timing?.startTime ?? 0, end = timing?.endTime ?? start + 12;
    const key = `${index}:${animationEpoch}`;
    let cursor = animationKey.current === key ? Math.max(start, Math.min(end, animationTime.current)) : start;
    animationKey.current = key; animationTime.current = cursor;
    const run = (now: number) => { const delta = Math.min((now - last) / 1000, .1); last = now; cursor = cursor + delta > end ? start : cursor + delta; animationTime.current = cursor; setTime(cursor); frame = requestAnimationFrame(run); };
    frame = requestAnimationFrame(run); return () => cancelAnimationFrame(frame);
  }, [active, calibration, anchorsConfirmed, tutorial?.scene, index, animationEpoch]);
  const frameImage = useCallback((maxWidth = 960) => {
    if (!video.current || video.current.readyState < 2) return null;
    const canvas = document.createElement("canvas"); canvas.width = Math.min(maxWidth, video.current.videoWidth); canvas.height = Math.round(canvas.width * video.current.videoHeight / video.current.videoWidth);
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return null;
    context.drawImage(video.current, 0, 0, canvas.width, canvas.height); return { canvas, context };
  }, []);
  useEffect(() => {
    if (!calibration || !cameraOn) return;
    let lostCount = 0;
    const timer = setInterval(() => {
      const settings = media.current?.getVideoTracks()[0]?.getSettings();
      if (JSON.stringify([settings?.width, settings?.height, settings?.deviceId, (settings as Record<string, unknown>)?.zoom]) !== cameraSettings.current) { invalidate("The camera lens or crop changed. Please align the workspace again."); return; }
      const snapshot = frameImage(320); if (!snapshot) return;
      const state = cameraMoved(snapshot.context.getImageData(0, 0, snapshot.canvas.width, snapshot.canvas.height), patches.current);
      if (state === "moved") invalidate("The phone moved. Realign before continuing with ghost guidance.");
      else if (state === "lost") { if (++lostCount >= 3) invalidate("The alignment landmarks are obscured. Clear the view and realign."); } else lostCount = 0;
    }, 1200);
    return () => clearInterval(timer);
  }, [calibration, cameraOn, frameImage, invalidate]);

  const checkStep = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || current.status !== "active" || !step || requestInFlight.current || !calibration || !anchorsConfirmed || !cameraOn) return;
    const snapshot = frameImage(); if (!snapshot) return;
    requestInFlight.current = true; setBusy(true); setError("");
    try {
      const frame = snapshot.canvas.toDataURL("image/jpeg", .72);
      const result = await request(`/api/practice/${current.id}/check`, "POST", { version: current.version, stepId: step.id, frames: [frame] });
      if (sessionRef.current?.version !== current.version) return;
      updateSession(result.session); setFeedback(result.check);
    } catch (cause) {
      if (cause instanceof ApiError && [401, 402, 403, 404, 422].includes(cause.status)) setAutoCheck(false);
      setError(cause instanceof Error ? cause.message : "The camera check could not complete.");
    }
    finally { requestInFlight.current = false; setBusy(false); }
  }, [step, calibration, anchorsConfirmed, frameImage, updateSession, cameraOn]);
  useEffect(() => { if (!active || !autoCheck || !anchorsConfirmed) return; const timer = setInterval(() => void checkStep(), 5000); return () => clearInterval(timer); }, [active, autoCheck, anchorsConfirmed, checkStep]);

  useEffect(() => { visualCheck.current = checkStep; }, [checkStep]);
  useEffect(() => { if (session?.status === "completed") { cameraGeneration.current++; media.current?.getTracks().forEach(track => track.stop()); media.current = null; } }, [session?.status]);
  function stopCamera() { cameraGeneration.current++; media.current?.getTracks().forEach(track => track.stop()); media.current = null; setCameraOn(false); setBusy(false); invalidate("Camera is off. Reopen it and align your workspace when you’re ready."); }
  async function startCamera() {
    const cameraToken = ++cameraGeneration.current;
    setBusy(true); setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access needs HTTPS or localhost and a supported browser.");
      media.current?.getTracks().forEach(track => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (cameraToken !== cameraGeneration.current || document.hidden) { stream.getTracks().forEach(track => track.stop()); return; }
      media.current = stream;
      if (!video.current) { stream.getTracks().forEach(track => track.stop()); return; }
      video.current.srcObject = stream; await video.current.play();
      if (cameraToken !== cameraGeneration.current || document.hidden) { stream.getTracks().forEach(track => track.stop()); return; }
      setDimensions({ width: video.current.videoWidth, height: video.current.videoHeight });
      const settings = stream.getVideoTracks()[0].getSettings(); cameraSettings.current = JSON.stringify([settings.width, settings.height, settings.deviceId, (settings as Record<string, unknown>).zoom]);
      stream.getVideoTracks()[0].onended = () => { if (cameraToken !== cameraGeneration.current) return; setCameraOn(false); invalidate("Camera access ended. Restart the camera to continue."); };
      setCameraOn(true);
      if (!tutorial?.isExample && !sessionRef.current) { const result = await request("/api/practice", "POST", { tutorialId: id }); if (cameraToken === cameraGeneration.current) updateSession(result.session); }
    } catch (cause) {
      if (cameraToken !== cameraGeneration.current) return;
      media.current?.getTracks().forEach(track => track.stop()); media.current = null; setCameraOn(false);
      setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser settings, or return to the 3D tutorial." : cause instanceof Error ? cause.message : "Your camera could not start.");
    }
    finally { if (cameraToken === cameraGeneration.current) setBusy(false); }
  }

  async function matchPoint(event: React.MouseEvent<HTMLDivElement>) {
    if (!video.current || !cameraOn || tutorial?.isExample || busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const image: [number, number] = [(event.clientX - rect.left) / rect.width * dimensions.width, (event.clientY - rect.top) / rect.height * dimensions.height];
    if (anchorIndex !== null && calibration) {
      const object = movable[anchorIndex]; if (!object) return;
      const camera = new PerspectiveCamera(calibration.verticalFov, calibration.width / calibration.height, .01, 100);
      camera.position.set(...calibration.position); camera.quaternion.set(...calibration.quaternion); camera.updateMatrixWorld();
      const ray = new Raycaster(); ray.setFromCamera(new Vector2(image[0] / dimensions.width * 2 - 1, 1 - image[1] / dimensions.height * 2), camera);
      const point = new Vector3();
      const support = new Plane(new Vector3(0, 1, 0), -object.position[1]);
      if (!ray.ray.intersectPlane(support, point)) { setError("Choose the object’s position on its original support surface."); return; }
      const original = new Vector3(...object.position);
      const supported = tutorial?.scene?.steps[index]?.handTargets?.some(target => target.objectId === object.id);
      const limit = supported ? .15 : .02;
      if (point.distanceTo(original) > limit) { setError(`Move this object back within ${Math.round(limit * 100)} cm of its captured position, keeping its original orientation. Larger changes need a new workspace scan.`); return; }
      setBusy(true);
      try { await action("anchor", { objectId: object.id, position: point.toArray() }); if (anchorIndex + 1 < movable.length) setAnchorIndex(anchorIndex + 1); else { setAnchorIndex(null); } } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not confirm the object."); } finally { setBusy(false); }
      return;
    }
    if (calibration || points.length >= landmarks.length || landmarks.length < 8) return;
    const landmark = landmarks[points.length];
    const next = [...points, { id: landmark.id, world: landmark.position, image, check: points.length >= 6 }];
    setPoints(next); setError("");
    if (next.length === 8) {
      setBusy(true);
      try {
        const solved = calibrateCamera(next, dimensions.width, dimensions.height);
        const snapshot = frameImage(320);
        if (snapshot) {
          patches.current = capturePatches(snapshot.context.getImageData(0, 0, snapshot.canvas.width, snapshot.canvas.height), next.map(p => [p.image[0] / dimensions.width * snapshot.canvas.width, p.image[1] / dimensions.height * snapshot.canvas.height]));
          if (patches.current.length < 3) throw new Error("These landmarks have too little visual detail to detect camera movement. Choose sharper edges and try again.");
        }
        const result = await action("calibrate", { calibration: { ...solved, points: next } });
        if (!result) throw new Error("A saved practice session is needed before camera guidance can begin.");
        setCalibration(result.calibration as unknown as Calibration);
      } catch (cause) { setPoints([]); setError(cause instanceof Error ? cause.message : "Alignment needs another attempt."); }
      finally { setBusy(false); }
    }
  }

  async function runAction(name: string) {
    setBusy(true); setError("");
    try { const result = await action(name); if (result && name === "repeat") { setFeedback(null); setAnimationEpoch(value => value + 1); } } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update this step."); } finally { setBusy(false); }
  }
  if (!tutorial) return <div className="scene-unavailable"><p>{error || "Opening your practice session…"}</p><Link href="/library">Back to your library</Link></div>;
  return <div className="practice-page"><Link href={`/tutorial/${id}/${tutorial.slug}`} className="player-breadcrumb"><ArrowLeft size={15} />Back to the 3D tutorial</Link><header className="practice-heading"><div><div className="eyebrow"><span className="live-dot" />LET’S DO THIS TOGETHER</div><h1>Make it happen.</h1><p>{tutorial.title} · Step {index + 1} of {steps.length}</p></div><button className="button button-secondary" disabled={busy || tutorial.isExample || !session} title={!session && !tutorial.isExample ? "Open your camera to start a practice session first" : undefined} onClick={() => void (voice.status === "connected" || voice.status === "connecting" ? voice.stop() : voice.start())}><Mic size={16} />{voice.status === "connected" ? "End conversation" : voice.status === "connecting" ? "Cancel connection" : "Talk to tutor"}</button></header>
    {session?.status === "completed" ? <section className="practice-complete"><CircleCheck size={46} /><h2>You did that.</h2><p>You’ve worked through every step. Your progress is saved, and your tutor is here whenever you need a refresher.</p><Link className="button button-primary" href="/library">Back to my library<ArrowRight size={16} /></Link><Link className="button button-secondary" href={`/tutorial/${id}/${tutorial.slug}`}>Watch again</Link></section> : <div className="practice-layout"><section><div className="practice-camera" ref={cameraBox}><video ref={video} muted playsInline />
      {!cameraOn && <div className="camera-empty"><ScanLine size={40} strokeWidth={1.2} /><h2>Your space. Your pace.</h2><p>Prop your phone where it can see the work area. We’ll align the guide before you begin.</p><button className="button button-primary" disabled={busy} onClick={() => void startCamera()}><Camera size={16} />{busy ? "Opening camera…" : "Open my camera"}</button><p>Your camera is shared for visual checks only while you practice.</p></div>}
      {cameraOn && <><button className="camera-stop" aria-label="Turn off camera" onClick={stopCamera}><CameraOff size={16} /><span>Camera off</span></button><div className="camera-status"><span />{tutorial.isExample ? "CAMERA PREVIEW" : calibration ? "WORKSPACE ALIGNED" : "ALIGN YOUR WORKSPACE"}</div>{calibration && anchorsConfirmed && <div className="ghost-layer" style={overlayBox}><SceneViewer tutorial={tutorial} time={time} mode="first" ghost calibration={calibration} opacity={opacity} objectAnchors={objectAnchors} /></div>}{(!calibration || anchorIndex !== null) && <div className="camera-click-layer" style={overlayBox} onClick={event => void matchPoint(event)}>{points.map((p, i) => <span key={p.id} className="landmark-dot" style={{ left: `${p.image[0] / dimensions.width * 100}%`, top: `${p.image[1] / dimensions.height * 100}%` }}>{i + 1}</span>)}</div>}<div className="practice-camera-caption"><strong>{tutorial.isExample ? "PREVIEW YOUR CAMERA SETUP" : anchorIndex !== null ? "LOCATE YOUR OBJECT" : calibration ? `STEP ${index + 1}` : "KEEP YOUR PHONE STILL"}</strong>{tutorial.isExample ? "Create a tutorial from your own scan to align ghost hands with your actual workspace." : anchorIndex !== null ? `Tap the base of ${movable[anchorIndex]?.id} on its support surface.` : calibration ? step?.instruction : `Tap ${landmarks[points.length]?.label || "the highlighted landmark"} in your camera view.`}</div></>}
    </div>{(error || voice.error) && <div className="practice-error" role="status">{error || voice.error}</div>}{voice.transcript && <div className="tutor-conversation"><div className="tutor-avatar"><Sparkles size={18} /></div><p>{voice.transcript}</p></div>}</section><aside className="practice-sidebar">
      {tutorial.isExample ? <><div className="eyebrow">A PREVIEW OF PRACTICE MODE</div><h2>Built around your reality.</h2><p>This example shows how the player works. To guide your hands accurately, we need a scan of your own room and equipment.</p><p>Start with a short walkthrough. Your tutor will ask for close-ups and measurements where needed.</p><Link className="button button-primary" href="/create">Create my tutorial<ArrowRight size={16} /></Link></> : !calibration ? <><div className="eyebrow">ONE-TIME WORKSPACE ALIGNMENT</div><h2>Match the landmarks.</h2><p>Find the highlighted point in your 3D scene, then tap the same point in the camera view. The last two points independently check the fit.</p><div className="alignment-progress">{Array.from({length:8}, (_, i) => <span className={i < points.length ? "done" : ""} key={i} />)}</div><div className="alignment-preview"><SceneViewer tutorial={tutorial} time={0} mode="free" landmarkIndex={points.length} /></div><p><strong>{Math.min(points.length + 1, 8)} of 8:</strong> {landmarks[points.length]?.label || "Waiting for scene landmarks"}</p><button className="button button-secondary" disabled={!points.length || busy} onClick={() => setPoints([])}><RotateCcw size={15} />Start alignment again</button>{landmarks.length < 8 && <p className="player-inline-error">This scene needs eight supported landmarks before spatial guidance can begin.</p>}</> : <><div className="eyebrow">STEP {String(index + 1).padStart(2,"0")} / {String(steps.length).padStart(2,"0")}</div><h2>{step?.title}</h2><p>{step?.instruction}</p>{!anchorsConfirmed ? <><p>Confirm each object’s base before this gesture. Keep objects on the same surface and facing the same direction as in your scan.</p><button className="button button-primary" disabled={busy} onClick={() => setAnchorIndex(0)}><Crosshair size={16} />Locate {movable.length} object{movable.length === 1 ? "" : "s"}</button></> : <><button className="button button-primary" disabled={busy || !active || !cameraOn} onClick={() => void checkStep()}><Camera size={16} />{busy ? "Checking…" : "Check this step"}</button><button className="button button-secondary" disabled={busy || !active || !cameraOn} onClick={() => void runAction("confirm")}><Check size={16} />I’ve done this</button><button className="button button-secondary" disabled={busy || !cameraOn} onClick={() => void runAction("repeat")}><RotateCcw size={15} />Repeat this gesture</button><button className="button button-quiet" disabled={busy || !cameraOn} onClick={() => void runAction(active ? "pause" : "resume")}>{active ? <Pause size={15} /> : <Play size={15} />}{active ? "Pause guidance" : "Resume guidance"}</button></>}{feedback?.stepId === step?.id && <div className="practice-feedback"><strong>{feedback.status === "complete" ? "That looks right" : feedback.status === "uncertain" ? "Let’s take another look" : "A little more to do"}</strong><p>{feedback.guidance}</p></div>}<div className="practice-options"><label><input type="checkbox" checked={autoCheck} onChange={event => setAutoCheck(event.target.checked)} />Check progress automatically</label><label>Ghost visibility<input type="range" min={.2} max={.9} step={.05} value={opacity} onChange={event => setOpacity(Number(event.target.value))} /></label><button className="button button-quiet" onClick={() => invalidate("Ready to realign your workspace.")}><Crosshair size={15} />Realign workspace</button></div></>}
    </aside></div>}
  </div>;
}
