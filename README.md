# vre

Lean, modular reverse-engineering pipeline for `VY.exe` (uni assignment).
Zero dependencies, Node >= 20.

Stages run in order; each reads the previous stage's output folder and records an entry in `out/manifest.json`.

| Stage | Purpose |
|---|---|
| `01-installer` | Unpack the installer |
| `02-asar` | Extract the Electron asar |
| `03-js` | Process the extracted JavaScript |

```
npm start                              # run all stages
node cli/vre.mjs stage 02-asar         # run one stage
npm run lint && npm test
```

Stages are currently **stubs**: they record `status: "stub"` and do no real work. See `docs/README.md`.
