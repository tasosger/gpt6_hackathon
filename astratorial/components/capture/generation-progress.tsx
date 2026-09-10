"use client";
import Link from "next/link";
import { tutorialHref, type GenerationJob, type Tutorial } from "@/lib/contracts";
import { Icon } from "@/components/shell/icon";
import { useAppConfig } from "@/lib/client";
const allStages = [{ id: "ingest", label: "Prepare your captures" }, { id: "analyze", label: "Get to know your space" }, { id: "reconstruct", label: "Rebuild the details" }, { id: "plan", label: "Put the steps in order" }, { id: "animate", label: "Bring your guide to life" }, { id: "render", label: "Make your walkthrough" }, { id: "validate", label: "Check everything comes together" }];
type ProgressProps = { job: GenerationJob | null; tutorial: Tutorial | null; busy: boolean; onCancel: () => void; onResume: () => void; onContext?: () => void };

export function GenerationProgress(props: ProgressProps) {
  const { config } = useAppConfig();
  return config?.generationMode === "measured" ? <MeasuredGenerationProgress {...props} /> : <AnimationProgress {...props} />;
}

function MeasuredGenerationProgress({ job, tutorial, busy, onCancel, onResume, onContext }: ProgressProps) {
  const { config } = useAppConfig();
  const stages = config?.generationMode === "illustrated" ? allStages.filter(stage => stage.id !== "reconstruct") : allStages;
  const active = job ? stages.findIndex((stage) => stage.id === job.stage) : -1;
  return <div><h2 className="subheading">{job?.status === "completed" ? "Your tutorial is ready." : job ? "Creating your tutorial." : "Ready to bring it to life?"}</h2><p className="section-description">{job ? job.message : "Your captures become a personal 3D walkthrough, with clear steps and a guide you can talk to."}</p><div className="generation-summary"><div><small>Generation allowance</small><strong>${(job?.budgetUsd ?? 25).toFixed(2)}</strong></div><div><small>Used so far</small><strong>${(job?.spentUsd ?? 0).toFixed(2)}</strong></div><div><small>Visibility</small><strong>Only you</strong></div></div>{job && <><div className="generation-progress"><div><span>{job.status === "running" ? "Making steady progress" : job.status.replace("_", " ")}</span><span>{Math.round(job.progress)}%</span></div><div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div></div>{stages.map((stage, index) => <div className={`job-stage ${index < active || job.status === "completed" ? "complete" : index === active ? "active" : ""}`} key={stage.id}><span>{index < active || job.status === "completed" ? <Icon name="check" size={13} /> : index === active && job.status === "running" ? <span className="spinner" style={{ width: 12, height: 12 }} /> : index + 1}</span><span>{stage.label}</span>{index === active && job.status === "running" && <span>In progress</span>}</div>)}{job.error && <div className="notice notice-error notice-inline" role="alert">{job.error}</div>}<p className="generation-message">{job.status === "budget_paused" ? "We’ve paused before committing more resources. Your current results are saved. No additional allowance is authorized." : job.status === "needs_context" ? "Your guide needs a little more information. Add the requested context, then analyze your captures again." : job.status === "cancelled" ? "Generation has been stopped. Your captures and completed work are saved." : job.status === "running" || job.status === "queued" ? "Your progress is saved. You can find this tutorial in My tutorials." : "Your original captures remain private."}</p><div className="button-row">{job.status === "completed" && tutorial?.status === "ready" ? <Link href={tutorialHref(tutorial)} className="button button-primary">Watch my tutorial<Icon name="arrow" size={17} /></Link> : job.status === "needs_context" ? <button className="button button-primary" onClick={onContext}>Add a little context<Icon name="arrow" size={16} /></button> : job.status === "running" || job.status === "queued" ? <button className="button button-secondary" disabled={busy} onClick={onCancel}>Stop generation</button> : job.status === "failed" || job.status === "cancelled" ? <button className="button button-secondary" disabled={busy} onClick={onResume}><Icon name="refresh" size={16} />Retry within existing allowance</button> : null}<Link href="/library" className="button button-quiet">Back to my tutorials</Link></div></>}</div>;
}


const animationStages = [
  { label: "Understand your video", description: "Finding your goal and the things around you." },
  { label: "Plan with what you have", description: "Turning your goal into clear, practical steps." },
  { label: "Build your animation", description: "Bringing the steps to life in your space." },
];

function AnimationProgress({ job, tutorial, busy, onCancel, onResume }: ProgressProps) {
  const ready = tutorial?.status === "ready";
  const running = !job || job.status === "running" || job.status === "queued";
  const retryable = !!job && ["failed", "cancelled", "needs_context"].includes(job.status);
  const paused = job?.status === "budget_paused";
  const stage = !job || ["upload", "ingest", "analyze"].includes(job.stage) ? 0 : job.stage === "plan" || job.stage === "reconstruct" ? 1 : 2;
  const title = ready ? "Ready to watch." : paused ? "Your animation is paused." : job?.status === "cancelled" ? "Your animation is stopped." : retryable ? "Let’s try that again." : animationStages[stage].label;
  const message = ready ? "Your personal guide is ready. Watch the steps and try them yourself." : retryable ? "Your video and completed work are saved. You can retry with the same video." : paused ? `Your progress is saved. Generation has reached its $${(job?.budgetUsd ?? 25).toFixed(2)} allowance.` : job?.status === "completed" ? "Opening your finished animation…" : job?.message || animationStages[stage].description;
  return <div>
    <div className="analysis-state">
      <span className="analysis-orb"><Icon name={ready ? "check" : "sparkles"} size={31} /></span>
      <h2 className="subheading">{title}</h2>
      <p className="section-description" aria-live="polite">{message}</p>
    </div>
    {!ready && <>
      <div className="generation-progress">
        <div><span>{running ? "Creating your animation" : paused ? "Paused" : retryable ? "Progress saved" : "Finishing up"}</span><span>{Math.round(job?.progress ?? 0)}%</span></div>
        <div className="progress-track" role="progressbar" aria-label="Animation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job?.progress ?? 0)}><span style={{ width: `${job?.progress ?? 0}%` }} /></div>
      </div>
      {animationStages.map((item, index) => <div className={`job-stage ${index < stage ? "complete" : index === stage ? "active" : ""}`} key={item.label}>
        <span>{index < stage ? <Icon name="check" size={13} /> : index === stage && running ? <span className="spinner" style={{ width: 12, height: 12 }} /> : index + 1}</span>
        <span>{item.label}</span>
        {index === stage && running && <span>In progress</span>}
      </div>)}
    </>}
    {job?.error && <div className="notice notice-error notice-inline" role="alert">{job.error}</div>}
    <p className="generation-message">{running ? "Your progress is saved. You can return to it from My tutorials." : "Your original video stays private."}</p>
    <div className="button-row">
      {ready && tutorial ? <Link href={tutorialHref(tutorial)} className="button button-primary">Watch my tutorial<Icon name="arrow" size={17} /></Link>
        : running && job ? <button className="button button-secondary" disabled={busy} onClick={onCancel}>Stop generation</button>
        : retryable ? <button className="button button-secondary" disabled={busy} onClick={onResume}><Icon name="refresh" size={16} />Try again</button>
        : null}
      <Link href="/library" className="button button-quiet">Back to my tutorials</Link>
    </div>
  </div>;
}
