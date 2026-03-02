#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(DASH, 'utf-8');
const hadCRLF = src.includes('\r\n');
if (hadCRLF) src = src.replace(/\r\n/g, '\n');

function replace(needle, replacement, label) {
  if (!src.includes(needle)) {
    console.error(`FAILED: ${label}`);
    console.error(`  Needle: ${JSON.stringify(needle.slice(0, 120))}`);
    process.exit(1);
  }
  src = src.replace(needle, replacement);
  console.log(`OK: ${label}`);
}

// ===========================================================================
// 1) Add page/pageSize to tableState
// ===========================================================================
replace(
  "sims: { data: [], sortKey: 'id', sortDir: 'asc' },\n            messages: { data: [], sortKey: 'received_at', sortDir: 'desc' },\n            imei: { data: [], sortKey: 'id', sortDir: 'desc' },",
  "sims: { data: [], sortKey: 'id', sortDir: 'asc', page: 1, pageSize: 50 },\n            messages: { data: [], sortKey: 'received_at', sortDir: 'desc', page: 1, pageSize: 50 },\n            imei: { data: [], sortKey: 'id', sortDir: 'desc', page: 1, pageSize: 50 },\n            errors: { data: [], sortKey: 'id', sortDir: 'desc', page: 1, pageSize: 50 },",
  'Add page/pageSize to tableState'
);

// ===========================================================================
// 2) Reset page to 1 on sort
// ===========================================================================
replace(
  "function sortTable(table, key) {\n            const state = tableState[table];\n            if (state.sortKey === key) {\n                state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';\n            } else {\n                state.sortKey = key;\n                state.sortDir = 'asc';\n            }",
  "function sortTable(table, key) {\n            const state = tableState[table];\n            if (state.sortKey === key) {\n                state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';\n            } else {\n                state.sortKey = key;\n                state.sortDir = 'asc';\n            }\n            state.page = 1;",
  'Reset page on sort'
);

// ===========================================================================
// 3) Add pagination helper functions after matchesSearch
// ===========================================================================
replace(
  "function matchesSearch(obj, query) {\n            if (!query) return true;\n            const q = query.toLowerCase();\n            return Object.values(obj).some(v => v != null && String(v).toLowerCase().includes(q));\n        }",
  `function matchesSearch(obj, query) {
            if (!query) return true;
            const q = query.toLowerCase();
            return Object.values(obj).some(v => v != null && String(v).toLowerCase().includes(q));
        }

        function paginate(data, table) {
            const state = tableState[table];
            const totalItems = data.length;
            const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize));
            if (state.page > totalPages) state.page = totalPages;
            const start = (state.page - 1) * state.pageSize;
            const paged = data.slice(start, start + state.pageSize);
            return { paged, totalItems, totalPages, page: state.page, pageSize: state.pageSize };
        }

        function changePageSize(table, size) {
            tableState[table].pageSize = parseInt(size) || 50;
            tableState[table].page = 1;
            if (table === 'sims') renderSims();
            else if (table === 'messages') renderMessages();
            else if (table === 'imei') renderImeiPool();
            else if (table === 'errors') renderErrors();
        }

        function goToPage(table, page) {
            tableState[table].page = page;
            if (table === 'sims') renderSims();
            else if (table === 'messages') renderMessages();
            else if (table === 'imei') renderImeiPool();
            else if (table === 'errors') renderErrors();
        }

        function renderPaginationControls(containerId, table, totalItems, totalPages, currentPage, pageSize) {
            const el = document.getElementById(containerId);
            if (!el) return;
            if (totalItems === 0) { el.innerHTML = ''; return; }

            const maxButtons = 7;
            let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
            let endPage = Math.min(totalPages, startPage + maxButtons - 1);
            if (endPage - startPage < maxButtons - 1) startPage = Math.max(1, endPage - maxButtons + 1);

            let buttons = '';
            if (currentPage > 1) {
                buttons += '<button onclick="goToPage(\\'' + table + '\\',' + (currentPage - 1) + ')" class="px-2 py-1 text-xs bg-dark-700 hover:bg-dark-600 text-gray-300 rounded transition">&laquo;</button>';
            }
            for (let p = startPage; p <= endPage; p++) {
                const active = p === currentPage ? 'bg-accent text-white' : 'bg-dark-700 hover:bg-dark-600 text-gray-300';
                buttons += '<button onclick="goToPage(\\'' + table + '\\',' + p + ')" class="px-2.5 py-1 text-xs ' + active + ' rounded transition">' + p + '</button>';
            }
            if (currentPage < totalPages) {
                buttons += '<button onclick="goToPage(\\'' + table + '\\',' + (currentPage + 1) + ')" class="px-2 py-1 text-xs bg-dark-700 hover:bg-dark-600 text-gray-300 rounded transition">&raquo;</button>';
            }

            const start = (currentPage - 1) * pageSize + 1;
            const end = Math.min(currentPage * pageSize, totalItems);

            el.innerHTML = '<div class="flex items-center justify-between px-4 py-3">'
                + '<div class="flex items-center gap-2">'
                + '<span class="text-xs text-gray-500">Show</span>'
                + '<select onchange="changePageSize(\\'' + table + '\\', this.value)" class="text-xs bg-dark-700 border border-dark-500 rounded px-2 py-1 text-gray-300">'
                + [25, 50, 100, 200, 500].map(n => '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + '</option>').join('')
                + '</select>'
                + '<span class="text-xs text-gray-500">per page</span>'
                + '</div>'
                + '<div class="flex items-center gap-1">' + buttons + '</div>'
                + '<span class="text-xs text-gray-500">' + start + '-' + end + ' of ' + totalItems + '</span>'
                + '</div>';
        }`,
  'Add pagination helper functions'
);

