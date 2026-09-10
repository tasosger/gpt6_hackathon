import { z } from "zod";

export const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export type Vec3 = z.infer<typeof Vec3Schema>;
export const CategorySchema = z.enum(["coffee", "cooking", "assembly", "home"]);
export const CaptureAssetSchema = z.object({
  id: z.string(), path: z.string(), name: z.string(), mimeType: z.string(), size: z.number().nonnegative(),
  kind: z.enum(["video", "image", "audio", "manual"]),
  pass: z.enum(["room", "work_area", "object", "empty_surface", "open_closed", "reference"]).default("room"),
});
export type CaptureAsset = z.infer<typeof CaptureAssetSchema>;
export const MeasurementSchema = z.object({
  id: z.string(), label: z.string().min(1), distanceMeters: z.number().positive().max(100),
  purpose: z.enum(["scale", "validation"]),
  observations: z.array(z.object({
    assetId: z.string(), timestamp: z.number().nonnegative(),
    start: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    end: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
  })).default([]),
});
export type Measurement = z.infer<typeof MeasurementSchema>;
export const SourceSchema = z.object({ id: z.string(), title: z.string(), url: z.string(), note: z.string() });
export const QuestionSchema = z.object({ id: z.string(), question: z.string(), reason: z.string(), required: z.boolean() });
export const TutorialStepSchema = z.object({
  id: z.string(), title: z.string(), instruction: z.string(), narration: z.string(),
  durationSeconds: z.number().positive().max(300), objectIds: z.array(z.string()),
  observable: z.boolean(), completionCriteria: z.string(), sourceIds: z.array(z.string()),
  action: z.enum(["reach", "point", "grasp", "move", "rotate", "press", "release", "pour", "insert", "open", "close", "wait"]),
});
export type TutorialStep = z.infer<typeof TutorialStepSchema>;
export const TutorialPlanSchema = z.object({
  version: z.literal(1), title: z.string(), goal: z.string(), description: z.string(), category: CategorySchema,
  difficulty: z.enum(["Beginner", "Intermediate", "Advanced"]), estimatedMinutes: z.number().positive(),
  objects: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), observed: z.boolean(), notes: z.string() })),
  steps: z.array(TutorialStepSchema).min(1).max(30), sources: z.array(SourceSchema),
  questions: z.array(QuestionSchema), constraints: z.array(z.string()),
});
export type TutorialPlan = z.infer<typeof TutorialPlanSchema>;
export const SceneAssetSchema = z.object({
  path: z.string(), kind: z.enum(["scene", "detail", "poster", "video", "narration", "sanitized_scene", "sanitized_poster", "sanitized_video", "sanitized_narration"]),
  stepId: z.string().optional(), bytes: z.number().optional(), url: z.string().optional(),
});
export const SceneManifestSchema = z.object({
  mode: z.enum(["illustrated", "measured"]).optional(),
  version: z.literal(1), units: z.literal("meters"), assets: z.array(SceneAssetSchema),
  durationSeconds: z.number().positive(),
  cameras: z.object({ first: z.object({ position: Vec3Schema, target: Vec3Schema }), third: z.object({ position: Vec3Schema, target: Vec3Schema }) }),
  bounds: z.object({ min: Vec3Schema, max: Vec3Schema }),
  landmarks: z.array(z.object({ id: z.string(), label: z.string(), position: Vec3Schema })),
  objects: z.array(z.object({ id: z.string(), nodeName: z.string(), position: Vec3Schema, movable: z.boolean(), anchors: z.array(z.object({ id: z.string(), position: Vec3Schema })) })),
  steps: z.array(z.object({ stepId: z.string(), startTime: z.number(), endTime: z.number(), clipName: z.string(), handTargets: z.array(z.object({ nodeName: z.string(), objectId: z.string() })).optional() })),
  rig: z.object({ bodyNode: z.string(), handNodes: z.array(z.string()) }),
  quality: z.object({ approved: z.boolean(), registeredFrameRatio: z.number(), medianReprojectionError: z.number(), measurementErrors: z.array(z.number()), notes: z.array(z.string()) }),
  sanitized: z.boolean().default(false),
});
export type SceneManifest = z.infer<typeof SceneManifestSchema>;
export const JobStatusSchema = z.enum(["queued", "running", "needs_context", "budget_paused", "completed", "cancelled", "failed"]);
export const JobStageSchema = z.enum(["upload", "ingest", "analyze", "reconstruct", "plan", "animate", "render", "validate", "publish", "ready"]);
export const GenerationJobSchema = z.object({
  id: z.string(), tutorialId: z.string(), revision: z.number(), kind: z.enum(["analyze", "generate", "publish", "export"]),
  status: JobStatusSchema, stage: JobStageSchema, progress: z.number().min(0).max(100), message: z.string(),
  budgetUsd: z.number().default(25), spentUsd: z.number().default(0), reservedUsd: z.number().default(0),
  createdAt: z.string(), updatedAt: z.string(), error: z.string().nullable().default(null),
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;
export const TutorialSchema = z.object({
  id: z.string(), ownerId: z.string(), title: z.string(), slug: z.string(), description: z.string(),
  category: CategorySchema, visibility: z.enum(["private", "public"]),
  status: z.enum(["draft", "analyzing", "needs_context", "generating", "ready", "failed"]),
  revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(),
  goal: z.string(), constraints: z.array(z.string()), referenceUrls: z.array(z.string()),
  assets: z.array(CaptureAssetSchema), measurements: z.array(MeasurementSchema),
  plan: TutorialPlanSchema.nullable(), scene: SceneManifestSchema.nullable(), job: GenerationJobSchema.nullable(),
  thumbnailUrl: z.string().nullable(), isExample: z.boolean().default(false),
  adaptedFrom: z.string().optional(), adaptationPlan: TutorialPlanSchema.optional(),
});
export type Tutorial = z.infer<typeof TutorialSchema>;
export const PracticeSessionSchema = z.object({
  id: z.string(), tutorialId: z.string(), tutorialRevision: z.number(), ownerId: z.string(),
  currentStepIndex: z.number().int().nonnegative(), version: z.number().int().nonnegative(),
  status: z.enum(["calibrating", "active", "paused", "completed"]),
  completedStepIds: z.array(z.string()), consecutiveComplete: z.number().default(0),
  calibration: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type PracticeSession = z.infer<typeof PracticeSessionSchema>;
export const StepCheckSchema = z.object({ stepId: z.string(), status: z.enum(["complete", "incomplete", "uncertain"]), evidence: z.string(), guidance: z.string() });
export type StepCheck = z.infer<typeof StepCheckSchema>;
export type AppConfig = { generationMode?: "illustrated" | "measured"; configured: boolean; services: { database: boolean; openai: boolean; worker: boolean }; user: { id: string } | null };
export const GENERATION_BUDGET_USD = 25;
export const VOICE_BUDGET_USD = 2;
export const VOICE_MAX_SECONDS = 600;
export function tutorialHref(tutorial: Pick<Tutorial, "id" | "slug">) { return `/tutorial/${tutorial.id}/${tutorial.slug}`; }
export function slugify(value: string) { return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "my-tutorial"; }
