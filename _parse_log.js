const text = require('fs').readFileSync('C:/Users/zalme/.claude/projects/C--Users-zalme-OneDrive-Documents-incomingsms-incomingsms/148fdbf5-17f6-45c1-833a-40c8f5615a73/tool-results/toolu_01X9iVxZHFCJnc6PRVbQg6dX.json', 'utf8');
const d = JSON.parse(text);
const raw = d[0].text;
const m = raw.indexOf('[{"id"');
const end = raw.lastIndexOf(']') + 1;
const rows = JSON.parse(raw.slice(m, end));

const runs = {};
for (const r of rows) {
  if (!runs[r.run_id]) runs[r.run_id] = [];
  runs[r.run_id].push(r);
}

const runIds = Object.keys(runs).sort((a, b) => {
  const ta = runs[a][0].created_at;
  const tb = runs[b][0].created_at;
  return tb > ta ? 1 : -1;
});

for (const rid of runIds.slice(0, 4)) {
  console.log('\n=== RUN:', rid, '===');
  const steps = runs[rid].sort((a, b) => a.id - b.id);
  for (const r of steps) {
    console.log('  step:', r.step, '| ts:', r.created_at, '| httpStatus:', r.response_status, '| ok:', r.response_ok);
    if (r.error) console.log('    ERROR:', r.error);
    try {
      const b = JSON.parse(r.response_body_text);
      if (b.rejected && b.rejected.length) console.log('    REJECTED:', JSON.stringify(b.rejected));
      if (b.fulfilled && b.fulfilled.length) {
        const f = b.fulfilled[0];
        const info = { status: f.status, subscriberState: f.subscriberState };
        const sc = f.serviceCharacteristic;
        if (sc) {
          const ss = sc.find(x => x.name === 'subscriberStatus');
          const rc = sc.find(x => x.name === 'statusReasonCode');
          if (ss) info.subscriberStatus = ss.value;
          if (rc) info.reasonCode = rc.value;
        }
        console.log('    fulfilled[0]:', JSON.stringify(info));
      }
    } catch (e) {
      console.log('    body:', String(r.response_body_text).slice(0, 150));
    }
  }
}
