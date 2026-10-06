// Compile the real module graph, as Wrangler does. Tests exercise exported
// handlers and the actual request gate without copying functions out of text.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function loadModule(relativePath) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, new URL('../../', import.meta.url)))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
