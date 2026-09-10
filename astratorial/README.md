# Astratorial

Personal tutorials built around your actual room, tools, and goal. Next.js 16 / React 19 / TypeScript, Three.js + React Three Fiber, Supabase, OpenAI, and isolated Modal reconstruction/render workers.

The hackathon application turns one video into an animated tutorial, with resumable uploads, camera-and-microphone recording, durable generation, an interactive three-camera player, and recorded narration. It also includes conversational WebRTC voice, camera practice, a private library, and publication previews. The optional measured pipeline retains advanced capture and review tools.

## Hackathon flow

1. Open **Upload a video**, then pick or record one short video. Show your workspace and say what you want to do in the recording—for example, “I want to make pasta,” while showing the pasta, sauce, pan, sink, and stove.
2. Uploading or finishing the recording starts generation automatically. Astra reads sampled frames and transcribed speech, identifies the goal and available supplies, plans the steps, and builds the animation in one saved job. There is no goal form, confirmation screen, follow-up question, or second create button.
3. Watch the narrated animation from first-person, third-person, or free camera. Optional voice and camera practice are available afterward.

The spoken goal takes priority over other plausible tasks in the scene. Astra uses visible or mentioned tools and ingredients, makes reasonable everyday assumptions, and omits optional extras. It never pauses the illustrated workflow to ask for more context. If processing fails, the same saved job can be retried within its existing allowance; reloading the page restores progress.

The runtime uses the existing OpenAI Responses API with `gpt-6-astra`, a transcription model for the video's audio, and speech generation for narration. Astra produces validated scene data that the Three.js renderer animates. A Codex SDK agent is not needed for this flow.

The default hackathon mode runs on an ordinary computer. Astra authors validated scene data, and Three.js turns it into an actual animated GLB with a generic instructor, objects and hand gestures. OpenAI generates recorded narration; the same scene is rendered for video export. This is an **illustrated tutorial informed by the video**, not a measured or photoreal replica. Manual guide alignment is a visual aid. The separate COLMAP/Blender/Modal measured pipeline remains available for further development.

## Run everything on this computer

From the `astratorial` directory, after the local settings are configured:

```sh
npm run build
npm run demo
```

Open <http://localhost:4173>. `npm run demo` starts the website, tutorial worker and voice supervisor together. Keep the terminal and computer running; **Ctrl+C** stops all three. To develop with live reload, use `npm run demo -- --dev` instead. Stop any old server on ports 4173 and 8766 first.

For the initial installation on another Mac (Node.js 22+ and Python 3.11+):

```sh
npm ci
brew install ffmpeg poppler cloudflared
npx playwright install chromium
python3 -m venv worker/.venv
worker/.venv/bin/python -m pip install -r worker/requirements-local-voice.txt
cp .env.example .env.local
```

Fill the ignored `.env.local` with the Supabase project URL, anon key, service-role key and OpenAI key. Set `ASTRATORIAL_LOCAL_WORKER=1`, `LOCAL_VOICE_URL=http://127.0.0.1:8766/voice`, and a random `LOCAL_WORKER_TOKEN`. Keep every secret server-side; only the project URL and anon key use `NEXT_PUBLIC_` names. Never commit `.env.local` or paste keys into source files.

The connected Supabase project must have both migrations applied, in order:

- `supabase/migrations/202609100001_astratorial.sql`
- `supabase/migrations/202609100002_free_hackathon.sql`

In Supabase Authentication, enable **Allow anonymous sign-ins**. A guest receives their own authenticated user ID and private rows; owner isolation stays enabled. Guest access belongs to the browser that created it. Do not clear its cookies if you want to return to those private tutorials. Email sign-in remains optional and is a separate account; guest-to-email migration is not implemented.

The free setup accepts videos up to **50 MB**. The recorder uses a lower bitrate and a 90-second limit. Capture reservations are limited to 200 MB per tutorial and 500 MB across this demo project, leaving room for derived files within free storage. Short 10–30 second clips are the best starting point.

### Open it on your phone

Stop any existing demo, then run:

```sh
npm run phone
```

This creates a free HTTPS link and starts the website, worker and voice supervisor together. Open the printed `https://…trycloudflare.com` link on your phone. Keep the terminal running; **Ctrl+C** stops everything. Use `npm run phone -- --dev` while editing the app.

