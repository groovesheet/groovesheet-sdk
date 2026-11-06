// A small stand-in for api.groovesheet.net: just enough routes for the SDK and CLI tests.
// Every route also answers under /sandbox (that is how the sandbox base URL is checked).
import http from 'node:http';

export const SONG = {
  id: '0fff6be3-93a4-421f-8436-5ad9e968c950',
  slug: 'easy-on-me-adele-0fff6be3',
  title: 'Easy On Me',
  artist: 'Adele',
  album: 'Easy On Me',
  year: 2021,
  duration_sec: 224,
  formats: ['stem', 'midi', 'musicxml'],
};

const ASSETS = [
  { id: 'a1', track_id: SONG.id, asset_type: 'musicxml', stem_name: 'piano', format: 'musicxml', file_key: 'piano_musicxml', note_view: 'roll' },
  { id: 'a2', track_id: SONG.id, asset_type: 'midi', stem_name: 'piano', format: 'mid', file_key: 'piano_midi', note_view: 'roll' },
  { id: 'a3', track_id: SONG.id, asset_type: 'stem', stem_name: 'drums', format: 'flac', file_key: 'compress_drums_flac' },
  { id: 'a4', track_id: SONG.id, asset_type: 'stem', stem_name: 'drums', format: 'opus', file_key: 'compress_drums_opus' },
];

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return null;
  const boundary = `--${match[1] || match[2]}`;
  const text = buffer.toString('latin1');
  const fields = {};
  for (const chunk of text.split(boundary).slice(1)) {
    if (chunk.startsWith('--')) break;
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    const value = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (name) fields[name] = filename !== undefined ? { filename, text: value } : value;
  }
  return fields;
}

