'use strict';
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');

let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// ── 1. Backend route ──────────────────────────────────────────────────────────
const routeAnchor = '    // Serve HTML dashboard for all non-API paths (SPA routing)';
if (!content.includes(routeAnchor)) throw new Error('Route anchor not found');
content = content.replace(routeAnchor,
  '    if (url.pathname === \'/api/atomic-query\' && request.method === \'POST\') {\n' +
  '      return handleAtomicQuery(request, env, corsHeaders);\n' +
  '    }\n\n' +
  routeAnchor
);
console.log('✓ Route added');

// ── 2. Backend handleAtomicQuery function ─────────────────────────────────────
const getHtmlAnchor = 'function getHTML()';
if (!content.includes(getHtmlAnchor)) throw new Error('getHTML anchor not found');
const handlerFn =
  'async function handleAtomicQuery(request, env, corsHeaders) {\n' +
  '  try {\n' +
  '    const body = await request.json();\n' +
  '    const identifier = (body.identifier || \'\').trim();\n' +
  '    if (!identifier) {\n' +
  '      return new Response(JSON.stringify({ error: \'ICCID or MSISDN required\' }), { status: 400, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' } });\n' +
  '    }\n' +
  '    if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {\n' +
  '      return new Response(JSON.stringify({ error: \'ATOMIC credentials not configured on dashboard worker (push ATOMIC_USERNAME, ATOMIC_TOKEN, ATOMIC_PIN secrets)\' }), { status: 500, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' } });\n' +
  '    }\n' +
  '    const apiUrl = env.ATOMIC_API_URL || \'https://solutionsatt-atomic.telgoo5.com:22712\';\n' +
  '    // ICCID starts with 89 and is 19-20 digits; else treat as MSISDN\n' +
  '    const isIccid = /^89\\d{17,19}$/.test(identifier);\n' +
  '    const requestBody = {\n' +
  '      wholeSaleApi: {\n' +
  '        session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },\n' +
  '        wholeSaleRequest: {\n' +
  '          requestType: \'subsriberInquiry\',\n' +
  '          MSISDN: isIccid ? \'\' : identifier,\n' +
  '          sim: isIccid ? identifier : \'\',\n' +
  '        },\n' +
  '      },\n' +
  '    };\n' +
  '    const res = await relayFetch(env, apiUrl, {\n' +
  '      method: \'POST\',\n' +
  '      headers: { \'Content-Type\': \'application/json\' },\n' +
  '      body: JSON.stringify(requestBody),\n' +
  '    });\n' +
  '    const text = await res.text();\n' +
  '    let data;\n' +
  '    try { data = JSON.parse(text); } catch { data = { raw: text }; }\n' +
  '    await logCarrierApiCall(env, {\n' +
  '      run_id: \'atomic_query_\' + identifier + \'_\' + Date.now(),\n' +
  '      step: \'query\',\n' +
  '      iccid: isIccid ? identifier : null,\n' +
  '      imei: null,\n' +
  '      vendor: \'atomic\',\n' +
  '      request_url: apiUrl,\n' +
  '      request_method: \'POST\',\n' +
  '      request_body: requestBody,\n' +
  '      response_status: res.status,\n' +
  '      response_ok: res.ok,\n' +
  '      response_body_text: text,\n' +
  '      response_body_json: data,\n' +
  '      error: (res.ok && data && data.wholeSaleApi && data.wholeSaleApi.wholeSaleResponse && data.wholeSaleApi.wholeSaleResponse.statusCode === \'00\')\n' +
  '        ? null\n' +
  '        : \'ATOMIC query: \' + (data && data.wholeSaleApi && data.wholeSaleApi.wholeSaleResponse ? data.wholeSaleApi.wholeSaleResponse.description : res.status),\n' +
  '    });\n' +
  '    return new Response(JSON.stringify({ ok: true, response: data }), {\n' +
  '      headers: { ...corsHeaders, \'Content-Type\': \'application/json\' },\n' +
  '    });\n' +
  '  } catch (error) {\n' +
  '    return new Response(JSON.stringify({ ok: false, error: String(error) }), {\n' +
  '      status: 500,\n' +
  '      headers: { ...corsHeaders, \'Content-Type\': \'application/json\' },\n' +
  '    });\n' +
  '  }\n' +
  '}\n\n';
content = content.replace(getHtmlAnchor, handlerFn + getHtmlAnchor);
console.log('✓ Backend handler added');

// ── 3. Modal: split Helix and ATOMIC into separate options ────────────────────
const oldHelixOption = '<option value="helix">Helix / ATOMIC (Sub ID)</option>';
if (!content.includes(oldHelixOption)) throw new Error('Modal option anchor not found');
content = content.replace(oldHelixOption,
  '<option value="helix">Helix (Sub ID)</option>\n' +
  '                        <option value="atomic">ATOMIC (AT&amp;T)</option>'
);
console.log('✓ Modal option split');

// ── 4. updateCarrierQueryUI: add ATOMIC case ──────────────────────────────────
const uiElseAnchor =
  '} else {\n' +
  '                label.textContent = \'Enter a Mobility Subscription ID:\';';
