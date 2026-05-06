// Add relay support to handleWingCheck
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

const OLD = `    const baseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
    const url = baseUrl + '/v1/devices/' + encodeURIComponent(iccid);
    const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);
    const runId = 'wing_check_' + iccid + '_' + Date.now();

    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: auth }
    });`;

const NEW = `    const baseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
    const url = baseUrl + '/v1/devices/' + encodeURIComponent(iccid);
    const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);
    const runId = 'wing_check_' + iccid + '_' + Date.now();

    const headers = { Authorization: auth };
    if (env.RELAY_KEY) headers['x-relay-key'] = env.RELAY_KEY;
    const fetchUrl = env.RELAY_URL ? env.RELAY_URL + '/' + url : url;
    const res = await fetch(fetchUrl, {
      method: 'GET',
      headers
    });`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old pattern not found');
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: Wing IoT check now uses relay if configured');
