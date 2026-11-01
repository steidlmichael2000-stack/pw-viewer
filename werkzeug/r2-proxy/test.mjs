/* Prueft den R2-Torwaechter ohne Cloudflare: Der Bucket ist hier nachgebaut
 * (get/head mit Bytebereichen wie bei R2).
 *
 *   node werkzeug/r2-proxy/test.mjs */

import assert from 'node:assert/strict';
import worker from './worker.js';

const DATEN = new Uint8Array(1000).map((_, i) => i % 256);
const DATEIEN = { 'geckenheim/octree.bin': DATEN, 'geckenheim/metadata.json': new TextEncoder().encode('{"a":1}') };
const zeit = new Date('2026-10-01T10:00:00Z');

const BUCKET = {
  async head(k) { return DATEIEN[k] ? { size: DATEIEN[k].length, httpEtag: '"e"', uploaded: zeit } : null; },
  async get(k, { range } = {}) {
    const d = DATEIEN[k];
    if (!d) return null;
    let s = 0, e = d.length;
    if (range) {
      if (range.suffix !== undefined) s = Math.max(0, d.length - range.suffix);
      else { s = range.offset; e = range.length !== undefined ? Math.min(d.length, s + range.length) : d.length; }
      if (s >= d.length) throw new Error('InvalidRange');
    }
    return { size: d.length, httpEtag: '"e"', uploaded: zeit, range, body: new Blob([d.slice(s, e)]).stream() };
  }
};

const ORIGIN = 'https://steidlmichael2000-stack.github.io';
const frage = (pfad, init = {}) => worker.fetch(new Request('https://w.test' + pfad, init), { BUCKET });
const bytes = async (r) => new Uint8Array(await r.arrayBuffer());

let r = await frage('/geckenheim/octree.bin', { headers: { Origin: ORIGIN } });
assert.equal(r.status, 200);
assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
assert.equal((await bytes(r)).length, 1000);

r = await frage('/geckenheim/octree.bin', { headers: { Origin: ORIGIN, Range: 'bytes=100-199' } });
assert.equal(r.status, 206);
assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000');
let b = await bytes(r);
assert.equal(b.length, 100); assert.equal(b[0], 100);

r = await frage('/geckenheim/octree.bin', { headers: { Range: 'bytes=900-' } });
assert.equal(r.headers.get('content-range'), 'bytes 900-999/1000');

r = await frage('/geckenheim/octree.bin', { headers: { Range: 'bytes=-50' } });
assert.equal(r.headers.get('content-range'), 'bytes 950-999/1000');
assert.equal((await bytes(r)).length, 50);

r = await frage('/geckenheim/octree.bin', { headers: { Range: 'bytes=990-1500' } });
assert.equal(r.headers.get('content-range'), 'bytes 990-999/1000');

assert.equal((await frage('/geckenheim/octree.bin', { headers: { Range: 'bytes=5000-6000' } })).status, 416);
assert.equal((await frage('/geckenheim/octree.bin', { headers: { Range: 'bytes=0-1,5-9' } })).status, 416);

r = await frage('/geckenheim/metadata.json', { method: 'HEAD', headers: { Origin: ORIGIN } });
assert.equal(r.status, 200);
assert.equal(r.headers.get('last-modified'), zeit.toUTCString());
assert.equal(r.headers.get('cache-control'), 'no-cache');

r = await frage('/geckenheim/octree.bin', { method: 'OPTIONS', headers: { Origin: ORIGIN,
  'Access-Control-Request-Headers': 'content-type,range' } });
assert.equal(r.status, 204);
assert.match(r.headers.get('access-control-allow-headers'), /Content-Type/);

assert.equal((await frage('/geckenheim/octree.bin', { headers: { Origin: 'https://boese.example' } })).status, 403);
assert.equal((await frage('/geckenheim/model.glb')).status, 404);
assert.equal((await frage('/geckenheim/../geheim.txt')).status, 404);
assert.equal((await frage('/')).status, 404);
assert.equal((await frage('/geckenheim/octree.bin', { method: 'PUT', body: 'x' })).status, 405);
assert.equal((await frage('/Geckenheim/octree.bin')).status, 404);

console.log('R2-Torwaechter: alle Pruefungen bestanden');
