// Patch: wrap getCachedToken in try/catch in queue handler so that
// if the token fetch fails, messages are NOT acked and can be retried.
// Also requires max_retries=2 in wrangler.toml (set separately).

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for matching
const normalized = content.replace(/\r\n/g, '\n');

const OLD = `    // Default: mdn-rotation-queue\n    const token = await getCachedToken(env);\n\n    for (const message of batch.messages) {`;

const NEW = `    // Default: mdn-rotation-queue\n    let token;\n    try {\n      token = await getCachedToken(env);\n    } catch (err) {\n      console.error(\`[Queue] Token fetch failed, messages will retry: \${err}\`);\n      return; // Don't ack - messages will be retried (max_retries=2 in wrangler.toml)\n    }\n\n    for (const message of batch.messages) {`;

if (!normalized.includes(OLD)) {
  console.error('ERROR: Target string not found in file. Patch aborted.');
  process.exit(1);
}

const patched = normalized.replace(OLD, NEW);

// Convert back to CRLF
const result = patched.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, result, 'utf8');
console.log('Patch applied successfully.');
