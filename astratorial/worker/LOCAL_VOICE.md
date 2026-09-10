# Voice on your computer

The local demo can run the conversational instructor without a Modal account. This small server only supervises voice sessions. It reuses the cloud worker's Realtime guard, shares the persisted **$2 or ten-minute** session allowance, and never executes scene-generation scripts.

From the `astratorial` directory:

```sh
python3 -m venv worker/.venv
worker/.venv/bin/python -m pip install -r worker/requirements-local-voice.txt
worker/.venv/bin/python worker/local_voice.py
```

Keep this process and the Next.js app running. It binds only to `127.0.0.1:8766`; the phone connects to the Next.js app, which negotiates the voice connection. Configure these entries in the app's ignored `.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_KEY
OPENAI_API_KEY=YOUR_REPLACEMENT_SERVER_ONLY_KEY
NEXT_PUBLIC_APP_URL=http://localhost:4173
LOCAL_WORKER_TOKEN=YOUR_RANDOM_SERVER_ONLY_TOKEN
LOCAL_VOICE_URL=http://127.0.0.1:8766/voice
```

`NEXT_PUBLIC_APP_URL` must be reachable from this process and point to the running Next.js server. For a phone demo, the browser needs HTTPS to grant microphone and camera access; the voice supervisor can still call the local app at the loopback URL. Run one voice process with one Uvicorn worker. No cloud hosting payment is required for this process, but actual OpenAI usage still uses the configured API account.

The app does not release its WebRTC answer until supervision is attached. An independent timer ends a session at its persisted expiration even if its conversation stalls. Graceful shutdown hangs up current calls. The process checks the database every five seconds to terminate expired calls and reattach active calls after a restart. If the computer is shut down or loses its network, the local process cannot enforce a remote deadline until it comes back; keep the computer awake for the demo. Use the separate Modal watchdog for a deployment that must survive loss of this computer.

The default conservative pricing ledger matches the documented worker ceilings. `WORKER_PRICE_CEILINGS_JSON` can increase these ceilings, but this local runner refuses values below the checked-in defaults.

```sh
worker/.venv/bin/python -m unittest worker/tests/test_local_voice.py -v
```

These tests use simulated provider/DB responses to check authentication, failed attachment, missing/expired sessions, idempotent retries, cleanup, and deadline enforcement. They do not create a paid voice call.
