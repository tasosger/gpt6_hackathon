"use client";
import Link from "next/link";
import { tutorialHref, type GenerationJob, type Tutorial } from "@/lib/contracts";
import { errorMessage } from "@/lib/client";
import { Icon } from "@/components/shell/icon";

type ProgressProps = {
  job: GenerationJob | null;
  tutorial: Tutorial | null;
  busy: boolean;
  onCancel: () => void;
  onResume: () => void;
  onContext?: () => void;
  worker?: { status: "ready" | "offline" | "unreachable"; message: string } | null;
};
const stages = [
  { id: "ingest", label: "Prepare your video", description: "Reading the video and listening to your spoken instructions." },
  { id: "analyze", label: "Understand your video", description: "Finding your goal and identifying the things around you." },
  { id: "plan", label: "Plan your steps", description: "Working out how to reach your goal with what you have." },
  { id: "animate", label: "Build your animation", description: "Creating your workspace, guide, and gestures." },
  { id: "render", label: "Add the walkthrough", description: "Recording narration and preparing your tutorial assets." },
  { id: "validate", label: "Check your tutorial", description: "Checking that the finished scene is ready to play." },
];

export function GenerationProgress({ job, tutorial, busy, onCancel, onResume, onContext, worker }: ProgressProps) {
  const ready = tutorial?.status === "ready" && !!tutorial.scene;
  const running = job?.status === "running";
  const queued = job?.status === "queued";
  const retryable = !!job && ["failed", "cancelled", "needs_context"].includes(job.status);
  const paused = job?.status === "budget_paused";
  const completed = job?.status === "completed";
  const stage = Math.max(0, stages.findIndex(item => item.id === (job?.stage === "reconstruct" ? "plan" : job?.stage)));
  const savedVideo = !!tutorial?.assets.some(asset => asset.kind === "video");
  const progress = Math.min(100, Math.max(0, Math.round(job?.progress ?? 0)));
  const title = ready ? "Ready to watch."
    : queued ? "Waiting to start."
    : paused ? "Generation is paused."
    : job?.status === "cancelled" ? "Generation stopped."
    : job?.status === "failed" ? "We couldn’t finish this tutorial."
    : job?.status === "needs_context" ? "We need a clearer view."
    : completed ? "Loading the finished tutorial…"
    : running ? stages[stage].label : "Starting your tutorial…";
  const message = ready ? "Your personal guide is ready. Watch the steps and try them yourself."
    : queued ? worker?.status === "offline" || worker?.status === "unreachable"
      ? "Your video is waiting for the local worker. Analysis starts automatically when it is available."
      : "Your video is in the queue. Analysis starts automatically when the local worker picks it up."
    : paused ? `We paused before spending beyond your $${(job?.budgetUsd ?? 25).toFixed(2)} generation allowance. Your completed work is saved.`
    : job?.status === "cancelled" ? "No more steps are being started. You can resume this tutorial when you’re ready."
    : job?.status === "failed" ? savedVideo ? "Your uploaded video is saved. Review what went wrong below, then retry to continue." : "Review what went wrong below. You can retry when the issue is resolved."
    : job?.status === "needs_context" ? "The video did not provide enough information to finish confidently. See the detail below before retrying."
    : completed ? "Processing is complete. Retrieving the playable scene…"
    : job?.message ? errorMessage(new Error(job.message)) : stages[stage].description;
  return <div>
    <div className="analysis-state" role="status" aria-live="polite" aria-atomic="true">
      <span className={`analysis-orb ${running ? "" : "is-still"}`}><Icon name={ready ? "check" : retryable || paused ? "info" : "sparkles"} size={31} /></span>
      <h2 className="subheading">{title}</h2>
      <p className="section-description">{message}</p>
    </div>
    {!ready && <>
      <div className="generation-progress">
        <div><span>{queued ? "Queued · waiting for processing" : running ? "In progress" : paused ? "Paused at the generation allowance" : retryable ? "Stopped at the last saved step" : "Finishing up"}</span><span>{progress}%</span></div>
        <div className="progress-track" role="progressbar" aria-label="Animation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
      </div>
      <div className="generation-stages" aria-label="Tutorial stages">
        {stages.map((item, index) => {
          const done = completed || (!queued && index < stage);
          const active = !completed && index === stage;
          return <div className={`job-stage ${done ? "complete" : active && running ? "active" : ""}`} key={item.id} aria-current={active && running ? "step" : undefined}>
            <span>{done ? <Icon name="check" size={13} /> : active && running ? <span className="spinner" style={{ width: 12, height: 12 }} /> : index + 1}</span>
            <span>{item.label}</span>
            <span>{done ? "Done" : active && running ? "In progress" : active && queued ? "Waiting" : active && retryable ? "Stopped" : ""}</span>
          </div>;
        })}
      </div>
    </>}
    {job?.error && <div className="notice notice-error notice-inline" role="alert"><Icon name="info" size={16} /><span>{errorMessage(new Error(job.error))}</span></div>}
    <p className="generation-message">{savedVideo ? "Your uploaded video and completed work are saved in My tutorials. Your original video stays private." : "Your original video stays private."}</p>
    <div className="button-row">
      {ready && tutorial ? <Link href={tutorialHref(tutorial)} className="button button-primary">Watch my tutorial<Icon name="arrow" size={17} /></Link>
        : (running || queued) && job ? <button className="button button-secondary" disabled={busy} onClick={onCancel}>{busy ? <><span className="spinner" />Stopping…</> : "Stop generation"}</button>
        : job?.status === "needs_context" && onContext ? <button className="button button-secondary" disabled={busy} onClick={onContext}>Add a little context</button>
        : retryable ? <button className="button button-secondary" disabled={busy} onClick={onResume}>{busy ? <><span className="spinner" />Restarting…</> : <><Icon name="refresh" size={16} />Try again</>}</button>
        : null}
      <Link href="/library" className="button button-quiet">Back to my tutorials</Link>
    </div>
  </div>;
}
