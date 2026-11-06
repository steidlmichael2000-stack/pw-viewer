/* Topovo — Laserpunkte im Hintergrund laden und ausschneiden
 *
 * Läuft als klassischer Worker (app.js, laserWerk). Die BVV gibt die
 * Laserpunkte als LAZ-Kacheln zu 1 × 1 km heraus (geodaten.bayern.de/odd_data/
 * laser/, CC BY 4.0). Am 04.11.2026 nachgesehen: LAS 1.2, Punktformat 1 (ohne
 * Farbe), nicht als COPC und in Fluglinien-Reihenfolge — für jeden Ausschnitt
 * muss deshalb die ganze Kachel geladen werden, 58–255 MB im Landkreis
 * Neustadt/Aisch, laut BVV bis 1 GB. Sie kommt Stück für Stück direkt in den
 * Speicher von laz-perf; entpackt wird Punkt für Punkt, behalten nur, was im
 * Ausschnitt liegt.
 *
 * Geladene Kacheln bleiben gepackt im Speicher (vorrat), solange die App den
 * Worker hält — ein anderer Ausschnitt daraus kostet dann nur das Entpacken.
 * Wird es mehr als vorratMax, fliegt die am längsten nicht gebrauchte Kachel
 * heraus, nie eine des laufenden Auftrags.
 *
 * laz-perf (Apache 2.0) steckt in der Bündelung von copc.js (MIT), wie im
 * PW-Viewer: vendor/copc/.
 *
 * Auftrag { kacheln: [{ kachel, url }], bereich: { e0, n0, e1, n1 }, max,
 * nurBoden, vorratMax } → Meldungen
 *   { art: 'laden', nr, von, geladen, gesamt }   beim Herunterladen (nr von von Kacheln)
 *   { art: 'lesen', nr, von, gelesen, gesamt }   beim Entpacken
 *   { art: 'normalen', fertig, gesamt }          beim Rechnen der Normalen
 *   { art: 'vorrat', kacheln }                   welche Kacheln gerade im Speicher liegen
 *   { art: 'fertig', … }                         Punkte relativ zur Mitte des Ausschnitts
 *   { art: 'fehler', text }
 *   { art: 'abgebrochen' }
 *   { art: 'warten', nr, von, versuch, sekunden, abgeschnitten }  Verbindung weg oder Kachel unvollständig, neuer Versuch folgt
 *
 * { art: 'abbrechen' } bricht den laufenden Auftrag ab: das Herunterladen über
 * den AbortController, das Entpacken an der nächsten Pause (alle 2^20 Punkte
 * gibt die Schleife den Faden kurz frei, sonst käme die Nachricht gar nicht an).
 * Fertig geladene Kacheln bleiben im Vorrat.
 */
importScripts('vendor/copc/copc.js');

// Boden im Sinne der BVV: Boden, Gewässer, abgeleiteter Boden (Klassen 2, 9, 23, 24)
const BODEN = new Set([2, 9, 23, 24]);

let lazPerf = null;
let abbruch = null;             // AbortController des laufenden Auftrags
const ABGEBROCHEN = 'abgebrochen';
const vorrat = new Map();       // Kachel → { zeiger, groesse }, in der Reihenfolge der Nutzung

function vorratMelden() {
  self.postMessage({ art: 'vorrat', kacheln: [...vorrat.keys()] });
}

/* Meldungen eines Exports tragen export: true — app.js reicht sie an die
 * Ansicht weiter statt an das Laden auf der Karte. */
let exportLaeuft = false;
const senden = m => self.postMessage(exportLaeuft ? { ...m, export: true } : m);

/** Platz für bedarf Byte schaffen; die Kacheln in behalten bleiben. */
function platzMachen(LP, bedarf, behalten, vorratMax) {
  let summe = bedarf;
  for (const v of vorrat.values()) summe += v.groesse;
  for (const [k, v] of vorrat) {
    if (summe <= vorratMax) break;
    if (behalten.has(k)) continue;
    LP._free(v.zeiger);
    vorrat.delete(k);
    summe -= v.groesse;
  }
}

/** Lädt eine Kachel in den Speicher von laz-perf; null, wenn es sie nicht gibt. */
/* Bricht die Verbindung ab (WLAN aus, Funkloch, Wechsel aufs Mobilnetz),
 * versucht es von selbst weiter: nach 2, 4, 8 … höchstens 15 s, oder sobald der
 * Browser wieder Netz meldet. Von vorn — durch den Worker gehen keine
 * Bytebereiche (siehe worker.js). Nach rund fünf Minuten wird aufgegeben. */
const NETZ_VERSUCHE = 25;

function warten(ms) {
  return new Promise(fertig => {
    const ende = () => { clearTimeout(uhr); self.removeEventListener('online', ende); abbruch.signal.removeEventListener('abort', ende); fertig(); };
    const uhr = setTimeout(ende, ms);
    self.addEventListener('online', ende);
    abbruch.signal.addEventListener('abort', ende);
  });
}

async function mitWiederholung(LP, url, melden, behalten, vorratMax, wartenMelden) {
  for (let versuch = 1; ; versuch++) {
    try {
      return await herunterladen(LP, url, melden, behalten, vorratMax);
    } catch (err) {
      /* Nur Netzfehler (TypeError) wiederholen; HTTP-Fehler und Abbrechen nicht. Ein
       * TypeError gleich beim Abruf bei bestehender Verbindung ist meist kein Funkloch,
       * sondern eine Antwort ohne CORS (etwa 5xx vom Worker) — dann nach zwei Versuchen
       * aufgeben statt fünf Minuten „Verbindung unterbrochen“ zu zeigen. */
      if (abbruch.signal.aborted || !(err instanceof TypeError) || versuch >= NETZ_VERSUCHE) throw err;
      /* Abgeschnitten trotz Netz: Das bricht bei sehr großen Kacheln jedes Mal ab
       * (gesehen ab einigen hundert MB) — nicht eine Stunde lang neu laden */
      if (err.abgeschnitten && versuch >= 3) {
        throw new Error('Die Kachel kam dreimal unvollständig an. Sehr große Kacheln (Gebirge, mehrere hundert MB) ' +
          'bricht die Weiterleitung ab — eine Stelle mit kleinerer Kachel wählen oder später noch einmal versuchen.');
      }
      if (!err.mittendrin && navigator.onLine && versuch >= 2) throw err;
      const ms = Math.min(15000, 1000 * 2 ** versuch);
      wartenMelden(versuch, Math.round(ms / 1000), !!err.abgeschnitten);
      await warten(ms);
      if (abbruch.signal.aborted) throw err;
    }
  }
}

