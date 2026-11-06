#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_BASE_URL,
  GrooveSheet,
  GrooveSheetError,
  INSTRUMENT_WORKFLOWS,
  INSTRUMENTS,
  JobFailedError,
  JobTimeoutError,
  VERSION,
  type Instrument,
  type Job,
  type SongFormat,
  type TokenSet,
  type TrackDetail,
} from './index.js';

class UsageError extends Error {}

const HELP = `groovesheet ${VERSION}: search the GrooveSheet library, transcribe audio, download results.

Usage: groovesheet <command> [options]

Commands
  search <query>               Search songs   [--instrument x] [--format sheet|midi|stems] [--page n] [--limit n]
  song <id-or-slug>            Show one song and its parts
  workflows                    List every workflow
  transcribe <file>            Start a job   (--instrument drums|piano|bass|guitar|chords|stems | --workflow name)
                               [--wait] [--out dir] [--idempotency-key k]
  job <id>                     Show a job   [--wait]
  jobs                         List your recent jobs   [--limit n]
  download <id> [file_key]     Save a job's outputs   [--out dir]
  account                      Show your plan and minutes
  login --email you@x.com      Sign in (prints a code and a link), saves a token
  logout                       Delete the saved token
  help                         This text

Global options
  --json                       Print the raw JSON instead of a table
  --sandbox                    Use the free sandbox (no token, no charge, demo outputs)
  --api-url <url>              API root (default ${DEFAULT_BASE_URL})
  --token <token>              Bearer token (default: saved login)
  -h, --help                   This text
  -v, --version                Print the version

Environment
  GROOVESHEET_TOKEN, GROOVESHEET_API_URL, GROOVESHEET_SANDBOX=1

Transcribing a full song in production uses your account's minutes. The sandbox never charges.
Docs: https://www.groovesheet.net/developers/docs
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  sandbox: { type: 'boolean' },
  'api-url': { type: 'string' },
  token: { type: 'string' },
  instrument: { type: 'string' },
  format: { type: 'string' },
  page: { type: 'string' },
  limit: { type: 'string' },
  workflow: { type: 'string' },
  wait: { type: 'boolean' },
  out: { type: 'string' },
  email: { type: 'string' },
  'idempotency-key': { type: 'string' },
} as const;

type Parsed = ReturnType<typeof parse>;

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

type Out = (text: string) => void;
const out: Out = (text) => process.stdout.write(`${text}\n`);
const err: Out = (text) => process.stderr.write(`${text}\n`);

function table(rows: string[][], header: string[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? '').padEnd(widths[i]))).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
}

function mmss(seconds?: number | null): string {
  if (!seconds && seconds !== 0) return '';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function jsonOut(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

function intFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a whole number of 1 or more.`);
  return n;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface StoredCredentials extends TokenSet {
  api_url?: string;
  email?: string;
}

function credentialsPath(): string {
  return path.join(os.homedir(), '.config', 'groovesheet', 'credentials.json');
}

async function readCredentials(): Promise<StoredCredentials | undefined> {
  try {
    const data = JSON.parse(await readFile(credentialsPath(), 'utf8')) as StoredCredentials;
    return typeof data.access_token === 'string' ? data : undefined;
  } catch {
    return undefined;
  }
}

async function writeCredentials(data: StoredCredentials): Promise<string> {
  const file = credentialsPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600); // writeFile's mode only applies when it creates the file
  return file;
}

// ---------------------------------------------------------------------------
// Settings from flags and environment
// ---------------------------------------------------------------------------

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

interface Settings {
  sandbox: boolean;
  apiUrl: string;
  token?: string;
}

async function settings(values: Parsed['values'], env: NodeJS.ProcessEnv): Promise<Settings> {
  const sandbox = values.sandbox === true || truthy(env.GROOVESHEET_SANDBOX);
  const apiUrl = values['api-url'] || env.GROOVESHEET_API_URL || DEFAULT_BASE_URL;
  let token = values.token || env.GROOVESHEET_TOKEN || undefined;
  // The sandbox needs no token, so a saved (possibly stale) login is not sent to it.
  if (!token && !sandbox) token = await storedToken(apiUrl);
  return { sandbox, apiUrl, token };
}

async function storedToken(apiUrl: string): Promise<string | undefined> {
  let creds = await readCredentials();
  if (!creds) return undefined;
  const expired = creds.expires_at !== undefined && creds.expires_at < Math.floor(Date.now() / 1000) + 60;
  if (expired && creds.refresh_token) {
    try {
      const fresh = await GrooveSheet.refresh({
        refreshToken: creds.refresh_token,
        accessToken: creds.access_token,
        baseUrl: creds.api_url ?? apiUrl,
      });
      creds = { ...creds, ...fresh };
      await writeCredentials(creds);
    } catch {
      err('Your saved sign-in has expired and could not be refreshed. Run `groovesheet login` again.');
    }
  }
  return creds.access_token;
}

