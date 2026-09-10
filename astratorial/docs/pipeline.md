# Local tutorial generation

The website, TypeScript generation worker and Python voice supervisor run on one computer. Supabase provides authentication, PostgreSQL/pgmq and two private Storage buckets. OpenAI supplies visual understanding, planning, scene data, narration and live voice. See [setup and launch commands](../README.md#run-everything-on-this-computer).

## From video to tutorial

1. Selecting or recording a video creates an authenticated guest session, uploads through TUS, and queues a revision-scoped `generate` job. The upload begins the workflow; a typed goal or confirmation screen is not required.
2. `npm run worker` polls the durable `astratorial_jobs` queue every two seconds when idle. It claims a 180-second lease, renews it every 30 seconds and checks it before checkpoint writes and artifact uploads. One process handles one job at a time. A browser disconnect does not remove the job.
3. FFmpeg extracts bounded video frames and audio in a temporary local directory. Up to twelve sampled frames and a transcript inform the model; video speech is limited to 90 seconds. Legacy manual attachments can be read with Poppler. Completed ingest artifacts and text are checkpointed privately so later retries can reuse them.
4. Astra infers the goal primarily from the spoken instructions, identifies supplies and creates a concise plan. It may consult manufacturer sources with bounded web search when equipment is identifiable. It never inserts a follow-up question into this single-video flow. Assumptions belong in notes; hidden-state completion remains explicit.
5. Astra returns a validated scene description made of primitive shapes and timed gestures, with stable object and step IDs. Application code checks the required objects and gesture targets. It does not execute model-generated scripts. Three.js builds the generic instructor, objects and hand animation from that data.
6. OpenAI generates narration for each step. The worker saves completed clips, then bakes the scene and narration durations into one GLB timeline. First-person, third-person, free-camera and practice views use that timeline. Headless Chromium renders a preview from the exported GLB.
7. A separate export job renders that same scene to video and combines the saved narration using FFmpeg. Publishing prepares separate illustration assets for owner review; a preview is not public until confirmed.

The resulting scene is an illustration with approximate dimensions and placement. Camera practice uses manually positioned ghost guidance. No measured reconstruction or photorealistic room generation is connected to this workflow. Remaining Python geometry helpers are experimental offline utilities, not an alternative production pipeline.

## Recovery and local processing

Jobs, leases, checkpoints and reservations live in Supabase. The worker saves ingest, inferred plan, scene data and individual narration clips as it completes them. Restarting it reclaims eligible queued work after the previous lease expires and reuses saved checkpoints. Cancellation invalidates its lease; a stale worker cannot commit a new manifest. A process interrupted between an external charge and its checkpoint may retain a conservative charge reservation rather than assume that attempt was free.

Media commands have bounded execution times, file-format restrictions and a minimal subprocess environment. They run on the host computer, not inside a security sandbox. Rendering uses application-owned code and validated scene data. The worker deletes its temporary directory after an attempt; durable artifacts remain in private Storage.

Keep the computer awake and leave `npm run demo` or `npm run phone` running. No remote service wakes a stopped worker. The local voice supervisor also cleans expired camera-frame caches while it is running; reads refuse expired frames even when background cleanup is delayed.

## Voice supervision

`worker/local_voice.py` serves `http://127.0.0.1:8766/voice`. Configure `LOCAL_VOICE_URL` with that address and use the same `LOCAL_WORKER_TOKEN` in the local website and supervisor. The browser receives a Realtime WebRTC answer only after the supervisor acknowledges attachment of the server sideband. Only the guard creates authorized model responses.

The guard reserves bounded response costs in the database and shares a $2 allowance with source-grounded expert questions. A session lasts at most ten minutes while the supervisor is available. Tools request navigation, repeat, pause/resume, explanations or visual checks through owner-checked server operations; voice cannot assert physical completion. An independent task enforces the stored deadline within the same local process, and recovery attempts reattach persisted active sessions after restart.

This depends on the computer and network staying available. If both sideband supervision and the local deadline task stop, the app cannot enforce a remote hangup until service returns. See [local voice operation and tests](../worker/LOCAL_VOICE.md).

## Costs and publication

Generation reserves conservative amounts within the tutorial revision's $25 application allowance before each paid model operation. Resuming retains the ledger. Actual reported usage is recorded without hiding an overrun; unknown outcomes retain their reservation. Recorded narration uses a configured conservative charge estimate because speech responses do not return a final invoice. Local rendering has no metered worker hosting fee, but OpenAI calls remain billable and Supabase storage/bandwidth limits still apply. Application allowances are not a substitute for provider account limits.

Both Storage buckets remain private. The server authorizes reads and issues short-lived URLs. Illustration GLBs contain generated primitive geometry and plain materials, not captured frame textures. Public-copy jobs save that scene, generated narration and available rendered previews under separate paths. The public snapshot excludes source videos, transcripts, measurements, private notes and owner IDs. It does not claim to crop or rebake a measured room. The owner must inspect the public scene and text before confirmation.

## Acceptance still needed

Run actual household videos through upload, goal inference, generation, playback, export and camera practice. Check whether the equipment, controls, hand contacts and step timing are useful for each task. Test worker interruption, cancellation, budget pauses, denied permissions, voice expiration and publication visibility. Measure loading and frame rate on actual phones. Model and renderer smoke tests alone do not establish those results; see [the verification record](verification.md).
