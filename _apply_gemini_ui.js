import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'src/dashboard/index.js');

let content = fs.readFileSync(FILE, 'utf8');
// Normalize CRLF → LF for consistent matching
content = content.replace(/\r\n/g, '\n');

function replaceOnce(oldStr, newStr, label) {
  const idx = content.indexOf(oldStr);
  if (idx === -1) {
    console.error(`PATCH FAILED: "${label}" — old string not found`);
    process.exit(1);
  }
  content = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
  console.log(`✓ ${label}`);
}

// ============================================================
// Patch 1 — <head> section (positional)
// ============================================================
{
  const headStart = content.indexOf('<head>');
  const headClose = '</head>';
  const headEnd = content.indexOf(headClose) + headClose.length;
  if (headStart === -1 || headEnd < headClose.length) {
    console.error('PATCH FAILED: head section not found'); process.exit(1);
  }
  const newHead = `<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SMS Gateway Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>

        let sidebarOpen = false;
        function toggleSidebar(open) {
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebar-overlay');
            if (!sidebar || !overlay) return;
            if (open) {
                sidebar.classList.add('sidebar-open');
                overlay.classList.remove('hidden');
                setTimeout(() => overlay.classList.add('opacity-100'), 10);
                document.body.classList.add('overflow-hidden');
            } else {
                sidebar.classList.remove('sidebar-open');
                overlay.classList.remove('opacity-100');
                setTimeout(() => {
                    overlay.classList.add('hidden');
                    document.body.classList.remove('overflow-hidden');
                }, 300);
            }
        }

        let confirmPromiseResolver = null;
        function showConfirm(title, message) {
            const modal = document.getElementById('confirm-modal');
            if (!modal) return Promise.resolve(confirm(message));
            document.getElementById('confirm-title').textContent = title;
            document.getElementById('confirm-message').textContent = message;
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            return new Promise((resolve) => {
                confirmPromiseResolver = resolve;
            });
        }
        function handleConfirm(confirmed) {
            const modal = document.getElementById('confirm-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
            if (confirmPromiseResolver) {
                confirmPromiseResolver(confirmed);
                confirmPromiseResolver = null;
            }
        }

        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        dark: {
                            950: '#050507',
                            900: '#09090b',
                            800: '#18181b',
                            700: '#27272a',
                            600: '#3f3f46',
                            500: '#52525b',
                            400: '#a1a1aa',
                            300: '#d4d4d8',
                            200: '#e4e4e7',
                            100: '#f4f4f5',
                        },
                        accent: {
                            DEFAULT: '#3b82f6',
                            hover: '#2563eb',
                            glow: 'rgba(59, 130, 246, 0.5)'
                        },
                        surface: {
                            DEFAULT: '#18181b',
                            hover: '#27272a',
                        }
                    },
                    fontFamily: {
                        sans: ['Fira Sans', 'system-ui', 'sans-serif'],
                        mono: ['Fira Code', 'monospace'],
                    }
                }
            }
        }
    </script>
    <style>
        * { font-family: 'Inter', system-ui, sans-serif; }
        .progress-ring { transform: rotate(-90deg); }
        .progress-ring__circle { transition: stroke-dashoffset 0.5s ease; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #111118; }
        ::-webkit-scrollbar-thumb { background: #2a2a35; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #3a3a48; }
        .sidebar-btn { transition: color 0.15s, background-color 0.15s; }
        .sidebar-btn.text-white { color: #3b82f6 !important; background-color: rgba(59,130,246,0.1) !important; border-left-color: #3b82f6 !important; }
        .sidebar-btn:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
        @media (max-width: 1024px) {
            .sidebar-open { transform: translateX(0) !important; }
            .sidebar-overlay-active { display: block !important; }
        }
    </style>
</head>`;
  content = content.slice(0, headStart) + newHead + content.slice(headEnd);
  console.log('✓ head section');
}

// ============================================================
// Patch 2 — Body tag + mobile overlay + flex wrapper
// ============================================================
replaceOnce(
  '<body class="bg-dark-900 text-gray-100">\n    <div class="flex min-h-screen">',
  '<body class="bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-dark-800 via-dark-900 to-dark-900 text-dark-100 min-h-screen selection:bg-accent/30 tracking-wide overflow-x-hidden">\n    <!-- Mobile Sidebar Overlay -->\n    <div id="sidebar-overlay" onclick="toggleSidebar(false)" class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 hidden transition-opacity duration-300"></div>\n\n    <div class="flex min-h-screen relative">',
  'body + mobile overlay + flex wrapper'
);

