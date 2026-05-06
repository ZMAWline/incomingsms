// Patch C1: Pass HELIX_ENABLED into getHTML() and inject window.HELIX_ENABLED into the page.
// Two changes: (1) call site: getHTML() → getHTML(env.HELIX_ENABLED === 'true')
//              (2) function def: getHTML() → getHTML(helixEnabled), inject global constant
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Change 1: call site
const OLD_CALL = "return new Response(getHTML(), {";
const NEW_CALL = "return new Response(getHTML(env.HELIX_ENABLED === 'true'), {";

if (!content.includes(OLD_CALL)) {
  console.error('PATCH FAILED: old call site not found');
  process.exit(1);
}
content = content.replace(OLD_CALL, NEW_CALL);

// Change 2: function definition + inject window global
const OLD_DEF = "function getHTML() {\n  return `<!DOCTYPE html>";
const NEW_DEF = "function getHTML(helixEnabled) {\n  return `<!DOCTYPE html>";

if (!content.includes(OLD_DEF)) {
  console.error('PATCH FAILED: old function def not found');
  process.exit(1);
}
content = content.replace(OLD_DEF, NEW_DEF);

// Change 3: inject window.HELIX_ENABLED at the top of the <script> block
const OLD_SCRIPT = "    <script>\n\n        let sidebarOpen = false;";
const NEW_SCRIPT = "    <script>\n\n" +
  "        window.HELIX_ENABLED = " + '\\${helixEnabled}' + ";\n\n" +
  "        let sidebarOpen = false;";

if (!content.includes(OLD_SCRIPT)) {
  console.error('PATCH FAILED: old script block not found');
  process.exit(1);
}
content = content.replace(OLD_SCRIPT, NEW_SCRIPT);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch C1 applied: HELIX_ENABLED flag wired into getHTML()');
