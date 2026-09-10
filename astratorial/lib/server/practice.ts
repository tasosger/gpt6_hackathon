import { z } from "zod";
import { type PracticeSession, type StepCheck, type Tutorial } from "@/lib/contracts";
import { fail } from "./errors";
import { calibrateCamera } from "@/lib/calibration";

export const actionSchema = z.object({
  action: z.enum(["calibrate", "confirm", "next", "previous", "repeat", "pause", "resume", "invalidate", "anchor"]),
  version: z.number().int().nonnegative(),
  calibration: z.record(z.string(), z.unknown()).optional(),
  objectId: z.string().optional(), position: z.tuple([z.number().finite(),z.number().finite(),z.number().finite()]).optional(),
}).strict();
export type PracticeAction = z.infer<typeof actionSchema>;

export function canonicalCalibration(tutorial: Tutorial, raw: Record<string, unknown> | undefined) {
  const input = z.object({ width:z.number().int().min(100).max(4096),height:z.number().int().min(100).max(4096),points:z.array(z.object({id:z.string(),image:z.tuple([z.number().finite(),z.number().finite()])})).length(8) }).safeParse(raw);
  if (!input.success || !tutorial.scene || tutorial.scene.landmarks.length < 8) fail(422,"Match six landmarks and two independent check points.","alignment_failed");
  const {width,height,points}=input.data;
  const selected=tutorial.scene.landmarks.slice(0,8);
  if(new Set(points.map(point=>point.id)).size!==8)fail(422,"Each alignment landmark must be different.","alignment_failed");
  const trusted=selected.map((landmark,index)=>{
    const observation=points.find(point=>point.id===landmark.id);
    if(!observation || observation.image[0]<0 || observation.image[0]>width || observation.image[1]<0 || observation.image[1]>height)fail(422,"Match all eight highlighted landmarks inside the camera view.","alignment_failed");
    return {id:landmark.id,world:landmark.position,image:observation.image,check:index>=6};
  });
  try { return {...calibrateCamera(trusted,width,height),points:trusted}; }
  catch(error) { fail(422,error instanceof Error?error.message:"Camera alignment failed.","alignment_failed"); }
}
function requireCurrent(session: PracticeSession, tutorial: Tutorial, version: number) {
  if (session.tutorialRevision !== tutorial.revision || version !== session.version) fail(409, "The tutorial or practice step changed. Refresh before continuing.", "stale_session");
  if (!tutorial.plan?.steps.length) fail(409, "This tutorial has no playable steps.");
}
function advance(session: PracticeSession, tutorial: Tutorial): PracticeSession {
  const step = tutorial.plan!.steps[session.currentStepIndex];
  if (!step) fail(409, "There is no next step.");
  const completedStepIds = Array.from(new Set([...session.completedStepIds, step.id]));
  const isLast = session.currentStepIndex === tutorial.plan!.steps.length - 1;
  return { ...session, completedStepIds, currentStepIndex: isLast ? session.currentStepIndex : session.currentStepIndex + 1, status: isLast ? "completed" : "active", consecutiveComplete: 0 };
}
export function applyPracticeAction(session: PracticeSession, tutorial: Tutorial, input: PracticeAction): PracticeSession {
  requireCurrent(session, tutorial, input.version);
  let next = { ...session, consecutiveComplete: 0 };
  if (input.action === "calibrate") {
    next = { ...next, calibration: canonicalCalibration(tutorial,input.calibration), status: "active" };
  } else if (input.action === "invalidate") next = { ...next, calibration: null, status: "calibrating" };
  else if (input.action === "pause") { if (next.status !== "completed") next.status = "paused"; }
  else if (input.action === "resume") { if (next.status === "completed") fail(409, "This tutorial is complete."); next.status = next.calibration ? "active" : "calibrating"; }
  else if (input.action === "previous") { next.currentStepIndex = Math.max(0, next.currentStepIndex - 1); next.status = next.calibration ? "active" : "calibrating"; next.completedStepIds = tutorial.plan!.steps.slice(0, next.currentStepIndex).map(step => step.id); }
  else if (input.action === "repeat") { next.status = next.calibration ? "active" : "calibrating"; if (session.status === "completed") { next.completedStepIds = next.completedStepIds.filter(id => id !== tutorial.plan!.steps[next.currentStepIndex].id); } }
  else if (input.action === "anchor") {
    if (!next.calibration || !input.objectId || !input.position || !tutorial.scene?.objects.some(o => o.id === input.objectId && o.movable)) fail(422, "Choose a movable object after aligning the camera.");
    const bounds = tutorial.scene.bounds;
    if (input.position.some((v, i) => v < bounds.min[i] || v > bounds.max[i])) fail(422, "Keep this object inside the captured workspace.");
    const object=tutorial.scene.objects.find(object=>object.id===input.objectId)!;
    const stepId=tutorial.plan!.steps[next.currentStepIndex].id;
    const timing=tutorial.scene.steps.find(step=>step.stepId===stepId);
    const linked=timing?.handTargets?.some(target=>target.objectId===object.id)??false;
    const shift=input.position.map((value,index)=>value-object.position[index]);
    if(Math.abs(shift[1])>.02||Math.hypot(...shift)>(linked ? 0.15 : 0.02))fail(422,linked?"Keep the object on the same surface, within 15 cm of its captured position and in its original orientation. Larger moves need a new capture.":"This gesture requires the original object position. Put it back within 2 cm and keep its orientation, or make a new capture.","object_moved_too_far");
    const anchors = (next.calibration.objectAnchors || {}) as Record<string, unknown>;
    next.calibration = { ...next.calibration, objectAnchors: { ...anchors, [input.objectId]: { position: input.position, stepId: tutorial.plan!.steps[next.currentStepIndex].id } } };
  } else {
    if (next.status !== "active" || !next.calibration) fail(409, "Align your camera and resume this step first.");
    next = advance(next, tutorial);
  }
  return { ...next, version: session.version + 1, updatedAt: new Date().toISOString() };
}
export function unconfirmedMovableObjects(session: PracticeSession,tutorial: Tutorial): string[] {
  const step=tutorial.plan?.steps[session.currentStepIndex];
  if(!step)return [];
  const anchors=(session.calibration?.objectAnchors||{}) as Record<string,{stepId?:string}>;
  return (tutorial.scene?.objects||[]).filter(object=>object.movable&&step.objectIds.includes(object.id)&&anchors[object.id]?.stepId!==step.id).map(object=>object.id);
}
export function applyStepCheck(session: PracticeSession, tutorial: Tutorial, check: StepCheck, version: number): PracticeSession {
  requireCurrent(session, tutorial, version);
  const step = tutorial.plan!.steps[session.currentStepIndex];
  if (session.status !== "active" || !session.calibration || check.stepId !== step.id) fail(409, "This visual check no longer matches the active step.", "stale_check");
  const count = check.status === "complete" && step.observable && unconfirmedMovableObjects(session,tutorial).length===0 ? session.consecutiveComplete + 1 : 0;
  let next = { ...session, consecutiveComplete: count };
  if (count >= 2) next = advance(next, tutorial);
  return { ...next, version: session.version + 1, updatedAt: new Date().toISOString() };
}
