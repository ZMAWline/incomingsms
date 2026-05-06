// Patch: close any modal on Escape key or backdrop click
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD = `        loadGatewayDropdown();`;

const NEW = `        // Close any visible modal on Escape key or backdrop click
        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape') return;
            document.querySelectorAll('[id$="-modal"]:not(.hidden)').forEach(function(m) {
                m.classList.add('hidden');
            });
        });
        document.addEventListener('click', function(e) {
            var t = e.target;
            if (t.id && t.id.endsWith('-modal') && !t.classList.contains('hidden')) {
                t.classList.add('hidden');
            }
        });

        loadGatewayDropdown();`;

if (!content.includes(OLD)) {
  console.error('ERROR: anchor not found');
  process.exit(1);
}
content = content.replace(OLD, NEW);
console.log('✓ Global modal close listeners added');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written (CRLF)');
