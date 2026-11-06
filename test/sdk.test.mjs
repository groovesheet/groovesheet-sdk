import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_BASE_URL,
  GrooveSheet,
  GrooveSheetError,
  INSTRUMENT_WORKFLOWS,
  JobFailedError,
  JobTimeoutError,
  VERSION,
  filenameFromContentDisposition,
  resolveBaseUrl,
  workflowForInstrument,
} from '../dist/index.js';
import { startFakeServer } from './fake-server.mjs';

let fake;
let tmp;
before(async () => {
  fake = await startFakeServer();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'gs-sdk-test-'));
});
after(async () => {
  await fake.close();
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

const last = () => fake.requests.at(-1);
const client = (extra = {}) => new GrooveSheet({ baseUrl: fake.url, token: 'tok-123', ...extra });

describe('basics', () => {
  it('version constant matches package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });

  it('sends the standard headers on every request', async () => {
    await client().searchSongs({ query: 'easy on me' });
    const h = last().headers;
    assert.equal(h['user-agent'], `groovesheet-sdk/${VERSION} (+https://www.groovesheet.net/developers)`);
    assert.equal(h.accept, 'application/json');
    assert.equal(h['api-version'], '2');
    assert.equal(h.authorization, 'Bearer tok-123');
  });

  it('omits Authorization without a token and prepends a custom user agent', async () => {
    await new GrooveSheet({ baseUrl: fake.url, userAgent: 'my-app/1.0' }).searchSongs({ query: 'x' });
    assert.equal(last().headers.authorization, undefined);
    assert.match(last().headers['user-agent'], /^my-app\/1\.0 groovesheet-sdk\//);
  });

  it('uses a custom fetch when given', async () => {
    let calls = 0;
    const gs = client({ fetch: (...args) => { calls += 1; return fetch(...args); } });
    await gs.searchSongs({ query: 'x' });
    await gs.downloadFile('WFtest123', 'piano_midi');
    assert.equal(calls, 2);
  });

  it('maps instruments to the workflows the web app starts', () => {
    assert.deepEqual(INSTRUMENT_WORKFLOWS, {
      drums: 'separate_to_drumscore_v2_full',
      piano: 'separate_to_piano_score_full',
      bass: 'separate_to_hfmt_bass_score_full',
      guitar: 'separate_to_guitar_score_full',
      chords: 'chords_from_mix_full',
      stems: 'bs_roformer_separate',
      midi: 'midi2score_quantize',
    });
    assert.throws(() => workflowForInstrument('kazoo'), /Unknown instrument/);
  });
});

describe('library', () => {
  it('searchSongs sends q, joined filters, page and limit', async () => {
    const result = await client().searchSongs({ query: 'easy on me', instrument: ['piano', 'drums'], format: 'sheet', page: 2, limit: 5 });
    assert.deepEqual(last().query, { q: 'easy on me', instrument: 'piano,drums', format: 'sheet', page: '2', limit: '5' });
    assert.equal(last().pathname, '/library/tracks');
    assert.equal(result.tracks[0].title, 'Easy On Me');
    assert.equal(result.total, 1);
  });

  it('getSong fetches by slug and returns assets', async () => {
    const song = await client().getSong('easy-on-me-adele-0fff6be3');
    assert.equal(last().pathname, '/library/tracks/easy-on-me-adele-0fff6be3');
    assert.equal(song.assets.length, 4);
    assert.equal(song.music_facts.song.bpm, 136);
  });

  it('getSong maps a 404 to GrooveSheetError', async () => {
    await assert.rejects(client().getSong('missing'), (err) => {
      assert.ok(err instanceof GrooveSheetError);
      assert.equal(err.status, 404);
      assert.equal(err.detail, 'Track not found');
      return true;
    });
  });

  it('getSongs posts { ids } as JSON and returns { tracks } with null for unknown ids', async () => {
    const result = await client().getSongs(['a', 'nope-1', 'b']);
    assert.equal(last().method, 'POST');
    assert.equal(last().pathname, '/library/tracks/batch');
    assert.match(last().headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(last().body.toString()), { ids: ['a', 'nope-1', 'b'] });
    assert.deepEqual(result.tracks.map((t) => t && t.id), ['a', null, 'b']);
  });

  it('getSongs splits more than 50 ids into several requests and keeps the order', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id-${i}`);
    const result = await client().getSongs(ids);
    assert.equal(fake.requests.length, 3);
    assert.deepEqual(fake.requests.map((r) => JSON.parse(r.body.toString()).ids.length), [50, 50, 20]);
    assert.deepEqual(result.tracks.map((t) => t.id), ids);
    assert.deepEqual((await client().getSongs([])).tracks, []);
    assert.equal(fake.requests.length, 3);
  });

  it('listWorkflows returns the workflow list', async () => {
    const { workflows } = await client().listWorkflows();
    assert.equal(workflows[0].name, 'separate_to_piano_score_full');
    assert.deepEqual(workflows[1].steps, ['bs_roformer']);
  });
});

describe('transcribe', () => {
  it('uploads a file path as multipart with the instrument workflow, metadata and idempotency key', async () => {
    const file = path.join(tmp, 'My Song.mp3');
    await writeFile(file, 'FAKE-AUDIO-BYTES');
    const started = await client().transcribe({ file, instrument: 'piano', metadata: { title: 'Mine' }, idempotencyKey: 'key-1' });

    assert.equal(started.workflow_id, 'WFtest123');
    assert.equal(started.status, 'started');
    const req = last();
    assert.equal(req.method, 'POST');
    assert.equal(req.pathname, '/workflow/separate_to_piano_score_full');
    assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.equal(req.headers['idempotency-key'], 'key-1');
    assert.equal(req.headers.authorization, 'Bearer tok-123');
    assert.equal(req.form.file.filename, 'My Song.mp3');
    assert.equal(req.form.file.text, 'FAKE-AUDIO-BYTES');
    const expected = { instrument: 'piano', title: 'Mine' };
    assert.deepEqual(JSON.parse(req.query.metadata), expected);
    assert.deepEqual(JSON.parse(req.form.metadata), expected);
  });

  it('accepts bytes plus filename, and an explicit workflow wins over the instrument', async () => {
    await client().transcribe({ file: new TextEncoder().encode('RAW'), filename: 'clip.wav', workflow: 'adtof_plus_transcribe', instrument: 'piano' });
    assert.equal(last().pathname, '/workflow/adtof_plus_transcribe');
    assert.equal(last().form.file.filename, 'clip.wav');
    assert.equal(last().form.file.text, 'RAW');
    assert.equal(last().query.metadata, JSON.stringify({ instrument: 'piano' }));
  });

  it('accepts a Blob and sends no metadata or idempotency key when none is given', async () => {
    await client().transcribe({ file: new Blob(['B']), instrument: 'stems' });
    assert.equal(last().pathname, '/workflow/bs_roformer_separate');
    assert.equal(last().form.file.filename, 'audio.bin');
    assert.equal(last().query.metadata, undefined);
    assert.equal(last().headers['idempotency-key'], undefined);
  });

  it('needs a workflow or an instrument, and a real file', async () => {
    await assert.rejects(client().transcribe({ file: new Blob(['x']) }), TypeError);
    await assert.rejects(client().transcribe({ file: path.join(tmp, 'nope.mp3'), instrument: 'drums' }), { code: 'ENOENT' });
    assert.equal(fake.requests.length, 0);
  });

  it('answers 401 with the OAuth error body as a GrooveSheetError', async () => {
    const gs = new GrooveSheet({ baseUrl: fake.url });
    await assert.rejects(gs.transcribe({ file: new Blob(['x']), instrument: 'drums' }), (err) => {
      assert.ok(err instanceof GrooveSheetError);
      assert.equal(err.status, 401);
      assert.equal(err.code, 'invalid_token');
      assert.equal(err.detail, 'Authentication required');
      return true;
    });
  });
});

describe('jobs', () => {
  it('getJob returns the status body', async () => {
    const job = await client().getJob('WFtest123');
    assert.equal(last().pathname, '/workflow/status/WFtest123');
    assert.equal(job.status, 'processing');
    assert.equal(job.progress, 50);
  });

  it('waitForJob resolves on the second poll and reports every update', async () => {
    const seen = [];
    const job = await client().waitForJob('WFtest123', { intervalMs: 5, onUpdate: (j) => seen.push(j.status) });
    assert.equal(job.status, 'completed');
    assert.deepEqual(Object.keys(job.outputs.files), ['piano_midi', 'piano_musicxml']);
    assert.deepEqual(seen, ['processing', 'completed']);
  });

  it('waitForJob rejects with JobFailedError when the job fails', async () => {
    await assert.rejects(client().waitForJob('WFfail', { intervalMs: 5 }), (err) => {
      assert.ok(err instanceof JobFailedError);
      assert.equal(err.detail, 'No piano found in the audio');
      assert.equal(err.job.status, 'failed');
      return true;
    });
  });

  it('waitForJob rejects with JobTimeoutError when it takes too long', async () => {
    await assert.rejects(client().waitForJob('WFnever', { intervalMs: 5, timeoutMs: 40 }), (err) => {
      assert.ok(err instanceof JobTimeoutError);
      assert.equal(err.job.status, 'processing');
      return true;
    });
  });

  it('waitForJob waits out a 429 while polling', async () => {
    const job = await client().waitForJob('WFlimited', { intervalMs: 5 });
    assert.equal(job.status, 'completed');
    assert.equal(fake.polls.get('WFlimited'), 2);
  });

  it('waitForJob lets other errors through', async () => {
    await assert.rejects(client().waitForJob('WFmissing', { intervalMs: 5 }), { status: 404 });
  });

  it('listJobs and getAccount', async () => {
    const jobs = await client().listJobs({ limit: 3 });
    assert.deepEqual(last().query, { limit: '3', offset: '0' });
    assert.equal(jobs.total, 1);
    assert.equal(jobs.items[0].workflow_id, 'WFtest123');
    const account = await client().getAccount();
    assert.equal(last().pathname, '/user/account');
    assert.equal(account.subscription.tier, 'lite');
  });
});

describe('downloads', () => {
  it('downloadFile returns a streaming Response', async () => {
    const res = await client().downloadFile('WFtest123', 'piano_midi');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'MThd-fake-midi');
    assert.equal(last().pathname, '/workflow/download/WFtest123/piano_midi');
  });

  it('downloadAll returns the zip', async () => {
    const res = await client().downloadAll('WFtest123');
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.equal(await res.text(), 'PK-fake-zip');
    assert.equal(last().pathname, '/workflow/download/WFtest123');
  });

  it('an unknown file key is a GrooveSheetError with the server detail', async () => {
    await assert.rejects(client().downloadFile('WFtest123', 'nope'), (err) => {
      assert.ok(err instanceof GrooveSheetError);
      assert.equal(err.status, 404);
      assert.match(err.detail, /not found/);
      return true;
    });
  });

  it('saveOutputs writes every file under the name the server gives it', async () => {
    const dir = path.join(tmp, 'outputs', 'nested');
    const saved = await client().saveOutputs('WFtest123', dir).catch((e) => e);
    // The first poll is still "processing", so nothing is written yet.
    assert.ok(saved instanceof Error);
    assert.match(saved.message, /not completed/);

    const done = await client().getJob('WFtest123'); // second poll: completed
    const files = await client().saveOutputs('WFtest123', dir, { job: done });
    assert.deepEqual((await readdir(dir)).sort(), ['Easy On Me - piano.mid', 'Easy On Me.musicxml']);
    assert.deepEqual(files.map((f) => f.fileKey).sort(), ['piano_midi', 'piano_musicxml']);
    assert.equal(await readFile(path.join(dir, 'Easy On Me - piano.mid'), 'utf8'), 'MThd-fake-midi');
    assert.equal(files.find((f) => f.fileKey === 'piano_musicxml').bytes, '<score-partwise/>'.length);
  });

  it('saveFile avoids overwriting a file with the same name', async () => {
    const dir = path.join(tmp, 'dupes');
    const used = new Set();
    const a = await client().saveFile('WFtest123', 'piano_midi', dir, used);
    const b = await client().saveFile('WFtest123', 'same_name', dir, used);
    assert.notEqual(a.path, b.path);
    assert.equal((await readdir(dir)).length, 2);
  });

  it('parses Content-Disposition forms', () => {
    assert.equal(filenameFromContentDisposition('attachment; filename="a b.mid"'), 'a b.mid');
    assert.equal(filenameFromContentDisposition("attachment; filename*=UTF-8''caf%C3%A9.mid"), 'café.mid');
    assert.equal(filenameFromContentDisposition('attachment; filename=plain.zip'), 'plain.zip');
    assert.equal(filenameFromContentDisposition(null), undefined);
  });
});

describe('errors', () => {
  it('maps 429 with Retry-After and the RateLimit headers', async () => {
    await assert.rejects(client().searchSongs({ query: 'ratelimit' }), (err) => {
      assert.ok(err instanceof GrooveSheetError);
      assert.equal(err.name, 'GrooveSheetError');
      assert.equal(err.status, 429);
      assert.equal(err.detail, 'Rate limit exceeded');
      assert.equal(err.retryAfter, 7);
      assert.deepEqual(err.rateLimit, { limit: 1200, remaining: 0, reset: 30, policy: '1200;w=60' });
      assert.match(err.message, /429/);
      return true;
    });
  });

  it('raw routes map errors the same way', async () => {
    await assert.rejects(new GrooveSheet({ baseUrl: fake.url }).downloadFile('WFtest123', 'piano_midi'), { status: 401, code: 'invalid_token' });
  });
});

describe('sandbox', () => {
  it('resolveBaseUrl adds /sandbox once and trims slashes', () => {
    assert.equal(resolveBaseUrl(), DEFAULT_BASE_URL);
    assert.equal(resolveBaseUrl(undefined, true), 'https://api.groovesheet.net/sandbox');
    assert.equal(resolveBaseUrl('https://x.test/', true), 'https://x.test/sandbox');
    assert.equal(resolveBaseUrl('https://x.test/sandbox/', true), 'https://x.test/sandbox');
  });

  it('switches every call to the /sandbox prefix and needs no token', async () => {
    const gs = new GrooveSheet({ baseUrl: fake.url, sandbox: true });
    assert.equal(gs.baseUrl, `${fake.url}/sandbox`);
    await gs.searchSongs({ query: 'easy on me' });
    await gs.listWorkflows();
    const started = await gs.transcribe({ file: new Blob(['x']), instrument: 'drums' });
    await gs.getJob(started.workflow_id);
    await gs.downloadFile(started.workflow_id, 'piano_midi');
    assert.equal(started.workflow_id, 'WFsandbox1');
    for (const r of fake.requests) {
      assert.ok(r.path.startsWith('/sandbox/'), r.path);
      assert.equal(r.headers.authorization, undefined);
    }
    assert.equal(fake.requests.length, 5);
  });

  it('still sends a token when one is given', async () => {
    await new GrooveSheet({ baseUrl: fake.url, sandbox: true, token: 't' }).listWorkflows();
    assert.equal(last().headers.authorization, 'Bearer t');
  });
});

describe('login', () => {
  const login = (extra = {}) => {
    const codes = [];
    const promise = GrooveSheet.login({
      email: 'me@example.com',
      baseUrl: fake.url,
      intervalMs: 5,
      onCode: (code, uri) => codes.push([code, uri]),
      ...extra,
    });
    return { codes, promise };
  };

  it('shows the code, polls through authorization_pending, and returns the token set', async () => {
    const { codes, promise } = login();
    const tokens = await promise;
    assert.deepEqual(codes, [['123456', 'https://api.groovesheet.net/agent/identity/verify?claim_attempt_token=abc']]);
    assert.equal(tokens.access_token, 'access-abc');
    assert.equal(tokens.refresh_token, 'refresh-abc');
    assert.equal(tokens.expires_in, 3600);
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(Math.abs(tokens.expires_at - (Date.now() / 1000 + 3600)) < 30);

    const [identity, ...polls] = fake.requests;
    assert.equal(identity.pathname, '/agent/identity');
    assert.deepEqual(JSON.parse(identity.body.toString()), { type: 'service_auth', login_hint: 'me@example.com' });
    assert.equal(polls.length, 3);
    assert.match(polls[0].headers['content-type'], /application\/x-www-form-urlencoded/);
    assert.deepEqual(polls[0].form, { grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: 'clm_test' });
  });

  it('asks for a fresh code when the first one expires', async () => {
    fake.tokenPolls.mode = 'expire';
    const { codes, promise } = login();
    const tokens = await promise;
    assert.equal(tokens.access_token, 'access-abc');
    assert.deepEqual(codes.map((c) => c[0]), ['123456', '654321']);
    assert.ok(fake.requests.some((r) => r.pathname === '/agent/identity/claim'));
  });

  it('rejects with the server error on invalid_grant', async () => {
    fake.tokenPolls.mode = 'invalid';
    const { promise } = login();
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof GrooveSheetError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'invalid_grant');
      return true;
    });
  });

  it('ignores the sandbox prefix and times out when nobody approves', async () => {
    const { promise } = login({ baseUrl: `${fake.url}/sandbox/`, timeoutMs: 1 });
    // The fake approves on the third poll; a 1 ms budget runs out first.
    await assert.rejects(promise, { status: 408 });
    assert.equal(fake.requests[0].path, '/agent/identity');
  });

  it('refresh exchanges the refresh token, reading client_id from the access token', async () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ client_id: 'cid-1' })).toString('base64url')}.y`;
    const tokens = await GrooveSheet.refresh({ refreshToken: 'r1', accessToken: jwt, baseUrl: fake.url });
    assert.equal(tokens.access_token, 'refreshed-access');
    assert.deepEqual(last().form, { grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'cid-1' });
  });
});
