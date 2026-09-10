import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GenerationJobSchema, MeasurementSchema, SceneManifestSchema, TutorialSchema, slugify, type Tutorial, type SceneManifest, type TutorialPlan } from "@/lib/contracts";
import { currentUser, supabaseAdmin } from "@/lib/supabase/server";
import { localMode } from "./env";
import { dbError, fail } from "./errors";

const urlSchema = z.string().url().refine(value => ["https:", "http:"].includes(new URL(value).protocol), "Use an HTTP or HTTPS reference URL.");
export const createTutorialSchema = z.object({ goal: z.string().trim().max(3000).default(""), title: z.string().trim().max(150).optional(), constraints: z.array(z.string().max(1000)).max(30).default([]), referenceUrls: z.array(urlSchema).max(20).default([]) });
export const updateTutorialSchema = z.object({ goal: z.string().trim().max(3000).optional(), title: z.string().trim().min(1).max(150).optional(), description: z.string().max(2000).optional(), constraints: z.array(z.string().max(1000)).max(50).optional(), referenceUrls: z.array(urlSchema).max(20).optional(), measurements: z.array(MeasurementSchema).max(30).optional(), answers: z.record(z.string(), z.string().max(2000)).optional(), expectedRevision: z.number().int().positive().optional() }).strict();

