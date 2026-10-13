# AGENTS.md

- Stack: Node >=20, ESM (`.mjs`), zero dependencies. No build step.
- Commands: `npm start` (run all stages), `node cli/vre.mjs stage <name>` (one stage), `npm run lint`, `npm test`, `node cli/vre.mjs mod rebuild|launch` (modded copy, stage 06; mods live in `mods/`).
- Boundary rule: stages (`stages/*`) never import other stages or `cli/`; they talk only via `out/` folders and `out/manifest.json`. Only `cli/registry.mjs` knows stage order. Lint enforces this.
- Stages not yet implemented must report `status: "stub"`, never fake success.
- Real input: `--input <VY.exe>` or env `VRE_INPUT`; stage 01 needs 7-Zip (`7z`/`7za`/`7zz` or `VRE_7Z`). Tests must not depend on VY.exe or 7-Zip (CI has neither).
- CI lives in `.github/workflows/ci.yml` (runs lint + test) and must stay green; keep it in sync with the commands above.
- 06-mod must never write to the installed Voyager or flip fuses; the copy goes to `out/06-mod/` only. Tests must not depend on an installed Voyager.
- Never commit with `--no-verify`.

## Platform CLIs

Installed and yours to run — use them directly; never send the user to a dashboard for something these answer:
- `gh` — PRs, issues, CI run logs, releases. Auth failure → ask the user to run `gh auth login`, then retry.
