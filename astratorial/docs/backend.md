# Backend setup and verification

Supabase is required for guest authentication, private media, saved tutorials, durable jobs and authoritative progress. The website, renderer and voice supervisor run locally; there is no additional worker hosting account to configure. See [the Supabase backend guide](../supabase/README.md) for RPCs, spending controls and publication boundaries.

From the `astratorial` directory, copy `.env.example` to the ignored `.env.local`. In the Supabase browser dashboard, create a Free project and use its SQL editor to apply `202609100001_astratorial.sql` and `202609100002_free_hackathon.sql` from `supabase/migrations`, in that order. Fill in `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and the server-only `OPENAI_API_KEY`.

Enable **Authentication → Sign In / Providers → Allow anonymous sign-ins**, then **Save changes**. Each upload-first guest receives a distinct owner ID and the same row-level isolation as an email user. Set the Auth Site URL to `http://localhost:4173` for the local demo. Optional email OTP needs a template displaying `{{ .Token }}`; the guest flow does not depend on email delivery.

Set `LOCAL_VOICE_URL=http://127.0.0.1:8766/voice` and a long random `LOCAL_WORKER_TOKEN`. After installing the dependencies in [the README](../README.md), run `npm run build` and `npm run demo`, or `npm run phone` for a temporary HTTPS phone link. The worker polls Supabase directly; the voice supervisor is reachable only over loopback. Public browser configuration never includes service-role, OpenAI or worker secrets.

Source uploads reserve at most **50 MB/file, 30 files and 200 MB/tutorial, 500 MB/account and 500 MB/project**. PDF manuals together must fit within **10 MB/tutorial**. These use decimal bytes. SQL serializes reservations across the project, including parallel uploads by different guests. Each pending upload reserves the full 50 MB bucket ceiling because signed tokens cannot constrain declared content length. On completion the server verifies actual size and settles the reservation down. Abandoned reservations remain counted until tutorial deletion. Generated assets and bandwidth use additional quota; source limits are not a total storage invoice cap.

Generation has a $25 allowance per revision. Retries retain that ledger. Camera checks have a separate $2 session allowance with conservative $0.15 reservations, including uncertain failures. Hidden-state checks require human confirmation and use no model. Voice and Astra expert questions share $2 and ten minutes; expert questions reserve $0.35 each. **OpenAI remains a paid API even with local hosting and a free database.**

## API boundaries

- `GET /api/config` exposes service readiness and the current user, never credentials. Missing settings return actionable `503` responses for dependent actions.
- `GET /api/uploads?tutorialId=...` lists owned pending tickets. `POST /api/uploads/[uploadId]/renew` refreshes the same upload path without another reservation. Reselect the same fingerprinted file to resume its TUS offset; a completed file can be attached idempotently during renewal.
- `POST /api/tutorials/[id]/publish` prepares a public-copy job or returns `{preview: Tutorial, requiresConfirmation: true}`. `POST {confirm:true}` publishes the reviewed illustration.
- `POST /api/tutorials/[publicId]/adapt` creates a private draft with published procedural context and references, excluding original captures and private scene data.
- `POST /api/realtime/session/[id]/context` accepts `{stepId,cameraMode}`. `GET` returns current `{stepId,cameraMode,action,version,status,budgetUsd,spentUsd}`; apply each increasing action version once.
- `GET /api/practice/[id]` returns authoritative progress. Visual checks and manual actions use optimistic versions; stale checks cannot advance a step.

The server checks ownership, validates request sizes, rejects unauthorized mutation origins and keeps canonical writes service-only. A running local voice supervisor maintains active call deadlines and expires temporary practice frames; stopping the computer interrupts that supervision.

Run `npm run test:database` for disposable local PostgreSQL checks; it never targets the configured project. Then test the actual browser → Storage → queue → worker flow and two-account isolation against your Supabase project. See [the verification record](verification.md) for the latest connected-test status. Unit tests do not establish physical-phone performance, illustration usefulness or actual provider invoices.