export function newTutorial(ownerId: string, input: z.infer<typeof createTutorialSchema>): Tutorial {
  const now = new Date().toISOString(); const title = input.title || "Untitled tutorial";
  return TutorialSchema.parse({ id: randomUUID(), ownerId, title, slug: slugify(title), description: "", category: "home", visibility: "private", status: "draft", revision: 1, createdAt: now, updatedAt: now, goal: input.goal, constraints: input.constraints, referenceUrls: input.referenceUrls, assets: [], measurements: [], plan: null, scene: null, job: null, thumbnailUrl: null, isExample: false });
}
export async function ownedTutorial(id: string, ownerId: string): Promise<Tutorial> {
  const { data, error } = await supabaseAdmin().from("tutorials").select("data").eq("id", id).eq("owner_id", ownerId).maybeSingle(); dbError(error);
  if (!data) fail(404, "This tutorial is unavailable."); return TutorialSchema.parse(data.data);
}
export async function readableTutorial(id: string): Promise<{ tutorial: Tutorial; isOwner: boolean }> {
  const user = await currentUser();
  const { data, error } = await supabaseAdmin().from("tutorials").select("owner_id,data,public_data,visibility").eq("id", id).maybeSingle(); dbError(error);
  if (!data) fail(404, "This tutorial is unavailable.");
  const isOwner = user?.id === data.owner_id;
  if (!isOwner && (data.visibility !== "public" || !data.public_data)) fail(404, "This tutorial is unavailable.");
  return { tutorial: TutorialSchema.parse(isOwner ? data.data : data.public_data), isOwner };
}
export async function hydrateTutorial(tutorial: Tutorial, includeJob = true, previewOnly = false): Promise<Tutorial> {
  const client = supabaseAdmin();
  if (includeJob && tutorial.ownerId) {
    const { data, error } = await client.from("generation_jobs").select("id").eq("tutorial_id", tutorial.id).eq("revision", tutorial.revision).order("created_at", { ascending: false }).limit(1).maybeSingle(); dbError(error);
    if (data) { const result = await client.rpc("job_json", { p_id: data.id }); dbError(result.error); tutorial = { ...tutorial, job: GenerationJobSchema.parse(result.data) }; }
  }
  if (!tutorial.scene) return tutorial;
  const assets = await Promise.all(tutorial.scene.assets.map(async asset => {
    // A persisted arbitrary URL is never trusted. We issue single-asset URLs only
    // for paths from the visibility-filtered manifest in this tutorial directory.
    if (previewOnly && asset.kind!=="poster" && asset.kind!=="sanitized_poster") return { ...asset, url: undefined };
    if (!validArtifactPath(asset.path, tutorial.id)) return { ...asset, url: undefined };
    const { data, error } = await client.storage.from("tutorial-assets").createSignedUrl(asset.path, 300);
    if (error) return { ...asset, url: undefined };
    return { ...asset, url: data.signedUrl };
  }));
  return { ...tutorial, scene: { ...tutorial.scene, assets }, thumbnailUrl: assets.find(a => a.kind === "sanitized_poster" || a.kind === "poster")?.url || null };
}
export function validArtifactPath(path: string, tutorialId: string) {
  const parts = path.split("/"); return parts.length >= 4 && parts[1] === tutorialId && !parts.some(p => !p || p === "." || p === "..");
}
export function publicSourceUrl(value:string):string|null {
  try {
    const url=new URL(value);
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password)return null;
    const host=url.hostname.toLowerCase();
    if(host==="localhost"||host.endsWith(".local")||/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)||host.includes(":"))return null;
    if(/\/storage\/v1\/object\/|\/api\/tutorials\/|\/captures\//i.test(url.pathname))return null;
    for(const key of Array.from(url.searchParams.keys())) {
      if(/^(x-amz-|x-goog-|sig$|signature$|token$|auth$|authorization$|access_token$|api_key$|key$|credential$|expires$|policy$|sas$|se$|sp$|sv$)/i.test(key))return null;
      if(/^utm_|^(gclid|fbclid)$/i.test(key))url.searchParams.delete(key);
    }
    url.hash="";
    return url.href;
  } catch { return null; }
}
function publicPlan(plan:TutorialPlan):TutorialPlan {
  const sources=plan.sources.flatMap(source=>{const url=publicSourceUrl(source.url);return url?[{...source,url}]:[];});
  const ids=new Set(sources.map(source=>source.id));
  return {...plan,questions:[],constraints:[],objects:plan.objects.map(object=>({...object,notes:""})),sources,steps:plan.steps.map(step=>({...step,sourceIds:step.sourceIds.filter(id=>ids.has(id))}))};
}
export function publicSnapshot(tutorial: Tutorial, sceneInput: unknown): Tutorial {
  const scene = SceneManifestSchema.parse(sceneInput);
  const allowed = new Set(["sanitized_scene", "sanitized_poster", "sanitized_video", "sanitized_narration"]);
  const publicPath=(path:string)=>{const parts=path.split("/");return validArtifactPath(path,tutorial.id)&&parts[0]===tutorial.ownerId&&parts[2]===`r${tutorial.revision}`&&parts[3]==="public-preview"&&parts.length===6&&/^[a-f0-9-]{36}$/i.test(parts[4])&&/^[A-Za-z0-9_.-]+$/.test(parts[5]);};
  if (!scene.sanitized || !scene.quality.approved || !scene.assets.some(a => a.kind === "sanitized_scene") || scene.assets.some(a => !allowed.has(a.kind) || !publicPath(a.path))) fail(409, "A verified, cropped public export is required before publishing.", "sanitized_export_required");
  const cleanScene: SceneManifest = { ...scene, assets: scene.assets.map(asset => { const clean = { ...asset }; delete clean.url; return clean; }) };
  // The published plan is intentionally explicit. Capture questions, constraints,
  // room measurements, owner IDs, filenames and original footage never leave it.
  const plan = tutorial.plan ? publicPlan(tutorial.plan) : null;
  return { ...tutorial, ownerId: "", visibility: "public", assets: [], measurements: [], constraints: [], referenceUrls: [], job: null, scene: cleanScene, plan, ...(tutorial.adaptationPlan?{adaptationPlan:publicPlan(tutorial.adaptationPlan)}:{}),thumbnailUrl: null };
}
export async function wakeWorker(jobId: string) {
  if(localMode()) return; // A separate local process drains the durable queue every two seconds.
  try {
    await fetch(process.env.MODAL_WORKER_URL!, { method: "POST", headers: { Authorization: `Bearer ${process.env.MODAL_WORKER_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ jobId }), signal: AbortSignal.timeout(8000) });
  } catch { /* Durable pgmq message is also drained by the worker's schedule. */ }
}
