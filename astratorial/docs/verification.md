# Verification record

Updated September 10, 2026. The app generates illustrated tutorials on the local computer and uses Supabase for persistence. These checks do not establish measured reconstruction, photorealism or physical-phone performance.

## Local-only simplification

Generation now uses the built-in TypeScript worker unconditionally. The server uses `LOCAL_VOICE_URL` and `LOCAL_WORKER_TOKEN` for local voice supervision. Remote worker deployment, generated-script execution and their configuration have been removed. The remaining Python geometry utilities are experimental offline helpers, documented in [worker/README.md](../worker/README.md), and are not connected to tutorial generation.

For this change:

- TypeScript and ESLint passed.
- All 44 application unit tests passed.
- 27 Python tests passed; six optional native geometry cases were skipped (33 discovered).
- The production build passed. All 24 production browser tests passed in 38.2 seconds.
- The live configuration endpoint reported database, OpenAI and local worker configuration present, with no signed-in user. This is a setup check, not completed paid generation or proof that guest authentication is enabled.

Configured local generation means the required application settings are present; it is not a worker-process health check. The computer and local worker must remain running for queued tutorials to advance.

## Earlier single-video workflow checks

The preceding workflow update made one uploaded or recorded video immediately queue a `generate` job. The job transcribes its audio, infers the spoken goal, plans and builds the narrated animation without a goal form, confirmation or follow-up questions.

- Production build, TypeScript and ESLint passed before the local-only simplification.
- All 45 then-current application unit tests passed, including missing-plan generation, suppression of questions, saved-plan recovery, animation retries, budgets, cancellation and required scene objects. The current suite count is recorded above.
- All 24 desktop/mobile browser tests passed before the local-only simplification. Coverage included automatic upload-to-generation, reload without duplicate jobs, interrupted upload renewal, oversized files, and browser recording with synthetic video/audio tracks. Finishing the recording uploaded exactly once and released both tracks.
- A practice synchronization race was corrected: synthetic phone rotation waits for the next step to render before asserting the session version.
- The connected acceptance attempt used a 6.68-second synthetic MP4 made from the existing cooking illustration and offline speech requesting pasta. The upload screen rendered, but guest authentication failed before any tutorial, upload, job or paid model call. Supabase's settings endpoint confirmed `external.anonymous_users=false`; credentials being present did not establish readiness.
- At that attempt, live acceptance remained blocked by anonymous sign-ins. Enable **Allow anonymous sign-ins** and **Save changes** in [the project's authentication settings](https://supabase.com/dashboard/project/kvvbeiolpuyvexeliowi/auth/providers), then retry the single-video flow. No authentication or RLS setting was saved during that test.

## Earlier infrastructure and rendering evidence

| Check | Result | Scope |
| --- | --- | --- |
| Hosted Supabase | Passed | Created free project `kvvbeiolpuyvexeliowi`; applied migrations 001/002 and verified all eight app tables use RLS and both buckets are private with 50 MB limits. Real pgmq create/claim/heartbeat/budget/checkpoint/archive passed in a rolled-back transaction. |
| PostgreSQL checks | Passed | Disposable local migration/RLS, atomic queues/leases, revision budgets, voice/expert races and adversarial upload reservations. Local queue transport uses a pgmq test double. |
| Real Astra and narration | Passed, bounded sample | With no typed goal, Astra inferred a four-step pasta task from an existing generated image, authored five scene objects and produced an animated GLB (~1.04 MB). Real speech generation, browser rendering and a five-second scene video passed. This was not a real phone capture. |
| Interrupted transfer | Passed | Real tus-js-client with simulated transport resumed at byte 6,291,456 after reload/reselection and authorization renewal. One ticket creation and one renewal. |
| Long-session media | Passed | Simulated four-minute refresh renewed narration/video links while retaining GLB, audio and timeline position. New revisions reset playback; revoked access removed the tutorial. |
| Phone HTTPS origin | Passed to setup boundary | Temporary HTTPS tunnel reached the local app; only its configured origin could mutate, and forged forwarding headers were rejected. That earlier guest test stopped at missing API-key configuration; the subsequent attempt reached the disabled-anonymous-sign-in boundary described above. |
| Credential scan | Passed | No usable project API key appeared in application, worker, migrations, docs or templates during that pass. Local secret files were excluded from git. |
| Native geometry helpers | Six passed separately | Earlier checks with pinned pycolmap/Open3D covered rigid alignment, symmetry rejection, distortion/occlusion, thin surfaces, overlap/UV preservation and fixed poses. These helpers are outside the app's illustrated generation flow. |

Browser coverage also includes home filtering, core routes, overflow, camera modes, playback, seeking, speed, permission denial, animated GLB loading, optional detail and publication-preview keyboard behavior. Practice tests use deterministic generated video streams and real animated GLBs. They prove the browser can render and update server-authoritative state; they do not establish physical-world guide alignment.

## Still needed for the connected demo

- Project keys are present and the configuration endpoint reports readiness. Recheck the earlier anonymous-sign-in failure and verify the real browser upload → private Storage → queue → local generation path. Project creation and migrations are complete; this removal pass did not perform a new paid end-to-end attempt.
- Exercise real WebRTC voice with the local supervisor, including interruption, budget/expiry and cleanup.
- Run actual espresso, cooking and assembly videos through the complete flow and inspect goal inference, equipment, gestures, narration, video export and public-preview privacy.
- Check usability and rendering performance on physical iPhone and Android devices. Sample images and browser emulation do not establish a 30 FPS result.

The illustrative examples remain labeled as examples. No unit test or generated sample is substituted for successful generation from the user's footage.
