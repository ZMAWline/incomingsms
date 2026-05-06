const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

content = content.replace(/Loading Helix API logs/g, 'Loading API logs');
content = content.replace(/Loading Helix logs/g, 'Loading API logs');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed Loading logs text');
