# AGENTS.md

For AI coding agents working in this repository (the `@groovesheet/sdk` npm
package and its `groovesheet` CLI) or using it from another project.

## This repository

- `src/index.ts`: the `GrooveSheet` client, typed against `src/schema.ts`,
  which is generated from `openapi.json` (`npm run generate` refetches the
  live document from https://api.groovesheet.net/openapi.json with a browser
  User-Agent, since Cloudflare refuses bare tool UAs). Never edit
  `src/schema.ts` by hand.
- `src/cli.ts`: the command line tool, `node:util` parseArgs only.
- `test/`: `node:test` against `test/fake-server.mjs`. No test may call
  production; a live smoke test is `node dist/cli.js search "easy on me"`.
- `npm run build && npm test` must pass before a commit. Bump `version` in
  `package.json` for a release; `npm publish` runs `prepublishOnly`.
- Keep the runtime dependency list to `openapi-fetch`. Node 20 or newer.
- No em dashes in any file. No prices in copy: link to
  https://www.groovesheet.net/pricing.

## Facts about the service

- Production `https://api.groovesheet.net` charges the account's minutes for
  a full song; the sandbox `https://api.groovesheet.net/sandbox` (option
  `sandbox: true`, flag `--sandbox`) charges nothing and needs no token.
- Tokens are OAuth 2.1 (dynamic client registration is open) or the
  verified-email flow the CLI's `login` command runs; there is no API key.
  See https://www.groovesheet.net/auth.md.
- A job is `POST /workflow/{name}` -> 202 -> poll `/workflow/status/{id}` ->
  download `outputs.files`. Send `Idempotency-Key` on the start request.
- More for agents: https://www.groovesheet.net/llms.txt,
  https://www.groovesheet.net/agents.md, https://github.com/groovesheet/groovesheet-mcp.
