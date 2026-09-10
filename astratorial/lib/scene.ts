import { z } from "zod";

const vector = z.array(z.number().min(-30).max(30)).length(3);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const sceneSchema = z
  .object({
    title: z.string().min(1).max(100),
    description: z.string().min(1).max(600),
    background: color,
    avatar: z
      .object({
        targetId: z.string(),
        handOffset: vector,
        standingPosition: vector,
        size: z.number().min(0.2).max(3),
      })
      .strict()
      .nullable(),
    objects: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/),
            parentId: z.string().nullable(),
            name: z.string().max(80),
            shape: z.enum([
              "box",
              "sphere",
              "cylinder",
              "cone",
              "torus",
              "capsule",
              "vessel",
            ]),
            position: vector,
            rotation: vector,
            scale: z.array(z.number().min(0.01).max(12)).length(3),
            color,
            metalness: z.number().min(0).max(1),
            roughness: z.number().min(0).max(1),
            opacity: z.number().min(0.1).max(1),
            motion: z
              .object({
                type: z.enum(["none", "spin", "bob", "orbit", "translate"]),
                axis: z.enum(["x", "y", "z"]),
                amplitude: z.number().min(0).max(10),
                speed: z.number().min(0).max(3),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(80),
  })
  .strict();

export type SceneSpec = z.infer<typeof sceneSchema>;
export type SceneObject = SceneSpec["objects"][number];

export function validateScene(value: unknown): SceneSpec {
  const scene = sceneSchema.parse(value);
  const nodes = new Map(scene.objects.map((object) => [object.id, object]));
  if (nodes.size !== scene.objects.length)
    throw new Error("Duplicate object IDs.");
  for (const object of scene.objects) {
    const visited = new Set([object.id]);
    let parent = object.parentId;
    while (parent !== null) {
      if (!nodes.has(parent) || visited.has(parent))
        throw new Error("Invalid object hierarchy.");
      visited.add(parent);
      parent = nodes.get(parent)!.parentId;
      if (visited.size > 6) throw new Error("Object hierarchy is too deep.");
    }
  }
  if (scene.avatar && !nodes.has(scene.avatar.targetId))
    throw new Error("Avatar target does not exist.");
  return scene;
}

function object(
  id: string,
  shape: SceneObject["shape"],
  position: number[],
  scale: number[],
  color: string,
  overrides: Partial<SceneObject> = {},
): SceneObject {
  return {
    id,
    parentId: null,
    name: id,
    shape,
    position,
    rotation: [0, 0, 0],
    scale,
    color,
    metalness: 0.15,
    roughness: 0.4,
    opacity: 1,
    motion: { type: "none", axis: "y", amplitude: 0, speed: 0 },
    ...overrides,
  };
}

// A deterministic local example, never substituted for an AI generation response.
export const exampleScene: SceneSpec = {
  title: "A little orbital system",
  description:
    "A local example built entirely from geometry. Describe a scene to create your own with Astra.",
  background: "#11141f",
  avatar: null,
  objects: [
    object("sun", "sphere", [0, 0.5, 0], [1.35, 1.35, 1.35], "#ffb65c", {
      roughness: 0.7,
    }),
    object("inner-orbit", "torus", [0, 0.5, 0], [2.5, 2.5, 0.06], "#4b526d", {
      rotation: [Math.PI / 2, 0, 0],
    }),
    object("outer-orbit", "torus", [0, 0.5, 0], [4, 4, 0.04], "#4b526d", {
      rotation: [Math.PI / 2, 0, 0],
    }),
    object(
      "blue-planet",
      "sphere",
      [2.5, 0.5, 0],
      [0.42, 0.42, 0.42],
      "#77aaff",
      { motion: { type: "orbit", axis: "y", amplitude: 2.5, speed: 0.35 } },
    ),
    object(
      "pink-planet",
      "sphere",
      [-4, 0.5, 0],
      [0.66, 0.66, 0.66],
      "#d8a6ff",
      { motion: { type: "orbit", axis: "y", amplitude: 4, speed: 0.15 } },
    ),
  ],
};

export const walkthroughSchema = z
  .object({
    title: z.string().min(1).max(100),
    summary: z.string().min(1).max(600),
    observations: z.array(z.string().max(240)).max(6),
    assumptions: z.array(z.string().max(240)).max(6),
    steps: z
      .array(
        z
          .object({
            instruction: z.string().min(1).max(500),
            check: z.string().min(1).max(300),
            scene: sceneSchema,
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export type Walkthrough = z.infer<typeof walkthroughSchema>;
export function validateWalkthrough(value: unknown): Walkthrough {
  const tutorial = walkthroughSchema.parse(value);
  tutorial.steps.forEach((step) => validateScene(step.scene));
  if (
    tutorial.steps.reduce((sum, step) => sum + step.scene.objects.length, 0) >
    180
  )
    throw new Error("Too many objects across steps.");
  return tutorial;
}

const desk = object("desk", "box", [0, -0.2, 0], [6, 0.3, 3.5], "#5d4963");
const base = object("base", "cylinder", [0, 0, 0], [0.9, 0.15, 0.7], "#b6a0ff");
const stand = object("stand", "box", [0, 0.65, 0], [0.2, 1.3, 0.2], "#a5a8bb");
const monitor = object(
  "screen",
  "box",
  [0, 1.5, 0],
  [2.8, 1.6, 0.15],
  "#748cba",
);
export const exampleWalkthrough: Walkthrough = {
  title: "Set up a monitor stand",
  summary:
    "A local three-step example. Upload your photos and describe your issue to get a walkthrough tailored to your situation.",
  observations: [],
  assumptions: ["Illustrative example, not an assessment of your equipment."],
  steps: [
    {
      instruction:
        "Clear a stable surface and place the stand base in the center.",
      check: "The base sits flat and has room around it.",
      scene: {
        title: "Position the base",
        description: "Start with a stable foundation.",
        background: "#11141f",
        avatar: null,
        objects: [desk, base],
      },
    },
    {
      instruction:
        "Align the upright with the base. Follow the stand manufacturer's attachment instructions.",
      check: "The upright is secured without wobbling.",
      scene: {
        title: "Fit the upright",
        description:
          "The movement shows where the upright aligns with the base.",
        background: "#11141f",
        avatar: {
          targetId: "stand",
          handOffset: [0.1, 0.2, 0],
          standingPosition: [-1.4, 0, 1],
          size: 1,
        },
        objects: [
          desk,
          base,
          {
            ...stand,
            motion: {
              type: "translate",
              axis: "y",
              amplitude: 0.8,
              speed: 0.5,
            },
          },
        ],
      },
    },
    {
      instruction:
        "With the display supported, attach it using its compatible mounting system. Adjust the viewing angle.",
      check:
        "The attachment is locked and the display is stable before releasing it.",
      scene: {
        title: "Position the display",
        description:
          "An illustrative final arrangement; actual mounting mechanisms vary.",
        background: "#11141f",
        avatar: null,
        objects: [desk, base, stand, monitor],
      },
    },
  ],
};
