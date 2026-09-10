"use client";

import Link from "next/link";
import { tutorialHref, type GenerationJob, type Tutorial } from "@/lib/contracts";
import { Icon } from "@/components/shell/icon";

const stages = [
  { id: "ingest", label: "Prepare your captures" },
  { id: "analyze", label: "Understand your workspace" },
  { id: "reconstruct", label: "Build your 3D workspace" },
  { id: "plan", label: "Organize the instructions" },
  { id: "animate", label: "Add step-by-step demonstrations" },
  { id: "render", label: "Create your walkthrough" },
  { id: "validate", label: "Check your guide" },
];

const statusLabels = {
  queued: "Waiting to start",
  running: "Building your guide",
  needs_context: "More information needed",
  budget_paused: "Paused at the spending limit",
  completed: "Your guide is ready",
  cancelled: "Generation stopped",
  failed: "Generation could not finish",
};

export function GenerationProgress({ job, tutorial, busy, onCancel, onResume, onContext }: { job: GenerationJob | null; tutorial: Tutorial | null; busy: boolean; onCancel: () => void; onResume: () => void; onContext: () => void }) {
  const active = job ? stages.findIndex((stage) => stage.id === job.stage) : -1;
  return <div>
    <h2 className="subheading">{job ? statusLabels[job.status] : "Build your personal guide"}</h2>
    <p className="section-description" role="status">{job ? job.message : "Turn your captures and instructions into a 3D walkthrough of your workspace."}</p>
    <div className="generation-summary">
      <div><small>Spending limit</small><strong>${(job?.budgetUsd ?? 25).toFixed(2)}</strong></div>
      <div><small>Used so far</small><strong>${(job?.spentUsd ?? 0).toFixed(2)}</strong></div>
      <div><small>Visibility</small><strong>Only you</strong></div>
    </div>
    {job && <>
      <div className="generation-progress">
        <div><span>{job.status === "running" ? stages[active]?.label ?? statusLabels.running : statusLabels[job.status]}</span><span>{Math.round(job.progress)}%</span></div>
        <div className="progress-track" role="progressbar" aria-label="Guide generation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress)}><span style={{ width: `${job.progress}%` }} /></div>
      </div>
      {job.error && <div className="notice notice-error notice-inline" role="alert">{job.error}</div>}
      <p className="generation-message">{job.status === "budget_paused" ? "Your current results are saved. Generation is paused and no additional spending is authorized." : job.status === "needs_context" ? "Review the request above, add the missing information, then analyze your captures again." : job.status === "cancelled" ? "Your captures and completed work are saved. You can retry within your existing spending limit." : job.status === "running" || job.status === "queued" ? "You can leave this page. Generation continues in the background; return to your library to check progress." : job.status === "failed" ? "Review the error above. You can retry within your existing spending limit." : "Open your guide to follow the instructions at your own pace."}</p>
      <div className="button-row">
        {job.status === "completed" && tutorial?.status === "ready" ? <Link href={tutorialHref(tutorial)} className="button button-primary">Open my guide<Icon name="arrow" size={17} /></Link> : job.status === "needs_context" ? <button className="button button-primary" disabled={busy} onClick={onContext}>Add missing information<Icon name="arrow" size={16} /></button> : job.status === "running" || job.status === "queued" ? <button className="button button-secondary" disabled={busy} onClick={onCancel}>Stop generation</button> : job.status === "failed" || job.status === "cancelled" ? <button className="button button-secondary" disabled={busy} onClick={onResume}><Icon name="refresh" size={16} />Retry within spending limit</button> : null}
        <Link href="/library" className="button button-quiet">Go to my library</Link>
      </div>
      <details className="generation-details">
        <summary>View generation details</summary>
        {stages.map((stage, index) => <div className={`job-stage ${index < active || job.status === "completed" ? "complete" : index === active ? "active" : ""}`} key={stage.id}>
          <span>{index < active || job.status === "completed" ? <Icon name="check" size={13} /> : index === active && job.status === "running" ? <span className="spinner" style={{ width: 12, height: 12 }} /> : index + 1}</span>
          <span>{stage.label}</span>
          {index === active && job.status === "running" && <span>In progress</span>}
        </div>)}
      </details>
    </>}
  </div>;
}