async function herunterladen(LP, url, melden, behalten, vorratMax) {
  // Nie in den HTTP-Zwischenspeicher des Browsers: der läge auf dem Gerät
  const r = await fetch(url, { cache: 'no-store', signal: abbruch.signal });
  if (r.status === 404) return null;
  if (r.status === 429) throw new Error('Gerade wurden sehr viele Laserkacheln geladen — die Weiterleitung lässt erst in einer Weile wieder welche durch.');
  if (!r.ok) throw new Error(`Laserkachel: HTTP ${r.status}`);
  if (!r.body) throw new Error('Laserkachel: keine Daten');
  // Gepackt unterwegs: Content-Length ist dann die gepackte Größe, nicht die der Datei
  const gesamt = r.headers.get('Content-Encoding') ? 0 : Number(r.headers.get('Content-Length')) || 0;
  const leser = r.body.getReader();
  if (!gesamt) return ohneLaenge(LP, leser, melden, behalten, vorratMax);
  platzMachen(LP, gesamt, behalten, vorratMax);
  /* Gleich in den Speicher von laz-perf, ohne Umweg über einen zweiten Puffer
   * derselben Größe. HEAPU8 neu holen: Wächst der Speicher, ist es ein anderes. */
  const zeiger = LP._malloc(gesamt);
  if (!zeiger) throw new Error('Zu wenig Speicher — einen kleineren Ausschnitt oder weniger Kacheln wählen.');
  let o = 0, gemeldet = 0;
  for (;;) {
    let stueck;
    try { stueck = await leser.read(); } catch (err) { LP._free(zeiger); err.mittendrin = true; throw err; }
    const { done, value } = stueck;
    if (done) break;
    if (value.byteLength > gesamt - o) { LP._free(zeiger); leser.cancel(); throw new Error('Laserkachel länger als angekündigt.'); }
    const n = value.byteLength;
    LP.HEAPU8.set(value.subarray(0, n), zeiger + o);
    o += n;
    if (o - gemeldet > 1 << 20 || o === gesamt) {
      gemeldet = o;
      melden(o, gesamt);
    }
  }
  if (o !== gesamt) { LP._free(zeiger); throw new Error('Laserkachel unvollständig geladen.'); }
  return { zeiger, groesse: gesamt };
}

/* Rückfall ohne Content-Length (gzip unterwegs, siehe worker.js): erst in
 * Stücken sammeln, dann am Stück in den Speicher von laz-perf — kurz doppelt
 * so viel Speicher, aber es läuft. */
async function ohneLaenge(LP, leser, melden, behalten, vorratMax) {
  const teile = [];
  let o = 0, gemeldet = 0;
  for (;;) {
    let stueck;
    try { stueck = await leser.read(); } catch (err) { err.mittendrin = true; throw err; }
    const { done, value } = stueck;
    if (done) break;
    teile.push(value);
    o += value.byteLength;
    if (o - gemeldet > 1 << 20) { gemeldet = o; melden(o, 0); }
  }
  platzMachen(LP, o, behalten, vorratMax);
  const zeiger = LP._malloc(o);
  if (!zeiger) throw new Error('Zu wenig Speicher — einen kleineren Ausschnitt oder weniger Kacheln wählen.');
  let p = 0;
  for (const t of teile) { LP.HEAPU8.set(t, zeiger + p); p += t.byteLength; }
  /* Ohne Länge merkt niemand, wenn der Strom zu früh endet — über Cloudflare kamen
   * von der 713-MB-Kachel 650_5254 einmal 540, einmal 214 MB an, jedes Mal mit
   * sauberem Ende (05.11.2026). Bei LAZ steht am Beginn der Punktdaten, wo die
   * Chunk-Tabelle liegt: ganz am Ende der Datei. Reicht die Datei nicht bis dorthin,
   * ist sie abgeschnitten und wird wie ein Abbruch mittendrin neu geholt. */
  if (!vollstaendig(LP.HEAPU8, zeiger, o)) {
    LP._free(zeiger);
    const err = new TypeError('Laserkachel kam unvollständig an.');
    err.mittendrin = err.abgeschnitten = true;
    throw err;
  }
  melden(o, o);
  return { zeiger, groesse: o };
}

/** Reicht die LAZ-Datei bis zu ihrer Chunk-Tabelle? Ohne Tabelle (LAS) gilt sie als ganz. */
function vollstaendig(heap, zeiger, groesse) {
  if (groesse < 375) return false;
  const d = new DataView(heap.buffer, heap.byteOffset + zeiger, groesse);
  const daten = d.getUint32(96, true);
  if (daten + 8 > groesse) return false;
  let tabelle = Number(d.getBigInt64(daten, true));
  // −1: beim Schreiben nicht bekannt, die Adresse steht dann in den letzten 8 Bytes
  if (tabelle === -1) tabelle = Number(d.getBigInt64(groesse - 8, true));
  return !(tabelle > daten) || tabelle + 8 <= groesse;
}

/** Der Kopf einer LAS-Datei (1.0–1.4), soweit hier gebraucht. */
function kopfLesen(b) {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'LASF') throw new Error('Keine LAS-Datei');
  return {
    format: b[104] & 0x3f, laenge: d.getUint16(105, true), kodierung: d.getUint16(6, true),
    anzahl: d.getUint32(107, true) || Number(d.getBigUint64(247, true)),
    skala: [d.getFloat64(131, true), d.getFloat64(139, true), d.getFloat64(147, true)],
    versatz: [d.getFloat64(155, true), d.getFloat64(163, true), d.getFloat64(171, true)],
    max: [d.getFloat64(179, true), d.getFloat64(195, true), d.getFloat64(211, true)],
    min: [d.getFloat64(187, true), d.getFloat64(203, true), d.getFloat64(219, true)]
  };
}

/** Holt die Kacheln, eine nach der anderen: aus dem Vorrat oder neu geladen. */
async function kachelnHolen(LP, kacheln, vorratMax) {
  const von = kacheln.length, behalten = new Set(kacheln.map(k => k.kachel));
  const da = [], fehlen = [];
  let megabyte = 0;
  for (let i = 0; i < von; i++) {
    const { kachel, url } = kacheln[i];
    let v = vorrat.get(kachel);
    if (v) vorrat.delete(kachel);               // nach hinten: zuletzt benutzt
    else {
      v = await mitWiederholung(LP, url, (geladen, gesamt) =>
        senden({ art: 'laden', nr: i, von, geladen, gesamt }), behalten, vorratMax,
        (versuch, sekunden, abgeschnitten) => senden({ art: 'warten', nr: i, von, versuch, sekunden, abgeschnitten }));
      if (!v) { fehlen.push(kachel); continue; }
      megabyte += v.groesse / 1e6;
    }
    // Erst prüfen, dann merken: Eine Fehlerseite mit Status 200 bliebe sonst als „im Speicher“ hängen
    let kopf;
    try {
      if (v.groesse < 375) throw new Error('Keine LAS-Datei');
      kopf = kopfLesen(LP.HEAPU8.subarray(v.zeiger, v.zeiger + 375));
    } catch (err) {
      LP._free(v.zeiger);
      vorratMelden();
      throw new Error(`Laserkachel ${kachel} ist beschädigt oder keine LAS-Datei.`);
    }
    vorrat.set(kachel, v);
    vorratMelden();
    da.push({ kachel, ...v, kopf });
  }
  if (!da.length) throw new Error('Für diese Stelle gibt es keine Laserkachel.');
  return { da, fehlen, megabyte };
}

