import type { GenerationJob } from "../contracts";

/** Only these application-authored messages may reach a job or worker log. */
export class LocalFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LocalFailure"; }
}

const stageNames: Record<GenerationJob["stage"], string> = {
  upload: "Uploading your video", ingest: "Reading your video", analyze: "Understanding your video",
  reconstruct: "Building your workspace", plan: "Planning your steps", animate: "Building the 3D animation",
  render: "Creating the narration or video", validate: "Creating the 3D preview", publish: "Preparing your public tutorial",
  ready: "Finishing your tutorial",
};

export function localFailureMessage(error: unknown, stage: GenerationJob["stage"]): { code: string; message: string } {
  if (error instanceof LocalFailure) return { code: error.code, message: error.message };
  return {
    code: `${stage}_failed`,
    message: `${stageNames[stage]} stopped unexpectedly. Your upload and completed work are saved. Retry to continue from the last saved stage.`,
  };
}

/** Provider bodies, command lines, paths, URLs and stack traces are never copied. */
export function providerFailure(status: number | undefined, code: unknown): LocalFailure {
  if (status === 401) return new LocalFailure("openai_key_rejected", "The server's OpenAI key was rejected. Update OPENAI_API_KEY in .env.local, restart the worker, then retry. Your video is saved.");
  if (status === 403 || status === 404 || code === "model_not_found") return new LocalFailure("openai_model_unavailable", "This OpenAI account cannot use the configured model. Check the model settings and account access, restart the worker, then retry. Your completed work is saved.");
  if (status === 429 && (code === "insufficient_quota" || code === "billing_hard_limit_reached")) return new LocalFailure("openai_credit_required", "The OpenAI account has no available API credit. Add credit or increase its spending limit, then retry. Your video and completed steps are saved.");
  if (status === 429) return new LocalFailure("openai_rate_limited", "OpenAI is temporarily limiting requests. Wait a minute, then retry. Your video and completed work are saved.");
  if (status === undefined || status === 408 || status >= 500) return new LocalFailure("openai_unavailable", "The connection to OpenAI timed out or the service is unavailable. Check this computer's internet connection, then retry. Your completed work is saved.");
  return new LocalFailure("openai_request_failed", "OpenAI could not process this stage. Check the configured models, then retry from your saved video and completed steps.");
}

export function rendererFailure(error: unknown): LocalFailure {
  if (error instanceof LocalFailure) return error;
  const detail = error instanceof Error ? error.message : "";
  if (/executable doesn.t exist|browser.*not found|failed to launch.*executable/i.test(detail)) return new LocalFailure("renderer_browser_missing", "The 3D preview browser could not be found on this computer. Run npx playwright install chromium in the astratorial folder, or correct its custom browser path, then retry. Your animation and narration are saved.");
  if (/webgl|gpu process|context lost|context could not be created/i.test(detail)) return new LocalFailure("renderer_webgl_failed", "The preview browser could not start its 3D renderer. Close other graphics-heavy apps and retry. Your animation and narration are saved.");
  if (/timeout|timed out/i.test(detail)) return new LocalFailure("renderer_timed_out", "Creating the 3D preview took too long on this computer. Close other busy apps and retry. Your animation and narration are saved.");
  if (/could not resolve|cannot find module|cannot find package/i.test(detail)) return new LocalFailure("renderer_dependency_missing", "A local 3D rendering dependency is missing. Run npm install in the astratorial folder, restart the worker, then retry. Your animation is saved.");
  return new LocalFailure("renderer_failed", "The 3D preview could not be rendered. Your video, steps, animation, and narration are saved. Retry to create the preview again.");
}
