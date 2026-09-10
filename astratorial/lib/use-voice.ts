"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceContext = { stepId: string; cameraMode: "first" | "third" | "free"; action?: string; version?: number; status?: string };
export function useVoice(tutorialId: string, practiceSessionId?: string, onSpeaking?: () => void, context?: Pick<VoiceContext, "stepId" | "cameraMode">, onNavigation?: (context: VoiceContext) => void) {
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const peer = useRef<RTCPeerConnection | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const output = useRef<HTMLAudioElement | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const sessionId = useRef<string | null>(null);
  const connecting = useRef(false);
  const generation = useRef(0);
  const onSpeakingRef = useRef(onSpeaking);
  const navigationRef = useRef(onNavigation);
  const contextRef = useRef(context);
  const navigationVersion = useRef(0);
  const contextQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => { onSpeakingRef.current = onSpeaking; }, [onSpeaking]);
  useEffect(() => { navigationRef.current = onNavigation; }, [onNavigation]);
  useEffect(() => {
    contextRef.current = context;
    const id = sessionId.current;
    if (id && context) {
      const snapshot = context;
      contextQueue.current = contextQueue.current.catch(() => {}).then(async () => {
        if (sessionId.current !== id) return;
        const response = await fetch(`/api/realtime/session/${id}/context`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(snapshot), signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("Your latest step could not be shared with the voice tutor. Reconnect if the guide is out of sync.");
      }).catch((cause) => { if (sessionId.current === id) setError(cause instanceof Error ? cause.message : "Voice context could not update."); });
    }
  }, [context?.stepId, context?.cameraMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useCallback(() => {
    generation.current++; connecting.current = false;
    channel.current?.close(); channel.current = null;
    peer.current?.close(); peer.current = null;
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    if (output.current) { output.current.pause(); output.current.srcObject = null; output.current = null; }
    const id = sessionId.current; sessionId.current = null;
    if (id) void fetch(`/api/realtime/session/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
    setStatus("idle");
  }, []);

  const start = useCallback(async () => {
    if (connecting.current || peer.current) return;
    connecting.current = true; const token = ++generation.current;
    setStatus("connecting"); setError(""); setTranscript("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Voice needs a secure connection and a browser with microphone access.");
      const local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (token !== generation.current) { local.getTracks().forEach(track => track.stop()); return; }
      stream.current = local;
      const connection = new RTCPeerConnection(); peer.current = connection;
      const speaker = new Audio(); speaker.autoplay = true; output.current = speaker;
      connection.ontrack = event => { if (token !== generation.current) return; speaker.srcObject = event.streams[0]; void speaker.play().catch(() => { if (token === generation.current) setError("Your browser blocked the voice audio. End the conversation, then reconnect to try again."); }); };
      for (const track of local.getTracks()) connection.addTrack(track, local);
      const data = connection.createDataChannel("oai-events"); channel.current = data;
      data.onmessage = event => {
        if (token !== generation.current) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "input_audio_buffer.speech_started" || message.type === "response.output_audio.delta") onSpeakingRef.current?.();
          if (message.type === "response.output_audio_transcript.delta" || message.type === "response.audio_transcript.delta") setTranscript(value => (value + message.delta).slice(-1800));
          if (message.type === "response.created") setTranscript("");
          if (message.type === "error") setError(message.error?.message || "The voice connection encountered an error.");
        } catch { /* Non-JSON transport messages do not carry tutorial state. */ }
      };
      connection.onconnectionstatechange = () => {
        if (token !== generation.current || peer.current !== connection) return;
        if (connection.connectionState === "connected") setStatus("connected");
        if (["failed", "disconnected"].includes(connection.connectionState)) { stop(); setStatus("error"); setError("Voice disconnected. Reconnect when you’re ready."); }
      };
      const offer = await connection.createOffer(); await connection.setLocalDescription(offer);
      const response = await fetch("/api/realtime/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tutorialId, practiceSessionId, sdp: offer.sdp }) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : result.error?.message || result.message || "Voice could not connect.");
      if (token !== generation.current) { if (result.voiceSessionId) void fetch(`/api/realtime/session/${result.voiceSessionId}`, { method: "DELETE" }).catch(() => {}); return; }
      sessionId.current = result.voiceSessionId;
      navigationVersion.current = 0;
      if (contextRef.current) {
        const snapshot = contextRef.current;
        contextQueue.current = contextQueue.current.catch(() => {}).then(async () => {
          if (token !== generation.current) return;
          const synced = await fetch(`/api/realtime/session/${result.voiceSessionId}/context`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(snapshot), signal: AbortSignal.timeout(10_000) });
          if (!synced.ok) throw new Error("The voice tutor could not synchronize your current step. Please reconnect.");
        });
        await contextQueue.current;
      }
      if (token !== generation.current) return;
      await connection.setRemoteDescription({ type: "answer", sdp: result.sdp });
    } catch (cause) {
      if (token !== generation.current) return;
      stop(); setStatus("error");
      setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser settings to talk with your tutor." : cause instanceof Error ? cause.message : "Voice could not connect.");
    } finally { if (token === generation.current) connecting.current = false; }
  }, [tutorialId, practiceSessionId, stop]);

  const sendImage = useCallback((dataUrl: string) => {
    if (channel.current?.readyState !== "open") return;
    try { channel.current.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_image", image_url: dataUrl }] } })); } catch { /* The channel can close between the state check and send. */ }
  }, []);
  useEffect(() => {
    if (status !== "connected") return;
    let cancelled = false, inFlight = false;
    const timer = setInterval(async () => {
      const id = sessionId.current;
      if (!id || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/realtime/session/${id}/context`, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const result: VoiceContext = await response.json();
        if (cancelled) return;
        if (result.status && result.status !== "active") { stop(); setError("This voice session ended. Start another conversation when you’re ready."); return; }
        if ((result.version ?? 0) > navigationVersion.current) {
          navigationVersion.current = result.version ?? 0;
          navigationRef.current?.(result);
        }
      } catch { /* A transient polling error does not interrupt the audio connection. */ }
      finally { inFlight = false; }
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [status, stop]);
  useEffect(() => () => stop(), [stop]);
  useEffect(() => { const hide = () => { if (document.hidden) stop(); }; document.addEventListener("visibilitychange", hide); return () => document.removeEventListener("visibilitychange", hide); }, [stop]);
  return { status, error, transcript, start, stop, sendImage };
}