async function ausschneiden({ kacheln, bereich, max, nurBoden, vorratMax }) {
  if (!lazPerf) lazPerf = await Copc.Las.PointData.createLazPerf({ locateFile: f => 'vendor/copc/' + f });
  const LP = lazPerf;

  // Erst alle Kacheln da haben, eine nach der anderen. Die Zeiten je Schritt
  // stehen unten in der Ansicht — damit sich sagen lässt, wo es hängt.
  const zeiten = { laden: 0, megabyte: 0, lesen: 0, normalen: 0 };
  let uhr = performance.now();
  const { da, fehlen, megabyte } = await kachelnHolen(LP, kacheln, vorratMax);
  zeiten.megabyte = megabyte;
  zeiten.laden = (performance.now() - uhr) / 1000;
  uhr = performance.now();

  /* Wie viele Punkte liegen etwa im Ausschnitt? Danach die Ausdünnung, damit
   * es höchstens rund max werden — gleichmäßig, jeder schritt-te Punkt. Beim
   * Boden allein grob die Hälfte (gezählt wird beim Lesen nur, was passt). */
  const { e0, n0, e1, n1 } = bereich;
  let erwartet = 0;
  for (const { kopf: k } of da) {
    const flaeche = Math.max(1, (k.max[0] - k.min[0]) * (k.max[1] - k.min[1]));
    const ueber = Math.max(0, Math.min(e1, k.max[0]) - Math.max(e0, k.min[0])) * Math.max(0, Math.min(n1, k.max[1]) - Math.max(n0, k.min[1]));
    erwartet += k.anzahl * Math.min(1, ueber / flaeche) * (nurBoden ? 0.5 : 1);
  }
  const schritt = Math.max(1, Math.ceil(erwartet / max));
  const ce = (e0 + e1) / 2, cn = (n0 + n1) / 2;

  let platz = Math.ceil(erwartet / schritt * 1.3) + 1024;
  let xyz = new Float32Array(platz * 3), klasse = new Uint8Array(platz), staerke = new Uint16Array(platz);
  const klassen = new Map();
  let n = 0, drin = 0, zMin = Infinity, zMax = -Infinity, iMax = 0;
  const punkt = LP._malloc(64);
  try {
    for (let t = 0; t < da.length; t++) {
      const { zeiger, groesse, kopf: k } = da[t];
      const laszip = new LP.LASZip();
      try {
        laszip.open(zeiger, groesse);
        // LAS 1.4 (alle neueren Befliegungen) lässt das alte 32-Bit-Feld leer, laz-perf meldet dann 0
        const anzahl = laszip.getCount() || k.anzahl;
        const [sx, sy, sz] = k.skala, [ox, oy, oz] = k.versatz;
        // Ganzzahlige Grenzen: der Vergleich je Punkt ohne Umrechnung
        const X0 = (e0 - ox) / sx, X1 = (e1 - ox) / sx, Y0 = (n0 - oy) / sy, Y1 = (n1 - oy) / sy;
        let puffer = null, d = null;
        for (let i = 0; i < anzahl; i++) {
          laszip.getPoint(punkt);
          if (puffer !== LP.HEAPU8.buffer) { puffer = LP.HEAPU8.buffer; d = new DataView(puffer, punkt, k.laenge); }
          if ((i & 0xfffff) === 0) {
            senden({ art: 'lesen', nr: t, von: da.length, gelesen: i, gesamt: anzahl });
            await new Promise(r => setTimeout(r));          // Nachrichten (Abbrechen) durchlassen
            if (abbruch.signal.aborted) throw new Error(ABGEBROCHEN);
          }
          const X = d.getInt32(0, true), Y = d.getInt32(4, true);
          if (X < X0 || X > X1 || Y < Y0 || Y > Y1) continue;
          // Formate 0–5: Klasse in den unteren 5 Bit von Byte 15; ab 6 ein ganzes Byte 16
          const kl = k.format >= 6 ? d.getUint8(16) : d.getUint8(15) & 31;
          if (nurBoden && !BODEN.has(kl)) continue;
          if (drin++ % schritt) continue;
          if (n === platz) {
            platz *= 2;
            const a = new Float32Array(platz * 3); a.set(xyz); xyz = a;
            const b = new Uint8Array(platz); b.set(klasse); klasse = b;
            const c = new Uint16Array(platz); c.set(staerke); staerke = c;
          }
          const z = d.getInt32(8, true) * sz + oz;
          xyz[3 * n] = X * sx + ox - ce; xyz[3 * n + 1] = Y * sy + oy - cn; xyz[3 * n + 2] = z;
          klasse[n] = kl;
          staerke[n] = d.getUint16(12, true);
          klassen.set(kl, (klassen.get(kl) || 0) + 1);
          if (z < zMin) zMin = z;
          if (z > zMax) zMax = z;
          if (staerke[n] > iMax) iMax = staerke[n];
          n++;
        }
      } finally {
        laszip.delete();
      }
    }
  } finally {
    LP._free(punkt);
  }
  if (!n) throw new Error('Im Ausschnitt liegen keine Laserpunkte.');
  // Höhen relativ zum tiefsten Punkt — Float32 reicht dann auf den Millimeter
  for (let j = 0; j < n; j++) xyz[3 * j + 2] -= zMin;
  /* Umkreis für die Normalen nach der Dichte: rund ein Dutzend Nachbarn, bei
   * voller Dichte (7–10 Punkte je m²) 0,8 m, ausgedünnt entsprechend mehr. */
  zeiten.lesen = (performance.now() - uhr) / 1000;
  uhr = performance.now();
  const dichte = n / Math.max(1, (e1 - e0) * (n1 - n0));
  const normalen = normalenRechnen(xyz, n, Math.max(0.8, Math.sqrt(12 / (Math.PI * dichte))));
  zeiten.normalen = (performance.now() - uhr) / 1000;
  if (abbruch.signal.aborted) throw new Error(ABGEBROCHEN);     // abgebrochen, während die Normalen liefen
  const ergebnis = {
    art: 'fertig', anzahl: n, schritt, fehlen, zeiten,
    mitte: [ce, cn], zMin, zMax, iMax,
    // Für den Export (Größe vorab): je Kachel Punkte, Format und Größe des LAZ
    kacheln: da.map(k => ({ kachel: k.kachel, anzahl: k.kopf.anzahl, format: k.kopf.format, groesse: k.groesse })),
    xyz: xyz.slice(0, n * 3), klasse: klasse.slice(0, n), staerke: staerke.slice(0, n), normalen,
    klassen: [...klassen].sort((a, b) => a[0] - b[0])
  };
  self.postMessage(ergebnis, [ergebnis.xyz.buffer, ergebnis.klasse.buffer, ergebnis.staerke.buffer, normalen.buffer]);
}

