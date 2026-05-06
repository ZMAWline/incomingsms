import { readFileSync, writeFileSync } from 'fs';

const FILE = 'src/dashboard/index.js';
let content = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

const OLD = `        html.light ::-webkit-scrollbar-thumb { background: rgb(var(--dark-600)); border-radius: 3px; }`;
const NEW = `        html.light ::-webkit-scrollbar-thumb { background: rgb(var(--dark-600)); border-radius: 3px; }
        /* text-gray-* classes are Tailwind built-ins that don't adapt — override for light mode */
        html.light .text-gray-200 { color: rgb(30 41 59) !important; }
        html.light .text-gray-300 { color: rgb(51 65 85) !important; }
        html.light .text-gray-400 { color: rgb(71 85 105) !important; }
        html.light .text-gray-500 { color: rgb(100 116 139) !important; }
        html.light .text-gray-600 { color: rgb(71 85 105) !important; }`;

if (!content.includes(OLD)) throw new Error('Anchor not found');
content = content.replace(OLD, NEW);
console.log('Patched text-gray-* light mode overrides');

writeFileSync(FILE, content.replace(/\n/g, '\r\n'), 'utf8');
console.log('Done.');
