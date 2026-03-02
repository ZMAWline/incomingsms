// Patch: click message body to see full text
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
src = src.replace(/\r\n/g, '\n');

// ── 1. Add msg-body-modal HTML after the bulk-send-sms-modal div ──────────
const modalAnchor = '<div id="bulk-send-sms-modal" class="fixed inset-0 bg-black/70 z-50 hidden flex items-center justify-center p-4">';
if (!src.includes(modalAnchor)) {
  console.error('Cannot find bulk-send-sms-modal anchor'); process.exit(1);
}

const msgBodyModalHtml =
  '\n    <!-- Message Body Modal -->\n' +
  '    <div id="msg-body-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onclick="hideMsgBodyModal()">\n' +
  '        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-lg" onclick="event.stopPropagation()">\n' +
  '            <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">\n' +
  '                <h3 class="text-base font-semibold text-white">Message</h3>\n' +
  '                <button onclick="hideMsgBodyModal()" class="text-gray-500 hover:text-white text-xl leading-none">&times;</button>\n' +
  '            </div>\n' +
  '            <div class="p-5">\n' +
  '                <p id="msg-body-text" class="text-sm text-gray-200 whitespace-pre-wrap break-words"></p>\n' +
  '            </div>\n' +
  '        </div>\n' +
  '    </div>\n';

src = src.replace(modalAnchor, msgBodyModalHtml + '\n    ' + modalAnchor);

// ── 2. Add showMsgBody / hideMsgBodyModal functions before renderMessages ──
const renderMsgsFn = 'function renderMessages() {';
if (!src.includes(renderMsgsFn)) {
  console.error('Cannot find renderMessages function'); process.exit(1);
}

const newFns =
  'function showMsgBody(text) {\n' +
  '            document.getElementById(\'msg-body-text\').textContent = text;\n' +
  '            document.getElementById(\'msg-body-modal\').classList.remove(\'hidden\');\n' +
  '        }\n' +
  '        function hideMsgBodyModal() {\n' +
  '            document.getElementById(\'msg-body-modal\').classList.add(\'hidden\');\n' +
  '        }\n' +
  '        ';

src = src.replace(renderMsgsFn, newFns + renderMsgsFn);

// ── 3. Make body cell clickable in renderMessages() ───────────────────────
const oldMainCell = '<td class="px-5 py-3 text-gray-300 max-w-md truncate">\\${msg.body}</td>';
if (!src.includes(oldMainCell)) {
  console.error('Cannot find main body cell'); process.exit(1);
}
const newMainCell =
  '<td class="px-5 py-3 text-gray-300 max-w-md truncate cursor-pointer hover:text-white" ' +
  'onclick="showMsgBody(this.dataset.body)" data-body="\\${(msg.body||\'\')}">\\${msg.body}</td>';
src = src.replace(oldMainCell, newMainCell);

// ── 4. Make body cell clickable in preview table ──────────────────────────
const oldPreviewCell = '<td class="px-5 py-3 text-gray-300 truncate max-w-xs">\\${msg.body}</td>';
if (!src.includes(oldPreviewCell)) {
  console.error('Cannot find preview body cell'); process.exit(1);
}
const newPreviewCell =
  '<td class="px-5 py-3 text-gray-300 truncate max-w-xs cursor-pointer hover:text-white" ' +
  'onclick="showMsgBody(this.dataset.body)" data-body="\\${(msg.body||\'\')}">\\${msg.body}</td>';
src = src.replace(oldPreviewCell, newPreviewCell);

// ── 5. Write back with CRLF ───────────────────────────────────────────────
src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, src, 'utf8');
console.log('Patch applied successfully.');