// ===========================================================================
// 4) Add pagination containers after each table's closing </table></div>
// ===========================================================================

// SIMs table
replace(
  '                            </tbody>\n                        </table>\n                    </div>\n                </div>\n            </div>\n\n            <!-- Messages Tab -->',
  '                            </tbody>\n                        </table>\n                    </div>\n                    <div id="sims-pagination"></div>\n                </div>\n            </div>\n\n            <!-- Messages Tab -->',
  'Add sims pagination container'
);

// Messages table
replace(
  '                            </tbody>\n                        </table>\n                    </div>\n                </div>\n            </div>\n\n            <!-- Workers Tab -->',
  '                            </tbody>\n                        </table>\n                    </div>\n                    <div id="messages-pagination"></div>\n                </div>\n            </div>\n\n            <!-- Workers Tab -->',
  'Add messages pagination container'
);

// IMEI pool table - use tab-specific context
replace(
  'id="imei-pool-table" class="text-sm">',
  'id="imei-pool-table" class="text-sm" data-paginated="imei">',
  'Mark imei table for pagination (unique marker)'
);
replace(
  'data-paginated="imei">\n                                <tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>\n                            </tbody>\n                        </table>\n                    </div>\n                </div>',
  'data-paginated="imei">\n                                <tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>\n                            </tbody>\n                        </table>\n                    </div>\n                    <div id="imei-pagination"></div>\n                </div>',
  'Add imei pagination container'
);

// Errors table
replace(
  'id="errors-table" class="text-sm">',
  'id="errors-table" class="text-sm" data-paginated="errors">',
  'Mark errors table for pagination (unique marker)'
);
replace(
  'data-paginated="errors">\n                                <tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>\n                            </tbody>\n                        </table>\n                    </div>\n                </div>',
  'data-paginated="errors">\n                                <tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>\n                            </tbody>\n                        </table>\n                    </div>\n                    <div id="errors-pagination"></div>\n                </div>',
  'Add errors pagination container'
);

// ===========================================================================
// 5) Modify renderSims to paginate
// ===========================================================================
{
  // Find the renderSims tbody.innerHTML block and add pagination before it
  const anchor = "function renderSims() {";
  const idx = src.indexOf(anchor);
  if (idx === -1) { console.error('FAILED: find renderSims'); process.exit(1); }

  // Find "data = genericSort" line after renderSims
  const sortLine = src.indexOf("data = genericSort(data, state.sortKey, state.sortDir);", idx);
  const afterSort = src.indexOf("\n", sortLine) + 1;

  // Find the next line which should set tbody
  const tbodyLine = src.indexOf("const tbody = document.getElementById('sims-table');", afterSort);

  // Insert pagination logic between sort and tbody
  const paginationCode = `
            const simsPag = paginate(data, 'sims');
            data = simsPag.paged;
            countEl.textContent = \`\${simsPag.totalItems} SIM(s) | Page \${simsPag.page}/\${simsPag.totalPages}\`;
`;
  // We need to inject after the countEl line. Let me find a better spot.
  // Actually let's find the countEl line and replace it
  const countLine = "countEl.textContent = `${data.length} of ${state.data.length} SIM(s)`;";
  const countIdx = src.indexOf(countLine, idx);
  if (countIdx === -1) {
    console.error('FAILED: find sims countEl line');
    // Try without backtick escaping - the file has \`
    console.error('Looking for escaped version...');
  }
}