// ============================================================
// Patch 3 — Sidebar (positional)
// ============================================================
{
  const sidebarMarker = '        <!-- Sidebar -->';
  const asideClose = '        </aside>';
  const sStart = content.indexOf(sidebarMarker);
  if (sStart === -1) { console.error('PATCH FAILED: sidebar start not found'); process.exit(1); }
  const sEnd = content.indexOf(asideClose, sStart) + asideClose.length;
  if (sEnd < asideClose.length) { console.error('PATCH FAILED: </aside> not found'); process.exit(1); }

  const newSidebar = `        <!-- Sidebar -->
        <aside id="sidebar" class="fixed inset-y-0 left-0 w-72 bg-dark-950/80 flex flex-col py-6 border-r border-white/5 z-50 backdrop-blur-2xl transition-transform duration-300 -translate-x-full lg:translate-x-0 lg:static lg:w-64">
            <div class="flex items-center gap-3 px-6 mb-10">
                <div class="w-9 h-9 bg-accent rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
                </div>
                <div>
                    <p class="text-sm font-semibold text-white leading-tight">SMS</p>
                    <p class="text-xs text-dark-500 leading-tight">Gateway</p>
                </div>
            </div>
            <nav class="flex flex-col gap-1 px-2">
                <a href="/" onclick="event.preventDefault();switchTab('dashboard')" data-tab="dashboard" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Dashboard">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path></svg>
                    <span class="text-sm">Dashboard</span>
                </a>
                <a href="/sims" onclick="event.preventDefault();switchTab('sims')" data-tab="sims" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="SIMs">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"></path></svg>
                    <span class="text-sm">SIMs</span>
                </a>
                <a href="/messages" onclick="event.preventDefault();switchTab('messages')" data-tab="messages" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Messages">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
                    <span class="text-sm">Messages</span>
                </a>
                <a href="/workers" onclick="event.preventDefault();switchTab('workers')" data-tab="workers" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Workers">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                    <span class="text-sm">Workers</span>
                </a>
                <a href="/gateway" onclick="event.preventDefault();switchTab('gateway')" data-tab="gateway" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Gateway">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path></svg>
                    <span class="text-sm">Gateway</span>
                </a>
                <a href="/imei-pool" onclick="event.preventDefault();switchTab('imei-pool')" data-tab="imei-pool" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="IMEI Pool">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                    <span class="text-sm">IMEI Pool</span>
                </a>
                <a href="/errors" onclick="event.preventDefault();switchTab('errors')" data-tab="errors" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Errors">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path></svg>
                    <span class="text-sm">Errors</span>
                    <span id="error-badge" class="hidden ml-auto min-w-[16px] h-4 bg-red-500 rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1">0</span>
                </a>
                <a href="/billing" onclick="event.preventDefault();switchTab('billing')" data-tab="billing" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Billing">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    <span class="text-sm">Billing</span>
                </a>
                <a href="/guide" onclick="event.preventDefault();switchTab('guide')" data-tab="guide" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Guide">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>
                    <span class="text-sm">Guide</span>
                </a>
            </nav>
            <div class="mt-auto px-2">
                <button onclick="loadData()" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-dark-400 hover:text-accent hover:bg-dark-600 transition" title="Refresh">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                    <span class="text-sm">Refresh</span>
                </button>
            </div>
        </aside>`;
  content = content.slice(0, sStart) + newSidebar + content.slice(sEnd);
  console.log('✓ sidebar');
}

// ============================================================
// Patch 4 — Main opening + mobile top header + padding wrapper
// ============================================================
replaceOnce(
  '        <!-- Main Content -->\n        <main class="flex-1 p-6 overflow-auto">\n            <!-- Header -->',
  '        <!-- Main Content -->\n        <main class="flex-1 w-full min-w-0 overflow-auto">\n            <!-- Mobile Top Header -->\n            <div class="lg:hidden flex items-center justify-between p-4 bg-dark-950/50 border-b border-white/5 backdrop-blur-md sticky top-0 z-30">\n                <div class="flex items-center gap-3">\n                    <div class="w-8 h-8 bg-accent rounded flex items-center justify-center">\n                        <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>\n                    </div>\n                    <span class="font-bold text-white tracking-tight">SMS Gateway</span>\n                </div>\n                <button onclick="toggleSidebar(true)" class="p-2 text-dark-400 hover:text-white transition">\n                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>\n                </button>\n            </div>\n\n            <div class="p-4 lg:p-8">\n            <!-- Header -->',
  'main opening + mobile header + padding wrapper'
);

// ============================================================
// Patch 5 — Add closing wrapper div before </main>
// ============================================================
replaceOnce(
  '        </main>',
  '            </div>\n        </main>',
  'main closing wrapper div'
);

// ============================================================
// Patch 6 — Dashboard header
// ============================================================
replaceOnce(
  '            <!-- Header -->\n            <header class="flex items-center justify-between mb-6">\n                <div>\n                    <h1 class="text-2xl font-bold text-white">SMS Gateway</h1>\n                    <p class="text-sm text-gray-400">Monitor SIMs, messages, and system status</p>\n                </div>\n                <div class="flex items-center gap-4">\n                    <span id="last-updated" class="text-xs text-gray-500"></span>\n                    <div class="w-2 h-2 bg-accent rounded-full animate-pulse" title="Connected"></div>\n                </div>\n            </header>',
  '            <!-- Header -->\n            <header class="flex flex-col md:flex-row md:items-center justify-between mb-8 pb-4 border-b border-white/5 gap-4">\n                <div>\n                    <h1 class="text-3xl font-bold text-white tracking-tight">SMS Gateway</h1>\n                    <p class="text-sm text-dark-400 mt-1 font-medium">Monitor SIMs, messages, and system status</p>\n                </div>\n                <div class="flex items-center gap-4">\n                    <span id="last-updated" class="text-xs text-dark-500"></span>\n                    <div class="w-2 h-2 bg-accent rounded-full animate-pulse" title="Connected"></div>\n                </div>\n            </header>',
  'dashboard header'
);

