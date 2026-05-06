// _fix_qty_label.js — change 'Qty' to 'Item Quantity' in QB billing CSV
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. CSV header
const OLD1 = `'ServiceDate', 'ProductService', 'Description', 'Qty', 'Rate', 'Amount'`;
const NEW1 = `'ServiceDate', 'ProductService', 'Description', 'Item Quantity', 'Rate', 'Amount'`;
if (!content.includes(OLD1)) { console.error('PATCH FAILED: CSV header not found.'); process.exit(1); }
content = content.replace(OLD1, NEW1);

// 2. Help text
const OLD2 = `InvoiceNo, Customer, InvoiceDate, DueDate, Terms, ServiceDate, ProductService, Description, Qty, Rate, Amount`;
const NEW2 = `InvoiceNo, Customer, InvoiceDate, DueDate, Terms, ServiceDate, ProductService, Description, Item Quantity, Rate, Amount`;
if (!content.includes(OLD2)) { console.error('PATCH FAILED: help text not found.'); process.exit(1); }
content = content.replace(OLD2, NEW2);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
