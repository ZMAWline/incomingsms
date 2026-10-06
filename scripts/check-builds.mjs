// Compile every deployable Worker, without uploading or touching bindings.
import { readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const src = new URL('../src/', import.meta.url);
const workers = [];
for (const entry of await readdir(src, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try { await access(new URL(entry.name + '/wrangler.toml', src)); }
  catch { continue; }
  workers.push(entry.name);
}
const results = await Promise.allSettled(workers.map(name => build({
  entryPoints: [fileURLToPath(new URL(name + '/index.js', src))],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
  target: 'es2022', logLevel: 'silent',
})));
let failed = false;
for (let i = 0; i < results.length; i++) {
  const result = results[i];
  if (result.status === 'rejected') {
    console.error(workers[i] + ': ' + result.reason.message);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`All ${workers.length} Worker bundles compile.`);