// Use a different approach: find the exact lines with the file's actual escaping
// The file uses \` and \$ inside the getHTML template literal
{
  // renderSims: after genericSort, before tbody assignment, add pagination
  // Find "data = genericSort(data, state.sortKey, state.sortDir);" inside renderSims
  const renderSimsStart = src.indexOf("function renderSims() {");
  const sortIdx = src.indexOf("data = genericSort(data, state.sortKey, state.sortDir);", renderSimsStart);
  const afterSortNewline = src.indexOf("\n", sortIdx) + 1;

  // Read the next few chars to find the tbody line
  const nextChunk = src.slice(afterSortNewline, afterSortNewline + 200);

  // The count line uses \` and \$ in the file
  // Replace the count line + insert pagination between sort and tbody
  // Strategy: insert right after the sort line

  const oldAfterSort = src.slice(afterSortNewline, afterSortNewline + nextChunk.indexOf("const tbody"));
  const paginationInsert = "            const simsPag = paginate(data, 'sims');\n            data = simsPag.paged;\n\n";

  src = src.slice(0, afterSortNewline) + paginationInsert + src.slice(afterSortNewline);
  console.log('OK: Add pagination to renderSims (data slice)');

  // Now update the countEl line - find it
  const countAnchor = "sims-count";
  const countIdx = src.indexOf(countAnchor, renderSimsStart);
  // Find the full line with textContent assignment
  const lineStart = src.lastIndexOf("\n", countIdx) + 1;
  const lineEnd = src.indexOf("\n", countIdx);
  const oldLine = src.slice(lineStart, lineEnd);

  // Build new line preserving the file's escaping (\` and \$)
  const newLine = "            countEl.textContent = \\`\\${simsPag.totalItems} SIM(s) | Page \\${simsPag.page}/\\${simsPag.totalPages}\\`;";
  src = src.slice(0, lineStart) + newLine + src.slice(lineEnd);
  console.log('OK: Update sims count display');

  // Add renderPaginationControls call at end of renderSims
  // Find the end of renderSims: after the tbody.innerHTML = data.map(...).join('');
  const joinEnd = src.indexOf("}).join('');", src.indexOf("tbody.innerHTML = data.map(sim =>", renderSimsStart));
  const afterJoin = src.indexOf("\n", joinEnd) + 1;
  const paginationCall = "            renderPaginationControls('sims-pagination', 'sims', simsPag.totalItems, simsPag.totalPages, simsPag.page, simsPag.pageSize);\n";
  src = src.slice(0, afterJoin) + paginationCall + src.slice(afterJoin);
  console.log('OK: Add pagination controls call to renderSims');
}

// ===========================================================================
// 6) Modify renderMessages to paginate
// ===========================================================================
{
  const fnStart = src.indexOf("function renderMessages() {");
  const sortIdx = src.indexOf("data = genericSort(data, state.sortKey, state.sortDir);", fnStart);
  const afterSort = src.indexOf("\n", sortIdx) + 1;

  const pagInsert = "            const msgPag = paginate(data, 'messages');\n            data = msgPag.paged;\n\n";
  src = src.slice(0, afterSort) + pagInsert + src.slice(afterSort);
  console.log('OK: Add pagination to renderMessages (data slice)');

  // Add pagination controls call at end
  const joinEnd = src.indexOf("}).join('');", src.indexOf("tbody.innerHTML = data.map(msg =>", fnStart));
  const afterJoin = src.indexOf("\n", joinEnd) + 1;
  const pagCall = "            renderPaginationControls('messages-pagination', 'messages', msgPag.totalItems, msgPag.totalPages, msgPag.page, msgPag.pageSize);\n";
  src = src.slice(0, afterJoin) + pagCall + src.slice(afterJoin);
  console.log('OK: Add pagination controls call to renderMessages');
}

