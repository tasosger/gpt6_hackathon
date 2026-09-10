"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/shell/icon";
import { errorMessage } from "@/lib/client";
import { cameraRecordingStream } from "@/lib/camera-recording";

type Facing = "user" | "environment";
const cameraSize = { width: { ideal: 1280 }, height: { ideal: 720 } };
const stopTracks = (media: MediaStream | null) => media?.getTracks().forEach(track => track.stop());

function cameraError(reason: unknown) {
  const name = reason instanceof Error ? reason.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Allow camera and microphone access in your browser, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "This camera isn’t available on your device. Try another camera or upload a recording.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is busy. Close other apps using it, then try again.";
  return "We couldn’t open the camera. Try again, or use your phone camera and upload the recording.";
}

// getUserMedia cannot be aborted. Release a late result after timeout or close.
function requestCamera(constraints: MediaStreamConstraints, active: () => boolean) {
  return new Promise<MediaStream>((resolve, reject) => {
    let expired = false;
    const timer = window.setTimeout(() => { expired = true; reject(new Error("Camera request timed out.")); }, 20_000);
    navigator.mediaDevices.getUserMedia(constraints).then(media => {
      window.clearTimeout(timer);
      if (expired || !active()) { stopTracks(media); reject(new DOMException("Recorder closed", "AbortError")); }
      else resolve(media);
    }, reason => { window.clearTimeout(timer); reject(reason); });
  });
}

