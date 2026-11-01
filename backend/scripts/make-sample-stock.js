// Writes web/public/sample-stock.xlsx: a small stock sheet with Banglish headers, built from the demo catalog, so demo
// visitors can try the import without a file of their own. Run: npm run demo:sample-stock
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { listCatalog } from '../src/catalog.js';

const { products } = await listCatalog('demo');
const picks = products.filter((p) => p.posts >= 2 && p.name.split(/\s+/).length >= 3 && p.status === 'in_stock').slice(0, 5);
if (picks.length < 4) throw new Error('The demo catalog has too few products. Run npm run demo:seed first.');

// names are written the way a seller types them: odd case, a typo, a missing "s"
const typed = [picks[0].name.toLowerCase(), picks[1].name.replace(/s\b/, ''), picks[2].name.toUpperCase(), picks[3].name, picks[4]?.name ?? picks[3].name];
const rows = [
  ['Amar Dokan - Stock List', '', '', '', ''],
  [],
  ['Pronno', 'Saiz', 'Rong', 'Mojud', 'Dam (Tk)'],
  [typed[0], '', 'pink', 8, 1450],
  [typed[1], '36', 'black', 4, 1850],
  [typed[1], '37', 'black', 2, 1850],
  [typed[1], '38', 'black', 1, 1850],
  [typed[2], '', '', 12, 990],
  [typed[3], '', '', 3, 750],
  ['Navy Silk Printed Dupatta', '', 'navy', 10, 650],
  ['Mot', '', '', 40, ''],
];
const ws = XLSX.utils.aoa_to_sheet(rows);
ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
ws['!cols'] = [{ wch: 36 }, { wch: 6 }, { wch: 10 }, { wch: 8 }, { wch: 10 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Stock');
const out = new URL('../../web/public/sample-stock.xlsx', import.meta.url);
fs.writeFileSync(out, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
console.log(`sample-stock.xlsx written (${rows.length - 4} data rows): ${typed.join(' | ')}`);
