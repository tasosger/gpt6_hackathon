# Astratorial visual walkthroughs

Upload 1–4 photos, describe your issue, and generate an illustrated step-by-step 3D walkthrough with GPT-6 Astra. Each step has an instruction, a check before continuing, and its own procedural Three.js scene. No pre-created model files, generated JavaScript execution, or video generation are required.

## Run locally

Use Node 22.15+ (or Node 24+) for the test runner's TypeScript and module-hook support.

```bash
npm install
cp .env.example .env.local
# Set OPENAI_API_KEY in .env.local. OPENAI_MODEL defaults to gpt-6-astra.
npm run dev
```

Open http://localhost:3000. If macOS reports too many file watchers, use:

```bash
WATCHPACK_POLLING=true npm run dev -- --webpack
```

The monitor-stand example is explicitly labeled LOCAL EXAMPLE and runs without credentials. Photo-based generation requires an API key with access to the configured model. There is no fake generation fallback. Credentials remain on the server. Restart after changing environment variables.

## Flow

1. Add JPG, PNG, or WebP photos (8 MB maximum each). The browser resizes them to a maximum 1280px edge, re-encodes JPEG, strips source metadata, and previews them locally. HEIC is not supported.
2. Explain the problem and select Show me the steps. Only this action sends photos to the server and OpenAI.
3. `POST /api/scenes` submits the photos and text to the Responses API and requests a strict walkthrough schema. Output is validated again, including parent references, cycle checks, and object budgets.
4. Navigate the generated steps. Orbit and zoom the scene, pause motion, or replay a step. Next step is manual; the application does not verify real-world completion.

The app stores neither photos nor walkthroughs. Requests use `store: false`; this is not a promise of zero retention by the provider. Do not log image payloads. Image preprocessing changes the representation; it does not remove personal content visible within the image.

## Why Responses API rather than Codex SDK

The current product needs image interpretation, a procedural scene specification, and instructions. Responses supports image inputs and Structured Outputs directly. It keeps generation inside an ordinary server request and rendering inside a known, bounded browser runtime.

Codex SDK is appropriate for a future asynchronous worker that creates custom geometry code, writes files, runs a renderer, inspects previews, and repairs its implementation. That requires an isolated execution environment, a job queue, resource limits, and artifact validation. It adds little to the current schema-driven path. Responses can also support a tool loop if bounded scene-editing tools are added; agentic behavior does not inherently require Codex SDK.

References:

- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/latest-model
- https://learn.chatgpt.com/docs/codex-sdk

## Architecture

- `app/page.tsx`: photo intake, problem description, request cancellation, step navigation.
- `app/api/scenes/route.ts`: server-only multimodal API integration, payload limits, timeouts, failure handling.
- `lib/scene.ts`: shared schema, runtime validation, procedural local example.
- `lib/uploads.ts`: browser-side photo preprocessing.
- `app/components/scene-viewer.tsx`: procedural geometry, object hierarchy, lighting, orbit controls, animation and GPU cleanup.

Supported geometry: box, sphere, cylinder, cone, torus, capsule, and hollow vessel. Motion: static, spin, bob, orbit, or a one-way eased translation from an offset into place. Child transforms follow their parent but do not inherit its mesh scale. Scenes are illustrative and do not reconstruct exact mechanics or simulate physical correctness. Generation is bounded to six steps and 180 total objects; complicated requests can time out or need simplification.

## Validation

```bash
node --test tests/*.test.mjs
npx tsc --noEmit
npm run build
```

Tests cover malformed scenes, unsafe/unsupported input, image request construction, missing configuration, model refusal, invalid output, rate-limit handling, and timeouts. Provider calls are mocked in tests; they do not prove live model generation quality. A real photo-to-scene run requires configured credentials.

This is a local hackathon prototype, not a public multi-user deployment. Before exposing its paid generation endpoint publicly, add authentication, per-user quotas, persistent rate limits, and deployment-appropriate request limits. The origin check is not authentication. No site deployment was added.
