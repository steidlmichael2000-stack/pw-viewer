// Inline-Skripte einer Seite hashen und mit der CSP vergleichen; mit --setzen eintragen.
// Nach jeder Änderung an einem Inline-Skript in index.html oder model.html:
//   node werkzeug/csp-hashes.js model.html --setzen
const fs = require('fs'), crypto = require('crypto');
const html = fs.readFileSync(process.argv[2], 'utf8');
const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
const csp = (html.match(/script-src ([^;]*)/) || [])[1] || '';
const da = csp.match(/'sha256-[^']+'/g) || [];
console.log(process.argv[2], 'skripte', hashes.length, 'passen:', hashes.every(h => da.includes(h)) && da.length === hashes.length);
if (process.argv[3] === '--setzen') {
  const neu = html.replace(/(script-src 'self')( 'sha256-[^']+')*/, '$1 ' + hashes.join(' '));
  fs.writeFileSync(process.argv[2], neu);
  console.log('gesetzt');
}
