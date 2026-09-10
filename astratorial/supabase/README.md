# Astratorial persistence and authentication

Create a **Free** Supabase project in the browser dashboard and apply every file in `supabase/migrations` in order through its SQL editor. Supabase remains required when the website and tutorial worker run on your computer. They enable pgmq and create private `captures` and `tutorial-assets` buckets, both capped at **50 MB per file** to match the [Free plan limit](https://supabase.com/docs/guides/storage/uploads/file-limits). Set the project-wide Storage upload maximum to 50 MB. No bucket is public and no public row policy exposes original media.

Copy `.env.example` to `.env.local` and fill in the project URL, anonymous key, and server-only service-role key. Keep the normal Supabase exposed schemas; do not expose `pgmq` as an anonymous REST schema. Set Auth's Site URL to the application URL (for the local demo, `http://localhost:4173`). Enable **Authentication → Sign In / Providers → Allow anonymous sign-ins**. Selecting the first capture or adapting a shared tutorial automatically creates a real Supabase guest session with a unique owner ID. Everyone is an [anonymous guest](https://supabase.com/docs/guides/auth/auth-anonymous), with owner-specific RLS and private data. Clearing browser data loses access to that guest library. There are no app accounts, sign-in forms or settings pages, and email delivery is not required.

Capture reservations allow 200 MB per tutorial, 500 MB per guest, and 500 MB across the project. An unfinished signed ticket reserves the full 50 MB until its actual size is verified; delete unused tutorials to reclaim their files and reservations. This leaves part of the Free plan's included 1 GB storage for generated scenes, but derived assets and bandwidth still need monitoring in the dashboard. The local illustrated worker also rejects individual derived assets above the 50 MB bucket limit.

The Next.js server validates the current Supabase user on every authenticated operation. Browser roles can only select their own tutorial, job, practice, and voice rows. All writes and worker functions use the service role after server authorization. Never put the service-role or OpenAI key in a `NEXT_PUBLIC_` variable. Upload tokens authorize one fresh private object path; TUS completes directly against Storage, and the completion endpoint verifies its stored size before attaching it. Pending tickets can be listed for a tutorial and renewed using the same upload ID/path after a page reload. Users reselect the file; the client matches its fingerprint and resumes the TUS offset. A completed-but-unattached upload is attached idempotently during renewal.

## Worker contract

The SQL migration is the authoritative RPC contract. The queue name is `astratorial_jobs`. A transaction enqueues the job and persists its current revision. The local TypeScript worker polls for work every two seconds while idle; it must be running for generation to proceed. A browser disconnect does not discard the message, and restarting the worker reclaims eligible work after an expired lease.

- `claim_job` returns `{job, tutorial, checkpoint}` or null; heartbeat the same lease before every artifact upload.
- `checkpoint_job` rejects expired, cancelled, or differently owned leases and excludes identity/capture/revision fields from worker patches.
- `reserve_job_cost` reserves from the shared $25 tutorial-revision allowance. Existing reservation IDs are never authorized twice. A retry gets a new attempt ID; ambiguous prior spending remains held.
- `settle_job_cost` is idempotent and may account for work already started before cancellation. Job cancellation/resumption preserves the same ledger and saved checkpoints.
- `update_voice_usage` and `charge_voice_expert` lock the same voice row. Voice output reservations and bounded Astra expert questions share one $2 allowance. Sessions expire at ten minutes. The application withholds the WebRTC answer until the local Python voice supervisor confirms its sideband is attached.
- `expire_practice_frames` clears expired camera-frame caches; the local voice supervisor invokes it during its recovery loop while running. Each cache contains at most one 1 MB image. Reads refuse a frame after 90 seconds even if background cleanup is delayed. Manual practice state transitions clear it immediately. No camera frame enters a published tutorial.

Live camera checks have a separate $2 session allowance, charged at a conservative $0.15 reservation per bounded check, including ambiguous failures. Hidden-state checks use no model and incur no charge. Manual confirmation stays available after the camera allowance is exhausted.

## Publication and deletion

The public library reads only `public_data`, a separately constructed snapshot backed by separately saved `sanitized_*` illustration artifacts from a completed publishing job. These contain generated geometry and plain materials rather than original footage or captured image textures. Preparing the preview does not publish it: the owner must confirm the preview. Capture files, room measurements, owner IDs, private notes, and source-question history are excluded. Signed assets expire after five minutes, including after unpublishing; refreshing the tutorial renews currently authorized URLs. No permanence of a previously downloaded public copy is implied.

Deleting a tutorial revokes active worker leases, unpublishes it, removes its object directory from both buckets, and then deletes the database record with dependent rows. If storage deletion fails, the private record remains for a retry.

## Verification

`npm test` exercises authorization/configuration boundaries, calibration using authoritative landmark geometry, step transitions, stale checks, and public-snapshot filtering. `tests/server/run-database-tests.sh` starts a disposable local PostgreSQL cluster and checks migration syntax, RLS, transaction invariants, queue idempotency, leases, budgets, and voice/expert reservation races. It uses a minimal pgmq queue double because the Supabase extension is not installed in ordinary PostgreSQL. It never connects to your existing database.

After configuring a staging Supabase project, verify:

1. Start guest sessions in two separate browser profiles. A guest can read their tutorial; the other guest gets 404. Direct authenticated REST writes to canonical tables and calls to service-only RPCs must fail.
2. Interrupt and resume a large TUS upload. `/api/uploads/complete` must reject an unfinished or incorrectly sized object and attach a completed upload only once.
3. Enqueue a job, close the browser, and confirm the local worker claims the same durable message. Terminate a worker after a checkpoint and confirm lease recovery retains its spending and completed artifacts.
4. Pause/cancel during rendering. A stale worker must fail its next heartbeat and cannot commit a new manifest. Resume must use the same revision budget.
5. Generate an illustrated publishing preview. Before confirmation its public URL is unavailable. After confirmation, the anonymous response must include only sanitized assets and no source captures. Unpublish and confirm future URL issuance stops.
6. Start practice and deliberately race two checks or send an old session version. Only the current check may commit. An uncertain or hidden state must never advance automatically. Move the camera and verify that detected movement or orientation changes require the guide to be aligned again.
7. Connect voice, verify the sideband is attached before audio starts, and exercise step navigation, pause/resume, and a source-grounded Astra question. Budget or time exhaustion must close the provider call even when the browser is disconnected, while the local supervisor and its network connection remain available. A stopped computer cannot enforce a remote deadline until it reconnects.

No live Supabase or OpenAI account is created by the tests. OpenAI calls remain metered; running the worker locally removes its separate hosting fee, not model charges. End-to-end usefulness and device performance still require real videos and configured services.
