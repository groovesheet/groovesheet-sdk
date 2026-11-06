// Refresh openapi.json from the live API and regenerate src/schema.ts.
//   npm run generate
//   OPENAPI_SOURCE=/path/to/openapi.json npm run generate   (use a local file)
//
// Cloudflare answers bare tool user agents with 403, so the fetch sends a
// browser one. Em and en dashes are replaced so the committed files stay
// plain (the backend docstrings use them).
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.OPENAPI_SOURCE || 'https://api.groovesheet.net/openapi.json';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let text;
if (/^https?:\/\//.test(source)) {
  const res = await fetch(source, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${source} answered ${res.status}`);
  text = await res.text();
} else {
  text = await readFile(source, 'utf8');
}

text = text.replace(/\s*\u2014\s*/g, ', ').replace(/\s*\u2013\s*/g, '-');
JSON.parse(text); // fail now if the document is not JSON

const out = path.join(root, 'openapi.json');
await writeFile(out, text.endsWith('\n') ? text : `${text}\n`);
console.log(`wrote ${out} (${text.length} bytes)`);

const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'openapi-typescript.cmd' : 'openapi-typescript');
const gen = spawnSync(bin, [out, '-o', path.join(root, 'src', 'schema.ts')], { stdio: 'inherit' });
if (gen.status !== 0) process.exit(gen.status ?? 1);

// openapi-typescript copies descriptions into comments; sweep those too.
const schemaPath = path.join(root, 'src', 'schema.ts');
const schema = (await readFile(schemaPath, 'utf8')).replace(/\s*\u2014\s*/g, ', ').replace(/\s*\u2013\s*/g, '-');
await writeFile(schemaPath, schema);
console.log(`wrote ${schemaPath}`);
