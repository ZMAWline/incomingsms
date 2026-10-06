// Read the dashboard's inline and local classic scripts in document order.
const fs = require('node:fs');
const path = require('node:path');

function readDashboardScripts(htmlPath) {
  const publicDir = fs.realpathSync(path.dirname(htmlPath));
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scripts = [];
  for (const [ , attrs, inline] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const type = attrs.match(/\btype\s*=\s*["']([^"']*)["']/i)?.[1];
    if (type && !/^(?:text|application)\/javascript$/i.test(type)) continue;
    const src = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    let filename = `${htmlPath}:inline-${scripts.length + 1}`;
    let source = inline;
    if (src) {
      const url = src[1] ?? src[2] ?? src[3];
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) continue;
      const asset = decodeURIComponent(url.split(/[?#]/)[0]);
      filename = path.resolve(publicDir, asset.replace(/^\//, ''));
      const insidePublic = (file) => {
        const relative = path.relative(publicDir, file);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      };
      if (!insidePublic(filename)) throw new Error(`Script escapes public directory: ${url}`);
      filename = fs.realpathSync(filename); // Also require the asset to exist.
      if (!insidePublic(filename)) throw new Error(`Script escapes public directory: ${url}`);
      source = fs.readFileSync(filename, 'utf8');
    }
    scripts.push({ filename, source: source.replace('__HELIX_ENABLED__', 'false') });
  }
  return scripts;
}

module.exports = { readDashboardScripts };
