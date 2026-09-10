/** Keep the recorded track set fixed while the physical camera changes.
 * MediaRecorder stops with InvalidModificationError if its tracks are replaced:
 * https://w3c.github.io/mediacapture-record/#dom-mediarecorder-start
 */
export function cameraRecordingStream(preview: HTMLVideoElement, source: MediaStream) {
  const canvas = document.createElement("canvas");
  if (typeof canvas.captureStream !== "function") return null;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  const width = preview.videoWidth || 1280;
  const height = preview.videoHeight || 720;
  const scale = Math.min(1, 1280 / Math.max(width, height));
  canvas.width = Math.max(2, Math.round(width * scale / 2) * 2);
  canvas.height = Math.max(2, Math.round(height * scale / 2) * 2);
  context.fillStyle = "#18252b";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const draw = () => {
    if (preview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !preview.videoWidth || !preview.videoHeight) return;
    const ratio = Math.min(canvas.width / preview.videoWidth, canvas.height / preview.videoHeight);
    const w = preview.videoWidth * ratio, h = preview.videoHeight * ratio;
    context.fillStyle = "#18252b";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(preview, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  };
  draw();
  const camera = canvas.captureStream(24);
  const combined = new MediaStream([...camera.getVideoTracks(), ...source.getAudioTracks()]);
  // Retain the last frame while the next camera opens; microphone audio continues.
  const timer = window.setInterval(draw, 1000 / 24);
  return { stream: combined, stop: () => { window.clearInterval(timer); camera.getTracks().forEach(track => track.stop()); } };
}
