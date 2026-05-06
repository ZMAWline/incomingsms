// Dashboard Redesign Patch
// Targets: test env deployment
// Changes: wider labeled sidebar, better fonts (Fira Sans/Code), richer dark palette, cleaner scrollbar, improved active state
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let raw = fs.readFileSync(filePath, 'utf8');
let content = raw.replace(/\r\n/g, '\n');

// ===== PATCH 1: HEAD SECTION =====
// Replace from <head> to </head> inclusive
const headStart = content.indexOf('<head>');
const headEndTag = '</head>';
const headEnd = content.indexOf(headEndTag) + headEndTag.length;
if (headStart === -1 || headEnd === headEndTag.length - 1) {
  console.error('ERROR: Could not find <head> section');
  process.exit(1);
}

const newHead = '<head>\n' +
'    <meta charset="UTF-8">\n' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'    <title>SMS Gateway Dashboard</title>\n' +
'    <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
'    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
'    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">\n' +
'    <script src="https://cdn.tailwindcss.com"></script>\n' +
'    <script>\n' +
'        tailwind.config = {\n' +
'            theme: {\n' +
'                extend: {\n' +
'                    colors: {\n' +
'                        dark: {\n' +
"                            900: '#0a0a0e',\n" +
"                            800: '#111118',\n" +
"                            700: '#17171f',\n" +
"                            600: '#1e1e28',\n" +
"                            500: '#26262f',\n" +
'                        },\n' +
"                        accent: '#22c55e',\n" +
'                    },\n' +
'                    fontFamily: {\n' +
"                        sans: ['Fira Sans', 'system-ui', 'sans-serif'],\n" +
"                        mono: ['Fira Code', 'monospace'],\n" +
'                    }\n' +
'                }\n' +
'            }\n' +
'        }\n' +
'    </script>\n' +
'    <style>\n' +
"        * { font-family: 'Fira Sans', system-ui, sans-serif; }\n" +
'        .progress-ring { transform: rotate(-90deg); }\n' +
'        .progress-ring__circle { transition: stroke-dashoffset 0.5s ease; }\n' +
'        ::-webkit-scrollbar { width: 6px; height: 6px; }\n' +
"        ::-webkit-scrollbar-track { background: #111118; }\n" +
"        ::-webkit-scrollbar-thumb { background: #2a2a35; border-radius: 3px; }\n" +
"        ::-webkit-scrollbar-thumb:hover { background: #3a3a48; }\n" +
'        .sidebar-btn { transition: color 0.15s, background-color 0.15s; }\n' +
'        .sidebar-btn.text-white { color: #22c55e !important; background-color: rgba(34,197,94,0.1) !important; }\n' +
'        .sidebar-btn:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }\n' +
'    </style>\n' +
'</head>';

content = content.slice(0, headStart) + newHead + content.slice(headEnd);

// ===== PATCH 2: SIDEBAR =====
// Replace from <!-- Sidebar --> through </aside> (before <!-- Main Content -->)
const sidebarMarker = '        <!-- Sidebar -->';
const sidebarStart = content.indexOf(sidebarMarker);
if (sidebarStart === -1) {
  console.error('ERROR: Could not find <!-- Sidebar --> marker');
  process.exit(1);
}
// Find the </aside> that closes the sidebar
const asideEndTag = '        </aside>';
const sidebarEnd = content.indexOf(asideEndTag, sidebarStart) + asideEndTag.length;
if (sidebarEnd === asideEndTag.length - 1) {
  console.error('ERROR: Could not find closing </aside> after sidebar');
  process.exit(1);
}

const dashSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path>';
const simSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"></path>';
const msgSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>';
const wkrSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>';
const gwSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path>';
const imeiSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path>';
const errSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path>';
const billSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>';
const guidSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path>';
const logoSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>';
const refreshSVG = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>';

function navBtn(href, tab, cls, svg, label, extra) {
  var isActive = tab === 'dashboard' ? ' active' : '';
  var rel = extra || '';
  return '                <a href="' + href + '" onclick="event.preventDefault();switchTab(\'' + tab + '\')" data-tab="' + tab + '" class="sidebar-btn' + isActive + ' w-full flex items-center gap-3 px-3 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-600" title="' + label + '">\n' +
         '                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">' + svg + '</svg>\n' +
         '                    <span class="text-sm">' + label + '</span>\n' +
         rel +
         '                </a>';
}

var newSidebar = '        <!-- Sidebar -->\n' +
'        <aside class="w-56 bg-dark-800 flex flex-col py-4 border-r border-dark-600">\n' +
'            <div class="flex items-center gap-3 px-4 mb-8">\n' +
'                <div class="w-9 h-9 bg-accent rounded-lg flex items-center justify-center flex-shrink-0">\n' +
'                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">' + logoSVG + '</svg>\n' +
'                </div>\n' +
'                <div>\n' +
'                    <p class="text-sm font-semibold text-white leading-tight">SMS</p>\n' +
'                    <p class="text-xs text-gray-500 leading-tight">Gateway</p>\n' +
'                </div>\n' +
'            </div>\n' +
'            <nav class="flex flex-col gap-1 px-2">\n' +
navBtn('/', 'dashboard', '', dashSVG, 'Dashboard') + '\n' +
navBtn('/sims', 'sims', '', simSVG, 'SIMs') + '\n' +
navBtn('/messages', 'messages', '', msgSVG, 'Messages') + '\n' +
navBtn('/workers', 'workers', '', wkrSVG, 'Workers') + '\n' +
navBtn('/gateway', 'gateway', '', gwSVG, 'Gateway') + '\n' +
navBtn('/imei-pool', 'imei-pool', '', imeiSVG, 'IMEI Pool') + '\n' +
'                <a href="/errors" onclick="event.preventDefault();switchTab(\'errors\')" data-tab="errors" class="sidebar-btn w-full flex items-center gap-3 px-3 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-600" title="Errors">\n' +
'                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">' + errSVG + '</svg>\n' +
'                    <span class="text-sm">Errors</span>\n' +
'                    <span id="error-badge" class="hidden ml-auto min-w-[16px] h-4 bg-red-500 rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1">0</span>\n' +
'                </a>\n' +
navBtn('/billing', 'billing', '', billSVG, 'Billing') + '\n' +
navBtn('/guide', 'guide', '', guidSVG, 'Guide') + '\n' +
'            </nav>\n' +
'            <div class="mt-auto px-2">\n' +
'                <button onclick="loadData()" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-gray-400 hover:text-accent hover:bg-dark-600 transition" title="Refresh">\n' +
'                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">' + refreshSVG + '</svg>\n' +
'                    <span class="text-sm">Refresh</span>\n' +
'                </button>\n' +
'            </div>\n' +
'        </aside>';

content = content.slice(0, sidebarStart) + newSidebar + content.slice(sidebarEnd);

// ===== CONVERT BACK TO CRLF AND WRITE =====
let final = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, final, 'utf8');
console.log('Patch applied successfully.');
console.log('Sidebar: w-16 icon-only -> w-56 labeled');
console.log('Head: added Fira Sans/Code fonts, richer dark palette, improved active state');
