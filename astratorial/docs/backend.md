# Backend setup and verification

See [the Supabase backend guide](../supabase/README.md) for the authentication model, RPC protocol, spending controls, publication boundaries, and a staging verification checklist.

From the `astratorial` app directory:

```sh
cp .env.example .env.local
supabase login
supabase link --project-ref YOUR_PROJECT_REFERENCE
supabase db push
npm run test:database
```

Fill `.env.local` with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and a replacement server-only `OPENAI_API_KEY`. For the cloud reconstruction pipeline, configure `MODAL_WORKER_URL` as the deployed `/wake` URL, `MODAL_VOICE_URL` as its `/voice` URL, and `MODAL_WORKER_TOKEN` to match the Modal secret. Configure that worker separately using [the pipeline guide](pipeline.md), including verified numerical price ceilings. Production requires the same environment values in Vercel and HTTPS URLs. The free hackathon configuration caps Supabase's global and both private bucket limits at 50 MB. Anonymous sign-ins should be enabled for an upload-first guest session; each guest receives a distinct owner ID and the same RLS isolation.

Supabase Auth's email template must display `{{ .Token }}` for the six-digit code UI; set the Auth Site URL to the deployed app. Supabase enforces its email OTP rate limits. The API additionally rejects cross-origin mutations, validates request sizes, checks every owner, and keeps all canonical writes service-only.

Source uploads reserve at most **50 MB/file, 30 files and 200 MB/tutorial, 500 MB/account and 500 MB/project**. PDF manuals together must fit within **10 MB/tutorial**. These use decimal bytes. SQL serializes reservations across the project, including parallel uploads by different guests. Each pending upload reserves the full 50 MB storage-bucket ceiling because signed tokens cannot constrain declared content length. On completion the server verifies the actual object size and settles down to that size. Abandoned reservations remain counted until the tutorial is deleted; this prevents expired-upload retries from exceeding the cap. These are source-file limits, not an overall cloud invoice cap. Derived assets and bandwidth still require monitoring; a large detailed reconstruction may not fit the Free plan even when its source captures do.

Generation has a $25 allowance per revision. Retries and resumptions retain that revision's ledger. Live camera checking has a $2 session allowance; bounded visual checks reserve $0.15 each and uncertain failures retain the reservation. Hidden-state checks are free and require human confirmation. Voice and source-grounded Astra expert questions share a separate $2 / ten-minute session limit. Expert questions conservatively reserve $0.35 each. Model and cloud price ceilings must be reviewed before deployment.

API examples and limits:

- `GET /api/config` exposes service readiness and the current user, never credentials. Missing services return actionable `503` for dependent actions; there is no fake signed-in backend.
- `GET /api/uploads?tutorialId=...` lists owned pending tickets in the current revision. `POST /api/uploads/[uploadId]/renew` refreshes that same path’s upload signature without creating a second reservation. Reselect the same fingerprinted file to resume its TUS offset; if the full file already arrived, renewal returns `{completed:true,tutorial,asset,uploadId}`.
- `POST /api/tutorials/[id]/publish` prepares a sanitized publishing job or returns `{preview: Tutorial, requiresConfirmation: true}`. It returns a full tutorial, not only a scene manifest. `POST {confirm:true}` publishes the reviewed copy.
- `POST /api/tutorials/[publicId]/adapt` creates a private draft with public procedural context and references. It copies no original room assets, geometry, or measurements.
- `POST /api/realtime/session/[id]/context` accepts `{stepId,cameraMode}`. `GET` returns current `{stepId,cameraMode,action,version,status,budgetUsd,spentUsd}`; apply each increasing action version once.
- `GET /api/practice/[id]` returns `{session}` for authoritative voice-driven pause/repeat/navigation. Visual checks and manual actions use optimistic session versions; stale checks cannot advance progress.

Local checks do not prove live cloud provisioning, real room reconstruction, avatar realism, mobile frame rate, or actual provider billing. Run the staging checklist with real espresso, cooking, and assembly captures before accepting those production criteria. Enable project-level spend/storage alerts and appropriate Supabase authentication abuse controls for a public signup launch; the app does not implement end-user subscriptions or payment collection.