export function ScanRecorder({ mode, autoGenerate = false, onCapture, onClose }: { mode: "video" | "audio"; autoGenerate?: boolean; onCapture: (file: File) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingOutput = useRef<ReturnType<typeof cameraRecordingStream>>(null);
  const session = useRef(0);
  const switchLock = useRef(false);
  const callback = useRef(onCapture);
  useEffect(() => { callback.current = onCapture; }, [onCapture]);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cameraNotice, setCameraNotice] = useState<string | null>(null);
  const [facing, setFacing] = useState<Facing>("environment");
  const [switching, setSwitching] = useState(false);
  const [opening, setOpening] = useState(true);
  const [liveFlip, setLiveFlip] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const activeSession = ++session.current;
    const active = () => activeSession === session.current;
    let openedStream: MediaStream | null = null;
    async function open() {
      setOpening(true);
      setReady(false);
      setError(null);
      setCameraNotice(null);
      try {
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Recording is unavailable in this browser. Use your phone camera and upload the recording instead.");
        const media = await requestCamera(mode === "video" ? { video: { ...cameraSize, facingMode: { ideal: "environment" } }, audio: true } : { audio: true }, active);
        if (!active()) { stopTracks(media); return; }
        openedStream = media;
        stream.current = media;
        if (video.current) { video.current.srcObject = media; await video.current.play(); }
        if (active()) {
          const selected = media.getVideoTracks()[0]?.getSettings().facingMode;
          setFacing(selected === "user" ? "user" : "environment");
          setLiveFlip(typeof document.createElement("canvas").captureStream === "function");
          setReady(true);
        }
      } catch (reason) {
        stopTracks(openedStream);
        if (active()) { stream.current = null; setError(mode === "video" ? cameraError(reason) : errorMessage(reason)); }
      } finally {
        if (active()) setOpening(false);
      }
    }
    void open();
    return () => {
      session.current += 1;
      if (recorder.current?.state === "recording") recorder.current.stop();
      recordingOutput.current?.stop();
      recordingOutput.current = null;
      stopTracks(stream.current);
      stream.current = null;
    };
  }, [mode, retry]);

  async function flipCamera() {
    if (mode !== "video" || !ready || switchLock.current || (recording && !liveFlip)) return;
    switchLock.current = true;
    setSwitching(true);
    setCameraNotice(null);
    const activeSession = session.current;
    const active = () => session.current === activeSession;
    const previous = stream.current!;
    const previousTrack = previous.getVideoTracks()[0];
    const previousSettings = previousTrack?.getSettings();
    const nextFacing: Facing = facing === "environment" ? "user" : "environment";
    let candidate: MediaStream | null = null;
    try {
      // Phones often cannot open both cameras at once. Keep the microphone and
      // the canvas recording track alive while releasing only the old camera.
      previous.getVideoTracks().forEach(track => track.stop());
      candidate = await requestCamera({ video: { ...cameraSize, facingMode: { exact: nextFacing } }, audio: false }, active);
      if (!active()) { stopTracks(candidate); return; }
      const selected = candidate.getVideoTracks()[0]?.getSettings();
      if ((selected?.facingMode && selected.facingMode !== nextFacing) || (!selected?.facingMode && selected?.deviceId && selected.deviceId === previousSettings?.deviceId)) throw new Error("No other camera available.");
      const combined = new MediaStream([...candidate.getVideoTracks(), ...previous.getAudioTracks()]);
      stream.current = combined;
      if (video.current) { video.current.srcObject = combined; await video.current.play(); }
      if (active()) setFacing(nextFacing);
    } catch {
      stopTracks(candidate);
      if (!active()) return;
      try {
        const restored = await requestCamera({ video: { ...cameraSize, ...(previousSettings?.deviceId ? { deviceId: { exact: previousSettings.deviceId } } : { facingMode: { ideal: facing } }) }, audio: false }, active);
        if (!active()) { stopTracks(restored); return; }
        const combined = new MediaStream([...restored.getVideoTracks(), ...previous.getAudioTracks()]);
        stream.current = combined;
        if (video.current) { video.current.srcObject = combined; await video.current.play(); }
        if (active()) setCameraNotice("We couldn’t switch cameras. Your previous camera is back; you can keep recording. Another camera may not be available on this device.");
      } catch {
        if (active()) {
          stream.current?.getVideoTracks().forEach(track => track.stop());
          if (recorder.current?.state !== "recording") stream.current?.getAudioTracks().forEach(track => track.stop());
          setReady(false);
          setError("The camera couldn’t reconnect. Finish to save your recording, or close the recorder and try again.");
        }
      }
    } finally {
      switchLock.current = false;
      if (active()) setSwitching(false);
    }
  }

  useEffect(() => {
    if (!recording) return;
    let elapsed = 0;
    const interval = window.setInterval(() => {
      elapsed += 1;
      setSeconds(Math.min(elapsed, 90));
      if (elapsed >= 90 && recorder.current?.state === "recording") recorder.current.stop();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [recording]);

  function start() {
    if (!ready || switching || !stream.current || recorder.current?.state === "recording") return;
    try {
      setError(null);
      const types = mode === "video" ? ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"] : ["audio/webm", "audio/mp4", "audio/ogg"];
      const mime = types.find(type => MediaRecorder.isTypeSupported(type));
      const output = mode === "video" && video.current ? cameraRecordingStream(video.current, stream.current) : null;
      recordingOutput.current = output;
      if (mode === "video") setLiveFlip(!!output);
      const current = new MediaRecorder(output?.stream ?? stream.current, { ...(mime ? { mimeType: mime } : {}), ...(mode === "video" ? { videoBitsPerSecond: 2_500_000 } : {}), audioBitsPerSecond: 96_000 });
      const chunks: Blob[] = [];
      const activeSession = session.current;
      let failed = false;
      current.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      current.onerror = () => {
        failed = true;
        if (activeSession !== session.current || recorder.current !== current) return;
        setError("The recording was interrupted. Close the recorder and try again, or upload a video.");
      };
      current.onstop = () => {
        output?.stop();
        if (activeSession !== session.current || recorder.current !== current) return;
        recordingOutput.current = null;
        recorder.current = null;
        setRecording(false);
        if (!failed && chunks.some(chunk => chunk.size > 0)) {
          const type = current.mimeType.split(";")[0];
          const extension = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
          callback.current(new File(chunks, `${mode === "video" ? "guided-scan" : "voice-context"}-${Date.now()}.${extension}`, { type }));
        } else if (!failed) setError("No recording was saved. Record for a moment, then try finishing again.");
        setSeconds(0);
      };
      recorder.current = current;
      current.start(1000);
      setRecording(true);
      setSeconds(0);
    } catch (reason) { recordingOutput.current?.stop(); recordingOutput.current = null; setError(errorMessage(reason)); }
  }

  function finish() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  return <div className="recorder">
    {mode === "video" && <p className="measurement-hint">{autoGenerate ? "Show your space and say what you want to do. Your animation starts when you finish recording." : "Show the things you want to use and say what you’d like to do while you record."}</p>}
    {mode === "video" ? <div className="recorder-preview"><video className={`recorder-video ${facing === "user" ? "is-front-camera" : ""}`} ref={video} muted playsInline aria-label="Camera preview" /><span className="recorder-camera-label">{facing === "user" ? "Front camera" : "Rear camera"}</span></div> : <div className="empty-state compact" style={{ margin: 0, minHeight: 120 }}><Icon name="mic" size={32} /><p>Tell us what you want to make happen.</p></div>}
    {error && <div className="notice notice-error notice-inline" role="alert">{error}</div>}
    {cameraNotice && <p className="recorder-camera-notice" role="status">{cameraNotice}</p>}
    {recording && mode === "video" && !liveFlip && <p className="recorder-camera-notice">You can flip the camera before recording in this browser.</p>}
    <div className="recorder-controls">
      <span className="recording-label" role="status">{recording ? <><span className="recording-dot" />{seconds}s / 90s{switching && " · Switching camera…"}</> : switching ? "Switching camera…" : ready ? "Ready when you are" : error ? "Recording unavailable" : mode === "video" ? "Opening your camera & microphone…" : "Opening your microphone…"}</span>
      <div className="button-row">
        {mode === "video" && <button className="button button-secondary button-small" onClick={() => void flipCamera()} disabled={!ready || switching || (recording && !liveFlip)} aria-label="Flip camera" title={`Switch to ${facing === "environment" ? "front" : "rear"} camera`}><Icon name="refresh" size={16} />Flip camera</button>}
        {recording ? <button className="button button-primary button-small" onClick={finish}><Icon name="stop" size={14} />Finish recording</button> : !ready && !opening ? <button className="button button-primary button-small" onClick={() => setRetry(value => value + 1)}>Try again</button> : <button className="button button-primary button-small" disabled={!ready || switching} onClick={start}><Icon name={mode === "video" ? "camera" : "mic"} size={15} />Record</button>}
        <button className="icon-button" aria-label="Close recorder" onClick={onClose}><Icon name="close" size={17} /></button>
      </div>
    </div>
  </div>;
}