/* Normalen je Punkt: Hauptachsen der Nachbarn im Umkreis r (Kovarianz, die
 * Richtung mit der kleinsten Streuung). Die Nachbarn kommen aus einem Gitter
 * mit Zellen der Größe r in der Ebene — bei Laserdaten liegt fast alles in
 * 2,5 D, und neun Zellen reichen. Ausgerichtet nach oben; als Int8 (×127),
 * damit 1,5 Mio. Punkte 4,5 MB brauchen statt 18. */
function normalenRechnen(xyz, n, r = 0.8) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i], y = xyz[3 * i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const nx = Math.max(1, Math.ceil((x1 - x0) / r) + 1), ny = Math.max(1, Math.ceil((y1 - y0) / r) + 1);
  const zelleVon = i => Math.floor((xyz[3 * i + 1] - y0) / r) * nx + Math.floor((xyz[3 * i] - x0) / r);
  // Zählsortierung der Punkte nach Zelle
  const start = new Uint32Array(nx * ny + 1);
  for (let i = 0; i < n; i++) start[zelleVon(i) + 1]++;
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const pos = start.slice(0, nx * ny), folge = new Uint32Array(n);
  for (let i = 0; i < n; i++) folge[pos[zelleVon(i)]++] = i;

  const aus = new Int8Array(n * 3), r2 = r * r;
  for (let i = 0; i < n; i++) {
    const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
    const cx = Math.floor((px - x0) / r), cy = Math.floor((py - y0) / r);
    let k = 0, sx = 0, sy = 0, sz = 0, xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(ny - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(nx - 1, cx + 1); gx++) {
        const c = gy * nx + gx;
        for (let j = start[c]; j < start[c + 1]; j++) {
          const q = folge[j];
          const dx = xyz[3 * q] - px, dy = xyz[3 * q + 1] - py, dz = xyz[3 * q + 2] - pz;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          k++; sx += dx; sy += dy; sz += dz;
          xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
        }
      }
    }
    let ox = 0, oy = 0, oz = 1;
    if (k >= 4) {
      const mx = sx / k, my = sy / k, mz = sz / k;
      const a = xx / k - mx * mx, b = xy / k - mx * my, c = xz / k - mx * mz;
      const d = yy / k - my * my, e = yz / k - my * mz, f = zz / k - mz * mz;
      [ox, oy, oz] = kleinsteAchse(a, b, c, d, e, f);
      if (oz < 0) { ox = -ox; oy = -oy; oz = -oz; }
    }
    aus[3 * i] = Math.round(ox * 127); aus[3 * i + 1] = Math.round(oy * 127); aus[3 * i + 2] = Math.round(oz * 127);
    if ((i & 0x3ffff) === 0) self.postMessage({ art: 'normalen', fertig: i, gesamt: n });
  }
  return aus;
}

/** Eigenvektor zum kleinsten Eigenwert der symmetrischen Matrix
 *  [[a b c] [b d e] [c e f]] — Eigenwerte geschlossen (trigonometrisch),
 *  der Vektor als größtes Kreuzprodukt zweier Zeilen von (M − λI). */
function kleinsteAchse(a, b, c, d, e, f) {
  const p1 = b * b + c * c + e * e;
  let lam;
  if (p1 < 1e-18) lam = Math.min(a, d, f);
  else {
    const q = (a + d + f) / 3;
    const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1, p = Math.sqrt(p2 / 6);
    const B = [(a - q) / p, b / p, c / p, (d - q) / p, e / p, (f - q) / p];
    const det = B[0] * (B[3] * B[5] - B[4] * B[4]) - B[1] * (B[1] * B[5] - B[4] * B[2]) + B[2] * (B[1] * B[4] - B[3] * B[2]);
    const phi = Math.acos(Math.max(-1, Math.min(1, det / 2))) / 3;
    lam = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);    // der kleinste
  }
  const r0 = [a - lam, b, c], r1 = [b, d - lam, e], r2 = [c, e, f - lam];
  const kreuz = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  let best = [0, 0, 1], bl = 0;
  for (const v of [kreuz(r0, r1), kreuz(r0, r2), kreuz(r1, r2)]) {
    const l = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (l > bl) { bl = l; best = v; }
  }
  const l = Math.sqrt(bl) || 1;
  return [best[0] / l, best[1] / l, best[2] / l];
}

/* ============================ Export ============================
 *
 * Auftrag { art: 'export', kacheln, bereich, einzeln, nurBoden, ziel, luftbild,
 * gebaeude, name, zusatz, vorratMax } aus laser.js (über app.js):
 *   einzeln   die Kacheln ganz statt des Ausschnitts bereich — zusammen in einer LAS;
 *             nur unverändert (siehe unten) je Kachel ihr LAZ
 *   ziel      'utm' (UTM32 wie geliefert) oder 3 / 4 (DB_REF Gauß-Krüger, Streifen 3 oder 4)
 *   luftbild  null oder die Stücke des DOP20 (luftbildHolen): für den Ausschnitt eines,
 *             bei einzeln eines je Kachel unter ihrem Namen — geholt erst, wenn die Kachel
 *             dran ist, damit nie mehr als ein Bild (5000², 75 MB) im Speicher liegt
 *   gebaeude  null oder { ecken: Float64Array (x, y, z je Ecke, drei je Dreieck),
 *             wand: Uint8Array je Dreieck } in UTM32 → DXF
 * Meldungen (alle mit export: true): laden, warten wie oben, dazu
 *   { art: 'luftbild' }, { art: 'schreiben', nr, von, gelesen, gesamt },
 *   { art: 'datei', name, blob, punkte }, { art: 'fertig', fehlen }, fehler, abgebrochen.
 *
 * Unverändert (ganze Kachel, alle Punkte, UTM, ohne Farbe) geht das LAZ der BVV
 * so hinaus, wie es im Vorrat liegt. Sonst LAS ohne Kompression — laz-perf in
 * vendor/copc kann nur entpacken. Rund 34 Byte je Punkt: eine Kachel mit
 * 30 Mio. Punkten wird 1 GB groß und liegt bis zum Speichern im Arbeitsspeicher.
 * Deshalb nur am Desktop (Knopf in der Spalte). */

