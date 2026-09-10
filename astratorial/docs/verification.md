# Verification record

Recorded September 10, 2026. Tests ran locally. No request used the supplied API key; no hosted Supabase mutation or Modal GPU job was performed.

| Check | Result | Scope |
| --- | --- | --- |
| Next.js production build | Passed | All application/API routes compile and generate successfully. |
| TypeScript / ESLint | Passed | Application, contracts, server APIs, and browser tests. |
| Vitest | 26 passed | Camera fitting, camera motion, authorization/configuration, server progress, budgets and publication boundaries. |
| Worker tests | 29 passed | Orchestration, geometry mathematics, format handling, cost reservations, checkpoint recovery and repair limits. Six native cases are skipped in this environment. |
| Native geometry tests | 6 passed separately | Pinned pycolmap 4.2.0 / Open3D 0.19.0: rigid alignment, symmetry rejection, distortion/occlusion, thin surfaces, overlap/UV preservation and fixed camera poses. |
| PostgreSQL checks | Passed | Disposable PostgreSQL migration/RLS, atomic queues/leases, revision budgets, voice/expert races and adversarial upload reservations. Queue transport uses a pgmq test double. |
| Playwright | 14 passed | Desktop Chrome and mobile Chrome emulation against the production build, including the recovery tests below. |
| Interrupted transfer regression | Passed | Real tus-js-client with a simulated transport: reload/reselect, renew authorization, resume at byte 6,291,456, complete and enqueue analysis. One ticket creation and one renewal. |
| Long-session media regression | Passed | Simulated four-minute refresh renewed narration and video links while retaining the loaded GLB and both audio/timeline positions; changed revisions reset playback; revoked access removed the tutorial. |
| Credential scan | Passed | No project API key found in application, worker, migrations, docs or templates. Environment templates contain no usable credentials. |

Browser tests cover home filtering, all core routes, horizontal overflow, first/third/free cameras, play/pause, timeline seeking, speed, permission denial, actual animated GLB loading and optional detail, sharing-modal keyboard behavior, and review of the exact public text and scene.

The camera integration uses a deterministic generated video stream, eight projected world landmarks and a real animated GLB. The browser solves the camera fit, renders the ghost materials, and exercises pause/resume/repeat without marking the physical step complete. This proves the browser pipeline can execute; it does **not** establish physical-world alignment accuracy or performance on an actual phone.

The worker's fixture suite and its latest count are reported in [the pipeline guide](pipeline.md). Those tests cover pure geometry, source formats, costs, checkpoints and isolation contracts. They do not execute the Docker image or prove photoreal scene quality.

Still required for release acceptance:

- Provision Vercel, Supabase, Modal and a replacement server-side OpenAI key.
- Build/smoke-test the exact worker image and test network/credential isolation in real Modal sandboxes.
- Complete real espresso, cooking and furniture-assembly captures through measured reconstruction, animation review, narration, publication and camera practice.
- Verify independent dimensions within max(3%, 2 cm), every interaction surface and held-out source comparison.
- Measure 30 FPS and under-20-MB initial asset delivery on representative physical iPhone Safari and Android Chrome devices.
- Exercise live Realtime interruption, tampering, expiry and spend limits with the actual provider and sideband supervisor.

The illustrative example scenes are intentionally marked as examples. No test result is substituted for successful generation from the user's footage.
