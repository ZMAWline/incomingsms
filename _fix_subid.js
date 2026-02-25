'use strict';
// Fix: save mobilitySubscriptionId to sims table in retryActivation step 6c
const fs = require('fs');
const filePath = 'src/mdn-rotator/index.js';

let src = fs.readFileSync(filePath, 'utf8');
src = src.replace(/\r\n/g, '\n');

const old_patch =
  '  await supabasePatch(env, \'sims?id=eq.\' + encodeURIComponent(String(simId)), {\n' +
  '    status: \'provisioning\',\n' +
  '    last_activation_error: null,\n' +
  '    imei: poolEntry.imei,\n' +
  '    current_imei_pool_id: poolEntry.id,\n' +
  '  });';

const new_patch =
  '  await supabasePatch(env, \'sims?id=eq.\' + encodeURIComponent(String(simId)), {\n' +
  '    status: \'provisioning\',\n' +
  '    last_activation_error: null,\n' +
  '    imei: poolEntry.imei,\n' +
  '    current_imei_pool_id: poolEntry.id,\n' +
  '    mobility_subscription_id: activateResult.mobilitySubscriptionId,\n' +
  '  });';

if (!src.includes(old_patch)) throw new Error('step 6c patch target not found');
src = src.replace(old_patch, new_patch);

src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, src, 'utf8');
console.log('Sub ID fix applied.');
