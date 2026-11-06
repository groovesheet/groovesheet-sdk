import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import createClient from 'openapi-fetch';
import type { components, paths } from './schema.js';
import { VERSION } from './version.js';

export type { components, operations, paths } from './schema.js';
export { VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_URL = 'https://api.groovesheet.net';
/** Path prefix under the API host where the free, token-less sandbox lives. */
export const SANDBOX_PATH = '/sandbox';
export const API_VERSION = '2';
/** Most ids the batch routes take in one request. */
const BATCH_LIMIT = 50;
export const DEFAULT_USER_AGENT = `groovesheet-sdk/${VERSION} (+https://www.groovesheet.net/developers)`;

/**
 * Instrument choice to workflow name, the same chains the web app starts
 * today (HeroUploader on https://www.groovesheet.net).
 *
 * - `drums`, `piano`, `bass`, `guitar`: separate the mix, transcribe the part,
 *   quantize to MusicXML (MIDI comes along in the outputs).
 * - `chords`: chord chart from the full mix.
 * - `stems`: stem separation only.
 * - `midi`: quantize a MIDI file you already have into a MusicXML score
 *   (`midi2score_quantize`). The web app does not start this one; use the
 *   `workflow` option for anything not listed here (`listWorkflows()` has them all).
 */
export const INSTRUMENT_WORKFLOWS = {
  drums: 'separate_to_drumscore_v2_full',
  piano: 'separate_to_piano_score_full',
  bass: 'separate_to_hfmt_bass_score_full',
  guitar: 'separate_to_guitar_score_full',
  chords: 'chords_from_mix_full',
  stems: 'bs_roformer_separate',
  midi: 'midi2score_quantize',
} as const;

export type Instrument = keyof typeof INSTRUMENT_WORKFLOWS;
export const INSTRUMENTS = Object.keys(INSTRUMENT_WORKFLOWS) as Instrument[];

/** Instruments that are written into the job metadata (the web app does the same). */
const TRANSCRIBED_INSTRUMENTS = new Set<string>(['drums', 'piano', 'bass', 'guitar', 'chords']);

export function workflowForInstrument(instrument: string): string {
  const name = (INSTRUMENT_WORKFLOWS as Record<string, string>)[instrument];
  if (!name) {
    throw new TypeError(`Unknown instrument "${instrument}". Use one of: ${INSTRUMENTS.join(', ')}.`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Types (response bodies are not modelled in the OpenAPI document, so these are
// hand-written and deliberately loose: every object keeps unknown extra fields)
// ---------------------------------------------------------------------------

export type SongFormat = 'sheet' | 'midi' | 'stems';
export type SongSort = 'relevance' | 'popular' | 'newest' | 'oldest' | 'plays' | 'downloads' | 'title';

export interface Track {
  id: string;
  slug: string | null;
  title: string;
  artist: string | null;
  album?: string | null;
  year?: number | null;
  duration_sec?: number | null;
  /** Asset kinds available: stem, midi, musicxml, json, sync_map. */
  formats?: string[];
  cover_url?: string | null;
  plays?: number;
  downloads?: number;
  youtube_url?: string | null;
  published_at?: string | null;
  [key: string]: unknown;
}

export interface TrackAsset {
  id: string;
  track_id: string;
  /** stem | midi | musicxml | json | sync_map */
  asset_type: string;
  /** The part: piano, drums, bass, guitar, vocals, other, chords. */
  stem_name: string | null;
  format: string;
  file_key: string;
  note_view?: string | null;
  size_bytes?: number | null;
  stream_url?: string | null;
  [key: string]: unknown;
}

export interface TrackDetail extends Track {
  assets: TrackAsset[];
  music_facts?: {
    song?: { bpm?: number; key?: { tonic?: string; mode?: string }; bars?: number; meter?: string; [k: string]: unknown };
    parts?: Record<string, { level?: string; notes?: number; nps?: number; [k: string]: unknown }>;
    [key: string]: unknown;
  } | null;
}

export interface SearchResult {
  tracks: Track[];
  next_cursor: string | null;
  /** Present when `page` was requested. */
  total?: number;
  page?: number;
  pages?: number;
  limit?: number;
  [key: string]: unknown;
}

export interface SearchSongsOptions {
  query: string;
  /** Part names, e.g. `piano` or `['piano', 'drums']`. */
  instrument?: string | string[];
  /** `sheet`, `midi` or `stems`. */
  format?: SongFormat | SongFormat[];
  /** 1-based. Setting it switches the API to offset paging and adds `total`. */
  page?: number;
  limit?: number;
  sort?: SongSort;
}

export interface WorkflowInfo {
  name: string;
  description: string;
  steps: string[];
}

export type JobStatus = 'initializing' | 'started' | 'processing' | 'worker_processing' | 'completed' | 'failed';

export interface Job {
  workflow_id: string;
  workflow_name?: string;
  status: JobStatus | (string & {});
  progress?: number;
  credits_spent?: number;
  created_at?: string | null;
  completed_at?: string | null;
  display_title?: string;
  metadata?: { instrument?: string | null; duration_seconds?: number | null; original_filename?: string | null; [k: string]: unknown };
  /** Present once completed: `files` maps a file key to its storage path. */
  outputs?: { files?: Record<string, string>; metadata?: Record<string, unknown>; [k: string]: unknown };
  error?: string | null;
  error_details?: unknown;
  queue?: unknown;
  [key: string]: unknown;
}

export interface JobListItem extends Job {
  title?: string | null;
  is_preview?: boolean;
}

export interface JobList {
  items: JobListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** The 202 body of POST /workflow/{name}. */
export interface TranscribeResponse {
  workflow_id: string;
  workflow_name: string;
  status: string;
  message: string;
  status_url?: string | null;
}

export type AccountSummary = components['schemas']['AccountSummaryResponse'];

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
  /** Epoch seconds, computed locally from `expires_in`. */
  expires_at?: number;
  scope?: string;
}

export interface SavedFile {
  fileKey: string;
  path: string;
  bytes: number;
}

export interface GrooveSheetOptions {
  /** OAuth access token. Optional with `sandbox: true`. */
  token?: string;
  /** API root. Defaults to https://api.groovesheet.net. */
  baseUrl?: string;
  /** Use `<baseUrl>/sandbox`: free, no token, canned demo outputs. */
  sandbox?: boolean;
  /** Custom fetch (proxies, tests). Defaults to the global one. */
  fetch?: typeof fetch;
  /** Prepended to the default `groovesheet-sdk/<version>` user agent. */
  userAgent?: string;
}

export interface TranscribeOptions {
  /** A file path, a Blob/File, or the raw bytes. */
  file: Blob | Uint8Array | string;
  /** Sent as the upload filename. Defaults to the path's basename, or `audio.bin`. */
  filename?: string;
  /** Explicit workflow name (see `listWorkflows()`). Wins over `instrument`. */
  workflow?: string;
  /** `drums | piano | bass | guitar | chords | stems | midi`. */
  instrument?: Instrument;
  /** Extra job metadata (JSON object). */
  metadata?: Record<string, unknown>;
  /** Same key within 24 h returns the first answer instead of charging twice. */
  idempotencyKey?: string;
}

export interface WaitOptions {
  /** Poll interval. Default 5000. */
  intervalMs?: number;
  /** Give up after this long and reject with JobTimeoutError. Default: no limit. */
  timeoutMs?: number;
  /** Called with every status poll, including the final one. */
  onUpdate?: (job: Job) => void;
  signal?: AbortSignal;
}

export interface LoginOptions {
  email: string;
  /** API root (the sandbox prefix is ignored). Defaults to production. */
  baseUrl?: string;
  /** Show the user the code and the link. Called again if the code expires and is renewed. */
  onCode: (code: string, verificationUri: string) => void;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Poll interval override (default: the server's `interval`, 5 s). */
  intervalMs?: number;
  /** Give up after this long. Default: the 15 minute claim window. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /** Seconds until the window resets. */
  reset?: number;
  /** e.g. `1200;w=60`. */
  policy?: string;
}

function num(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = num(value);
  if (seconds !== undefined) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function describeBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const detail = b.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) {
      // FastAPI validation errors: [{loc, msg, type}, ...]
      return detail
        .map((d) => {
          if (d && typeof d === 'object') {
            const e = d as { loc?: unknown[]; msg?: string };
            const where = Array.isArray(e.loc) ? e.loc.filter((p) => p !== 'body' && p !== 'query').join('.') : '';
            return where ? `${where}: ${e.msg ?? 'invalid'}` : (e.msg ?? 'invalid');
          }
          return String(d);
        })
        .join('; ');
    }
    if (typeof b.error_description === 'string' && b.error_description) return b.error_description;
    if (typeof b.error === 'string' && b.error) return b.error;
    if (typeof b.message === 'string' && b.message) return b.message;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  return fallback;
}

/** Any non-2xx answer from the API. */
export class GrooveSheetError extends Error {
  readonly status: number;
  /** The server's `detail` (or `error_description`), or the status text. */
  readonly detail: string;
  /** OAuth-style `error` code when the body has one (e.g. `invalid_token`). */
  readonly code?: string;
  /** Seconds from the Retry-After header (429, and 409 while a request is in flight). */
  readonly retryAfter?: number;
  readonly rateLimit: RateLimitInfo;
  /** The parsed JSON body (or the raw text). */
  readonly body: unknown;
  readonly method?: string;
  readonly url?: string;

  constructor(
    status: number,
    detail: string,
    init: { code?: string; retryAfter?: number; rateLimit?: RateLimitInfo; body?: unknown; method?: string; url?: string } = {},
  ) {
    super(`GrooveSheet API error ${status}: ${detail}`);
    this.name = 'GrooveSheetError';
    this.status = status;
    this.detail = detail;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
    this.rateLimit = init.rateLimit ?? {};
    this.body = init.body;
    this.method = init.method;
    this.url = init.url;
  }

  /** `body` is the already-parsed body if the caller consumed the response. */
  static async fromResponse(res: Response, body?: unknown, method?: string): Promise<GrooveSheetError> {
    let parsed = body;
    if (parsed === undefined) {
      const text = await res.text().catch(() => '');
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
    }
    const h = res.headers;
    const code =
      parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? ((parsed as { error: string }).error)
        : undefined;
    return new GrooveSheetError(res.status, describeBody(parsed, res.statusText || `HTTP ${res.status}`), {
      code,
      retryAfter: parseRetryAfter(h.get('retry-after')),
      rateLimit: {
        limit: num(h.get('ratelimit-limit')),
        remaining: num(h.get('ratelimit-remaining')),
        reset: num(h.get('ratelimit-reset')),
        policy: h.get('ratelimit-policy') ?? undefined,
      },
      body: parsed,
      method,
      url: res.url || undefined,
    });
  }
}

/** The job reached `failed`. */
export class JobFailedError extends Error {
  readonly job: Job;
  readonly detail: string;
  constructor(job: Job) {
    const detail = typeof job.error === 'string' && job.error ? job.error : 'The job failed.';
    super(`Job ${job.workflow_id} failed: ${detail}`);
    this.name = 'JobFailedError';
    this.job = job;
    this.detail = detail;
  }
}

/** `waitForJob` ran out of time. The job itself may still finish. */
export class JobTimeoutError extends Error {
  readonly job?: Job;
  constructor(jobId: string, timeoutMs: number, job?: Job) {
    super(`Job ${jobId} did not finish within ${timeoutMs} ms${job ? ` (last status: ${job.status})` : ''}.`);
    this.name = 'JobTimeoutError';
    this.job = job;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `https://api.groovesheet.net` (+ `/sandbox`), without a trailing slash. */
export function resolveBaseUrl(baseUrl: string = DEFAULT_BASE_URL, sandbox = false): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (sandbox && !url.endsWith(SANDBOX_PATH)) url += SANDBOX_PATH;
  return url;
}

function apiRoot(baseUrl: string = DEFAULT_BASE_URL): string {
  const url = baseUrl.trim().replace(/\/+$/, '');
  return url.endsWith(SANDBOX_PATH) ? url.slice(0, -SANDBOX_PATH.length) : url;
}

function userAgentFor(custom?: string): string {
  return custom ? `${custom} ${DEFAULT_USER_AGENT}` : DEFAULT_USER_AGENT;
}

function csv(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const joined = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean).join(',');
  return joined || undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The file name from a Content-Disposition header, if it carries one. */
export function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain form */
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  return bare ? bare[1].trim() : undefined;
}

function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : '';
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1] ?? '';
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function withExpiry(tokens: TokenSet): TokenSet {
  if (tokens.expires_at === undefined && typeof tokens.expires_in === 'number') {
    return { ...tokens, expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in };
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GrooveSheet {
  /** Effective base URL, including `/sandbox` when sandbox mode is on. */
  readonly baseUrl: string;
  readonly sandbox: boolean;
  private token?: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly api: ReturnType<typeof createClient<paths>>;

  constructor(options: GrooveSheetOptions = {}) {
    this.sandbox = options.sandbox ?? false;
    this.baseUrl = resolveBaseUrl(options.baseUrl, this.sandbox);
    this.token = options.token || undefined;
    this.userAgent = userAgentFor(options.userAgent);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.api = createClient<paths>({
      baseUrl: this.baseUrl,
      fetch: (request: Request) => this.fetchImpl(request),
    });
    this.api.use({
      onRequest: ({ request }) => {
        for (const [name, value] of Object.entries(this.headers())) request.headers.set(name, value);
        return request;
      },
    });
  }

  /** Swap the bearer token (for example after a refresh). */
  setToken(token: string | undefined): void {
    this.token = token || undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
      'API-Version': API_VERSION,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  /** Plain fetch with the standard headers, for routes the OpenAPI client does not cover. */
  private async raw(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(this.headers());
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const method = init.method ?? 'GET';
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...init, headers });
    if (!res.ok) throw await GrooveSheetError.fromResponse(res, undefined, method);
    return res;
  }

  private async unwrap<T>(result: { data?: unknown; error?: unknown; response: Response }, method: string): Promise<T> {
    if (!result.response.ok) throw await GrooveSheetError.fromResponse(result.response, result.error, method);
    return result.data as T;
  }

  // -- library --------------------------------------------------------------

  /** Search the public sheet music library (GET /library/tracks). */
  async searchSongs(options: SearchSongsOptions): Promise<SearchResult> {
    const result = await this.api.GET('/library/tracks', {
      params: {
        query: {
          q: options.query.trim() || undefined,
          instrument: csv(options.instrument),
          format: csv(options.format),
          page: options.page,
          limit: options.limit,
          sort: options.sort,
        },
      },
    });
    return this.unwrap<SearchResult>(result, 'GET');
  }

  /** One song by UUID or slug, with its assets (GET /library/tracks/{id}). */
  async getSong(idOrSlug: string): Promise<TrackDetail> {
    const result = await this.api.GET('/library/tracks/{track_id}', { params: { path: { track_id: idOrSlug } } });
    return this.unwrap<TrackDetail>(result, 'GET');
  }

  /**
   * Several songs (POST /library/tracks/batch), in the order asked. Each entry is
   * what `getSong` would return, or `null` for an id that does not exist or is not
   * visible. The API takes 50 ids per request; longer lists are split for you.
   */
  async getSongs(ids: string[]): Promise<{ tracks: (TrackDetail | null)[] }> {
    const tracks: (TrackDetail | null)[] = [];
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      const res = await this.raw('/library/tracks/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids.slice(i, i + BATCH_LIMIT) }),
      });
      const body = (await res.json()) as { tracks: (TrackDetail | null)[] };
      tracks.push(...body.tracks);
    }
    return { tracks };
  }

  /** Every workflow name with its description (GET /workflows, public). */
  async listWorkflows(): Promise<{ workflows: WorkflowInfo[] }> {
    const result = await this.api.GET('/workflows');
    return this.unwrap<{ workflows: WorkflowInfo[] }>(result, 'GET');
  }

  // -- jobs -----------------------------------------------------------------

  /**
   * Upload audio and start a job (POST /workflow/{name}). Answers when the job is
   * queued (202), not when it is done: follow up with `waitForJob`.
   *
   * In production this uses the account's minutes. The sandbox never charges.
   */
  async transcribe(options: TranscribeOptions): Promise<TranscribeResponse> {
    const workflow = options.workflow ?? (options.instrument ? workflowForInstrument(options.instrument) : undefined);
    if (!workflow) {
      throw new TypeError(`transcribe() needs a workflow or an instrument (${INSTRUMENTS.join(', ')}).`);
    }

    let blob: Blob;
    let filename = options.filename;
    if (typeof options.file === 'string') {
      await stat(options.file); // a clear ENOENT before any request
      blob = await openAsBlob(options.file);
      filename ??= path.basename(options.file);
    } else if (options.file instanceof Blob) {
      blob = options.file;
      filename ??= (options.file as Blob & { name?: string }).name;
    } else {
      blob = new Blob([options.file]);
    }
    filename = safeFileName(filename ?? '') || 'audio.bin';

    const metadata: Record<string, unknown> = {
      ...(options.instrument && TRANSCRIBED_INSTRUMENTS.has(options.instrument) ? { instrument: options.instrument } : {}),
      ...options.metadata,
    };
    const metadataJson = Object.keys(metadata).length ? JSON.stringify(metadata) : undefined;

    const form = new FormData();
    form.append('file', blob, filename);
    // The OpenAPI document lists `metadata` as a query parameter; it is also
    // sent as a form field so either reading of the contract works.
    if (metadataJson) form.append('metadata', metadataJson);

    const result = await this.api.POST('/workflow/{workflow_name}', {
      params: {
        path: { workflow_name: workflow },
        query: { metadata: metadataJson },
        header: { 'Idempotency-Key': options.idempotencyKey } as never,
      },
      body: { file: '' },
      bodySerializer: () => form,
    });
    return this.unwrap<TranscribeResponse>(result, 'POST');
  }

  /** Status of one job (GET /workflow/status/{id}). */
  async getJob(id: string): Promise<Job> {
    const result = await this.api.GET('/workflow/status/{workflow_id}', { params: { path: { workflow_id: id } } });
    return this.unwrap<Job>(result, 'GET');
  }

  /**
   * Poll until the job is `completed` (resolves with the final job) or `failed`
   * (rejects with JobFailedError). A 429 while polling waits out Retry-After.
   */
  async waitForJob(id: string, options: WaitOptions = {}): Promise<Job> {
    const intervalMs = options.intervalMs ?? 5000;
    const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
    let last: Job | undefined;
    for (;;) {
      let wait = intervalMs;
      try {
        last = await this.getJob(id);
        options.onUpdate?.(last);
        if (last.status === 'completed') return last;
        if (last.status === 'failed') throw new JobFailedError(last);
      } catch (err) {
        if (err instanceof GrooveSheetError && err.status === 429) {
          wait = Math.max(intervalMs, (err.retryAfter ?? 0) * 1000);
        } else {
          throw err;
        }
      }
      if (deadline !== undefined) {
        const left = deadline - Date.now();
        if (left <= 0) throw new JobTimeoutError(id, options.timeoutMs as number, last);
        wait = Math.min(wait, left);
      }
      await sleep(wait, options.signal);
    }
  }

  /** One output file of a completed job, as a streaming Response. */
  async downloadFile(id: string, fileKey: string): Promise<Response> {
    return this.raw(`/workflow/download/${encodeURIComponent(id)}/${encodeURIComponent(fileKey)}`);
  }

  /** Every output of a completed job as one zip, as a streaming Response. */
  async downloadAll(id: string): Promise<Response> {
    return this.raw(`/workflow/download/${encodeURIComponent(id)}`);
  }

  /** Download every file in `outputs.files` into `dir` (created if missing). */
  async saveOutputs(id: string, dir: string, options: { job?: Job } = {}): Promise<SavedFile[]> {
    const job = options.job ?? (await this.getJob(id));
    if (job.status !== 'completed') {
      throw new Error(`Job ${id} is ${job.status}, not completed; there is nothing to save yet.`);
    }
    const keys = Object.keys(job.outputs?.files ?? {});
    await mkdir(dir, { recursive: true });
    const saved: SavedFile[] = [];
    const used = new Set<string>();
    for (const fileKey of keys) {
      saved.push(await this.saveFile(id, fileKey, dir, used));
    }
    return saved;
  }

  /** Download one output file into `dir`, named from Content-Disposition. */
  async saveFile(id: string, fileKey: string, dir: string, used: Set<string> = new Set()): Promise<SavedFile> {
    const res = await this.downloadFile(id, fileKey);
    await mkdir(dir, { recursive: true });
    let name = safeFileName(filenameFromContentDisposition(res.headers.get('content-disposition')) ?? '') || safeFileName(fileKey) || 'file';
    if (used.has(name)) name = `${fileKey}-${name}`;
    used.add(name);
    const target = path.join(dir, name);
    if (res.body) {
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(target));
    } else {
      await pipeline(Readable.from([]), createWriteStream(target));
    }
    return { fileKey, path: target, bytes: (await stat(target)).size };
  }

  /** The caller's recent jobs, newest first (GET /workflow/list). */
  async listJobs(options: { limit?: number; offset?: number } = {}): Promise<JobList> {
    const result = await this.api.GET('/workflow/list', {
      params: { query: { limit: options.limit ?? 20, offset: options.offset ?? 0 } },
    });
    return this.unwrap<JobList>(result, 'GET');
  }

  /** Profile, plan and minutes balance (GET /user/account). */
  async getAccount(): Promise<AccountSummary> {
    const result = await this.api.GET('/user/account');
    return this.unwrap<AccountSummary>(result, 'GET');
  }

  // -- auth -----------------------------------------------------------------

  /**
   * Verified-email sign-in for CLIs and agents (no browser needed here):
   * shows a 6-digit code and a link through `onCode`; the user opens the link,
   * types the code, signs in with that same email and clicks Allow; this method
   * polls and resolves with the token set. A code that expires is renewed
   * automatically while the 15 minute claim is still open.
   */
  static async login(options: LoginOptions): Promise<TokenSet> {
    const root = apiRoot(options.baseUrl);
    const doFetch = options.fetch ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init));
    const baseHeaders = { 'User-Agent': userAgentFor(options.userAgent), Accept: 'application/json', 'API-Version': API_VERSION };

    const post = async (route: string, body: string, contentType: string): Promise<{ status: number; json: Record<string, unknown>; res: Response }> => {
      const res = await doFetch(`${root}${route}`, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': contentType },
        body,
        signal: options.signal,
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { error: 'invalid_response', error_description: text.slice(0, 200) };
      }
      return { status: res.status, json, res };
    };
    const fail = async (r: { status: number; json: Record<string, unknown>; res: Response }, method = 'POST'): Promise<never> => {
      throw await GrooveSheetError.fromResponse(r.res, r.json, method);
    };

    const reg = await post('/agent/identity', JSON.stringify({ type: 'service_auth', login_hint: options.email }), 'application/json');
    if (reg.status !== 200) return fail(reg);
    const claimToken = String(reg.json.claim_token ?? '');
    const claim = (reg.json.claim ?? {}) as { user_code?: string; verification_uri?: string; interval?: number };
    if (!claimToken || !claim.user_code || !claim.verification_uri) {
      throw new GrooveSheetError(502, 'The sign-in answer was missing the claim token or code.', { body: reg.json });
    }
    options.onCode(claim.user_code, claim.verification_uri);

    let intervalMs = options.intervalMs ?? Math.max(1, Number(claim.interval ?? 5)) * 1000;
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60 * 1000);

    for (;;) {
      await sleep(intervalMs, options.signal);
      if (Date.now() > deadline) throw new GrooveSheetError(408, 'Timed out waiting for the sign-in to be approved.');
      const poll = await post(
        '/oauth/token',
        new URLSearchParams({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: claimToken }).toString(),
        'application/x-www-form-urlencoded',
      );
      if (poll.status === 200 && typeof poll.json.access_token === 'string') {
        return withExpiry({
          access_token: poll.json.access_token,
          refresh_token: typeof poll.json.refresh_token === 'string' ? poll.json.refresh_token : undefined,
          expires_in: typeof poll.json.expires_in === 'number' ? poll.json.expires_in : undefined,
          token_type: String(poll.json.token_type ?? 'Bearer'),
          scope: typeof poll.json.scope === 'string' ? poll.json.scope : undefined,
        });
      }
      const error = String(poll.json.error ?? '');
      if (poll.status === 400 && error === 'authorization_pending') continue;
      if (poll.status === 400 && error === 'slow_down') {
        intervalMs += 5000;
        continue;
      }
      if (poll.status === 400 && error === 'expired_token') {
        // The code ran out; the claim may still be open, so ask for a fresh one.
        const renew = await post('/agent/identity/claim', JSON.stringify({ claim_token: claimToken, email: options.email }), 'application/json');
        const attempt = (renew.json.claim_attempt ?? {}) as { user_code?: string; verification_uri?: string };
        if (renew.status !== 200 || !attempt.user_code || !attempt.verification_uri) return fail(poll);
        options.onCode(attempt.user_code, attempt.verification_uri);
        continue;
      }
      return fail(poll);
    }
  }

  /**
   * Exchange a refresh token for a new token set. The access token (or an
   * explicit `clientId`) identifies the OAuth client the tokens were issued to.
   */
  static async refresh(options: { refreshToken: string; accessToken?: string; clientId?: string; baseUrl?: string; fetch?: typeof fetch; userAgent?: string }): Promise<TokenSet> {
    const root = apiRoot(options.baseUrl);
    const doFetch = options.fetch ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init));
    const clientId = options.clientId ?? (options.accessToken ? (decodeJwtPayload(options.accessToken).client_id as string | undefined) : undefined);
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: options.refreshToken });
    if (clientId) body.set('client_id', clientId);
    const res = await doFetch(`${root}/oauth/token`, {
      method: 'POST',
      headers: {
        'User-Agent': userAgentFor(options.userAgent),
        Accept: 'application/json',
        'API-Version': API_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) throw await GrooveSheetError.fromResponse(res, undefined, 'POST');
    const json = (await res.json()) as TokenSet;
    return withExpiry({ ...json, refresh_token: json.refresh_token ?? options.refreshToken });
  }
}

export default GrooveSheet;
