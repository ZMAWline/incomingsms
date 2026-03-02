const fs = require('fs');

const filePath = 'src/dashboard/index.js';
let content = fs.readFileSync(filePath, 'utf8');
let lf = content.replace(/\r\n/g, '\n');
let patched = lf;

// Map each tab to its URL (mirrors TAB_ROUTES in the page)
const routes = {
  dashboard: '/',
  sims: '/sims',
  messages: '/messages',
  workers: '/workers',
  gateway: '/gateway',
  'imei-pool': '/imei-pool',
  errors: '/errors',
  billing: '/billing',
};

// Convert each sidebar <button> to an <a href="..."> so middle-click works natively.
// Left-click: event.preventDefault() + switchTab() keeps SPA behaviour.
// The errors button has class "... relative" (unique), all others are the same.

for (const [tab, url] of Object.entries(routes)) {
  // Build the old opening tag (errors button has "transition relative", others have "transition")
  const isErrors = tab === 'errors';
  const oldClass = isErrors
    ? `sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition relative`
    : `sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition`;

  // dashboard button has class "sidebar-btn active ..."
  const isDashboard = tab === 'dashboard';
  const actualOldClass = isDashboard
    ? `sidebar-btn active w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition`
    : oldClass;

  const oldOpen = `<button onclick="switchTab('${tab}')" data-tab="${tab}" class="${actualOldClass}" title="`;
  const newOpen = `<a href="${url}" onclick="event.preventDefault();switchTab('${tab}')" data-tab="${tab}" class="${actualOldClass}" title="`;

  if (!patched.includes(oldOpen)) {
    console.error(`ERROR: Could not find button for tab "${tab}"`);
    console.error('Looking for:', JSON.stringify(oldOpen));
    process.exit(1);
  }

  patched = patched.replace(oldOpen, newOpen);
  // Replace the closing </button> right after this nav item
  // Each button closes with </button>\n  so we replace the first occurrence after the open
  const afterOpen = patched.indexOf(newOpen);
  const closeIdx = patched.indexOf('</button>', afterOpen);
  if (closeIdx === -1) {
    console.error(`ERROR: Could not find closing </button> for tab "${tab}"`);
    process.exit(1);
  }
  patched = patched.slice(0, closeIdx) + '</a>' + patched.slice(closeIdx + '</button>'.length);
}

// Remove the auxclick JS block added previously (no longer needed with <a> tags)
const OLD_AUXCLICK =
  '\n        // Middle-click sidebar buttons to open page in a new tab\n' +
  '        document.querySelectorAll(\'.sidebar-btn[data-tab]\').forEach(btn => {\n' +
  '            btn.addEventListener(\'auxclick\', e => {\n' +
  '                if (e.button === 1) {\n' +
  '                    e.preventDefault();\n' +
  '                    const url = TAB_ROUTES[btn.dataset.tab];\n' +
  '                    if (url) window.open(url, \'_blank\');\n' +
  '                }\n' +
  '            });\n' +
  '        });\n';

if (patched.includes(OLD_AUXCLICK)) {
  patched = patched.replace(OLD_AUXCLICK, '\n');
  console.log('Removed old auxclick handler.');
} else {
  console.log('Note: auxclick block not found (may already be removed).');
}

fs.writeFileSync(filePath, patched.replace(/\n/g, '\r\n'), 'utf8');
console.log('Patched successfully.');