if (!content.includes(uiElseAnchor)) throw new Error('updateCarrierQueryUI else anchor not found');
content = content.replace(uiElseAnchor,
  '} else if (vendor === \'atomic\') {\n' +
  '                label.textContent = \'Enter ICCID or MDN (10-digit):\';\n' +
  '                input.placeholder = \'ICCID (89010...) or MDN (9295551234)\';\n' +
  '                bulkBtn.style.display = \'none\';\n' +
  '            } else {\n' +
  '                label.textContent = \'Enter a Mobility Subscription ID:\';'
);
console.log('✓ updateCarrierQueryUI updated');

// ── 5. querySimCarrier: add ATOMIC branch ─────────────────────────────────────
const qscElseAnchor =
  '} else {\n' +
  '                vendorSelect.value = \'helix\';\n' +
  '                input.value = subId || \'\';';
if (!content.includes(qscElseAnchor)) throw new Error('querySimCarrier else anchor not found');
content = content.replace(qscElseAnchor,
  '} else if (vendor === \'atomic\') {\n' +
  '                vendorSelect.value = \'atomic\';\n' +
  '                input.value = iccid || \'\';\n' +
  '            } else {\n' +
  '                vendorSelect.value = \'helix\';\n' +
  '                input.value = subId || \'\';'
);
console.log('✓ querySimCarrier updated');

// ── 6. queryHelix: insert ATOMIC branch before Helix block ───────────────────
// Anchor: the comment that starts the Helix block
const helixBlockAnchor = '            // Helix query (original)';
if (!content.includes(helixBlockAnchor)) throw new Error('Helix block anchor not found');

// The ATOMIC result uses <br> for line breaks to avoid \\n escaping inside template literal
const atomicBranch =
  '            // ATOMIC query\n' +
  '            if (vendor === \'atomic\') {\n' +
  '                try {\n' +
  '                    const response = await fetch(API_BASE + \'/atomic-query\', {\n' +
  '                        method: \'POST\',\n' +
  '                        headers: { \'Content-Type\': \'application/json\' },\n' +
  '                        body: JSON.stringify({ identifier: inputVal })\n' +
  '                    });\n' +
  '                    const result = await response.json();\n' +
  '                    const outputEl = document.getElementById(\'helix-query-output\');\n' +
  '                    const resultDiv = document.getElementById(\'helix-query-result\');\n' +
  '                    document.getElementById(\'helix-db-update-banner\').classList.add(\'hidden\');\n' +
  '                    if (!result.ok) {\n' +
  '                        outputEl.innerHTML = \'<span class="text-red-400">Error: \' + (result.error || \'Unknown\') + \'</span>\';\n' +
  '                    } else {\n' +
  '                        const wr = result.response && result.response.wholeSaleApi && result.response.wholeSaleApi.wholeSaleResponse;\n' +
  '                        let fmtd = \'\';\n' +
  '                        if (wr) {\n' +
  '                            const r = wr.Result || {};\n' +
  '                            const ok2 = wr.statusCode === \'00\';\n' +
  '                            fmtd += \'<span class="\' + (ok2 ? \'text-green-400\' : \'text-red-400\') + \' font-bold">statusCode: \' + wr.statusCode + \'</span><br>\';\n' +
  '                            fmtd += \'<span class="text-blue-400">description:</span> \' + wr.description + \'<br>\';\n' +
  '                            if (r.attStatus) fmtd += \'<span class="text-blue-400">attStatus:</span> <span class="\' + (r.attStatus === \'Active\' ? \'text-accent\' : \'text-orange-400\') + \' font-bold">\' + r.attStatus + \'</span><br>\';\n' +
  '                            if (r.MSISDN) fmtd += \'<span class="text-blue-400">MSISDN:</span> \' + r.MSISDN + \'<br>\';\n' +
  '                            if (r.BAN) fmtd += \'<span class="text-blue-400">BAN:</span> \' + r.BAN + \'<br>\';\n' +
  '                            if (r.activationDate) fmtd += \'<span class="text-blue-400">activationDate:</span> \' + r.activationDate + \'<br>\';\n' +
  '                            fmtd += \'<br><span class="text-gray-500">--- Full Response ---</span><br>\';\n' +
  '                            fmtd += JSON.stringify(wr, null, 2);\n' +
  '                        } else {\n' +
  '                            fmtd = JSON.stringify(result.response, null, 2);\n' +
  '                        }\n' +
  '                        outputEl.innerHTML = fmtd;\n' +
  '                    }\n' +
  '                    resultDiv.classList.remove(\'hidden\');\n' +
  '                } catch (err) {\n' +
  '                    showToast(\'Error querying ATOMIC\', \'error\');\n' +
  '                    console.error(err);\n' +
  '                } finally {\n' +
  '                    btn.disabled = false;\n' +
  '                    btn.textContent = \'Query\';\n' +
  '                }\n' +
  '                return;\n' +
  '            }\n\n' +
  helixBlockAnchor;

content = content.replace(helixBlockAnchor, atomicBranch);
console.log('✓ queryHelix ATOMIC branch added');

// ── Write back ────────────────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done. Run: node --input-type=module --check < src/dashboard/index.js');