// ===========================================================================
// 7) Modify renderImeiPool to paginate
// ===========================================================================
{
  const fnStart = src.indexOf("function renderImeiPool() {");
  const sortIdx = src.indexOf("data = genericSort(data, state.sortKey, state.sortDir);", fnStart);
  const afterSort = src.indexOf("\n", sortIdx) + 1;

  const pagInsert = "            const imeiPag = paginate(data, 'imei');\n            data = imeiPag.paged;\n\n";
  src = src.slice(0, afterSort) + pagInsert + src.slice(afterSort);
  console.log('OK: Add pagination to renderImeiPool (data slice)');

  // Add pagination controls call at end
  const joinEnd = src.indexOf("}).join('');", src.indexOf("tbody.innerHTML = data.map(entry =>", fnStart));
  const afterJoin = src.indexOf("\n", joinEnd) + 1;
  const pagCall = "            renderPaginationControls('imei-pagination', 'imei', imeiPag.totalItems, imeiPag.totalPages, imeiPag.page, imeiPag.pageSize);\n";
  src = src.slice(0, afterJoin) + pagCall + src.slice(afterJoin);
  console.log('OK: Add pagination controls call to renderImeiPool');
}

// ===========================================================================
// 8) Modify renderErrors to paginate
// ===========================================================================
{
  const fnStart = src.indexOf("function renderErrors() {");
  // errors doesn't use genericSort currently, it just filters. Add pagination after the filter.
  // Find the "const tbody = document.getElementById('errors-table');" line
  const tbodyIdx = src.indexOf("const tbody = document.getElementById('errors-table');", fnStart);

  // Insert pagination before tbody
  const pagInsert = "            const errPag = paginate(data, 'errors');\n            data = errPag.paged;\n\n            ";
  src = src.slice(0, tbodyIdx) + pagInsert + src.slice(tbodyIdx);
  console.log('OK: Add pagination to renderErrors (data slice)');

  // Update errors count display - find the line
  const errCountAnchor = "errors-count";
  const errCountIdx = src.indexOf(errCountAnchor, fnStart);
  const errLineStart = src.lastIndexOf("\n", errCountIdx) + 1;
  const errLineEnd = src.indexOf("\n", errCountIdx);
  const newErrLine = "            document.getElementById('errors-count').textContent = \\`\\${errPag.totalItems} error(s) | Page \\${errPag.page}/\\${errPag.totalPages}\\`;";
  src = src.slice(0, errLineStart) + newErrLine + src.slice(errLineEnd);
  console.log('OK: Update errors count display');

  // Add pagination controls call at end of renderErrors
  const joinEnd = src.indexOf("}).join('');", src.indexOf("tbody.innerHTML = data.map(sim =>", fnStart + 100));
  const afterJoin = src.indexOf("\n", joinEnd) + 1;
  const pagCall = "            renderPaginationControls('errors-pagination', 'errors', errPag.totalItems, errPag.totalPages, errPag.page, errPag.pageSize);\n";
  src = src.slice(0, afterJoin) + pagCall + src.slice(afterJoin);
  console.log('OK: Add pagination controls call to renderErrors');
}

// ===========================================================================
// 9) Reset page to 1 on search input for each table
// ===========================================================================
replace(
  'oninput="renderSims()"',
  'oninput="tableState.sims.page=1;renderSims()"',
  'Reset sims page on search'
);

replace(
  'oninput="renderMessages()"',
  'oninput="tableState.messages.page=1;renderMessages()"',
  'Reset messages page on search'
);

replace(
  'oninput="renderImeiPool()"',
  'oninput="tableState.imei.page=1;renderImeiPool()"',
  'Reset imei page on search'
);

replace(
  'oninput="renderErrors()"',
  'oninput="tableState.errors.page=1;renderErrors()"',
  'Reset errors page on search'
);

// Also reset on filter change
replace(
  'onchange="renderImeiPool()"',
  'onchange="tableState.imei.page=1;renderImeiPool()"',
  'Reset imei page on filter change'
);

// ===========================================================================
// WRITE
// ===========================================================================
if (hadCRLF) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(DASH, src, 'utf-8');
console.log('\n=== Pagination complete! ===');