/* ---------- DB_REF ----------
 * Ril 883.9010 (gültig ab 01.08.2024), Abschnitt 7: Datumsübergang ETRS89 →
 * DB_REF mit den Parametern der Ril für genau diese Richtung (DBREF_HIN; die
 * Gegenrichtung ist EPSG:5826 und steht als DBREF in app.js). Die
 * Transformation definiert DB_REF, gilt also als fehlerfrei. Anders als in
 * app.js mit der Ellipsoidhöhe des Punkts: Die Drehungen (bis 3,1″) verschieben
 * die Lage sonst um rund 1 cm je 500 m Höhe. Ellipsoidhöhe = Höhe + Geoid, das
 * Geoid fest mit 47 m (Bayern etwa 45–50 m) — 3 m daneben machen 0,05 mm.
 * Die Höhen bleiben, wie sie sind: DB_REF2016 nimmt Normalhöhen über GCG2016,
 * das sind die DHHN2016-Höhen der BVV (Ril 883.9010 Abschnitt 3 und 9).
 * Geprüft gegen proj4 (werkzeug/dbref-pruefen.mjs). */
// Coordinate Frame wie in app.js: Verschiebung in m, Drehung in Bogensekunden, Maßstab in ppm
const DBREF_HIN = { tx: -584.9567, ty: -107.7277, tz: -413.8036,
  rx: 1.1155257601, ry: 0.2824170155, rz: -3.1384505907, s: -7.992171 };
const ELL_GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const ELL_BESSEL = { a: 6377397.155, f: 1 / 299.1528128 };
const GEOID = 47;

function ellXyz(lat, lon, h, { a, f }) {
  const p = lat * Math.PI / 180, l = lon * Math.PI / 180, e2 = f * (2 - f);
  const N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return [(N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - e2) + h) * Math.sin(p)];
}

function ellAusXyz([x, y, z], { a, f }) {
  const e2 = f * (2 - f), r = Math.hypot(x, y);
  let p = Math.atan2(z, r * (1 - e2)), h = 0;
  for (let i = 0; i < 8; i++) {
    const N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    h = r / Math.cos(p) - N;
    p = Math.atan2(z, r * (1 - e2 * N / (N + h)));
  }
  return [p * 180 / Math.PI, Math.atan2(y, x) * 180 / Math.PI];
}

function tmHin(lat, lon, { a, f }, l0, k0, e0) {
  const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n;
  const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64);
  const alpha = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180, 13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440,
    61 * n3 / 240 - 103 * n4 / 140, 49561 * n4 / 161280];
  const p = lat * Math.PI / 180, l = (lon - l0) * Math.PI / 180, ex = 2 * Math.sqrt(n) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(p)) - ex * Math.atanh(ex * Math.sin(p)));
  const xi1 = Math.atan2(t, Math.cos(l)), eta1 = Math.atanh(Math.sin(l) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 4; j++) {
    xi += alpha[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += alpha[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  return [e0 + k0 * A * eta, k0 * A * xi];
}

function tmZurueck(e, nord, { a, f }, l0, k0, e0) {
  const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n;
  const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64);
  const beta = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360, n2 / 48 + n3 / 15 - 437 * n4 / 1440,
    17 * n3 / 480 - 37 * n4 / 840, 4397 * n4 / 161280];
  const delta = [2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45, 7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45,
    56 * n3 / 15 - 136 * n4 / 35, 4279 * n4 / 630];
  const xi = nord / (k0 * A), eta = (e - e0) / (k0 * A);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 4; j++) {
    xi1 -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let p = chi;
  for (let j = 1; j <= 4; j++) p += delta[j - 1] * Math.sin(2 * j * chi);
  return [p * 180 / Math.PI, l0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) * 180 / Math.PI];
}

/** UTM32 (ETRS89) mit Höhe h (DHHN2016) → DB_REF Gauß-Krüger im Streifen: [Rechts, Hoch]. */
function dbrefPunkt(e, n, h, streifen) {
  const [lat, lon] = tmZurueck(e, n, ELL_GRS80, 9, 0.9996, 500000);
  const [x, y, z] = ellXyz(lat, lon, h + GEOID, ELL_GRS80);
  const par = DBREF_HIN, sek = Math.PI / 180 / 3600, rx = par.rx * sek, ry = par.ry * sek, rz = par.rz * sek;
  const m = 1 + par.s * 1e-6;
  // X_db = T + m·R·X_etrs, R wie gkZurueck in app.js
  const xd = par.tx + m * (x + rz * y - ry * z);
  const yd = par.ty + m * (-rz * x + y + rx * z);
  const zd = par.tz + m * (ry * x - rx * y + z);
  const [pb, lb] = ellAusXyz([xd, yd, zd], ELL_BESSEL);
  return tmHin(pb, lb, ELL_BESSEL, 3 * streifen, 1, streifen * 1e6 + 500000);
}

/* Streng gerechnet rund 1 µs je Punkt — bei 30 Mio. Punkten eine halbe Minute.
 * Über eine Fläche bis etwa 1 km reicht ein Polynom dritten Grades in der Lage,
 * linear in der Höhe, an 6 × 6 × 3 Stützpunkten ausgeglichen. An 500
 * Zufallspunkten nachgeprüft; liegt es irgendwo über 0,05 mm daneben, bleibt
 * es bei der strengen Rechnung. Gibt (e, n, h, aus) → aus = [Rechts, Hoch]. */
function dbrefFlaeche(e0, n0, e1, n1, z0, z1, streifen) {
  const me = (e0 + e1) / 2, mn = (n0 + n1) / 2, se = Math.max(1, (e1 - e0) / 2), sn = Math.max(1, (n1 - n0) / 2);
  const mz = (z0 + z1) / 2, sz = Math.max(50, (z1 - z0) / 2);
  const [R0, H0] = dbrefPunkt(me, mn, mz, streifen);
  const terme = (u, v, w, t) => {
    t[0] = 1; t[1] = u; t[2] = v; t[3] = u * u; t[4] = u * v; t[5] = v * v;
    t[6] = u * u * u; t[7] = u * u * v; t[8] = u * v * v; t[9] = v * v * v; t[10] = w; t[11] = w * u; t[12] = w * v;
  };
  const T = 13, A = new Float64Array(T * T), bR = new Float64Array(T), bH = new Float64Array(T), t = new Float64Array(T);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) for (let k = 0; k < 3; k++) {
    const u = -1 + i * 0.4, v = -1 + j * 0.4, w = k - 1;
    const [R, H] = dbrefPunkt(me + u * se, mn + v * sn, mz + w * sz, streifen);
    terme(u, v, w, t);
    for (let a = 0; a < T; a++) {
      bR[a] += t[a] * (R - R0); bH[a] += t[a] * (H - H0);
      for (let b = 0; b < T; b++) A[a * T + b] += t[a] * t[b];
    }
  }
  const cR = loesen(A.slice(), bR, T), cH = loesen(A, bH, T);
  const genaehert = (e, n, h, aus) => {
    terme((e - me) / se, (n - mn) / sn, (h - mz) / sz, t);
    let r = 0, hh = 0;
    for (let a = 0; a < T; a++) { r += cR[a] * t[a]; hh += cH[a] * t[a]; }
    aus[0] = R0 + r; aus[1] = H0 + hh;
    return aus;
  };
  const streng = (e, n, h, aus) => { const [r, hh] = dbrefPunkt(e, n, h, streifen); aus[0] = r; aus[1] = hh; return aus; };
  const aus = [0, 0];
  for (let i = 0; i < 500; i++) {
    const e = e0 + Math.random() * (e1 - e0), n = n0 + Math.random() * (n1 - n0), h = mz + (Math.random() * 2 - 1) * sz;
    const [r, hh] = dbrefPunkt(e, n, h, streifen);
    genaehert(e, n, h, aus);
    if (Math.hypot(aus[0] - r, aus[1] - hh) > 5e-5) return streng;
  }
  return genaehert;
}

