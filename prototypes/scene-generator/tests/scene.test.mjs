import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  exampleWalkthrough,
  validateWalkthrough,
  walkthroughSchema,
} from "../lib/scene.ts";
import { z } from "zod";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/walkthrough-prompt")
      return next(
        new URL("../lib/walkthrough-prompt.ts", import.meta.url).href,
        context,
      );
    if (specifier === "@/lib/scene")
      return next(new URL("../lib/scene.ts", import.meta.url).href, context);
    return next(specifier, context);
  },
});
const { POST } = await import("../app/api/scenes/route.ts");
const payload = {
  prompt: "Show how to assemble this stand",
  context: "Only a Phillips screwdriver; the base is attached.",
  images: ["data:image/jpeg;base64,/9j/"],
};
const request = (data = payload, origin = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/scenes", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify(data),
  });

test("walkthrough validation rejects cycles, duplicates, code, and unbounded dimensions", () => {
  assert.equal(validateWalkthrough(exampleWalkthrough).steps.length, 3);
  for (const mutation of [
    (scene) => {
      scene.objects[0].parentId = scene.objects[0].id;
    },
    (scene) => {
      scene.objects[0].parentId = "missing";
    },
    (scene) => {
      scene.objects[1].id = scene.objects[0].id;
    },
    (scene) => {
      scene.objects[0].scale[0] = 1e10;
    },
    (scene) => {
      scene.objects[0].code = "alert(1)";
    },
  ]) {
    const modified = structuredClone(exampleWalkthrough);
    mutation(modified.steps[0].scene);
    assert.throws(() => validateWalkthrough(modified));
  }
  const schema = z.toJSONSchema(walkthroughSchema);
  assert.equal(schema.additionalProperties, false);
});

test("API validates inputs before any provider request", async () => {
  assert.equal(
    (await POST(request({ prompt: "help", images: [] }))).status,
    400,
  );
  assert.equal(
    (
      await POST(
        request({ ...payload, images: ["https://example.com/photo.jpg"] }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await POST(request(payload, "https://unrelated.example"))).status,
    403,
  );
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal((await POST(request())).status, 503);
  } finally {
    if (oldKey !== undefined) process.env.OPENAI_API_KEY = oldKey;
  }
});

test("API sends photos with structured output and rejects invalid model responses", async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-never-sent";
  try {
    let sent;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      sent = JSON.parse(options.body);
      return Response.json({
        status: "completed",
        output: [
          {
            content: [
              { type: "output_text", text: JSON.stringify(exampleWalkthrough) },
            ],
          },
        ],
      });
    };
    const success = await POST(request());
    assert.equal(success.status, 200);
    assert.equal((await success.json()).walkthrough.steps.length, 3);
    assert.equal(sent.input[0].content[1].type, "input_image");
    assert.equal(sent.input[0].content[1].image_url, payload.images[0]);
    assert.equal(sent.store, false);
    assert.equal(
      JSON.parse(sent.input[0].content[0].text).additionalContext,
      payload.context,
    );
    assert.equal(sent.input[0].content[1].detail, "high");
    assert.equal(sent.reasoning.effort, "medium");
    assert.equal(sent.text.format.strict, true);
    globalThis.fetch = async () =>
      Response.json({
        status: "completed",
        output: [{ content: [{ type: "output_text", text: '{"steps":[]}' }] }],
      });
    assert.equal((await POST(request())).status, 502);
    globalThis.fetch = async () =>
      Response.json({
        status: "completed",
        output: [{ content: [{ type: "refusal", refusal: "Cannot help" }] }],
      });
    assert.equal((await POST(request())).status, 422);
    globalThis.fetch = async () => Response.json({}, { status: 429 });
    assert.equal((await POST(request())).status, 502);
    globalThis.fetch = async () => {
      throw new DOMException("Timeout", "TimeoutError");
    };
    assert.equal((await POST(request())).status, 504);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  }
});

test("avatar IK preserves contact and limb lengths, rejecting unreachable poses", async () => {
  const { Vector3 } = await import("three");
  const { solveArm, createAvatar } = await import("../lib/avatar.ts");
  const { Object3D } = await import("three");
  const shoulder = new Vector3(0.34, 1.65, 0);
  for (const wrist of [
    new Vector3(1, 1, 0),
    new Vector3(0.34, 1, 0),
    new Vector3(0.5, 2, 0.3),
  ]) {
    const elbow = solveArm(shoulder, wrist, 0.95);
    assert.ok(elbow);
    assert.ok(Math.abs(shoulder.distanceTo(elbow) - 0.95) < 1e-6);
    assert.ok(Math.abs(wrist.distanceTo(elbow) - 0.95) < 1e-6);
  }
  assert.equal(solveArm(shoulder, new Vector3(10, 0, 0), 0.95), null);
  const avatar = createAvatar(1, [0, 0, 0]);
  const target = new Object3D();
  target.position.set(1, 1, 0);
  target.updateMatrixWorld();
  assert.equal(avatar.update(target, [0, 0, 0]), true);
  const palm = avatar.group.children[7];
  assert.ok(palm.position.distanceTo(target.position) < 1e-6);
  target.position.x = 10;
  target.updateMatrixWorld();
  assert.equal(avatar.update(target, [0, 0, 0]), false);
  assert.equal(avatar.group.visible, false);
  avatar.dispose();
  const bad = structuredClone(exampleWalkthrough);
  bad.steps[0].scene.avatar = {
    targetId: "missing",
    handOffset: [0, 0, 0],
    standingPosition: [0, 0, 0],
    size: 1,
  };
  assert.throws(() => validateWalkthrough(bad));
});
