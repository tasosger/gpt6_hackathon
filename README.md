# Astratorial

The active application is in [`astratorial/`](astratorial/). Follow its [setup instructions](astratorial/README.md) to run the video-first tutorial website, local generation worker, and voice supervisor.

The separate [photo scene-generator prototype](prototypes/scene-generator/README.md) is preserved in `prototypes/scene-generator/`. It has its own dependencies and setup and is not mounted in the active application.

## Branch consolidation

`main` contains the application and the history of the former feature branches. `codex/astrotorial` is an exact copy of `main` at consolidation.

- The local hackathon pipeline, removal of Modal, automatic uploads, error feedback, and guest-only interface are integrated in the active application.
- The UI branch's logo and palette were already integrated. Its remaining mobile accessibility and tutorial-step improvements are retained. The old goal-first form, required measurement flow, and account controls were superseded by the latest video-first guest experience.
- Both commits from `feat/scene-generator`, through `9bbf959`, are preserved as a complete standalone prototype. Its original API does not use the active application's guest ownership or spending controls, so it remains separate.
- The previous stash was audited against the completed application. Its remaining branding and workspace configuration edits were committed; older copies of the same changes were superseded.

Generated verification screenshots, recordings, and scene files in `outputs/` remain local and are excluded from Git.

Consolidation checks passed: 87 application unit tests, four original prototype tests, TypeScript, ESLint, and the production build. Desktop/mobile browser verification passed 45 cases; the mobile-only navigation case was skipped on desktop.