/** Löst A·x = b (n × n) nach Gauß mit Spaltenpivot; A und b werden verändert. */
function loesen(A, b, n) {
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const x = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = x; }
      const x = b[c]; b[c] = b[p]; b[p] = x;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/* ---------- LAS schreiben ---------- */
// Bytes je Punkt und Lage der Farbe; 4/5 und 9/10 sind 1/3 und 6/8 mit Wellenform
const LAS_LAENGE = { 0: 20, 1: 28, 2: 26, 3: 34, 6: 30, 7: 36 };
const LAS_RGB = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
const LAS_GPS = new Set([1, 3, 4, 5]);
// Kein Bezugssystem steht in den Kacheln der BVV: es wird hier gesetzt (EPSG, Höhe DHHN2016)
const WKT_HOEHE = 'VERT_CS["DHHN2016 height",VERT_DATUM["Deutsches Haupthoehennetz 2016",2005,AUTHORITY["EPSG","1170"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Gravity-related height",UP],AUTHORITY["EPSG","7837"]]';
const WKT_DBREF = 'GEOGCS["DB_REF",DATUM["Deutsche_Bahn_Reference_System",SPHEROID["Bessel 1841",6377397.155,299.1528128],TOWGS84[584.9636,107.7175,413.8067,-1.1155,-0.2824,3.1384,7.9922]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","5681"]]';
const LAS_CRS = {
  utm: { epsg: 25832, wkt: 'PROJCS["ETRS89 / UTM zone 32N",GEOGCS["ETRS89",DATUM["European_Terrestrial_Reference_System_1989",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],TOWGS84[0,0,0,0,0,0,0],AUTHORITY["EPSG","6258"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4258"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",9],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","25832"]]' },
  3: { epsg: 5683, wkt: `PROJCS["DB_REF / 3-degree Gauss-Kruger zone 3 (E-N)",${WKT_DBREF},PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",9],PARAMETER["scale_factor",1],PARAMETER["false_easting",3500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","5683"]]` },
  4: { epsg: 5684, wkt: `PROJCS["DB_REF / 3-degree Gauss-Kruger zone 4 (E-N)",${WKT_DBREF},PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",12],PARAMETER["scale_factor",1],PARAMETER["false_easting",4500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","5684"]]` }
};

/** Kopf und VLR einer LAS-Datei (1.2 mit GeoKeys, 1.4 mit WKT). */
function lasKopf({ neu, format, anzahl, rueck, skala, versatz, min, max, kodierung, ziel }) {
  const crs = LAS_CRS[ziel];
  const kopfGr = neu ? 375 : 227;
  let vlr;
  if (neu) {
    const wkt = new TextEncoder().encode(`COMPD_CS["${crs.wkt.match(/^PROJCS\["([^"]+)"/)[1]} + DHHN2016 height",${crs.wkt},${WKT_HOEHE}]\0`);
    vlr = { id: 2112, daten: wkt };
  } else {
    const schluessel = [1, 1, 0, 5, 1024, 0, 1, 1, 3072, 0, 1, crs.epsg, 3076, 0, 1, 9001, 4096, 0, 1, 7837, 4099, 0, 1, 9001];
    vlr = { id: 34735, daten: new Uint8Array(Uint16Array.from(schluessel).buffer) };
  }
  const gesamt = kopfGr + 54 + vlr.daten.length;
  const b = new Uint8Array(gesamt), d = new DataView(b.buffer);
  const text = (o, s, len) => { for (let i = 0; i < Math.min(len, s.length); i++) b[o + i] = s.charCodeAt(i); };
  text(0, 'LASF', 4);
  // Bit 0: GPS-Zeit wie in der Kachel; Bit 4: Bezugssystem als WKT (Pflicht ab Format 6)
  d.setUint16(6, (kodierung & 1) | (neu ? 16 : 0), true);
  b[24] = 1; b[25] = neu ? 4 : 2;
  text(26, 'OTHER', 32);
  text(58, 'Topovo', 32);
  const heute = new Date(), jan1 = Date.UTC(heute.getUTCFullYear(), 0, 1);
  d.setUint16(90, Math.floor((heute - jan1) / 864e5) + 1, true);
  d.setUint16(92, heute.getUTCFullYear(), true);
  d.setUint16(94, kopfGr, true);
  d.setUint32(96, gesamt, true);
  d.setUint32(100, 1, true);
  b[104] = format;
  d.setUint16(105, LAS_LAENGE[format], true);
  if (!neu) {
    d.setUint32(107, anzahl, true);
    for (let i = 0; i < 5; i++) d.setUint32(111 + 4 * i, rueck[i], true);
  }
  for (let i = 0; i < 3; i++) {
    d.setFloat64(131 + 8 * i, skala[i], true);
    d.setFloat64(155 + 8 * i, versatz[i], true);
    d.setFloat64(179 + 16 * i, max[i], true);
    d.setFloat64(187 + 16 * i, min[i], true);
  }
  if (neu) {
    d.setBigUint64(247, BigInt(anzahl), true);
    for (let i = 0; i < 15; i++) d.setBigUint64(255 + 8 * i, BigInt(rueck[i]), true);
  }
  // VLR: reserviert, Nutzerkennung, Nummer, Länge, Beschreibung
  const o = kopfGr;
  text(o + 2, 'LASF_Projection', 16);
  d.setUint16(o + 18, vlr.id, true);
  d.setUint16(o + 20, vlr.daten.length, true);
  text(o + 22, neu ? 'OGC WKT' : 'GeoKeyDirectory', 32);
  b.set(vlr.daten, o + 54);
  return b;
}

