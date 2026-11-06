# @groovesheet/sdk

The official SDK and command line for [GrooveSheet](https://www.groovesheet.net), the AI music transcription service by Kelin Studio Pte. Ltd. (Singapore). Search the sheet music library, turn audio into sheet music, MIDI and stems, poll jobs and download the results.

- TypeScript, ESM, Node 20 or newer. One runtime dependency (`openapi-fetch`).
- Typed against the live [OpenAPI document](https://api.groovesheet.net/openapi.json) (bundled as `openapi.json`).
- A `groovesheet` command for the terminal.

> **Minutes and cost.** Transcribing a full song in production uses minutes from your GrooveSheet account. Searching the library, reading song details and listing workflows are free and need no account. The **sandbox never charges**: it needs no token and answers with canned outputs of a demo song, so you can build and test an integration before you spend anything.

## Install

```sh
npm i @groovesheet/sdk
npx @groovesheet/sdk search "easy on me"
```

## SDK quickstart

```ts
import { GrooveSheet } from '@groovesheet/sdk';

const gs = new GrooveSheet({ token: process.env.GROOVESHEET_TOKEN });

const { tracks } = await gs.searchSongs({ query: 'easy on me', instrument: 'piano' });
console.log(tracks[0].title, tracks[0].artist);          // no token needed for the library

const job = await gs.transcribe({ file: './song.mp3', instrument: 'piano' });  // uses account minutes
const done = await gs.waitForJob(job.workflow_id, { onUpdate: (j) => console.log(j.status, j.progress) });
const files = await gs.saveOutputs(done.workflow_id, './out');   // MIDI, MusicXML, ...
console.log(files.map((f) => f.path));
```

To try it for free, construct the client with `sandbox: true` (no token needed).

### Methods

| Method | Does |
| --- | --- |
| `searchSongs({ query, instrument?, format?, page?, limit?, sort? })` | `GET /library/tracks`. `format` is `sheet`, `midi` or `stems`. Setting `page` adds `total` and `pages`. |
| `getSong(idOrSlug)` | `GET /library/tracks/{id}`: the song, its assets and per-part facts. |
| `getSongs(ids)` | `POST /library/tracks/batch`: several songs (50 per request, longer lists are split), returns `{ tracks }` in order with `null` for unknown ids. |
| `listWorkflows()` | `GET /workflows`: every workflow name and description. |
| `transcribe({ file, filename?, workflow?, instrument?, metadata?, idempotencyKey? })` | `POST /workflow/{name}`. `file` is a path, a `Blob` or bytes. Returns the 202 body (`workflow_id`, `status_url`). |
| `getJob(id)` | `GET /workflow/status/{id}`. |
| `waitForJob(id, { intervalMs = 5000, timeoutMs?, onUpdate?, signal? })` | Polls until `completed`; rejects with `JobFailedError` if the job fails, `JobTimeoutError` on timeout. Waits out a 429 on its own. |
| `downloadFile(id, fileKey)` / `downloadAll(id)` | A streaming `Response` for one output file, or the zip of all of them. |
| `saveOutputs(id, dir)` | Writes every file in `outputs.files` into `dir`. |
| `listJobs({ limit?, offset? })` | `GET /workflow/list`. |
| `getAccount()` | `GET /user/account`: profile, plan and minutes balance. |
| `GrooveSheet.login({ email, baseUrl?, onCode })` | Verified-email sign-in (see Auth). Resolves to the token set. |
| `GrooveSheet.refresh({ refreshToken, accessToken })` | Exchange a refresh token for a new token set. |

Constructor options: `{ token?, baseUrl?, sandbox?, fetch?, userAgent? }`. Every request sends `User-Agent: groovesheet-sdk/<version> (+https://www.groovesheet.net/developers)`, `Accept: application/json`, `API-Version: 2` and `Authorization: Bearer <token>` when a token is set.

Pass `idempotencyKey` to `transcribe` when you retry: the same key within 24 hours returns the first answer instead of starting (and charging for) a second job.

### Errors

Any non-2xx answer throws a `GrooveSheetError` with `status`, `detail` (the server's message), `code` (OAuth error code when there is one), `retryAfter` (seconds, from `Retry-After`, set on 429 and on 409 while a request is in flight), `rateLimit` (`limit`, `remaining`, `reset`, `policy` from the `RateLimit-*` headers) and the parsed `body`.

```ts
try {
  await gs.getSong('no-such-song');
} catch (err) {
  if (err instanceof GrooveSheetError && err.status === 429) await new Promise((r) => setTimeout(r, (err.retryAfter ?? 5) * 1000));
}
```

### Instruments and workflows

`transcribe({ instrument })` picks the same workflow chain the web app starts today. Use `workflow` for anything else; `listWorkflows()` lists them all.

| `instrument` | Workflow | Result |
| --- | --- | --- |
| `drums` | `separate_to_drumscore_v2_full` | drum MIDI and MusicXML |
| `piano` | `separate_to_piano_score_full` | piano MIDI and MusicXML |
| `bass` | `separate_to_hfmt_bass_score_full` | bass MIDI and MusicXML |
| `guitar` | `separate_to_guitar_score_full` | guitar MIDI, notation and tab |
| `chords` | `chords_from_mix_full` | chord chart |
| `stems` | `bs_roformer_separate` | six stems (vocals, drums, bass, guitar, piano, other) |

## CLI

```sh
npx @groovesheet/sdk search "easy on me"      # or: npm i -g @groovesheet/sdk, then `groovesheet ...`
```

| Command | Does |
| --- | --- |
| `groovesheet search <query> [--instrument x] [--format sheet\|midi\|stems] [--page n] [--limit n] [--json]` | Search the library. |
| `groovesheet song <id-or-slug> [--json]` | One song and its parts. |
| `groovesheet workflows [--json]` | List every workflow. |
| `groovesheet transcribe <file> (--instrument drums\|piano\|bass\|guitar\|chords\|stems \| --workflow name) [--wait] [--out dir] [--json]` | Start a job; with `--wait` poll to the end, with `--out` also save the files. |
| `groovesheet job <id> [--wait] [--json]` | Show a job, or wait for it. |
| `groovesheet jobs [--limit n] [--json]` | Your recent jobs. |
| `groovesheet download <id> [file_key] [--out dir]` | Save one output file, or all of them. |
| `groovesheet account [--json]` | Plan and minutes left. |
| `groovesheet login --email you@example.com` | Sign in; stores a token. |
| `groovesheet logout` | Delete the stored token. |
| `groovesheet help`, `groovesheet --version` | Help and version. |

Global flags: `--sandbox`, `--api-url <url>`, `--token <token>`, `--json` (print the raw JSON). Environment: `GROOVESHEET_TOKEN`, `GROOVESHEET_API_URL`, `GROOVESHEET_SANDBOX=1`.

Exit codes: `0` ok, `1` API or job error (message on stderr), `2` usage error.

## Auth

Searching the library and listing workflows need no token. Everything that touches your account (transcribing, jobs, downloads, account) needs an OAuth 2.1 bearer token, identical to the one the web app and MCP server use. There are no API keys. The REST API is in private beta; email support@groovesheet.net with what you are building.

**Verified-email login (CLI and scripts).** No browser is needed on the machine running the code:

```sh
groovesheet login --email you@example.com
```

It prints a 6-digit code and a link. Open the link, type the code, sign in to groovesheet.net with that same email and click Allow. The CLI polls, then saves the token set to `~/.config/groovesheet/credentials.json` (mode 0600) and refreshes it when it expires. `groovesheet logout` deletes the file. In code:

```ts
const tokens = await GrooveSheet.login({
  email: 'you@example.com',
  onCode: (code, uri) => console.log(`Open ${uri} and enter ${code}`),
});
const gs = new GrooveSheet({ token: tokens.access_token });
```

**Token from the environment.** Set `GROOVESHEET_TOKEN` (or pass `--token`, or `new GrooveSheet({ token })`). A token given this way wins over a saved login.

**Sandbox.** `--sandbox` (CLI), `GROOVESHEET_SANDBOX=1` or `new GrooveSheet({ sandbox: true })` switches the base URL to `https://api.groovesheet.net/sandbox`. The library and workflow reads behave like production. `POST /sandbox/workflow/{name}` accepts any file, needs no token, charges nothing and completes in about 15 to 20 seconds with the real outputs of a fixed demo song (Easy On Me by Adele); sandbox job ids start with `SBX` and expire after 24 hours. Use it to wire up and test your integration. A saved login is not sent to the sandbox.

## Links

- Developer docs: https://www.groovesheet.net/developers/docs
- OpenAPI document: https://api.groovesheet.net/openapi.json
- For LLMs and agents: https://www.groovesheet.net/llms.txt
- MCP server (no sign-in, searches the library): https://api.groovesheet.net/mcp/public
- Support: support@groovesheet.net

## Development

```sh
npm install
npm test            # builds, then runs the node:test suite against a local fake server
npm run generate    # refresh openapi.json and src/schema.ts from the live API
```

MIT licensed. Copyright 2026 Kelin Studio Pte. Ltd.
