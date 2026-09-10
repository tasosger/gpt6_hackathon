# Astratorial

Personal tutorials built around your room, tools, and goal. The app uses Next.js 16, React 19, TypeScript, Three.js, Supabase and OpenAI. The website, tutorial renderer and voice supervisor run on your own computer.

## Hackathon flow

1. Open **Upload a video**, then pick or record one short video. Show your workspace and say what you want to do—for example, “I want to make pasta,” while showing the pasta, sauce, pan, sink and stove.
2. Uploading or finishing the recording starts generation automatically. Astra reads sampled frames and transcribed speech, identifies the goal and available supplies, plans the steps, and builds the animation in one saved job. There is no goal form, confirmation screen, follow-up question or second create button.
3. Watch the narrated animation from first-person, third-person or free camera. Try conversational voice or **Ready to try?** for camera practice with manually aligned ghost hands.

The spoken goal takes priority over other plausible tasks in the scene. Astra uses visible or mentioned tools and ingredients, makes reasonable everyday assumptions, and omits optional extras. If processing fails, retry the saved job within its existing allowance; reloading the page restores progress.

After selecting a video, the page shows connection, upload and processing progress immediately. Failed transfers retain the selected file and offer a resumable retry. A stopped worker is identified separately from a storage or AI error. See [upload feedback and recovery](docs/upload-feedback.md).

Astra produces validated scene data, and Three.js turns it into an animated GLB with a generic instructor, objects and hand gestures. The same scene supports narrated video export. This is an **illustrated tutorial informed by the video**, with approximate object placement and manual guide alignment. It does not reconstruct measured surfaces or a photorealistic replica. No additional agent SDK, GPU worker or paid hosting service is required.

## Run everything on this computer

From the `astratorial` directory, after configuring the settings below:

```sh
npm run build
npm run demo
```

Open <http://localhost:4173>. `npm run demo` starts the website, tutorial worker and voice supervisor together. Keep the terminal and computer running; **Ctrl+C** stops all three. For live reload, use `npm run demo -- --dev`. Stop any old server on ports 4173 and 8766 first.

For the initial installation on another Mac (Node.js 22+ and Python 3.11+):

```sh
npm ci
brew install ffmpeg poppler cloudflared
npx playwright install chromium
python3 -m venv worker/.venv
worker/.venv/bin/python -m pip install -r worker/requirements-local-voice.txt
cp .env.example .env.local
```

Fill the ignored `.env.local` with:

- `NEXT_PUBLIC_SUPABASE_URL`: the Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the project's anon key.
- `SUPABASE_SERVICE_ROLE_KEY`: the server-only service-role key.
- `OPENAI_API_KEY`: a server-side key with access to the configured models.
- `LOCAL_VOICE_URL=http://127.0.0.1:8766/voice`.
- `LOCAL_WORKER_TOKEN`: a long random secret shared by the local website and voice supervisor.
- `NEXT_PUBLIC_APP_URL=http://localhost:4173`: the browser address permitted to upload, even when the server listens on `0.0.0.0`.

Only the project URL and anon key use `NEXT_PUBLIC_` names. Never commit `.env.local` or put secret values in source files. The configured model defaults are `gpt-6-astra`, `gpt-realtime-2.1`, `gpt-transcribe` and `gpt-4o-mini-tts`; unavailable models return a setup error instead of silently switching.

**Supabase is still required**, using its Free plan for guest authentication, private uploads, saved tutorials, jobs and progress. In the project's browser SQL editor, apply these migrations in order:

- `supabase/migrations/202609100001_astratorial.sql`
- `supabase/migrations/202609100002_free_hackathon.sql`

Enable and save **Authentication → Sign In / Providers → Allow anonymous sign-ins**. Everyone uses an anonymous guest session, created automatically when they upload or adapt a shared tutorial. Each guest receives their own authenticated user ID and private rows. The library belongs to that browser: clearing its cookies loses access to it. The app has no sign-in, account or settings pages. See [backend setup](docs/backend.md).

The free setup accepts videos up to **50 MB**. The recorder uses a lower bitrate and a 90-second limit. Short 10–30 second clips are the best starting point. Capture reservations are capped at 200 MB per tutorial and 500 MB across the project, leaving room for derived files within free storage.

### Open it on your phone

Stop any existing demo, then run:

```sh
npm run phone
```

This creates a free HTTPS link and starts all three local services. Open the printed `https://…trycloudflare.com` link on your phone. Keep the terminal running; **Ctrl+C** stops everything. Use `npm run phone -- --dev` while editing.

Phone camera and microphone access require HTTPS; a plain LAN HTTP address will not enable them. The launcher authorizes its generated public origin. The temporary tunnel has a new address on each run and no uptime guarantee. Stop it after the demo.

For separate terminals or troubleshooting:

```sh
npm start -- --port 4173
npm run worker
npm run voice
```

The voice supervisor listens on loopback and does not need public exposure. See [local voice details](worker/LOCAL_VOICE.md) and [the local generation pipeline](docs/pipeline.md).

## Costs, privacy and limits

**Local hosting and Supabase's Free plan do not make OpenAI calls free.** Generation uses the configured API account, with a $25 application allowance per tutorial revision. Retries preserve its spending ledger. Voice has a shared $2 allowance and ten-minute session limit; live visual checks have a separate $2 allowance. These application reservations are estimates, not provider billing-account hard limits. Storage and bandwidth quotas remain separate.

Keep the computer awake and the services running during generation and voice. Jobs and completed checkpoints survive a worker restart in Supabase; processing resumes when the worker is running again. A stopped or disconnected computer cannot supervise an active remote voice call until connectivity returns.

Original video, extracted frames and transcripts remain private. Public previews contain a separately saved illustration and generated narration, without original footage or room-image textures. Review the instructions and visible objects before publishing. Asset links are signed and short-lived; unpublishing prevents new access but cannot recall downloaded copies. Other users can adapt published procedural context into a private tutorial with their own video.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run test:database
npm run contracts
npm run build
npm start -- --port 4173
# In another terminal:
npm run test:e2e
# Local voice tests:
worker/.venv/bin/python -m unittest discover -s worker/tests -p test_local_voice.py -v
```

The database test script uses a disposable local PostgreSQL cluster and a queue test double; it never targets a configured project. Set `PLAYWRIGHT_BASE_URL` for another test origin or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an existing Chromium binary.

Real espresso, cooking and assembly footage still need complete upload-to-practice acceptance, including interrupted uploads, denied permissions, voice interruption, cancellation, budget exhaustion, publication and guest isolation. Physical-phone performance and overlay usefulness require actual device checks. See [the verification record](docs/verification.md) for executed checks and their limits.

## Project map

- `app`, `components`: upload flow, library, player and practice UI.
- `lib/contracts.ts`: versioned capture, plan, scene, job and practice contracts.
- `lib/local`: video analysis, structured scene building and local rendering.
- `lib/server`, `lib/supabase`: authenticated APIs, provider calls and persistence.
- `scripts/local-worker.ts`, `scripts/demo.mjs`, `scripts/phone.mjs`: local queue consumer and launchers.
- `worker/local_voice.py`: Python voice supervisor; remaining [geometry helpers](worker/README.md) are experimental and not part of generation.
- `supabase/migrations`: private storage, RLS, queue, leases, checkpoints and budget reservations.
- `tests`: server, database and browser checks.

[Asset provenance](docs/assets.md) records the example imagery and bundled rendering assets.
