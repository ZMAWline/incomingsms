const fs = require('fs');
const path = require('path');

const indexJsPath = path.join(__dirname, 'src', 'dashboard', 'index.js');
const frontendHtmlPath = path.join(__dirname, 'src', 'dashboard', 'frontend_v2.html');

let indexJs = fs.readFileSync(indexJsPath, 'utf8');
const frontendHtml = fs.readFileSync(frontendHtmlPath, 'utf8');

const splitToken = "function getHTML() {\n  return `";
const splitTokenFallback = "function getHTML() {";

let parts = indexJs.split(splitToken);
let prefix = splitToken;

if (parts.length !== 2) {
    parts = indexJs.split(splitTokenFallback);
    if (parts.length !== 2) {
        console.error("Could not find getHTML marker in index.js");
        process.exit(1);
    }
    prefix = splitTokenFallback + "\n  return `";
}

// Since frontend_v2.html is exactly the source-code snippet from inside the original template literal,
// it ALREADY HAS the correct `\`` and `\${` escapes inside it. We don't need to add backslashes.
// We just perfectly splice it back in.

const newIndexJs = parts[0] + prefix + frontendHtml + "`;\n}\n";

fs.writeFileSync(indexJsPath, newIndexJs);
console.log("Successfully injected frontend_v2.html into index.js directly using _fix.js");
