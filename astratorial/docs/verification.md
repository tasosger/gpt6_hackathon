# Verification record

Updated September 10, 2026. The hackathon pass added real Supabase provisioning and bounded OpenAI smoke tests using the user-authorized server-side key. No Modal GPU job or real room reconstruction was performed. The app now has an illustrated CPU generation mode in addition to the optional measured pipeline.

| Check | Result | Scope |
| --- | --- | --- |
| Next.js production build | Passed | All application/API routes compile and generate successfully. |
| TypeScript / ESLint | Passed | Application, contracts, server APIs, and browser tests. |
| Vitest | 34 passed | Camera fitting, camera motion, authorization/configuration, server progress, budgets and publication boundaries. |
| Worker tests | 34 passed | Orchestration, geometry mathematics, format handling, cost reservations, checkpoint recovery, repair limits and local voice supervision. Six native cases are skipped in this environment. |
| Native geometry tests | 6 passed separately | Pinned pycolmap 4.2.0 / Open3D 0.19.0: rigid alignment, symmetry rejection, distortion/occlusion, thin surfaces, overlap/UV preservation and fixed camera poses. |
| PostgreSQL checks | Passed | Disposable PostgreSQL migration/RLS, atomic queues/leases, revision budgets, voice/expert races and adversarial upload reservations. Queue transport uses a pgmq test double. |
| Playwright | 20 passed | Desktop Chrome and mobile Chrome emulation against the production build, including video-first inference, interrupted uploads, illustrated/manual guide alignment, measured alignment and recovery. Two workers avoid concurrent software 3D rendering contention; timeouts were not increased. |
| Interrupted transfer regression | Passed | Real tus-js-client with a simulated transport: reload/reselect, renew authorization, resume at byte 6,291,456, complete and enqueue analysis. One ticket creation and one renewal. |
| Long-session media regression | Passed | Simulated four-minute refresh renewed narration and video links while retaining the loaded GLB and both audio/timeline positions; changed revisions reset playback; revoked access removed the tutorial. |
| Hosted Supabase | Passed | Created free project `kvvbeiolpuyvexeliowi`; applied migrations 001/002, recorded history, verified all eight application tables use RLS and both buckets are private with 50 MB limits. Real pgmq create/claim/heartbeat/budget/checkpoint/archive lifecycle passed inside a rolled-back test transaction. |
| Real Astra and narration | Passed, bounded sample | With no typed goal, Astra inferred a four-step pasta task from an existing generated sample image, authored five scene objects, and produced an animated GLB (~1.04 MB). Real OpenAI speech, browser rendering and a five-second scene video also passed. This is not a real phone capture acceptance test. |
| Phone HTTPS origin | Passed to setup boundary | The temporary HTTPS tunnel reaches the local app. Only its explicitly configured origin can submit requests; forged forwarding headers remain rejected. Guest creation currently stops at missing project API-key configuration. |
| Credential scan | Passed | No project API key found in application, worker, migrations, docs or templates. Environment templates contain no usable credentials. |

Browser tests cover home filtering, all core routes, horizontal overflow, first/third/free cameras, play/pause, timeline seeking, speed, permission denial, actual animated GLB loading and optional detail, sharing-modal keyboard behavior, and review of the exact public text and scene. New tests verify upload → guest → blank-goal draft → analysis → editable inferred goal without a preceding form, 50 MB rejection, and manual positioning of illustrated ghost hands with server-authoritative checks and progress.

The camera integration uses a deterministic generated video stream, eight projected world landmarks and a real animated GLB. The browser solves the camera fit, renders the ghost materials, and exercises pause/resume/repeat without marking the physical step complete. This proves the browser pipeline can execute; it does **not** establish physical-world alignment accuracy or performance on an actual phone.

The worker's fixture suite and its latest count are reported in [the pipeline guide](pipeline.md). Those tests cover pure geometry, source formats, costs, checkpoints and isolation contracts. They do not execute the Docker image or prove photoreal scene quality.

Still required for the connected hackathon demo:

- Copy the new project's anon and service-role keys into ignored `.env.local`, enable dashboard anonymous sign-ins, and verify the real browser upload → storage → queue → local generation path. Project creation and database setup are already complete; Chrome automation became stuck on an invisible menu while retrieving these settings.
- Exercise real WebRTC voice with the local supervisor, including interruption, budget/expiry and cleanup.
- Run actual espresso, cooking and assembly videos through the complete flow and check physical-phone usability. Sample images and emulation do not establish this result.

For the optional measured release, also build/smoke-test the exact Modal worker image and sandbox isolation, verify reconstruction/animation against held-out source footage and independent measurements, and measure 30 FPS plus initial assets under 20 MB on representative physical phones. The illustrated hackathon path makes no metric alignment or photorealism claim.

The illustrative example scenes are intentionally marked as examples. No test result is substituted for successful generation from the user's footage.