/** Holt die Stücke des DOP20 zu einem Bild: { e0, n1, res, breite, hoehe, rgb }. */
async function luftbildHolen(f) {
  const rgb = new Uint8Array(f.breite * f.hoehe * 3);
  await Promise.all(f.teile.map(async t => {
    const r = await fetch(t.url, { signal: abbruch.signal });
    if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) throw new Error(`Luftbild: HTTP ${r.status}`);
    const bild = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(t.w, t.h), g = c.getContext('2d');
    g.drawImage(bild, 0, 0, t.w, t.h);
    bild.close();
    const pix = g.getImageData(0, 0, t.w, t.h).data;
    for (let y = 0; y < t.h; y++) {
      let q = y * t.w * 4, z = ((t.y + y) * f.breite + t.x) * 3;
      for (let x = 0; x < t.w; x++, q += 4, z += 3) { rgb[z] = pix[q]; rgb[z + 1] = pix[q + 1]; rgb[z + 2] = pix[q + 2]; }
    }
  }));
  return { e0: f.e0, n1: f.n1, res: f.res, breite: f.breite, hoehe: f.hoehe, rgb };
}

/** Die Punkte der Kacheln da im Bereich b als LAS-Datei: [{ blob, punkte }].
 *  farbeFuer(t): das Luftbild für Kachel t (luftbildHolen), oder null ohne Farbe.
 *  getrennt: zwei Dateien in einem Durchgang — [0] Boden (BODEN), [1] der Rest.
 *  Für ReCap: jede Datei wird dort ein eigener Scan, in Civil einzeln ausblendbar. */
async function lasBauen(LP, da, b, { nurBoden, getrennt, ziel, farbeFuer }) {
  const neu = da.some(k => k.kopf.format >= 6);
  const mitRgb = !!farbeFuer || da.some(k => LAS_RGB[k.kopf.format] != null);
  const format = neu ? (mitRgb ? 7 : 6) : (mitRgb ? 3 : 1), L = LAS_LAENGE[format];
  let z0 = Infinity, z1 = -Infinity;
  for (const { kopf } of da) { z0 = Math.min(z0, kopf.min[2]); z1 = Math.max(z1, kopf.max[2]); }
  const umrechnen = ziel === 'utm' ? null : dbrefFlaeche(b.e0, b.n0, b.e1, b.n1, z0, z1, ziel);
  const xy = [0, 0];
  const mitte = umrechnen ? umrechnen((b.e0 + b.e1) / 2, (b.n0 + b.n1) / 2, (z0 + z1) / 2, [0, 0]) : [(b.e0 + b.e1) / 2, (b.n0 + b.n1) / 2];
  const skala = da[0].kopf.skala.slice();
  const versatz = [Math.round(mitte[0] / 1000) * 1000, Math.round(mitte[1] / 1000) * 1000, 0];
  // In Stücken zu rund 8 MB als Blob gesammelt — der Browser darf sie auslagern
  const STUECK = Math.floor((8 << 20) / L) * L;
  const ausgaben = Array.from({ length: getrennt ? 2 : 1 }, () => ({ aus: new Uint8Array(STUECK), o: 0, anzahl: 0, teile: [],
    min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], rueck: new Array(15).fill(0) }));
  for (const a of ausgaben) a.dv = new DataView(a.aus.buffer);
  const punkt = LP._malloc(64);
  try {
    for (let t = 0; t < da.length; t++) {
      const { zeiger, groesse, kopf: k } = da[t];
      const altNeu = k.format >= 6, gps = LAS_GPS.has(k.format), rgbIn = LAS_RGB[k.format];
      const farbe = farbeFuer ? await farbeFuer(t) : null;
      const laszip = new LP.LASZip();
      try {
        laszip.open(zeiger, groesse);
        const gesamt = laszip.getCount() || k.anzahl;
        const [sx, sy, sz] = k.skala, [ox, oy, oz] = k.versatz;
        const X0 = (b.e0 - ox) / sx, X1 = (b.e1 - ox) / sx, Y0 = (b.n0 - oy) / sy, Y1 = (b.n1 - oy) / sy;
        let heap = null, q = 0;
        for (let i = 0; i < gesamt; i++) {
          laszip.getPoint(punkt);
          if (heap !== LP.HEAPU8) heap = LP.HEAPU8;
          if ((i & 0xfffff) === 0) {
            senden({ art: 'schreiben', nr: t, von: da.length, gelesen: i, gesamt });
            await new Promise(r => setTimeout(r));          // Nachrichten (Abbrechen) durchlassen
            if (abbruch.signal.aborted) throw new Error(ABGEBROCHEN);
          }
          q = punkt;
          const quelle = new DataView(heap.buffer, q, 40);
          const X = quelle.getInt32(0, true), Y = quelle.getInt32(4, true);
          if (X < X0 || X >= X1 || Y < Y0 || Y >= Y1) continue;
          const kl = altNeu ? heap[q + 16] : heap[q + 15] & 31;
          if (nurBoden && !BODEN.has(kl)) continue;
          const a = ausgaben[getrennt && !BODEN.has(kl) ? 1 : 0];
          if (a.o === STUECK) { a.teile.push(new Blob([a.aus])); a.aus = new Uint8Array(STUECK); a.dv = new DataView(a.aus.buffer); a.o = 0; }
          const { aus, dv, o, min, max, rueck } = a;
          const e = X * sx + ox, n = Y * sy + oy, h = quelle.getInt32(8, true) * sz + oz;
          if (umrechnen) umrechnen(e, n, h, xy); else { xy[0] = e; xy[1] = n; }
          const XO = Math.round((xy[0] - versatz[0]) / skala[0]), YO = Math.round((xy[1] - versatz[1]) / skala[1]);
          const ZO = Math.round((h - versatz[2]) / skala[2]);
          dv.setInt32(o, XO, true); dv.setInt32(o + 4, YO, true); dv.setInt32(o + 8, ZO, true);
          if (altNeu === neu) {
            // Gleiche Familie: Stärke bis GPS-Zeit wie geliefert
            aus.set(heap.subarray(q + 12, q + (neu ? 30 : 20)), o + 12);
            if (!neu && gps) aus.set(heap.subarray(q + 20, q + 28), o + 20);
          } else {
            // Format 0–5 in 6/7: Echo in 4 Bit, Klasse in ein eigenes Byte, Scanwinkel in 0,006°
            const b14 = heap[q + 14], b15 = heap[q + 15];
            aus[o + 12] = heap[q + 12]; aus[o + 13] = heap[q + 13];
            aus[o + 14] = (b14 & 7) | ((b14 >> 3) & 7) << 4;
            aus[o + 15] = (b15 >> 5) | ((b14 >> 6) & 1) << 6 | (b14 >> 7) << 7;
            aus[o + 16] = kl;
            aus[o + 17] = heap[q + 17];
            dv.setInt16(o + 18, Math.round(quelle.getInt8(16) / 0.006), true);
            aus[o + 20] = heap[q + 18]; aus[o + 21] = heap[q + 19];
            if (gps) aus.set(heap.subarray(q + 20, q + 28), o + 22);
          }
          if (mitRgb) {
            const r = o + (neu ? 30 : 28);
            if (farbe) {
              const sp = Math.min(farbe.breite - 1, Math.max(0, Math.floor((e - farbe.e0) / farbe.res)));
              const ze = Math.min(farbe.hoehe - 1, Math.max(0, Math.floor((farbe.n1 - n) / farbe.res)));
              const f = (ze * farbe.breite + sp) * 3;
              // 8 → 16 Bit: ×257, damit 255 zu 65535 wird
              dv.setUint16(r, farbe.rgb[f] * 257, true); dv.setUint16(r + 2, farbe.rgb[f + 1] * 257, true); dv.setUint16(r + 4, farbe.rgb[f + 2] * 257, true);
            } else if (rgbIn != null) aus.set(heap.subarray(q + rgbIn, q + rgbIn + 6), r);
          }
          const echo = neu ? aus[o + 14] & 15 : aus[o + 14] & 7;
          if (echo >= 1 && echo <= 15) rueck[echo - 1]++;
          const x = XO * skala[0] + versatz[0], y = YO * skala[1] + versatz[1], z = ZO * skala[2] + versatz[2];
          if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
          if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
          if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
          a.o += L;
          a.anzahl++;
        }
      } finally {
        laszip.delete();
      }
    }
  } finally {
    LP._free(punkt);
  }
  return ausgaben.map(({ aus, o, anzahl, teile, min, max, rueck }) => {
    if (o) teile.push(new Blob([aus.subarray(0, o)]));
    if (!anzahl) return { blob: null, punkte: 0 };
    if (!neu && anzahl > 0xffffffff) throw new Error('Zu viele Punkte für LAS 1.2.');
    const kopf = lasKopf({ neu, format, anzahl, rueck, skala, versatz, min, max, kodierung: da[0].kopf.kodierung, ziel });
    return { blob: new Blob([kopf, ...teile], { type: 'application/octet-stream' }), punkte: anzahl };
  });
}

