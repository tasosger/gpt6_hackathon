"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  exampleWalkthrough,
  validateWalkthrough,
  type Walkthrough,
} from "@/lib/scene";
import { MAX_PHOTOS, preparePhoto, type Photo } from "@/lib/uploads";

const SceneViewer = dynamic(() => import("./components/scene-viewer"), {
  ssr: false,
  loading: () => <div className="viewer-loading">Opening the 3D canvas…</div>,
});

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [context, setContext] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [tutorial, setTutorial] = useState<Walkthrough>(exampleWalkthrough);
  const [stepIndex, setStepIndex] = useState(0);
  const [isExample, setIsExample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const request = useRef<AbortController | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const step = tutorial.steps[stepIndex];
  useEffect(() => {
    setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    fetch("/api/scenes")
      .then((response) => response.json())
      .then((data) => setConfigured(data.configured))
      .catch(() => setConfigured(null));
    return () => request.current?.abort();
  }, []);
  async function addPhotos(files: FileList | null) {
    if (!files || busy || uploading) return;
    setError("");
    if (photos.length + files.length > MAX_PHOTOS) {
      setError("You can add up to 4 photos. Remove one before adding more.");
      return;
    }
    setUploading(true);
    try {
      const added: Photo[] = [];
      for (const file of Array.from(files))
        added.push(await preparePhoto(file));
      setPhotos((current) => [...current, ...added]);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "This photo could not be opened. Try JPG or PNG.",
      );
    } finally {
      setUploading(false);
      if (photoInput.current) photoInput.current.value = "";
    }
  }
  async function generate() {
    if (prompt.trim().length < 3 || !photos.length || busy || uploading) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          context,
          images: photos.map((photo) => photo.dataUrl),
        }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "Walkthrough generation failed. Please try again.",
        );
      setTutorial(validateWalkthrough(data.walkthrough));
      setStepIndex(0);
      setIsExample(false);
      setPlaying(
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : "Could not generate the walkthrough.",
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  function goToStep(index: number) {
    setStepIndex(index);
    setResetKey((key) => key + 1);
  }
  return (
    <main className="studio">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Astratorial home">
          <span className="brand-mark">a</span> astratorial
        </a>
        <span className="studio-label">VISUAL WALKTHROUGHS</span>
        <span className="prototype-label">Experimental</span>
      </header>
      <div className="workspace">
        <aside className="prompt-panel">
          <div>
            <p className="eyebrow">SHOW IT. SOLVE IT.</p>
            <h1>
              A little help,
              <br />
              in every dimension.
            </h1>
            <p className="intro">
              Add photos and explain what’s wrong. Astra shows you what to do,
              step by step.
            </p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void generate();
            }}
          >
            <div className="field-heading">
              <label htmlFor="photos">Your photos</label>
              <span>{photos.length} / 4</span>
            </div>
            <input
              ref={photoInput}
              className="sr-only"
              id="photos"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={busy || uploading}
              onChange={(event) => void addPhotos(event.target.files)}
            />
            <button
              className="upload-button"
              type="button"
              disabled={busy || uploading || photos.length === 4}
              onClick={() => photoInput.current?.click()}
            >
              <span aria-hidden="true">＋</span>
              {uploading ? "Preparing photos…" : "Add photos"}
              <small>JPG, PNG or WebP · up to 8 MB each</small>
            </button>
            {photos.length > 0 && (
              <div className="photo-grid">
                {photos.map((photo, index) => (
                  <div className="photo-card" key={photo.id}>
                    {/* Local, resized user data URLs do not need Next image optimization. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.dataUrl}
                      alt={`Reference photo ${index + 1}: ${photo.name}`}
                    />
                    <button
                      type="button"
                      disabled={busy || uploading}
                      aria-label={`Remove ${photo.name}`}
                      onClick={() =>
                        setPhotos((current) =>
                          current.filter((item) => item.id !== photo.id),
                        )
                      }
                    >
                      ×
                    </button>
                    <span>Photo {index + 1}</span>
                  </div>
                ))}
              </div>
            )}
            <label className="issue-label" htmlFor="prompt">
              What do you need help with?
            </label>
            <div className="prompt-box">
              <textarea
                id="prompt"
                value={prompt}
                disabled={busy}
                onChange={(event) => setPrompt(event.target.value)}
                maxLength={2000}
                placeholder="These are the parts of my monitor stand. I’m not sure how they fit together. Show me the setup sequence."
                rows={5}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    void generate();
                  }
                }}
              />
              <span className="character-count">{prompt.length} / 2,000</span>
            </div>
            <details className="scene-context">
              <summary>Add context (optional)</summary>
              <label htmlFor="task-context">
                Tools, constraints, and what you have tried
              </label>
              <div className="prompt-box">
                <textarea
                  id="task-context"
                  value={context}
                  disabled={busy}
                  maxLength={2000}
                  rows={3}
                  onChange={(event) => setContext(event.target.value)}
                  placeholder="I have a Phillips screwdriver. The base is already attached. I’m new to this."
                />
              </div>
            </details>
            <button
              className="generate-button"
              type="submit"
              disabled={
                busy || uploading || prompt.trim().length < 3 || !photos.length
              }
            >
              {busy ? "Creating your walkthrough…" : "Show me the steps"}
              <span aria-hidden="true">✦</span>
            </button>
            {busy && (
              <button
                className="cancel-button"
                type="button"
                onClick={() => {
                  request.current?.abort();
                  request.current = null;
                  setBusy(false);
                }}
              >
                Cancel generation
              </button>
            )}
            <p className="privacy-note">
              Photos are sent to OpenAI when you generate. This prototype
              doesn’t save your photos or walkthrough.
            </p>
          </form>
          <div aria-live="polite">
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            {configured === false && (
              <p className="setup-note">
                Astra isn’t connected yet. Add <code>OPENAI_API_KEY</code> to{" "}
                <code>.env.local</code> and restart the app. Explore the local
                example meanwhile.
              </p>
            )}
          </div>
          <p className="panel-footnote">
            Use clear views of the whole setup and close-ups of the problem.
          </p>
        </aside>
        <section
          className="walkthrough-panel"
          aria-label="Step-by-step walkthrough"
        >
          <div className="walkthrough-heading">
            <span className="scene-badge">
              {isExample ? "LOCAL EXAMPLE" : "YOUR WALKTHROUGH"}
            </span>
            <h2>{tutorial.title}</h2>
            <p>{tutorial.summary}</p>
          </div>
          <nav className="step-tabs" aria-label="Walkthrough steps">
            {tutorial.steps.map((item, index) => (
              <button
                key={index}
                aria-current={index === stepIndex ? "step" : undefined}
                onClick={() => goToStep(index)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                {item.scene.title}
              </button>
            ))}
          </nav>
          <div className="viewer-panel sequence-viewer">
            <div className="viewer-topline">
              <span>
                STEP {stepIndex + 1} OF {tutorial.steps.length}
              </span>
              <span>Illustrative 3D scene</span>
            </div>
            <SceneViewer
              scene={step.scene}
              playing={playing}
              resetKey={resetKey}
            />
            {busy && (
              <div className="generation-status" role="status">
                <span className="spinner" />
                Astra is examining your photos and building the sequence. This
                can take a minute or two.
              </div>
            )}
            <div className="sequence-controls">
              <button
                aria-pressed={!playing}
                onClick={() => setPlaying(!playing)}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <button
                onClick={() => {
                  setResetKey((key) => key + 1);
                  setPlaying(true);
                }}
              >
                Replay step
              </button>
              <button onClick={() => setResetKey((key) => key + 1)}>
                Reset view
              </button>
            </div>
            <div className="viewer-hint">
              Drag to orbit <span>·</span> Scroll or pinch to zoom
            </div>
          </div>
          <div className="step-instruction" aria-live="polite">
            <div className="instruction-number">
              {String(stepIndex + 1).padStart(2, "0")}
            </div>
            <div>
              <h3>{step.scene.title}</h3>
              <p>{step.instruction}</p>
              <p className="step-check">
                <strong>Check before continuing</strong>
                {step.check}
              </p>
            </div>
          </div>
          <div className="step-navigation">
            <button
              disabled={stepIndex === 0}
              onClick={() => goToStep(stepIndex - 1)}
            >
              ← Previous
            </button>
            <span>
              {stepIndex === tutorial.steps.length - 1
                ? "Final step · confirm the result yourself"
                : "Continue at your own pace"}
            </span>
            <button
              disabled={stepIndex === tutorial.steps.length - 1}
              onClick={() => goToStep(stepIndex + 1)}
            >
              Next step →
            </button>
          </div>
          {(tutorial.observations.length > 0 ||
            tutorial.assumptions.length > 0) && (
            <details className="scene-context">
              <summary>What Astra noticed and assumed</summary>
              {tutorial.observations.length > 0 && (
                <>
                  <h3>From your photos</h3>
                  <ul>
                    {tutorial.observations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {tutorial.assumptions.length > 0 && (
                <>
                  <h3>Needs your confirmation</h3>
                  <ul>
                    {tutorial.assumptions.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          )}
        </section>
      </div>
    </main>
  );
}
