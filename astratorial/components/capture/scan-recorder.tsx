"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/shell/icon";
import { errorMessage } from "@/lib/client";
export function ScanRecorder({ mode, onCapture, onClose }: { mode: "video" | "audio"; onCapture: (file: File) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const alive = useRef(true);
  const callback = useRef(onCapture);
  useEffect(() => { callback.current = onCapture; }, [onCapture]);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    async function open() {
      try {
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Recording is unavailable in this browser. Use your phone camera and upload the recording instead.");
        const media = await navigator.mediaDevices.getUserMedia(mode === "video" ? { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true } : { audio: true });
        if (!alive.current) { media.getTracks().forEach((track) => track.stop()); return; }
        stream.current = media;
        if (video.current) { video.current.srcObject = media; await video.current.play(); }
        setReady(true);
      } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    }
    void open();
    return () => { alive.current = false; if (recorder.current?.state === "recording") recorder.current.stop(); stream.current?.getTracks().forEach((track) => track.stop()); };
  }, [mode]);
  useEffect(() => {
    if (!recording) return;
    const interval = window.setInterval(() => setSeconds((value) => { if (value >= 89) { recorder.current?.stop(); return 90; } return value + 1; }), 1000);
    return () => window.clearInterval(interval);
  }, [recording]);
  function start() {
    if (!stream.current) return;
    try {
      const types = mode === "video" ? ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"] : ["audio/webm", "audio/mp4", "audio/ogg"];
      const mime = types.find((type) => MediaRecorder.isTypeSupported(type));
      const current = new MediaRecorder(stream.current, { ...(mime ? { mimeType: mime } : {}), ...(mode === "video" ? { videoBitsPerSecond: 2_500_000 } : {}), audioBitsPerSecond: 96_000 });
      const chunks: Blob[] = [];
      current.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      current.onstop = () => {
        if (!alive.current) return;
        setRecording(false);
        const type = current.mimeType.split(";")[0];
        const extension = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
        callback.current(new File(chunks, `${mode === "video" ? "guided-scan" : "voice-context"}-${Date.now()}.${extension}`, { type }));
        setSeconds(0);
      };
      recorder.current = current;
      current.start(1000);
      setRecording(true);
      setSeconds(0);
    } catch (reason) { setError(errorMessage(reason)); }
  }
  return <div className="recorder">{mode === "video" && <p className="measurement-hint">Show the things you want to use. You can say what you’d like to do while you record.</p>}{mode === "video" ? <video className="recorder-video" ref={video} muted playsInline aria-label="Camera preview" /> : <div className="empty-state compact" style={{ margin: 0, minHeight: 120 }}><Icon name="mic" size={32} /><p>Tell us what you want to make happen.</p></div>}{error && <div className="notice notice-error notice-inline" role="alert">{error}</div>}<div className="recorder-controls"><span className="recording-label">{recording ? <><span className="recording-dot" />{seconds}s / 90s</> : ready ? "Ready when you are" : error ? "Recording unavailable" : mode === "video" ? "Opening your camera & microphone…" : "Opening your microphone…"}</span><div className="button-row">{recording ? <button className="button button-primary button-small" onClick={() => recorder.current?.stop()}><Icon name="stop" size={14} />Finish recording</button> : <button className="button button-primary button-small" disabled={!ready || !!error} onClick={start}><Icon name={mode === "video" ? "camera" : "mic"} size={15} />Record</button>}<button className="icon-button" aria-label="Close recorder" onClick={onClose}><Icon name="close" size={17} /></button></div></div></div>;
}