/* ---------- LoD2 als DXF ----------
 * R12 (AC1009), nur 3DFACE: liest jedes CAD. Dächer und Wände auf eigenen
 * Layern, Koordinaten wie die Punkte (UTM32 oder DB_REF), Höhen DHHN2016. */
function dxfBauen({ ecken, wand }, ziel) {
  const zeilen = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '2',
    '0', 'LAYER', '2', 'LOD2_DACH', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'LOD2_WAND', '70', '0', '62', '8', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  const teile = [];
  const xy = [0, 0], zahl = v => v.toFixed(3);
  for (let i = 0; i < wand.length; i++) {
    zeilen.push('0', '3DFACE', '8', wand[i] ? 'LOD2_WAND' : 'LOD2_DACH');
    for (let j = 0; j < 4; j++) {
      const k = (3 * i + Math.min(j, 2)) * 3;           // die vierte Ecke gleich der dritten
      const e = ecken[k], n = ecken[k + 1], h = ecken[k + 2];
      if (ziel === 'utm') { xy[0] = e; xy[1] = n; } else [xy[0], xy[1]] = dbrefPunkt(e, n, h, ziel);
      zeilen.push(String(10 + j), zahl(xy[0]), String(20 + j), zahl(xy[1]), String(30 + j), zahl(h));
    }
    if (zeilen.length > 100000) { teile.push(zeilen.join('\r\n') + '\r\n'); zeilen.length = 0; }
  }
  zeilen.push('0', 'ENDSEC', '0', 'EOF');
  teile.push(zeilen.join('\r\n') + '\r\n');
  return new Blob(teile, { type: 'application/dxf' });
}

async function exportieren({ kacheln, bereich, einzeln, nurBoden, getrennt, ziel, luftbild, gebaeude, name, zusatz, vorratMax }) {
  if (!lazPerf) lazPerf = await Copc.Las.PointData.createLazPerf({ locateFile: f => 'vendor/copc/' + f });
  const LP = lazPerf;
  const { da, fehlen } = await kachelnHolen(LP, kacheln, vorratMax);
  const datei = (n, blob, punkte) => senden({ art: 'datei', name: n, blob, punkte });
  if (einzeln && ziel === 'utm' && !luftbild && !nurBoden && !getrennt) {
    // Unverändert: das LAZ der BVV je Kachel, so wie es im Vorrat liegt
    for (const k of da) datei(`${k.kachel}.laz`, new Blob([LP.HEAPU8.subarray(k.zeiger, k.zeiger + k.groesse)], { type: 'application/octet-stream' }), k.kopf.anzahl);
  } else {
    // Ganze Kacheln: der Bereich um alle herum — jede liefert ohnehin nur ihre eigenen Punkte
    const flaechen = da.map(k => { const [e, n] = k.kachel.split('_').map(Number); return [e * 1000, n * 1000]; });
    const b = einzeln ? { e0: Math.min(...flaechen.map(f => f[0])), n0: Math.min(...flaechen.map(f => f[1])),
      e1: Math.max(...flaechen.map(f => f[0])) + 1000, n1: Math.max(...flaechen.map(f => f[1])) + 1000 } : bereich;
    let bild = null;
    const farbeFuer = !luftbild ? null : async t => {
      if (!einzeln && bild) return bild;
      senden({ art: 'luftbild', nr: t, von: da.length });
      bild = null;            // das vorige Bild freigeben, bevor das nächste kommt
      bild = await luftbildHolen(einzeln ? luftbild[da[t].kachel] : luftbild);
      return bild;
    };
    const ergebnis = await lasBauen(LP, da, b, { nurBoden, getrennt, ziel, farbeFuer });
    if (!ergebnis.some(e => e.blob)) throw new Error(einzeln ? 'In den Kacheln liegen keine passenden Punkte.' : 'Im Ausschnitt liegen keine Laserpunkte.');
    const endung = getrennt ? ['_boden', '_rest'] : [''];
    ergebnis.forEach(({ blob, punkte }, i) => { if (blob) datei(`${name}${zusatz}${endung[i]}.las`, blob, punkte); });
  }
  if (gebaeude && gebaeude.wand.length) datei(`${name}_lod2${zusatz.replace('_rgb', '')}.dxf`, dxfBauen(gebaeude, ziel), 0);
  senden({ art: 'fertig', fehlen });
}

self.onmessage = async ev => {
  if (ev.data.art === 'abbrechen') { if (abbruch) abbruch.abort(); return; }
  const istExport = ev.data.art === 'export';
  // Eins nach dem anderen: Laden und Export teilen sich den Speicher von laz-perf
  if (abbruch) { if (istExport) self.postMessage({ art: 'fehler', text: 'Es läuft noch ein Auftrag.', export: true }); return; }
  abbruch = new AbortController();
  exportLaeuft = istExport;
  try {
    if (istExport) await exportieren(ev.data);
    else await ausschneiden(ev.data);
  } catch (err) {
    if (abbruch.signal.aborted) senden({ art: 'abgebrochen' });
    else senden({ art: 'fehler', text: String(err && err.message || err) });
  } finally {
    abbruch = null;
    exportLaeuft = false;
  }
};