function client(s: Settings): GrooveSheet {
  return new GrooveSheet({ token: s.token, baseUrl: s.apiUrl, sandbox: s.sandbox, userAgent: `groovesheet-cli/${VERSION}` });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdSearch(gs: GrooveSheet, p: Parsed): Promise<void> {
  const query = p.positionals.slice(1).join(' ').trim();
  if (!query) throw new UsageError('search needs a query, for example: groovesheet search "easy on me"');
  const format = p.values.format;
  if (format) {
    for (const f of format.split(',')) {
      if (!['sheet', 'midi', 'stems'].includes(f.trim())) throw new UsageError('--format must be sheet, midi or stems.');
    }
  }
  const result = await gs.searchSongs({
    query,
    instrument: p.values.instrument,
    format: format?.split(',').map((f) => f.trim()) as SongFormat[] | undefined,
    page: intFlag('page', p.values.page) ?? 1,
    limit: intFlag('limit', p.values.limit),
  });
  if (p.values.json) return jsonOut(result);
  if (!result.tracks.length) return out(`No songs found for "${query}".`);
  out(
    table(
      result.tracks.map((t) => [clip(t.title, 40), clip(t.artist, 28), (t.formats ?? []).join(','), t.slug ?? t.id]),
      ['TITLE', 'ARTIST', 'FORMATS', 'SLUG'],
    ),
  );
  const shown = result.tracks.length;
  out(
    result.total !== undefined
      ? `\n${shown} of ${result.total} result${result.total === 1 ? '' : 's'} (page ${result.page} of ${result.pages}). Details: groovesheet song <slug>`
      : `\n${shown} result${shown === 1 ? '' : 's'}. Details: groovesheet song <slug>`,
  );
}

function describeSong(song: TrackDetail): string {
  const lines: string[] = [];
  const facts = song.music_facts?.song;
  lines.push(`${song.title}${song.artist ? `, ${song.artist}` : ''}${song.year ? ` (${song.year})` : ''}`);
  lines.push(`slug: ${song.slug ?? '-'}   id: ${song.id}`);
  const bits = [
    song.duration_sec ? mmss(song.duration_sec) : '',
    facts?.bpm ? `${facts.bpm} bpm` : '',
    facts?.key?.tonic ? `${facts.key.tonic} ${facts.key.mode ?? ''}`.trim() : '',
    facts?.meter ?? '',
  ].filter(Boolean);
  if (bits.length) lines.push(bits.join(', '));
  if (song.slug) lines.push(`https://www.groovesheet.net/explore/${song.slug}`);

  const parts = new Map<string, Map<string, Set<string>>>();
  for (const a of song.assets ?? []) {
    const part = a.stem_name ?? '(song)';
    const kinds = parts.get(part) ?? new Map<string, Set<string>>();
    const fmts = kinds.get(a.asset_type) ?? new Set<string>();
    fmts.add(a.format);
    kinds.set(a.asset_type, fmts);
    parts.set(part, kinds);
  }
  if (parts.size) {
    lines.push('', 'Parts:');
    const rows = [...parts.entries()].map(([part, kinds]) => {
      const extra = song.music_facts?.parts?.[part];
      return [
        part,
        [...kinds.entries()].map(([kind, fmts]) => (kind === 'stem' ? `stem(${[...fmts].join('/')})` : kind)).join(' '),
        extra?.level ?? '',
        extra?.notes !== undefined ? `${extra.notes} notes` : '',
      ];
    });
    lines.push(table(rows, ['PART', 'FILES', 'LEVEL', 'NOTES']).split('\n').map((l) => `  ${l}`).join('\n'));
  }
  return lines.join('\n');
}

async function cmdSong(gs: GrooveSheet, p: Parsed): Promise<void> {
  const ref = p.positionals[1];
  if (!ref) throw new UsageError('song needs an id or slug, for example: groovesheet song easy-on-me-adele-0fff6be3');
  const song = await gs.getSong(ref);
  if (p.values.json) return jsonOut(song);
  out(describeSong(song));
}

async function cmdWorkflows(gs: GrooveSheet, p: Parsed): Promise<void> {
  const result = await gs.listWorkflows();
  if (p.values.json) return jsonOut(result);
  const byWorkflow = new Map<string, string>();
  for (const [instrument, name] of Object.entries(INSTRUMENT_WORKFLOWS)) byWorkflow.set(name, instrument);
  out(
    table(
      result.workflows.map((w) => [w.name, byWorkflow.get(w.name) ?? '', clip(w.description, 90)]),
      ['WORKFLOW', '--INSTRUMENT', 'DESCRIPTION'],
    ),
  );
}

function jobLine(job: Job): string {
  const files = Object.keys(job.outputs?.files ?? {});
  const bits = [
    job.workflow_id,
    String(job.status).padEnd(17),
    job.progress !== undefined ? `${job.progress}%` : '',
    job.workflow_name ?? '',
  ].filter((b) => b !== '');
  let line = bits.join('  ');
  if (job.status === 'completed' && files.length) line += `\nfiles: ${files.join(', ')}`;
  if (job.status === 'failed' && job.error) line += `\nerror: ${job.error}`;
  return line;
}

function progressPrinter(): (job: Job) => void {
  let last = '';
  return (job) => {
    const state = `${job.status} ${job.progress ?? ''}`;
    if (state !== last) {
      last = state;
      err(`  ${job.workflow_id}: ${job.status}${job.progress !== undefined ? ` ${job.progress}%` : ''}`);
    }
  };
}

function waitIntervalMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.GROOVESHEET_POLL_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

async function cmdTranscribe(gs: GrooveSheet, p: Parsed, s: Settings, env: NodeJS.ProcessEnv): Promise<void> {
  const file = p.positionals[1];
  if (!file) throw new UsageError('transcribe needs a file, for example: groovesheet transcribe song.mp3 --instrument piano');
  const instrument = p.values.instrument;
  const workflow = p.values.workflow;
  if (!instrument && !workflow) {
    throw new UsageError(`transcribe needs --instrument (${INSTRUMENTS.join('|')}) or --workflow <name>. See: groovesheet workflows`);
  }
  if (instrument && !INSTRUMENTS.includes(instrument as Instrument)) {
    throw new UsageError(`--instrument must be one of: ${INSTRUMENTS.join(', ')}.`);
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    throw new UsageError(`Cannot read ${file}.`);
  }
  if (!s.sandbox) err('Note: this uses minutes from your GrooveSheet account. Add --sandbox to try it for free.');

  const started = await gs.transcribe({
    file,
    instrument: instrument as Instrument | undefined,
    workflow,
    idempotencyKey: p.values['idempotency-key'],
  });
  if (!p.values.wait) {
    if (p.values.json) return jsonOut(started);
    out(`Started ${started.workflow_id} (${started.workflow_name}).`);
    out(`Check it with: groovesheet job ${started.workflow_id} --wait`);
    return;
  }

  err(`Started ${started.workflow_id} (${started.workflow_name}). Waiting...`);
  const job = await gs.waitForJob(started.workflow_id, {
    intervalMs: waitIntervalMs(env),
    onUpdate: progressPrinter(),
  });
  const saved = p.values.out ? await gs.saveOutputs(job.workflow_id, p.values.out, { job }) : undefined;
  if (p.values.json) return jsonOut(saved ? { ...job, saved } : job);
  out(jobLine(job));
  if (saved) for (const f of saved) out(`saved ${f.path} (${f.bytes} bytes)`);
  else if (Object.keys(job.outputs?.files ?? {}).length) out(`Save them with: groovesheet download ${job.workflow_id} --out <dir>`);
}

async function cmdJob(gs: GrooveSheet, p: Parsed, env: NodeJS.ProcessEnv): Promise<void> {
  const id = p.positionals[1];
  if (!id) throw new UsageError('job needs a job id, for example: groovesheet job WF1234abcd --wait');
  const job = p.values.wait
    ? await gs.waitForJob(id, { intervalMs: waitIntervalMs(env), onUpdate: progressPrinter() })
    : await gs.getJob(id);
  if (p.values.json) return jsonOut(job);
  out(jobLine(job));
}

async function cmdJobs(gs: GrooveSheet, p: Parsed): Promise<void> {
  const result = await gs.listJobs({ limit: intFlag('limit', p.values.limit) });
  if (p.values.json) return jsonOut(result);
  if (!result.items.length) return out('No jobs yet.');
  out(
    table(
      result.items.map((j) => [
        j.workflow_id,
        String(j.status),
        clip(j.workflow_name, 32),
        clip(String(j.display_title ?? j.title ?? j.metadata?.original_filename ?? ''), 36),
        (j.created_at ?? '').slice(0, 16).replace('T', ' '),
      ]),
      ['ID', 'STATUS', 'WORKFLOW', 'TITLE', 'CREATED'],
    ),
  );
  out(`\n${result.items.length} of ${result.total}.`);
}

async function cmdDownload(gs: GrooveSheet, p: Parsed): Promise<void> {
  const id = p.positionals[1];
  if (!id) throw new UsageError('download needs a job id, for example: groovesheet download WF1234abcd --out ./stems');
  const key = p.positionals[2];
  const dir = p.values.out ?? '.';
  const saved = key ? [await gs.saveFile(id, key, dir)] : await gs.saveOutputs(id, dir);
  if (p.values.json) return jsonOut(saved);
  if (!saved.length) return out('The job has no output files.');
  for (const f of saved) out(`saved ${f.path} (${f.bytes} bytes)`);
}

async function cmdAccount(gs: GrooveSheet, p: Parsed): Promise<void> {
  const account = await gs.getAccount();
  if (p.values.json) return jsonOut(account);
  const sub = account.subscription;
  out(`${account.profile.email ?? account.profile.user_id}${account.profile.display_name ? ` (${account.profile.display_name})` : ''}`);
  out(`plan: ${sub.tier}${sub.is_active ? '' : ' (inactive)'}`);
  const minutes = sub.balance_minutes ?? (sub.balance_seconds != null ? sub.balance_seconds / 60 : undefined);
  if (minutes != null) out(`minutes left: ${Math.round(minutes * 10) / 10}`);
  if (sub.next_recharge_at) out(`next recharge: ${sub.next_recharge_at}`);
}

async function cmdLogin(p: Parsed, s: Settings, env: NodeJS.ProcessEnv): Promise<void> {
  const email = p.values.email;
  if (!email) throw new UsageError('login needs --email, for example: groovesheet login --email you@example.com');
  const tokens = await GrooveSheet.login({
    email,
    baseUrl: s.apiUrl,
    userAgent: `groovesheet-cli/${VERSION}`,
    intervalMs: env.GROOVESHEET_POLL_MS ? waitIntervalMs(env) : undefined,
    onCode: (code, uri) => {
      err(`\nOpen this link and enter the code ${code}:\n  ${uri}\n`);
      err(`Sign in with ${email} and click Allow. Waiting for approval (Ctrl+C to cancel)...`);
    },
  });
  const file = await writeCredentials({ ...tokens, api_url: s.apiUrl, email });
  if (p.values.json) return jsonOut({ email, saved: file, expires_at: tokens.expires_at });
  out(`Signed in as ${email}. Token saved to ${file}`);
}

async function cmdLogout(p: Parsed): Promise<void> {
  const file = credentialsPath();
  await rm(file, { force: true });
  if (p.values.json) return jsonOut({ removed: file });
  out(`Signed out. Removed ${file}`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const p = parse(argv);
    if (p.values.version) {
      out(VERSION);
      return 0;
    }
    const command = p.positionals[0];
    if (p.values.help || command === 'help') {
      out(HELP.trimEnd());
      return 0;
    }
    if (!command) {
      err(HELP.trimEnd());
      return 2;
    }

    const known = ['search', 'song', 'workflows', 'transcribe', 'job', 'jobs', 'download', 'account', 'login', 'logout'];
    if (!known.includes(command)) throw new UsageError(`Unknown command "${command}".`);

    if (command === 'logout') {
      await cmdLogout(p);
      return 0;
    }
    const s = await settings(p.values, env);
    if (command === 'login') {
      await cmdLogin(p, s, env);
      return 0;
    }
    const gs = client(s);
    switch (command) {
      case 'search': await cmdSearch(gs, p); break;
      case 'song': await cmdSong(gs, p); break;
      case 'workflows': await cmdWorkflows(gs, p); break;
      case 'transcribe': await cmdTranscribe(gs, p, s, env); break;
      case 'job': await cmdJob(gs, p, env); break;
      case 'jobs': await cmdJobs(gs, p); break;
      case 'download': await cmdDownload(gs, p); break;
      case 'account': await cmdAccount(gs, p); break;
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`groovesheet: ${e.message}`);
      err("Run 'groovesheet help' for usage.");
      return 2;
    }
    if (e instanceof GrooveSheetError) {
      const hint =
        e.status === 401 ? ' Run `groovesheet login`, or pass --token / use --sandbox.' :
        e.retryAfter !== undefined ? ` Retry in ${e.retryAfter}s.` : '';
      err(`groovesheet: ${e.status} ${e.detail.replace(/[.\s]+$/, '')}.${hint}`);
      return 1;
    }
    if (e instanceof JobFailedError || e instanceof JobTimeoutError) {
      err(`groovesheet: ${e.message}`);
      return 1;
    }
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    err(`groovesheet: ${(e as Error).message}${cause?.message ? ` (${cause.message})` : ''}`);
    return 1;
  }
}

process.exitCode = await run(process.argv.slice(2));