// ============================================================
// Patch 7 — switchTab function (positional)
// ============================================================
{
  const funcStartStr = '        function switchTab(tabName, push = true) {';
  const funcEndStr = "            if (tabName === 'billing') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadWingHistory(); }\n        }";
  const fStart = content.indexOf(funcStartStr);
  if (fStart === -1) { console.error('PATCH FAILED: switchTab start not found'); process.exit(1); }
  const fEnd = content.indexOf(funcEndStr, fStart) + funcEndStr.length;
  if (fEnd < funcEndStr.length) { console.error('PATCH FAILED: switchTab end not found'); process.exit(1); }

  // New switchTab — backtick-escaped sequences written via double-quoted strings to avoid template literal issues
  const newFunc = [
    "        function switchTab(tabName, push = true) {",
    "            toggleSidebar(false);",
    "            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));",
    "            document.querySelectorAll('.sidebar-btn').forEach(el => {",
    "                el.classList.remove('text-white');",
    "                el.classList.add('text-dark-400');",
    "            });",
    "            const tabEl = document.getElementById(\\`tab-\\${tabName}\\`);",
    "            if (!tabEl) return;",
    "            tabEl.classList.remove('hidden');",
    "            // Highlight the correct sidebar button",
    "            document.querySelectorAll('.sidebar-btn').forEach(b => {",
    "                if (b.getAttribute('data-tab') === tabName) {",
    "                    b.classList.add('text-white');",
    "                    b.classList.remove('text-dark-400');",
    "                }",
    "            });",
    "            if (push && TAB_ROUTES[tabName]) {",
    "                history.pushState({ tab: tabName }, '', TAB_ROUTES[tabName]);",
    "            }",
    "            const PAGE_TITLES = { dashboard: 'Dashboard', sims: 'SIMs', messages: 'Messages', workers: 'Workers', gateway: 'Gateway', 'imei-pool': 'IMEI Pool', errors: 'Errors', billing: 'Billing', guide: 'Guide' };",
    "            document.title = (PAGE_TITLES[tabName] || tabName) + ' \u2014 SMS Gateway';",
    "            if (tabName === 'imei-pool') loadImeiPool();",
    "            if (tabName === 'gateway') loadPortStatus();",
    "            if (tabName === 'errors') loadErrors();",
    "            if (tabName === 'billing') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadWingHistory(); }",
    "        }",
  ].join('\n');

  content = content.slice(0, fStart) + newFunc + content.slice(fEnd);
  console.log('✓ switchTab function');
}

// ============================================================
// Patch 8 — Custom confirm modal before </body>
// ============================================================
{
  const oldEnd = '</body>\n</html>`;';
  const endIdx = content.indexOf(oldEnd);
  if (endIdx === -1) { console.error('PATCH FAILED: </body> end marker not found'); process.exit(1); }

  const confirmModal = `    <!-- Custom Confirm Modal -->
    <div id="confirm-modal" class="fixed inset-0 z-[100] hidden items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="handleConfirm(false)"></div>
        <div class="relative bg-dark-900 border border-white/10 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <div class="flex items-center gap-4 mb-4">
                <div class="w-12 h-12 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                    <svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path></svg>
                </div>
                <h3 id="confirm-title" class="text-xl font-bold text-white tracking-tight">Confirmation Required</h3>
            </div>
            <p id="confirm-message" class="text-dark-300 mb-6 leading-relaxed">Are you sure you want to proceed with this action?</p>
            <div class="flex items-center justify-end gap-3">
                <button onclick="handleConfirm(false)" class="px-5 py-2.5 text-sm font-medium text-dark-400 hover:text-white hover:bg-white/5 rounded-xl transition-all border border-transparent hover:border-white/10">Cancel</button>
                <button id="confirm-yes-btn" onclick="handleConfirm(true)" class="px-6 py-2.5 text-sm font-bold bg-accent hover:bg-blue-600 text-white rounded-xl transition-all shadow-lg shadow-accent/20 hover:shadow-accent/40 hover:-translate-y-0.5 active:translate-y-0">Confirm Action</button>
            </div>
        </div>
    </div>
`;

  content = content.slice(0, endIdx) + confirmModal + oldEnd + content.slice(endIdx + oldEnd.length);
  console.log('✓ confirm modal');
}

// ============================================================
// Write back with CRLF
// ============================================================
const output = content.replace(/\n/g, '\r\n');
fs.writeFileSync(FILE, output, 'utf8');
console.log('\nAll patches applied. Running syntax check...');
