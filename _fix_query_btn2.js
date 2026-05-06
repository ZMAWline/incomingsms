// Add Query button after Status button
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

// Find the Status button and add Query after it
// The Status button ends with: ml-1">Status</button>\`}
// Followed by whitespace and </td>

const oldPattern = 'ml-1">Status</button>\\`}\n                    </td>';
const newPattern = 'ml-1">Status</button>\\`}\n                        \\${\\`<button onclick="querySimCarrier(\\${sim.id}, \'\\${sim.vendor}\', \'\\${sim.mobility_subscription_id || \'\'}\', \'\\${sim.iccid}\')" class="px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded transition ml-1">Query</button>\\`}\n                    </td>';

if (content.includes(oldPattern)) {
  content = content.replace(oldPattern, newPattern);
  console.log('Added Query button');
} else {
  console.log('Pattern not found');
  // Debug
  const idx = content.indexOf('Status</button>');
  if (idx > -1) {
    console.log('Context around Status button:');
    console.log(JSON.stringify(content.slice(idx, idx + 100)));
  }
}

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
