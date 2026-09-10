# Local worker utilities

Tutorial generation runs on your computer through `npm run worker` from the app directory. Its TypeScript implementation lives in `lib/local/`; it uses bounded media processing and validated scene descriptions to build the illustrated tutorial. It does not execute model-generated Python or require a GPU service.

The Python process in this directory provides the conversational instructor. Follow [LOCAL_VOICE.md](LOCAL_VOICE.md), or use `npm run demo` to start the app, tutorial worker, and voice process together. OpenAI requests still use your API account.

`astratorial/` also contains independent geometry, artifact, and budget validation utilities. `geometry_tools/` retains geometry research helpers for measured scans; these are not part of the active tutorial-generation flow and do not launch a render service. The optional native tests require Open3D 0.19.0 and pycolmap 4.2.0.

Run the Python tests after installing the test dependencies:

```sh
python3 -m venv worker/.venv
worker/.venv/bin/python -m pip install -r worker/requirements.txt
worker/.venv/bin/python -m unittest discover -s worker/tests -v
```

Native geometry tests skip automatically when their optional dependencies are unavailable. The local voice tests use simulated provider and database responses; they do not incur API charges.
