import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startFakeServer } from './fake-server.mjs';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
let fake;
let home;
let work;

before(async () => {
  fake = await startFakeServer();
  home = await mkdtemp(path.join(os.tmpdir(), 'gs-cli-home-'));
  work = await mkdtemp(path.join(os.tmpdir(), 'gs-cli-work-'));
});
after(async () => {
  await fake.close();
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

/** Run the built CLI against the fake server (async: the server lives in this process). */
function cli(args, { env = {}, noToken = false } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      GROOVESHEET_API_URL: fake.url,
      GROOVESHEET_POLL_MS: '10',
      ...(noToken ? {} : { GROOVESHEET_TOKEN: 'tok-cli' }),
      ...env,
    };
    const child = spawn(process.execPath, [CLI, ...args], { env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('cli basics', () => {
  it('--version prints the version', async () => {
    const r = await cli(['--version']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  });

  it('help lists the commands', async () => {
    const r = await cli(['help']);
    assert.equal(r.code, 0);
    for (const word of ['search', 'song', 'workflows', 'transcribe', 'job', 'jobs', 'download', 'account', 'login', 'logout', '--sandbox']) {
      assert.ok(r.stdout.includes(word), word);
    }
  });

  it('exits 2 on no command, an unknown command, an unknown flag and missing arguments', async () => {
    assert.equal((await cli([])).code, 2);
    const unknown = await cli(['frobnicate']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown command/);
    assert.equal((await cli(['search', '--bogus', 'x'])).code, 2);
    assert.equal((await cli(['search'])).code, 2);
    assert.equal((await cli(['search', 'x', '--format', 'pdf'])).code, 2);
    assert.equal((await cli(['transcribe', 'a.mp3'])).code, 2);
    assert.equal((await cli(['transcribe', path.join(work, 'missing.mp3'), '--instrument', 'drums'])).code, 2);
    assert.equal((await cli(['login'])).code, 2);
    assert.equal(fake.requests.length, 0);
  });
});

describe('cli read commands', () => {
  it('search --json prints the raw JSON', async () => {
    const r = await cli(['search', 'easy on me', '--json', '--instrument', 'piano', '--format', 'sheet']);
    assert.equal(r.code, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.tracks[0].title, 'Easy On Me');
    assert.equal(body.tracks[0].artist, 'Adele');
    const req = fake.requests[0];
    assert.equal(req.query.q, 'easy on me');
    assert.equal(req.query.instrument, 'piano');
    assert.equal(req.query.format, 'sheet');
    assert.equal(req.query.page, '1');
    assert.match(req.headers['user-agent'], /groovesheet-cli\/.* groovesheet-sdk\//);
    assert.equal(req.headers.authorization, 'Bearer tok-cli');
  });

  it('search prints a table and joins unquoted words', async () => {
    const r = await cli(['search', 'easy', 'on', 'me']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /TITLE\s+ARTIST\s+FORMATS\s+SLUG/);
    assert.match(r.stdout, /Easy On Me\s+Adele\s+stem,midi,musicxml\s+easy-on-me-adele-0fff6be3/);
    assert.match(r.stdout, /1 of 1 result/);
    assert.equal(fake.requests[0].query.q, 'easy on me');
  });

  it('song prints the parts', async () => {
    const r = await cli(['song', 'easy-on-me-adele-0fff6be3']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Easy On Me, Adele \(2021\)/);
    assert.match(r.stdout, /3:44, 136 bpm, F major, 4\/4/);
    assert.match(r.stdout, /piano\s+musicxml midi\s+intermediate\s+1200 notes/);
    assert.match(r.stdout, /drums\s+stem\(flac\/opus\)\s+beginner/);
  });

  it('song with an unknown slug exits 1 with the API detail', async () => {
    const r = await cli(['song', 'missing']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /404 Track not found/);
  });

  it('workflows lists names and the instrument flag that maps to them', async () => {
    const r = await cli(['workflows']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /separate_to_piano_score_full\s+piano\s+Separate audio/);
    assert.match(r.stdout, /bs_roformer_separate\s+stems/);
  });

  it('account, jobs and an authenticated call without a token', async () => {
    const account = await cli(['account']);
    assert.equal(account.code, 0, account.stderr);
    assert.match(account.stdout, /edward@example\.com/);
    assert.match(account.stdout, /plan: lite/);
    assert.match(account.stdout, /minutes left: 60/);

    const jobs = await cli(['jobs', '--limit', '5']);
    assert.equal(jobs.code, 0, jobs.stderr);
    assert.match(jobs.stdout, /WFtest123\s+completed\s+separate_to_piano_score_full/);
    assert.equal(fake.requests.at(-1).query.limit, '5');

    const anon = await cli(['account'], { noToken: true });
    assert.equal(anon.code, 1);
    assert.match(anon.stderr, /401 Authentication required/);
    assert.match(anon.stderr, /groovesheet login/);
  });

  it('a 429 exits 1 and says how long to wait', async () => {
    const r = await cli(['search', 'ratelimit']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /429 Rate limit exceeded\. Retry in 7s\./);
  });
});

describe('cli jobs', () => {
  it('job --wait --json waits for completion and prints the final job', async () => {
    const r = await cli(['job', 'WFtest123', '--wait', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const job = JSON.parse(r.stdout);
    assert.equal(job.status, 'completed');
    assert.deepEqual(Object.keys(job.outputs.files), ['piano_midi', 'piano_musicxml']);
    assert.match(r.stderr, /processing 50%/);
    assert.equal(fake.polls.get('WFtest123'), 2);
  });

  it('job without --wait shows the current status once', async () => {
    const r = await cli(['job', 'WFtest123']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /WFtest123\s+processing\s+50%/);
    assert.equal(fake.polls.get('WFtest123'), 1);
  });

  it('job --wait exits 1 when the job fails', async () => {
    const r = await cli(['job', 'WFfail', '--wait']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /failed: No piano found in the audio/);
  });

  it('download saves one file or all of them', async () => {
    fake.polls.set('WFtest123', 1); // already past "processing"
    const one = path.join(work, 'dl-one');
    const r1 = await cli(['download', 'WFtest123', 'piano_midi', '--out', one]);
    assert.equal(r1.code, 0, r1.stderr);
    assert.deepEqual(await readdir(one), ['Easy On Me - piano.mid']);

    const all = path.join(work, 'dl-all');
    const r2 = await cli(['download', 'WFtest123', '--out', all]);
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual((await readdir(all)).sort(), ['Easy On Me - piano.mid', 'Easy On Me.musicxml']);

    const bad = await cli(['download', 'WFtest123', 'nope', '--out', all]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /404/);
  });
});

describe('cli transcribe and sandbox', () => {
  it('--sandbox transcribe --wait --out needs no token, uses /sandbox and saves the outputs', async () => {
    const audio = path.join(work, 'demo.mp3');
    await writeFile(audio, 'AUDIO');
    const out = path.join(work, 'sandbox-out');
    const r = await cli(['transcribe', audio, '--instrument', 'piano', '--wait', '--out', out, '--sandbox'], { noToken: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /WFsandbox1\s+completed/);
    assert.match(r.stdout, /saved .*Easy On Me - piano\.mid/);
    assert.ok(!/uses minutes/.test(r.stderr));
    assert.deepEqual((await readdir(out)).sort(), ['Easy On Me - piano.mid', 'Easy On Me.musicxml']);
    for (const req of fake.requests) {
      assert.ok(req.sandbox, req.path);
      assert.equal(req.headers.authorization, undefined);
    }
    assert.equal(fake.requests[0].workflowName, 'separate_to_piano_score_full');
  });

  it('GROOVESHEET_SANDBOX=1 works like --sandbox', async () => {
    const r = await cli(['workflows'], { env: { GROOVESHEET_SANDBOX: '1' }, noToken: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.requests[0].path, '/sandbox/workflows');
  });

  it('production transcribe without --wait prints the job id and warns about minutes', async () => {
    const audio = path.join(work, 'real.mp3');
    await writeFile(audio, 'AUDIO');
    const r = await cli(['transcribe', audio, '--workflow', 'bs_roformer_separate', '--idempotency-key', 'abc']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Started WFtest123 \(bs_roformer_separate\)/);
    assert.match(r.stdout, /groovesheet job WFtest123 --wait/);
    assert.match(r.stderr, /uses minutes/);
    assert.equal(fake.requests[0].headers['idempotency-key'], 'abc');
    assert.equal(fake.requests[0].path, '/workflow/bs_roformer_separate');

    const json = await cli(['transcribe', audio, '--instrument', 'stems', '--json']);
    assert.equal(JSON.parse(json.stdout).workflow_id, 'WFtest123');
  });

  it('--api-url and --token override the environment', async () => {
    const r = await cli(['search', 'x', '--api-url', fake.url, '--token', 'flag-token', '--json'], { env: { GROOVESHEET_API_URL: 'http://127.0.0.1:1', GROOVESHEET_TOKEN: 'env-token' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.requests[0].headers.authorization, 'Bearer flag-token');
  });
});

describe('cli login and logout', () => {
  it('login prints the code and link, stores the token with mode 0600, and a saved login is then used', async () => {
    const r = await cli(['login', '--email', 'me@example.com'], { noToken: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /enter the code 123456/);
    assert.match(r.stderr, /claim_attempt_token=abc/);
    assert.match(r.stdout, /Signed in as me@example\.com/);

    const file = path.join(home, '.config', 'groovesheet', 'credentials.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.access_token, 'access-abc');
    assert.equal(saved.refresh_token, 'refresh-abc');
    assert.equal(saved.email, 'me@example.com');
    assert.equal(saved.api_url, fake.url);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

    fake.reset();
    const next = await cli(['account'], { noToken: true });
    assert.equal(next.code, 0, next.stderr);
    assert.equal(fake.requests[0].headers.authorization, 'Bearer access-abc');

    // The sandbox does not send a saved login.
    fake.reset();
    await cli(['workflows', '--sandbox'], { noToken: true });
    assert.equal(fake.requests[0].headers.authorization, undefined);

    const out = await cli(['logout']);
    assert.equal(out.code, 0, out.stderr);
    await assert.rejects(stat(file), { code: 'ENOENT' });
    assert.equal((await cli(['logout'])).code, 0);
  });

  it('an expired saved login is refreshed before use', async () => {
    const dir = path.join(home, '.config', 'groovesheet');
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    const jwt = `x.${Buffer.from(JSON.stringify({ client_id: 'cid-9' })).toString('base64url')}.y`;
    await writeFile(path.join(dir, 'credentials.json'), JSON.stringify({ access_token: jwt, refresh_token: 'old-refresh', expires_at: 1, token_type: 'Bearer' }));
    const r = await cli(['account'], { noToken: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.requests[0].pathname, '/oauth/token');
    assert.equal(fake.requests[0].form.client_id, 'cid-9');
    assert.equal(fake.requests[1].headers.authorization, 'Bearer refreshed-access');
    const saved = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8'));
    assert.equal(saved.refresh_token, 'refreshed-refresh');
    await cli(['logout']);
  });
});