HTTPS is required for phone camera and microphone access; a plain LAN HTTP address will not enable them. The launcher explicitly authorizes only its generated public origin. This is a temporary development tunnel with a new address on each run and no uptime guarantee. Stop it after the demo. [Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

For separate terminals or troubleshooting, the underlying commands are:

```sh
npm start -- --port 4173
npm run worker
npm run voice
```

The local supervisor calls the website over loopback; it does not need to be exposed through the tunnel. See [local voice details](worker/LOCAL_VOICE.md). Local hosting and the free database do not make OpenAI calls free: generation and voice use the configured API account and the application allowances below.

## Optional managed deployment

1. Create or select a Supabase project near the Vercel/Modal region. Apply `supabase/migrations/202609100001_astratorial.sql` through the Supabase SQL editor or the linked Supabase CLI. The migration creates the private capture/artifact buckets, RLS-protected tables, durable queue, budget ledger, leases, and transactional progress functions. See [backend setup](docs/backend.md).
2. Enable email OTP in Supabase Auth. Set the application URL and allowed redirect URLs to the actual HTTPS deployment. The sign-in screen uses email codes; configure the email template to display the OTP token. Set the project URL, anon key, and server-only service-role key in `.env.local` and Vercel environment settings.
3. Set `OPENAI_API_KEY` to a new server-side key with access to the configured models. Defaults are `gpt-6-astra`, `gpt-realtime-2.1`, `gpt-transcribe`, and `gpt-4o-mini-tts`. Model availability must be checked on that project; errors are shown rather than silently switching models.
4. Deploy the worker using [the worker guide](docs/pipeline.md). Its trusted coordinator receives a Modal Secret named `astratorial-services`. Reconstruction and generated Blender scripts execute in separate credentialless, network-disabled sandboxes. Configure verified conservative price ceilings before allowing paid jobs.
5. Set `MODAL_WORKER_URL` to the worker API’s `/wake` URL, `MODAL_VOICE_URL` to its `/voice` URL, and the same random `MODAL_WORKER_TOKEN` in Vercel and the Modal Secret. Set worker `APP_BASE_URL` to the public HTTPS application origin.
6. Import the repository into Vercel with **Root Directory `astratorial`**. `vercel.json` selects Next.js and the lockfile-based install. Add the environment settings from `.env.example`; redeploy after changing public build-time values. Set `NEXT_PUBLIC_APP_URL` to the final HTTPS origin.
7. Complete the deployment acceptance checklist below before opening paid generation to other users.

Preview and production should use separate Supabase projects, worker secrets, storage, and API budgets. Long reconstruction jobs stay on Modal; the website only authorizes work and reads durable job progress. The once-per-minute Modal recovery function resumes eligible queue work even if the immediate wake request failed.

## Advanced measured reconstruction capture

- Keep the room and equipment stationary during overlapping room and work-area passes. Avoid motion blur; use diffuse light and fixed lens/zoom. Reflective, transparent, or featureless surfaces may need additional views and may remain unreconstructable.
- Record movable items while they are stationary. Capture the surface beneath them separately and show relevant open/closed states; do not mix changing states into a rigid room scan. The worker can process up to three supplementary stationary scan groups per revision, with at least six overlapping views in each and unchanged background for registration. Rigid state changes must pass independent alignment checks; unsupported or ambiguous geometry requests more capture.
- Mark a measured width and a nonparallel, independent depth on the **same flat horizontal work surface**. Mark both endpoints in at least two different views per measurement. One establishes metric scale; the other validates it and determines the work plane.
- Capture every surface that hands or tools will contact. Unseen geometry is not filled in and represented as measured. The worker requests more context if registration, coverage, measurement, or source comparison fails.

Camera practice uses six depth-separated landmarks to fit the phone camera and two additional landmarks to independently check the fit. Keep the phone fixed. Orientation, crop, lens/zoom changes, obscured landmarks, or detected motion invalidate alignment. Movable objects are reconfirmed per gesture. Only small translations on the same support surface are supported: up to 15 cm for an explicitly linked hand target, otherwise 2 cm. Preserve orientation; larger moves require another capture/revision.

## Costs and privacy

Each tutorial revision has a $25 generation allowance, shared by analysis, reconstruction, repair, narration, and exports. Workers reserve conservative worst-case amounts before paid operations and preserve budget state across retries. A budget pause does not increase the cap automatically. Recorded worker charges depend on the configured price ceilings; hosting and storage are separate.

Live voice has a shared $2 allowance (including expert tool answers) and a ten-minute server-enforced limit. The sideband guard controls responses and an independent watchdog ends expired calls. Visual practice checks have a separate $2 session allowance with conservative per-check reservations. Repeated automatic checks stop when that allowance is exhausted. The UI always supports explicit completion for hidden or uncertain states.

Original media and detailed reconstruction files stay private. Public tutorials use separate cropped geometry and rebaked texture maps; the owner reviews a publication preview before publishing. Download URLs are signed and short-lived. Unpublishing stops new public reads, but cannot recall content someone has already downloaded. Public adaptation copies only published procedural context into a new private draft; the new user must capture their own workspace.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run test:database
npm run contracts
npm run build
npm start -- --port 4173
# In another terminal, after installing Playwright Chromium:
npx playwright install chromium
npm run test:e2e
# Worker unit tests (after installing worker/requirements.txt in a virtualenv):
python -m unittest discover -s worker/tests -v
```

The database test script creates a disposable local PostgreSQL cluster and never targets a configured project. It uses a queue test double for transaction/lease checks; verify the actual Supabase pgmq extension in staging. Set `PLAYWRIGHT_BASE_URL` for another test origin or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an existing Chromium binary.

Before production, run real espresso, simple cooking, and furniture assembly scans through upload → reconstruction → quality review → playback → calibrated practice. Require all interaction surfaces to be observed; test held-out visual comparisons, controls/grasp points and occlusion, 3% or 2 cm measurement tolerance, and a first playable GLB under 20 MB. Measure sustained 30 FPS on representative physical iPhone Safari and Android Chrome devices. Browser emulation does not establish that device result.

Exercise interrupted uploads, blurry/reflective scans, missing manuals, reconstruction failures, expired auth, denied camera/mic, voice interruption, stale checks, cancellation, and budget exhaustion. With two independent accounts, test isolation and publication/unpublication. Attempt generated-script network/credential access in a staging sandbox and verify it fails. See [pipeline details and limitations](docs/pipeline.md).

See [the verification record](docs/verification.md) for the executed checks and their limits.

## Project map

- `app`, `components`: application, capture flow, player, practice UI.
- `lib/contracts.ts`: versioned shared capture/plan/scene/job/practice contracts.
- `lib/calibration.ts`, `lib/camera-motion.ts`: measured camera fit and fixed-camera movement guard.
- `lib/server`, `lib/supabase`: authenticated APIs, state transitions, provider calls.
- `supabase/migrations`: storage/RLS, durable queue, leases, checkpoints, budget reservations.
- `worker`: trusted coordinator, Modal deployment, isolated FFmpeg/COLMAP/Open3D/Blender work.
- `tests`: server, geometry, database, and browser verification.

[Asset provenance](docs/assets.md) records the generated example imagery and bundled rendering assets.