export async function startFakeServer() {
  const requests = [];
  const polls = new Map(); // job id -> status polls seen
  const tokenPolls = { n: 0, mode: 'ok' };
  let server;

  const send = (res, status, body, headers = {}) => {
    const isBuffer = Buffer.isBuffer(body) || typeof body === 'string';
    res.writeHead(status, {
      'API-Version': '2',
      'RateLimit-Limit': '1200',
      'RateLimit-Remaining': status === 429 ? '0' : '1190',
      'RateLimit-Reset': '30',
      'RateLimit-Policy': '1200;w=60',
      'Content-Type': isBuffer ? 'application/octet-stream' : 'application/json',
      ...headers,
    });
    res.end(isBuffer ? body : JSON.stringify(body));
  };

  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://fake');
    let pathname = url.pathname;
    const sandbox = pathname.startsWith('/sandbox/');
    if (sandbox) pathname = pathname.slice('/sandbox'.length);
    const entry = {
      method: req.method,
      path: url.pathname,
      pathname,
      sandbox,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    };
    requests.push(entry);

    const authed = Boolean(req.headers.authorization) || sandbox;
    const needAuth = () => {
      if (authed) return false;
      send(res, 401, { error: 'invalid_token', error_description: 'Authentication required' }, {
        'WWW-Authenticate': 'Bearer resource_metadata="https://api.groovesheet.net/.well-known/oauth-protected-resource"',
      });
      return true;
    };
    let m;

    if (req.method === 'GET' && pathname === '/library/tracks') {
      if (url.searchParams.get('q') === 'ratelimit') {
        return send(res, 429, { detail: 'Rate limit exceeded' }, { 'Retry-After': '7' });
      }
      const payload = { tracks: [{ ...SONG }], next_cursor: null };
      if (url.searchParams.has('page')) Object.assign(payload, { total: 1, page: Number(url.searchParams.get('page')), pages: 1, limit: Number(url.searchParams.get('limit') || 24) });
      return send(res, 200, payload);
    }
    if (req.method === 'POST' && pathname === '/library/tracks/batch') {
      const { ids = [] } = JSON.parse(body.toString() || '{}');
      return send(res, 200, { tracks: ids.map((id) => (id.startsWith('nope') ? null : { ...SONG, id, assets: [] })) });
    }
    if (req.method === 'GET' && (m = /^\/library\/tracks\/([^/]+)$/.exec(pathname))) {
      if (m[1] === 'missing') return send(res, 404, { detail: 'Track not found' });
      return send(res, 200, {
        ...SONG,
        assets: ASSETS,
        music_facts: { v: 2, song: { bpm: 136, key: { tonic: 'F', mode: 'major' }, meter: '4/4', bars: 89 }, parts: { piano: { level: 'intermediate', notes: 1200 }, drums: { level: 'beginner', notes: 8 } } },
      });
    }
    if (req.method === 'GET' && pathname === '/workflows') {
      return send(res, 200, {
        workflows: [
          { name: 'separate_to_piano_score_full', description: 'Separate audio into stems, transcribe the piano track to MIDI, then quantize to MusicXML', steps: ['bs_roformer', 'transkun-v2', 'midi2score'] },
          { name: 'bs_roformer_separate', description: 'Separate audio into 6 stems', steps: ['bs_roformer'] },
        ],
      });
    }
    if (req.method === 'POST' && (m = /^\/workflow\/([^/]+)$/.exec(pathname))) {
      if (needAuth()) return;
      const fields = parseMultipart(body, req.headers['content-type']) ?? {};
      entry.form = fields;
      entry.workflowName = m[1];
      return send(res, 202, {
        workflow_id: sandbox ? 'WFsandbox1' : 'WFtest123',
        workflow_name: m[1],
        status: 'started',
        message: `Workflow '${m[1]}' started. Processing in background.`,
        status_url: '/workflow/status/WFtest123',
      }, { Location: '/workflow/status/WFtest123' });
    }
    if (req.method === 'GET' && pathname === '/workflow/list') {
      if (needAuth()) return;
      return send(res, 200, {
        items: [{ workflow_id: 'WFtest123', workflow_name: 'separate_to_piano_score_full', status: 'completed', progress: 100, created_at: '2026-11-06T10:00:00', display_title: 'Piano transcription of song.mp3', metadata: { instrument: 'piano', original_filename: 'song.mp3' } }],
        total: 1, limit: Number(url.searchParams.get('limit') || 20), offset: Number(url.searchParams.get('offset') || 0),
      });
    }
    if (req.method === 'GET' && (m = /^\/workflow\/status\/([^/]+)$/.exec(pathname))) {
      if (needAuth()) return;
      const id = m[1];
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      if (id === 'WFlimited' && n === 1) return send(res, 429, { detail: 'Rate limit exceeded' }, { 'Retry-After': '0' });
      if (id === 'WFnever') return send(res, 200, { workflow_id: id, status: 'processing', progress: 10 });
      if (id === 'WFmissing') return send(res, 404, { detail: `Workflow '${id}' not found.` });
      if (n < 2 && id !== 'WFlimited') return send(res, 200, { workflow_id: id, workflow_name: 'separate_to_piano_score_full', status: 'processing', progress: 50 });
      if (id === 'WFfail') return send(res, 200, { workflow_id: id, status: 'failed', progress: 0, error: 'No piano found in the audio' });
      return send(res, 200, {
        workflow_id: id,
        workflow_name: 'separate_to_piano_score_full',
        status: 'completed',
        progress: 100,
        outputs: { files: { piano_midi: 'workflows/x/piano.mid', piano_musicxml: 'workflows/x/piano.musicxml' } },
      });
    }
    if (req.method === 'GET' && (m = /^\/workflow\/download\/([^/]+)\/([^/]+)$/.exec(pathname))) {
      if (needAuth()) return;
      if (m[2] === 'piano_midi') return send(res, 200, Buffer.from('MThd-fake-midi'), { 'Content-Disposition': 'attachment; filename="Easy On Me - piano.mid"', 'Content-Type': 'audio/midi' });
      if (m[2] === 'piano_musicxml') return send(res, 200, Buffer.from('<score-partwise/>'), { 'Content-Disposition': "attachment; filename*=UTF-8''Easy%20On%20Me.musicxml", 'Content-Type': 'application/vnd.recordare.musicxml+xml' });
      if (m[2] === 'same_name') return send(res, 200, Buffer.from('x'), { 'Content-Disposition': 'attachment; filename="Easy On Me - piano.mid"' });
      return send(res, 404, { detail: `File '${m[2]}' not found. Available: ['piano_midi', 'piano_musicxml']` });
    }
    if (req.method === 'GET' && (m = /^\/workflow\/download\/([^/]+)$/.exec(pathname))) {
      if (needAuth()) return;
      return send(res, 200, Buffer.from('PK-fake-zip'), { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${m[1]}.zip"` });
    }
    if (req.method === 'GET' && pathname === '/user/account') {
      if (needAuth()) return;
      return send(res, 200, {
        profile: { user_id: 'u1', email: 'edward@example.com', display_name: 'Edward' },
        subscription: { user_id: 'u1', tier: 'lite', credits_balance: 3600, balance_minutes: 60, is_active: true, next_recharge_at: '2026-12-01T00:00:00Z' },
        settings: {}, security: {}, recharge_options: {}, recent_usage: { items: [], total: 0 },
      });
    }

    // --- verified-email login -------------------------------------------------
    if (req.method === 'POST' && pathname === '/agent/identity') {
      const json = JSON.parse(body.toString() || '{}');
      if (json.type !== 'service_auth') return send(res, 400, { error: 'unsupported_identity_type', error_description: 'Only service_auth is supported.' });
      tokenPolls.n = 0;
      return send(res, 200, {
        registration_type: 'service_auth',
        claim_token: 'clm_test',
        claim: { user_code: '123456', expires_in: 600, verification_uri: 'https://api.groovesheet.net/agent/identity/verify?claim_attempt_token=abc', interval: 1 },
      });
    }
    if (req.method === 'POST' && pathname === '/agent/identity/claim') {
      tokenPolls.mode = 'ok';
      return send(res, 200, { status: 'initiated', claim_attempt: { user_code: '654321', verification_uri: 'https://api.groovesheet.net/agent/identity/verify?claim_attempt_token=def', interval: 1, expires_in: 600 } });
    }
    if (req.method === 'POST' && pathname === '/oauth/token') {
      const form = new URLSearchParams(body.toString());
      entry.form = Object.fromEntries(form);
      if (form.get('grant_type') === 'refresh_token') {
        return send(res, 200, { access_token: 'refreshed-access', refresh_token: 'refreshed-refresh', expires_in: 3600, token_type: 'Bearer' });
      }
      tokenPolls.n += 1;
      const n = tokenPolls.n;
      const pending = () => send(res, 400, { error: 'authorization_pending', error_description: 'Waiting for the user to approve.' });
      if (tokenPolls.mode === 'expire' && n === 1) return pending();
      if (tokenPolls.mode === 'expire' && n === 2) return send(res, 400, { error: 'expired_token', error_description: 'The user_code expired.' });
      if (tokenPolls.mode === 'invalid' && n === 1) return pending();
      if (tokenPolls.mode === 'invalid' && n >= 2) return send(res, 400, { error: 'invalid_grant', error_description: 'Unknown or expired claim_token.' });
      if (tokenPolls.mode === 'ok' && n < 3) return pending();
      return send(res, 200, { access_token: 'access-abc', refresh_token: 'refresh-abc', expires_in: 3600, token_type: 'Bearer' });
    }

    return send(res, 404, { detail: 'Not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    tokenPolls,
    polls,
    reset() {
      requests.length = 0;
      polls.clear();
      tokenPolls.n = 0;
      tokenPolls.mode = 'ok';
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
