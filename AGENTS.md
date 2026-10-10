# AGENTS.md

- Stack: Node >=20, ESM (`.mjs`), zero dependencies. No build step.
- Commands: `npm start` (run all stages), `node cli/vre.mjs stage <name>` (one stage), `npm run lint`, `npm test`.
- Boundary rule: stages (`stages/*`) never import other stages or `cli/`; they talk only via `out/` folders and `out/manifest.json`. Only `cli/registry.mjs` knows stage order. Lint enforces this.
- Stages not yet implemented must report `status: "stub"`, never fake success.
- CI lives in `.github/workflows/ci.yml` (runs lint + test) and must stay green; keep it in sync with the commands above.
- Never commit with `--no-verify`.

## Platform CLIs

Installed and yours to run — use them directly; never send the user to a dashboard for something these answer:
- `gh` — PRs, issues, CI run logs, releases. Auth failure → ask the user to run `gh auth login`, then retry.
