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
 * Kacheln mit geraet: true kommen aus dem Speicher des Geräts (vomGeraet), wenn sie
 * dort liegen; dann meldet 'laden' geraet: true. Dorthin speichert der Auftrag
 * { art: 'speichern' } (unten, „Auf dem Gerät speichern“).
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
  self.postMessage({ art: 'vorrat', kacheln: [...new Set([...vorrat.keys(), ...entpackt.keys()])] });
}

/* Entpackte Kacheln (11.11.2026, nur am PC — app.js gibt am Handy entpacktMax 0):
 * Die LAZ der BVV sind nach Flugstreifen geordnet, jeder neue Ausschnitt müsste
 * die ganze Kachel neu entpacken. Deshalb hier je Kachel alle Punkte, knapp:
 * Lage relativ zur Kachelecke und Höhe als Float32, Klasse, Intensität — 15 Byte
 * je Punkt statt 30–40 im LAS. Verschieben heißt dann nur noch Durchsehen. */
const ENTPACKT_BYTE = 15;
const entpackt = new Map();     // Kachel → { x, y, z, kl, st, n, e0, n0, kopf, groesse, bytes }, zuletzt benutzt hinten
let entpacktSumme = 0;
/** Platz für bedarf Byte; false, wenn es auch ohne die Kacheln in behalten nicht reicht. */
function entpacktPlatz(bedarf, behalten, max) {
  for (const [k, v] of entpackt) {
    if (entpacktSumme + bedarf <= max) break;
    if (behalten.has(k)) continue;
    entpackt.delete(k);
    entpacktSumme -= v.bytes;
  }
  return entpacktSumme + bedarf <= max;
}
/** Alle Punkte einer gepackten Kachel in Felder; meldet den Fortschritt wie das Ausschneiden. */
async function entpacken(LP, { kachel, zeiger, groesse, kopf: k }, nr, von) {
  const laszip = new LP.LASZip(), punkt = LP._malloc(64);
  try {
    laszip.open(zeiger, groesse);
    const anzahl = laszip.getCount() || k.anzahl;
    const [ke, kn] = kachel.split('_').map(Number), e0 = ke * 1000, n0 = kn * 1000;
    const x = new Float32Array(anzahl), y = new Float32Array(anzahl), z = new Float32Array(anzahl);
    const kl = new Uint8Array(anzahl), st = new Uint16Array(anzahl);
    const [sx, sy, sz] = k.skala, [ox, oy, oz] = k.versatz;
    let puffer = null, d = null;
    for (let i = 0; i < anzahl; i++) {
      laszip.getPoint(punkt);
      if ((i & 0xfffff) === 0) {
        senden({ art: 'lesen', nr, von, gelesen: i, gesamt: anzahl });
        await new Promise(r => setTimeout(r));
        if (abbruch.signal.aborted) throw new Error(ABGEBROCHEN);
      }
      /* Erst nach dem Warten: Währenddessen kann ein Download den Wasm-Speicher wachsen
       * lassen, der alte Puffer ist dann abgelöst (Handy, 12.11.2026: „detached ArrayBuffer“). */
      if (puffer !== LP.HEAPU8.buffer) { puffer = LP.HEAPU8.buffer; d = new DataView(puffer, punkt, k.laenge); }
      x[i] = d.getInt32(0, true) * sx + ox - e0;
      y[i] = d.getInt32(4, true) * sy + oy - n0;
      z[i] = d.getInt32(8, true) * sz + oz;
      kl[i] = k.format >= 6 ? d.getUint8(16) : d.getUint8(15) & 31;
      st[i] = d.getUint16(12, true);
    }
    return { x, y, z, kl, st, n: anzahl, e0, n0, kopf: k, groesse, bytes: anzahl * ENTPACKT_BYTE };
  } finally {
    laszip.delete();
    LP._free(punkt);
  }
}

/* Mehrere Kacheln gleichzeitig entpacken (11.11.2026, so gewünscht, nur am PC — app.js gibt
 * am Handy entpacktMax 0): laz-perf rechnet auf einem Kern, je Kachel ein Hilfs-Worker (diese
 * Datei noch einmal, Aufträge teilEntpacken + teilDaten) bekommt eine Kopie des LAZ und schickt
 * die Felder zurück. Höchstens parallel zugleich, der Rest wartet in der Reihe.
 *
 * Überlappend (seit dem Abend des 11.11.2026): ausschneiden gibt jede Kachel gleich nach dem
 * Laden hinein (start), während die nächste noch lädt — gemessen bei Kempten 22 s Laden und rund
 * 20 s Entpacken je Kachel. Solange noch geladen wird, meldet der Pool nichts (die Leiste zeigt
 * das Laden); ab alleGeladen() den Fortschritt über alle als 'lesen' mit gleichzeitig.
 * start(q) gibt ein Versprechen auf die Felder wie entpacken() oder null, wenn der Hilfs-Worker
 * scheiterte — dann entpackt der Aufrufer diese Kachel selbst. Es scheitert nie (kein
 * unbehandelter Fehler beim Abbrechen); ob abgebrochen wurde, prüft der Aufrufer. */
function entpackPool(parallel) {
  const reihe = [], laufen = new Map(), stand = [];      // laufen: Hilfs-Worker → sein fertig()
  let melden = false, zuletzt = 0;
  const fortschritt = () => {
    if (!melden || !stand.length) return;
    const jetzt = performance.now();
    if (jetzt - zuletzt < 100) return;
    zuletzt = jetzt;
    const gelesen = stand.reduce((a, s) => a + s.gelesen, 0), gesamt = stand.reduce((a, s) => a + s.gesamt, 0);
    const offen = stand.filter(s => s.gelesen < s.gesamt).length;
    senden({ art: 'lesen', nr: 0, von: 1, gelesen, gesamt, gleichzeitig: Math.max(1, Math.min(parallel, offen)) });
  };
  const weiter = () => {
    while (laufen.size < parallel && reihe.length && !abbruch.signal.aborted) {
      const { q, s, fertig } = reihe.shift();
      let w = null;
      try { w = new Worker('laser-werk.js'); } catch (err) { console.warn(err); fertig(null); continue; }
      laufen.set(w, fertig);
      const ende = e => {
        if (!laufen.has(w)) return;
        laufen.delete(w);
        w.terminate();
        s.gelesen = s.gesamt;
        fortschritt();
        fertig(e);
        weiter();
      };
      w.onmessage = ev => {
        const m = ev.data;
        if (m.art === 'lesen') { s.gelesen = m.gelesen; fortschritt(); }
        else if (m.art === 'entpackt') ende(m.e);
        else if (m.art === 'fehler') { console.warn(`Kachel ${q.kachel} im Hilfs-Worker:`, m.text); ende(null); }
      };
      w.onerror = ev => { if (ev.preventDefault) ev.preventDefault(); console.warn(`Kachel ${q.kachel} im Hilfs-Worker:`, ev.message); ende(null); };
      // Die Kopie erst jetzt: Das LAZ liegt bis dahin nur einmal im Speicher
      const daten = lazPerf.HEAPU8.slice(q.zeiger, q.zeiger + q.groesse);
      w.postMessage({ art: 'teilEntpacken', kachel: q.kachel, kopf: q.kopf });
      w.postMessage({ art: 'teilDaten', daten }, [daten.buffer]);
    }
  };
  /* Beim Abbrechen jedes Versprechen erfüllen (mit null), auch das der laufenden: Wer darauf
   * wartet, käme sonst nie weiter — der Worker hinge mit gesetztem abbruch, und jeder neue
   * Auftrag würde still verworfen (so beim Prüfen am 11.11.2026 aufgefallen). */
  const stopp = () => {
    for (const [w, fertig] of laufen) { w.terminate(); fertig(null); }
    laufen.clear();
    for (const r of reihe.splice(0)) r.fertig(null);
  };
  abbruch.signal.addEventListener('abort', stopp, { once: true });
  return {
    start(q) {
      const s = { gelesen: 0, gesamt: q.kopf.anzahl };
      stand.push(s);
      return new Promise(fertig => { reihe.push({ q, s, fertig }); weiter(); });
    },
    alleGeladen() { melden = true; zuletzt = 0; fortschritt(); },
    ende() { abbruch.signal.removeEventListener('abort', stopp); stopp(); }
  };
}

/* Im Hilfs-Worker: erst der Auftrag, dann die Bytes (eigene Nachricht, damit der
 * Kopf nicht mit dem großen Puffer auf die Reise muss). */
let teilAuftrag = null;
async function teilEntpacken({ daten }) {
  if (!lazPerf) lazPerf = await Copc.Las.PointData.createLazPerf({ locateFile: f => 'vendor/copc/' + f });
  const LP = lazPerf, groesse = daten.length, zeiger = LP._malloc(groesse);
  if (!zeiger) throw new Error('Kein Speicher für die Kachel.');
  try {
    LP.HEAPU8.set(daten, zeiger);
    daten = null;
    const e = await entpacken(LP, { kachel: teilAuftrag.kachel, zeiger, groesse, kopf: teilAuftrag.kopf }, 0, 1);
    self.postMessage({ art: 'entpackt', e }, [e.x.buffer, e.y.buffer, e.z.buffer, e.kl.buffer, e.st.buffer]);
  } finally { LP._free(zeiger); }
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

/** holen() lädt einmal von vorn (in den Speicher oder, beim Speichern, in eine Datei). */
async function mitWiederholung(holen, wartenMelden) {
  for (let versuch = 1; ; versuch++) {
    try {
      return await holen();
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

/* ======================= Auf dem Gerät speichern =======================
 *
 * 11.11.2026, so gewünscht: ausgewählte Kacheln dauerhaft auf dem Gerät, um sie
 * öfter oder offline anzusehen (etwa die Allgäuer Alpen, mehrere GB). Gespeichert
 * wird das LAZ der BVV unverändert im Origin Private File System, Ordner „laser“,
 * je Kachel <kachel>.laz. Nicht IndexedDB oder Cache Storage: Dateien bis 1,9 GB
 * gehen dort nur am Stück durch den Speicher, und der Service Worker räumt die
 * Caches bei jedem Deploy. Geschrieben wird hier im Worker über
 * createSyncAccessHandle (nur in Workern, dafür Stück für Stück direkt aus dem
 * Netz, ohne die Kachel im Speicher zu halten), erst in <kachel>.teil — fertig
 * und geprüft wird daraus <kachel>.laz. Was mit .teil liegen bleibt (App
 * geschlossen), räumt app.js beim Auflisten weg.
 *
 * Auftrag { art: 'speichern', kacheln: [{ kachel, url }] } — läuft in einem
 * eigenen Worker (app.js, laserSpeicherWerk), damit Ansehen und Speichern
 * nebeneinander gehen. Meldungen:
 *   { art: 'laden', nr, von, kachel, geladen, gesamt }   (gesamt 0 = unbekannt)
 *   { art: 'warten', nr, von, versuch, sekunden, abgeschnitten }
 *   { art: 'gespeichert', kachel, groesse }   { art: 'fehlt', kachel }  (gibt es nicht)
 *   { art: 'fertig' }, { art: 'fehler', text }, { art: 'abgebrochen' } */
const GERAET_ORDNER = 'laser';
async function geraetOrdner() {
  if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('Dieser Browser kann keine Dateien auf dem Gerät ablegen.');
  return (await navigator.storage.getDirectory()).getDirectoryHandle(GERAET_ORDNER, { create: true });
}

/** Eine gespeicherte Kachel in den Speicher von laz-perf; null, wenn sie nicht (mehr) da ist. */
async function vomGeraet(LP, kachel, behalten, vorratMax) {
  let h;
  try {
    const datei = await (await geraetOrdner()).getFileHandle(`${kachel}.laz`);
    h = await datei.createSyncAccessHandle();
  } catch (err) { return null; }               // dann wie bisher aus dem Netz
  try {
    const groesse = h.getSize();
    if (groesse < 375) return null;
    platzMachen(LP, groesse, behalten, vorratMax);
    const zeiger = LP._malloc(groesse);
    if (!zeiger) throw new Error('Zu wenig Speicher — einen kleineren Ausschnitt oder weniger Kacheln wählen.');
    // Gleich in den Speicher von laz-perf; HEAPU8 erst nach malloc holen (er kann wachsen)
    const n = h.read(LP.HEAPU8.subarray(zeiger, zeiger + groesse), { at: 0 });
    if (n !== groesse || !vollstaendig(LP.HEAPU8, zeiger, groesse)) { LP._free(zeiger); return null; }
    return { zeiger, groesse };
  } finally {
    h.close();
  }
}

/** Reicht die Datei im Griff h bis zu ihrer Chunk-Tabelle? Wie vollstaendig, nur ohne die Datei zu lesen. */
function dateiVollstaendig(h, groesse) {
  if (groesse < 375) return false;
  const lies = (at, n) => { const b = new Uint8Array(n); h.read(b, { at }); return new DataView(b.buffer); };
  const kopf = lies(0, 104);
  if (String.fromCharCode(kopf.getUint8(0), kopf.getUint8(1), kopf.getUint8(2), kopf.getUint8(3)) !== 'LASF') return false;
  const daten = kopf.getUint32(96, true);
  if (daten + 8 > groesse) return false;
  let tabelle = Number(lies(daten, 8).getBigInt64(0, true));
  if (tabelle === -1) tabelle = Number(lies(groesse - 8, 8).getBigInt64(0, true));
  return !(tabelle > daten) || tabelle + 8 <= groesse;
}

/** Lädt url Stück für Stück in die Datei hinter h (von vorn); Größe oder null bei 404. */
async function inDatei(url, h, melden) {
  const r = await fetch(url, { cache: 'no-store', signal: abbruch.signal });
  if (r.status === 404) return null;
  if (r.status === 429) throw new Error('Gerade wurden sehr viele Laserkacheln geladen — die Weiterleitung lässt erst in einer Weile wieder welche durch.');
  if (!r.ok) throw new Error(`Laserkachel: HTTP ${r.status}`);
  if (!r.body) throw new Error('Laserkachel: keine Daten');
  const gesamt = r.headers.get('Content-Encoding') ? 0 : Number(r.headers.get('Content-Length')) || 0;
  const leser = r.body.getReader();
  h.truncate(0);
  let o = 0, gemeldet = 0;
  for (;;) {
    let stueck;
    try { stueck = await leser.read(); } catch (err) { err.mittendrin = true; throw err; }
    const { done, value } = stueck;
    if (done) break;
    try { h.write(value, { at: o }); } catch (err) {
      leser.cancel();
      if (err && err.name === 'QuotaExceededError') throw new Error('Der Speicher auf dem Gerät ist voll.');
      throw err;
    }
    o += value.byteLength;
    if (o - gemeldet > 1 << 20) { gemeldet = o; melden(o, gesamt); }
  }
  h.flush();
  // Wie beim Laden: über Cloudflare kommen große Kacheln manchmal still abgeschnitten an
  if ((gesamt && o !== gesamt) || !dateiVollstaendig(h, o)) {
    const err = new TypeError('Laserkachel kam unvollständig an.');
    err.mittendrin = err.abgeschnitten = true;
    throw err;
  }
  melden(o, o);
  return o;
}

async function speichern({ kacheln }) {
  const ordner = await geraetOrdner();
  const von = kacheln.length;
  for (let i = 0; i < von; i++) {
    const { kachel, url } = kacheln[i];
    const teil = await ordner.getFileHandle(`${kachel}.teil`, { create: true });
    const h = await teil.createSyncAccessHandle();
    let groesse;
    try {
      groesse = await mitWiederholung(() => inDatei(url, h, (geladen, gesamt) =>
        self.postMessage({ art: 'laden', nr: i, von, kachel, geladen, gesamt })),
        (versuch, sekunden, abgeschnitten) => self.postMessage({ art: 'warten', nr: i, von, versuch, sekunden, abgeschnitten }));
    } catch (err) {
      h.close();
      await ordner.removeEntry(`${kachel}.teil`).catch(() => {});
      throw err;
    }
    h.close();
    if (groesse == null) {
      await ordner.removeEntry(`${kachel}.teil`).catch(() => {});
      self.postMessage({ art: 'fehlt', kachel });
      continue;
    }
    // Erst jetzt unter dem richtigen Namen — eine halbe Kachel gilt so nie als gespeichert
    await ordner.removeEntry(`${kachel}.laz`).catch(() => {});
    if (teil.move) await teil.move(`${kachel}.laz`);
    else {
      // Ohne move() (ältere Browser): umkopieren in Stücken zu 16 MB
      const ziel = await (await ordner.getFileHandle(`${kachel}.laz`, { create: true })).createSyncAccessHandle();
      const quelle = await teil.createSyncAccessHandle();
      try {
        const b = new Uint8Array(1 << 24);
        for (let o = 0; o < groesse; o += b.length) {
          const n = quelle.read(b, { at: o });
          ziel.write(b.subarray(0, n), { at: o });
        }
        ziel.flush();
      } finally { ziel.close(); quelle.close(); }
      await ordner.removeEntry(`${kachel}.teil`);
    }
    self.postMessage({ art: 'gespeichert', kachel, groesse });
  }
  self.postMessage({ art: 'fertig' });
}

/* ===================== Entpackt auf dem Gerät (11.11.2026) =====================
 *
 * Auf Wunsch, für Geräte mit viel Platz: zu einer gespeicherten Kachel auch die
 * entpackte Fassung, <kachel>.pts neben <kachel>.laz. Beim Öffnen entfällt dann das
 * Entpacken (rund 10 s je Kachel) — gelesen wird nur noch die Datei. Das LAZ bleibt
 * liegen: Der Export baut aus ihm, und es ist die Quelle, falls sich das Format hier
 * einmal ändert. Inhalt wie die entpackten Kacheln im Arbeitsspeicher (15 Byte je
 * Punkt, bei den BVV-Kacheln rund 2,4-mal das LAZ):
 *   0     „TPVE“, u32 Fassung (1), u32 Punkte n, u32 Länge des JSON-Kopfs
 *   16    JSON { kopf, groesse (des LAZ), e0, n0 }
 *   4096  x, y, z (je Float32 × n, relativ zur Kachelecke bzw. absolut), Intensität
 *         (Uint16 × n), Klasse (Uint8 × n)
 * Geschrieben erst als <kachel>.pts.teil, dann umbenannt — wie beim LAZ.
 *
 * Auftrag { art: 'entpacktSpeichern', kacheln: [name] } im Speicher-Worker. Meldungen:
 *   { art: 'lesen', nr, von, gelesen, gesamt }  beim Entpacken
 *   { art: 'gespeichert', kachel, groesse, entpackt: true }   { art: 'fehlt', kachel }
 *   { art: 'fertig' }, { art: 'fehler', text }, { art: 'abgebrochen' } */
const PTS_KOPF = 4096, PTS_FASSUNG = 1;
const ptsLage = n => ({ x: PTS_KOPF, y: PTS_KOPF + 4 * n, z: PTS_KOPF + 8 * n, st: PTS_KOPF + 12 * n, kl: PTS_KOPF + 14 * n,
  ende: PTS_KOPF + 15 * n });

async function entpacktSpeichern({ kacheln }) {
  if (!lazPerf) lazPerf = await Copc.Las.PointData.createLazPerf({ locateFile: f => 'vendor/copc/' + f });
  const LP = lazPerf, ordner = await geraetOrdner(), von = kacheln.length;
  for (let i = 0; i < von; i++) {
    const kachel = kacheln[i];
    const v = await vomGeraet(LP, kachel, new Set(), Infinity);
    if (!v) { self.postMessage({ art: 'fehlt', kachel }); continue; }
    let e;
    try {
      const kopf = kopfLesen(LP.HEAPU8.subarray(v.zeiger, v.zeiger + 375));
      e = await entpacken(LP, { kachel, ...v, kopf }, i, von);
    } finally { LP._free(v.zeiger); }
    const teil = await ordner.getFileHandle(`${kachel}.pts.teil`, { create: true });
    const h = await teil.createSyncAccessHandle();
    try {
      const json = new TextEncoder().encode(JSON.stringify({ kopf: e.kopf, groesse: e.groesse, e0: e.e0, n0: e.n0 }));
      if (16 + json.length > PTS_KOPF) throw new Error('Kopf zu groß');
      const k = new Uint8Array(PTS_KOPF), d = new DataView(k.buffer);
      k.set([84, 80, 86, 69]);                    // TPVE
      d.setUint32(4, PTS_FASSUNG, true); d.setUint32(8, e.n, true); d.setUint32(12, json.length, true);
      k.set(json, 16);
      const L = ptsLage(e.n);
      h.truncate(0);
      h.write(k, { at: 0 });
      h.write(e.x, { at: L.x }); h.write(e.y, { at: L.y }); h.write(e.z, { at: L.z });
      h.write(e.st, { at: L.st }); h.write(e.kl, { at: L.kl });
      h.flush();
      if (h.getSize() !== L.ende) throw new Error('Die entpackte Kachel ließ sich nicht vollständig schreiben.');
    } catch (err) {
      h.close();
      await ordner.removeEntry(`${kachel}.pts.teil`).catch(() => {});
      if (err && err.name === 'QuotaExceededError') throw new Error('Der Speicher auf dem Gerät ist voll.');
      throw err;
    }
    h.close();
    await ordner.removeEntry(`${kachel}.pts`).catch(() => {});
    if (teil.move) await teil.move(`${kachel}.pts`);
    else throw new Error('Dieser Browser kann die Datei nicht umbenennen.');
    self.postMessage({ art: 'gespeichert', kachel, groesse: ptsLage(e.n).ende, entpackt: true });
    if (abbruch.signal.aborted) throw new Error(ABGEBROCHEN);
  }
  self.postMessage({ art: 'fertig' });
}

/** Die entpackte Kachel öffnen (Griff bleibt offen); null, wenn es keine passende gibt. */
async function entpacktOeffnen(kachel) {
  let h;
  try {
    h = await (await (await geraetOrdner()).getFileHandle(`${kachel}.pts`)).createSyncAccessHandle();
  } catch (err) { return null; }
  try {
    const k = new Uint8Array(PTS_KOPF);
    h.read(k, { at: 0 });
    const d = new DataView(k.buffer);
    if (String.fromCharCode(k[0], k[1], k[2], k[3]) !== 'TPVE' || d.getUint32(4, true) !== PTS_FASSUNG) throw 0;
    const n = d.getUint32(8, true), lj = d.getUint32(12, true);
    if (h.getSize() !== ptsLage(n).ende) throw 0;
    const j = JSON.parse(new TextDecoder().decode(k.subarray(16, 16 + lj)));
    return { h, n, e0: j.e0, n0: j.n0, kopf: j.kopf, groesse: j.groesse, bytes: n * ENTPACKT_BYTE };
  } catch (err) {
    h.close();
    return null;                               // beschädigt oder alte Fassung: dann wie bisher über das LAZ
  }
}

/** Stück [i0, i1) der Felder aus der Datei; ganz gelesen ergibt es die Felder wie entpacken(). */
function entpacktStueck(D, i0, i1) {
  const L = ptsLage(D.n), m = i1 - i0;
  const lies = (Typ, at, b) => { const a = new Typ(m); D.h.read(new Uint8Array(a.buffer), { at: at + i0 * b }); return a; };
  return { x: lies(Float32Array, L.x, 4), y: lies(Float32Array, L.y, 4), z: lies(Float32Array, L.z, 4),
    st: lies(Uint16Array, L.st, 2), kl: lies(Uint8Array, L.kl, 1) };
}

/** Holt die Kacheln, eine nach der anderen: aus dem Vorrat oder neu geladen. */
async function kachelnHolen(LP, kacheln, vorratMax, leerErlaubt = false, jeKachel = null) {
  const von = kacheln.length, behalten = new Set(kacheln.map(k => k.kachel));
  const da = [], fehlen = [];
  let megabyte = 0;
  for (let i = 0; i < von; i++) {
    const { kachel, url } = kacheln[i];
    let v = vorrat.get(kachel);
    if (v) vorrat.delete(kachel);               // nach hinten: zuletzt benutzt
    // Auf dem Gerät gespeichert (app.js setzt geraet): von dort statt aus dem Netz
    else if (kacheln[i].geraet && (v = await vomGeraet(LP, kachel, behalten, vorratMax))) {
      senden({ art: 'laden', nr: i, von, geladen: v.groesse, gesamt: v.groesse, geraet: true });
    } else {
      v = await mitWiederholung(() => herunterladen(LP, url, (geladen, gesamt) =>
        senden({ art: 'laden', nr: i, von, geladen, gesamt }), behalten, vorratMax),
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
    // Darf warten (viele Kacheln, strom): die nächste lädt erst, wenn die vorletzte geschnitten ist
    if (jeKachel) await jeKachel(da[da.length - 1]);
  }
  if (!da.length && !leerErlaubt) throw new Error('Für diese Stelle gibt es keine Laserkachel.');
  return { da, fehlen, megabyte };
}

/* Freihand-Umriss (11.11.2026): Statt jeden Punkt gegen das Vieleck zu prüfen,
 * einmal ein Raster über das Rechteck füllen (Zeile für Zeile, gerade/ungerade)
 * und je Punkt nur eine Zelle nachsehen. Bei 2 km Kante und 0,5 m Zellen 16 MB. */
function umrissMaske(umriss, { e0, n0, e1, n1 }) {
  const res = Math.max(0.25, Math.max(e1 - e0, n1 - n0) / 4000);
  const w = Math.ceil((e1 - e0) / res), h = Math.ceil((n1 - n0) / res), m = new Uint8Array(w * h);
  let zellen = 0;
  for (let r = 0; r < h; r++) {
    const y = n0 + (r + 0.5) * res, xs = [];
    for (let i = 0, j = umriss.length - 1; i < umriss.length; j = i++) {
      const [xa, ya] = umriss[j], [xb, yb] = umriss[i];
      if ((ya > y) !== (yb > y)) xs.push(xa + (y - ya) * (xb - xa) / (yb - ya));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - e0) / res - 0.5)), c1 = Math.min(w - 1, Math.floor((xs[k + 1] - e0) / res - 0.5));
      for (let c = c0; c <= c1; c++) { m[r * w + c] = 1; zellen++; }
    }
  }
  return { m, w, h, res, e0, n0, flaeche: zellen * res * res };
}
const inMaske = (M, e, n) => {
  const c = Math.floor((e - M.e0) / M.res), r = Math.floor((n - M.n0) / M.res);
  return c >= 0 && r >= 0 && c < M.w && r < M.h && M.m[r * M.w + c] === 1;
};

/* Ab so vielen Kacheln (bis 9, 12.11.2026 so gewünscht) liegen sie nicht mehr alle zugleich im
 * Speicher von laz-perf (höchstens rund 2 GB, eine Kachel 40–250 MB, im Gebirge bis 1,9 GB):
 * Jede wird gleich nach ihrem Download ausgeschnitten und dann freigegeben, auch am PC — ohne
 * Hilfs-Worker und ohne entpackten Vorrat. Im Speicher sind so höchstens zwei zugleich. */
const STROM_AB = 5;

async function ausschneiden({ kacheln, bereich, umriss, max, nurBoden, vorratMax, entpacktMax = 0, parallel = 1, gitterZellen = 0, zGrenze = null }) {
  const strom = kacheln.length >= STROM_AB;
  if (strom) { entpacktMax = 0; zGrenze = null; }
  if (!lazPerf) lazPerf = await Copc.Las.PointData.createLazPerf({ locateFile: f => 'vendor/copc/' + f });
  const LP = lazPerf;

  // Erst alle Kacheln da haben, eine nach der anderen. Die Zeiten je Schritt
  // stehen unten in der Ansicht — damit sich sagen lässt, wo es hängt.
  // Schon entpackte brauchen ihr LAZ nicht (es kann längst aus dem Vorrat sein).
  const zeiten = { laden: 0, megabyte: 0, lesen: 0, normalen: 0 };
  let uhr = performance.now();
  const behalten = new Set(kacheln.map(k => k.kachel));
  // Entpackt auf dem Gerät (<kachel>.pts): weder LAZ laden noch entpacken
  const vonDatei = new Map();
  let pool = null;                // Hilfs-Worker zum Entpacken (entpackPool), im finally beendet
  try {
  for (const k of kacheln) {
    if (!k.geraet || entpackt.has(k.kachel)) continue;
    const D = await entpacktOeffnen(k.kachel);
    if (D) vonDatei.set(k.kachel, D);
  }
  const offen = kacheln.filter(k => !entpackt.has(k.kachel) && !vonDatei.has(k.kachel));
  /* Am PC jede Kachel gleich nach dem Laden in einen Hilfs-Worker zum Entpacken, während die
   * nächste lädt (entpackPool). Platz im Vorrat für die entpackte Fassung wird dabei reserviert. */
  pool = entpacktMax && typeof Worker !== 'undefined' ? entpackPool(Math.max(1, parallel)) : null;
  const frueh = new Map();        // Kachel → Versprechen auf die Felder
  let reserviert = 0;
  const reservieren = q => {
    const bedarf = q.kopf.anzahl * ENTPACKT_BYTE;
    if (!entpacktPlatz(reserviert + bedarf, behalten, entpacktMax)) return false;
    reserviert += bedarf;
    return true;
  };
  /* ---------- Ausschneiden vorbereiten (vor dem Laden, damit es am Handy überlappen kann) ---------- */
  const { e0, n0, e1, n1 } = bereich;
  const maske = umriss && umriss.length > 2 ? umrissMaske(umriss, bereich) : null;
  const anteil = maske ? maske.flaeche / Math.max(1, (e1 - e0) * (n1 - n0)) : 1;
  const ce = (e0 + e1) / 2, cn = (n0 + n1) / 2;
  // Fläche einer Kachel (1 × 1 km, aus dem Namen) im Ausschnitt
  const kachelFlaeche = name => {
    const [ke, kn] = name.split('_').map(Number);
    return Math.max(0, Math.min(e1, ke * 1000 + 1000) - Math.max(e0, ke * 1000)) * Math.max(0, Math.min(n1, kn * 1000 + 1000) - Math.max(n0, kn * 1000));
  };
  /** Erwartete Punkte einer Kachel im Ausschnitt, nach ihrem Kopf. */
  const erwartetVon = k => {
    const flaeche = Math.max(1, (k.max[0] - k.min[0]) * (k.max[1] - k.min[1]));
    const ueber = Math.max(0, Math.min(e1, k.max[0]) - Math.max(e0, k.min[0])) * Math.max(0, Math.min(n1, k.max[1]) - Math.max(n0, k.min[1]));
    return k.anzahl * Math.min(1, ueber / flaeche) * (nurBoden ? 0.5 : 1) * anteil;
  };
  /* Am Handy (ohne entpackten Vorrat) überlappend: Jede Kachel wird gleich nach ihrem Download
   * ausgeschnitten, während die nächste lädt — im selben Worker abwechselnd, ohne zweite Kopie des
   * LAZ (11.11.2026). Die Ausdünnung kann dann nicht auf alle Kacheln zusammen warten: Jede bekommt
   * ihr Budget nach ihrem Flächenanteil am Ausschnitt (der steht vorher fest) und ihre Punktzahl aus
   * dem eigenen Kopf. Bei gleicher Dichte ergibt das denselben Schritt wie zusammen gerechnet; bei
   * sehr verschiedener Dichte zweier Kacheln sieht man an der Grenze einen Dichtesprung.
   * Mit Höhengrenze (Dichter laden) nicht: Dort passt sich der Schritt beim Lesen an. */
  const ueberlappen = !entpacktMax && !zGrenze && kacheln.length > 1 && offen.length > 0;
  const flaecheGesamt = kacheln.reduce((a, k) => a + kachelFlaeche(k.kachel), 0) || 1;
  const schrittFuer = q => Math.max(1, Math.ceil(erwartetVon(q.kopf) / Math.max(1, max * kachelFlaeche(q.kachel) / flaecheGesamt)));

  let schritt = 1;
  let platz = max + 1024;          // wächst bei Bedarf (verdoppelt)
  let xyz = new Float32Array(platz * 3), klasse = new Uint8Array(platz), staerke = new Uint16Array(platz);
  const klassen = new Map();
  let n = 0, drin = 0, zMin = Infinity, zMax = -Infinity, iMax = 0;
  /** Ein Punkt im Rechteck: Umriss, Klasse, Ausdünnung prüfen und übernehmen. */
  const gitter = gitterZellen ? gitterAnlegen(bereich, gitterZellen) : null;
  const [zVon, zBis] = zGrenze || [-Infinity, Infinity];
  let verdichtet = false;
  const verdichten = () => {
    let j = 0;
    for (let i = 0; i < n; i += 2, j++) {
      xyz[3 * j] = xyz[3 * i]; xyz[3 * j + 1] = xyz[3 * i + 1]; xyz[3 * j + 2] = xyz[3 * i + 2];
      klasse[j] = klasse[i]; staerke[j] = staerke[i];
    }
    n = j;
    schritt *= 2;
    verdichtet = true;
  };
  const nimm = (e, nn, z, kl, s) => {
    if (maske && !inMaske(maske, e, nn)) return;
    if (z < zVon || z > zBis) return;
    // Das Bodenraster sieht jeden Punkt, auch die, die die Ausdünnung gleich verwirft
    if (gitter && BODEN.has(kl)) {
      const cx = Math.floor((e - e0) / gitter.zelle), cy = Math.floor((nn - n0) / gitter.zelle);
      if (cx >= 0 && cy >= 0 && cx < gitter.nx && cy < gitter.ny) { const c = cy * gitter.nx + cx; gitter.summe[c] += z; gitter.zahl[c]++; }
    }
    if (nurBoden && !BODEN.has(kl)) return;
    if (drin++ % schritt) return;
    if (zGrenze && n >= max) { verdichten(); if ((drin - 1) % schritt) return; }
    if (n === platz) {
      platz *= 2;
      const a = new Float32Array(platz * 3); a.set(xyz); xyz = a;
      const b = new Uint8Array(platz); b.set(klasse); klasse = b;
      const c = new Uint16Array(platz); c.set(staerke); staerke = c;
    }
    xyz[3 * n] = e - ce; xyz[3 * n + 1] = nn - cn; xyz[3 * n + 2] = z;
    klasse[n] = kl;
    staerke[n] = s;
    klassen.set(kl, (klassen.get(kl) || 0) + 1);
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    if (s > iMax) iMax = s;
    n++;
  };
  /* Während noch geladen wird, schweigt das Ausschneiden (die Leiste zeigt das Laden) und gibt den
   * Faden öfter frei, damit der Download weiterläuft. vorbei: der Auftrag ist anders zu Ende gegangen. */
  let stillLesen = false, vorbei = false;
  const LESEN_TAKT = () => stillLesen ? 0x1ffff : 0xfffff;
  const lesenMelden = m => { if (!stillLesen) senden(m); };
  const pruefen = () => { if (abbruch.signal.aborted || vorbei) throw new Error(ABGEBROCHEN); };
  async function schneiden(q, t, von) {
    if (q.felder) {
      // Aus den entpackten Feldern: nur noch durchsehen
      const { x, y, z, kl, st, n: anzahl, e0: ke, n0: kn } = q.felder;
      const X0 = e0 - ke, X1 = e1 - ke, Y0 = n0 - kn, Y1 = n1 - kn;
      for (let i = 0; i < anzahl; i++) {
        if ((i & 0x3fffff) === 0) {
          lesenMelden({ art: 'lesen', nr: t, von, gelesen: i, gesamt: anzahl });
          await new Promise(r => setTimeout(r));
          pruefen();
        }
        const xi = x[i], yi = y[i];
        if (xi < X0 || xi > X1 || yi < Y0 || yi > Y1) continue;
        nimm(xi + ke, yi + kn, z[i], kl[i], st[i]);
      }
      return;
    }
    if (q.datei) {
      // Entpackt auf dem Gerät, ohne Platz im Arbeitsspeicher: in Stücken zu 2^20 Punkten
      const D = q.datei, X0 = e0 - D.e0, X1 = e1 - D.e0, Y0 = n0 - D.n0, Y1 = n1 - D.n0;
      for (let i0 = 0; i0 < D.n; i0 += 1 << 20) {
        lesenMelden({ art: 'lesen', nr: t, von, gelesen: i0, gesamt: D.n, datei: true });
        await new Promise(r => setTimeout(r));
        pruefen();
        const { x, y, z, kl, st } = entpacktStueck(D, i0, Math.min(D.n, i0 + (1 << 20)));
        for (let i = 0; i < x.length; i++) {
          const xi = x[i], yi = y[i];
          if (xi < X0 || xi > X1 || yi < Y0 || yi > Y1) continue;
          nimm(xi + D.e0, yi + D.n0, z[i], kl[i], st[i]);
        }
      }
      return;
    }
    const { zeiger, groesse, kopf: k } = q;
    const laszip = new LP.LASZip(), punkt = LP._malloc(64);
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
        if ((i & LESEN_TAKT()) === 0) {
          lesenMelden({ art: 'lesen', nr: t, von, gelesen: i, gesamt: anzahl });
          await new Promise(r => setTimeout(r));          // Nachrichten (Abbrechen) und den Download durchlassen
          pruefen();
        }
        // Nach dem Warten: der Download kann den Speicher inzwischen vergrößert haben (siehe entpacken)
        if (puffer !== LP.HEAPU8.buffer) { puffer = LP.HEAPU8.buffer; d = new DataView(puffer, punkt, k.laenge); }
        const X = d.getInt32(0, true), Y = d.getInt32(4, true);
        if (X < X0 || X > X1 || Y < Y0 || Y > Y1) continue;
        // Formate 0–5: Klasse in den unteren 5 Bit von Byte 15; ab 6 ein ganzes Byte 16
        nimm(X * sx + ox, Y * sy + oy, d.getInt32(8, true) * sz + oz,
          k.format >= 6 ? d.getUint8(16) : d.getUint8(15) & 31, d.getUint16(12, true));
      }
    } finally {
      laszip.delete();
      LP._free(punkt);
    }
  }

  /* Überlappend: die Schnitte laufen nacheinander in einer Kette, gestartet je Kachel gleich
   * nach ihrem Download (kachelnHolen ruft jeKachel); entpackt auf dem Gerät liegende zuerst. */
  let kette = Promise.resolve(), schrittAnzeige = 1;   // überlappend: der gröbste Schritt einer Kachel (für die Anzeige)
  const geschnitten = new Set();
  const einreihen = (q, t) => {
    geschnitten.add(q.kachel);
    const davor = kette;
    kette = kette.then(async () => {
      schritt = schrittFuer(q); schrittAnzeige = Math.max(schrittAnzeige, schritt); drin = 0;
      await schneiden(q, t, kacheln.length);
      if (strom) freigeben(q);
    });
    kette.catch(() => {});        // ausgewertet wird beim Warten auf die Kette
    // Bei vielen Kacheln wartet der Download auf den vorigen Schnitt: höchstens zwei LAZ zugleich
    return strom ? davor.catch(() => {}) : undefined;
  };
  const nrVon = name => kacheln.findIndex(k => k.kachel === name);
  /** Viele Kacheln (strom): das LAZ nach dem Schnitt aus dem Speicher — es wird nicht mehr gebraucht. */
  const freigeben = q => {
    const v = vorrat.get(q.kachel);
    if (!v || v.zeiger !== q.zeiger) return;
    LP._free(v.zeiger);
    vorrat.delete(q.kachel);
    vorratMelden();
  };
  if (ueberlappen) {
    stillLesen = true;
    for (const [kachel, D] of vonDatei) einreihen({ kachel, kopf: D.kopf, groesse: D.groesse, datei: D }, nrVon(kachel));
  }
  let geladen;
  try {
    geladen = offen.length
      ? await kachelnHolen(LP, offen, vorratMax, true,
        pool ? q => { if (reservieren(q)) frueh.set(q.kachel, pool.start(q)); }
          : ueberlappen ? q => einreihen(q, nrVon(q.kachel)) : null)
      : { da: [], fehlen: [], megabyte: 0 };
  } catch (err) {
    vorbei = true;                  // die laufenden Schnitte beenden, bevor der Fehler hinausgeht
    await kette.catch(() => {});
    throw err;
  }
  const { da, fehlen, megabyte } = geladen;
  zeiten.megabyte = megabyte;
  zeiten.ausDatei = vonDatei.size;       // so viele Kacheln kamen entpackt vom Gerät (laser.js: „Lesen“ statt „Entpacken“)
  zeiten.kacheln = kacheln.length;
  zeiten.laden = (performance.now() - uhr) / 1000;
  uhr = performance.now();
  stillLesen = false;

  // In der Reihenfolge des Auftrags: je Kachel die entpackten Felder oder das LAZ
  const quellen = [];
  for (const { kachel } of kacheln) {
    const e = entpackt.get(kachel);
    if (e) { entpackt.delete(kachel); entpackt.set(kachel, e); quellen.push({ kachel, kopf: e.kopf, groesse: e.groesse, felder: e }); continue; }
    const D = vonDatei.get(kachel);
    if (D) {
      // Am PC ganz in den Arbeitsspeicher (dann geht Verschieben ohne Datei), sonst Stück für Stück
      if (entpacktMax && entpacktPlatz(D.bytes, behalten, entpacktMax)) {
        const f = { ...entpacktStueck(D, 0, D.n), n: D.n, e0: D.e0, n0: D.n0, kopf: D.kopf, groesse: D.groesse, bytes: D.bytes };
        entpackt.set(kachel, f);
        entpacktSumme += f.bytes;
        quellen.push({ kachel, kopf: D.kopf, groesse: D.groesse, felder: f });
      } else quellen.push({ kachel, kopf: D.kopf, groesse: D.groesse, datei: D });
      continue;
    }
    const v = da.find(x => x.kachel === kachel);
    if (v) quellen.push(v);
  }
  if (!quellen.length) throw new Error('Für diese Stelle gibt es keine Laserkachel.');
  // Neu geladene entpacken und merken, soweit der Platz reicht — sonst wie bisher im Durchgang
  if (entpacktMax) {
    // Kacheln aus dem gepackten Vorrat (schon früher geladen) kommen jetzt noch in den Pool
    const auftraege = [];
    for (let t = 0; t < quellen.length; t++) {
      const q = quellen[t];
      if (q.felder || q.datei) continue;
      if (frueh.has(q.kachel)) { auftraege.push({ q, t, e: frueh.get(q.kachel) }); continue; }
      if (!reservieren(q)) continue;
      auftraege.push({ q, t, e: pool ? pool.start(q) : null });
    }
    if (pool) pool.alleGeladen();
    for (let i = 0; i < auftraege.length; i++) {
      const { q, t } = auftraege[i];
      // Ohne Ergebnis des Hilfs-Workers (keiner gestartet, Speicher, Fehler): hier wie bisher
      const e = (auftraege[i].e && await auftraege[i].e) || (abbruch.signal.aborted ? null : await entpacken(LP, q, t, quellen.length));
      if (abbruch.signal.aborted) throw new Error(ABGEBROCHEN);
      entpackt.set(q.kachel, e);
      entpacktSumme += e.bytes;
      q.felder = e;
    }
    vorratMelden();
  }

  /* Wie viele Punkte liegen etwa im Ausschnitt? Danach die Ausdünnung, damit
   * es höchstens rund max werden — gleichmäßig, jeder schritt-te Punkt. Beim
   * Boden allein grob die Hälfte (gezählt wird beim Lesen nur, was passt).
   * Mit Höhengrenze (Limitbox „Dichter laden“) taugt die Schätzung nach Fläche nicht — eine flache
   * Box um ein Dach enthält einen Bruchteil der Säule. Dann von 1 an und beim Lesen anpassen:
   * Sind es mehr als max, fällt jeder zweite behaltene Punkt weg und der Schritt verdoppelt sich
   * (verdichten). Überlappend hat jede Kachel ihren eigenen Schritt (schrittFuer). */
  if (ueberlappen) {
    await kette;                    // was noch nicht geschnitten ist
    pruefen();
    for (let t = 0; t < quellen.length; t++) {
      const q = quellen[t];
      if (geschnitten.has(q.kachel)) continue;
      schritt = schrittFuer(q); schrittAnzeige = Math.max(schrittAnzeige, schritt); drin = 0;
      await schneiden(q, t, quellen.length);
      if (strom) freigeben(q);
    }
  } else {
    const erwartet = quellen.reduce((a, q) => a + erwartetVon(q.kopf), 0);
    schritt = zGrenze ? 1 : Math.max(1, Math.ceil(erwartet / max));
    for (let t = 0; t < quellen.length; t++) await schneiden(quellen[t], t, quellen.length);
  }
  if (!n) throw new Error('Im Ausschnitt liegen keine Laserpunkte.');
  if (verdichtet) {
    // Die Zählung je Klasse stammt noch von vor dem Verdichten
    klassen.clear();
    for (let j = 0; j < n; j++) klassen.set(klasse[j], (klassen.get(klasse[j]) || 0) + 1);
  }
  // Höhen relativ zum tiefsten Punkt — Float32 reicht dann auf den Millimeter
  for (let j = 0; j < n; j++) xyz[3 * j + 2] -= zMin;
  /* Umkreis für die Normalen nach der Dichte: rund ein Dutzend Nachbarn, bei
   * voller Dichte (7–10 Punkte je m²) 0,8 m, ausgedünnt entsprechend mehr. */
  zeiten.lesen = (performance.now() - uhr) / 1000;
  uhr = performance.now();
  const dichte = n / Math.max(1, maske ? maske.flaeche : (e1 - e0) * (n1 - n0));
  const normalen = normalenRechnen(xyz, n, Math.max(0.8, Math.sqrt(12 / (Math.PI * dichte))));
  zeiten.normalen = (performance.now() - uhr) / 1000;
  if (abbruch.signal.aborted) throw new Error(ABGEBROCHEN);     // abgebrochen, während die Normalen liefen
  const fertigGitter = gitter ? gitterFertig(gitter, bereich, maske, zMin, ce, cn) : null;
  const ergebnis = {
    art: 'fertig', anzahl: n, schritt: ueberlappen ? schrittAnzeige : schritt, fehlen, zeiten, gitter: fertigGitter,
    mitte: [ce, cn], zMin, zMax, iMax,
    // Für den Export (Größe vorab): je Kachel Punkte, Format und Größe des LAZ
    kacheln: quellen.map(k => ({ kachel: k.kachel, anzahl: k.kopf.anzahl, format: k.kopf.format, groesse: k.groesse })),
    xyz: xyz.slice(0, n * 3), klasse: klasse.slice(0, n), staerke: staerke.slice(0, n), normalen,
    klassen: [...klassen].sort((a, b) => a[0] - b[0])
  };
  self.postMessage(ergebnis, [ergebnis.xyz.buffer, ergebnis.klasse.buffer, ergebnis.staerke.buffer, normalen.buffer,
    ...(fertigGitter ? [fertigGitter.z.buffer, fertigGitter.art.buffer] : [])]);
  } finally {
    if (pool) pool.ende();
    for (const D of vonDatei.values()) { try { D.h.close(); } catch (err) { /* schon zu */ } }
  }
}

/* ===================== Bodenraster fürs Geländemodell (11.11.2026) =====================
 *
 * Für die Darstellung „Gelände“ in laser.js (ein Mesh statt Punkte, so gewünscht): je Zelle der
 * Mittelwert aller Bodenpunkte (BODEN), gefüllt beim Ausschneiden — also aus allen Punkten, nicht nur
 * aus den nach der Ausdünnung behaltenen. Die Zelle so fein, dass höchstens gitterZellen Zellen
 * entstehen (app.js: Handy 1 Mio., PC 4 Mio.), in den Stufen 0,5 / 1 / 2 / 4 … m.
 * Ergebnis { z (Float32, über zMin, NaN außerhalb des Umrisses), art (0 gemessen, 1 aufgefüllt,
 * 2 außerhalb), nx, ny, zelle, x0, y0 (Südwestecke relativ zur Mitte) }. */
function gitterAnlegen({ e0, n0, e1, n1 }, maxZellen) {
  let zelle = 0.5;
  while (Math.ceil((e1 - e0) / zelle) * Math.ceil((n1 - n0) / zelle) > maxZellen) zelle *= 2;
  const nx = Math.ceil((e1 - e0) / zelle), ny = Math.ceil((n1 - n0) / zelle);
  return { zelle, nx, ny, summe: new Float64Array(nx * ny), zahl: new Uint32Array(nx * ny) };
}

/** Mittelwerte bilden, Lücken füllen (unter Häusern, dichtem Wald, Brücken). Gefüllt über eine
 *  Pyramide: jede Stufe halb so fein, gemittelt aus den belegten Zellen darunter; eine leere Zelle
 *  nimmt den Wert der gröberen Stufe. Danach glätten nur die gefüllten Zellen ihre Kanten. */
function gitterFertig(g, { e0, n0 }, maske, zMin, ce, cn) {
  const { nx, ny, zelle } = g, N = nx * ny;
  const z = new Float32Array(N), art = new Uint8Array(N);
  let belegt = 0;
  for (let c = 0; c < N; c++) {
    const cx = c % nx, cy = (c / nx) | 0;
    if (maske && !inMaske(maske, e0 + (cx + 0.5) * zelle, n0 + (cy + 0.5) * zelle)) { z[c] = NaN; art[c] = 2; continue; }
    if (g.zahl[c]) { z[c] = g.summe[c] / g.zahl[c] - zMin; belegt++; } else { z[c] = NaN; art[c] = 1; }
  }
  g.summe = g.zahl = null;
  if (!belegt) return null;
  // Pyramide nach oben
  const stufen = [{ w: nx, h: ny, v: z }];
  while (stufen[stufen.length - 1].w > 1 || stufen[stufen.length - 1].h > 1) {
    const u = stufen[stufen.length - 1], w = Math.ceil(u.w / 2), h = Math.ceil(u.h / 2), v = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const xx = 2 * x + dx, yy = 2 * y + dy;
        if (xx >= u.w || yy >= u.h) continue;
        const q = u.v[yy * u.w + xx];
        if (q === q) { s += q; a++; }
      }
      v[y * w + x] = a ? s / a : NaN;
    }
    stufen.push({ w, h, v });
  }
  /* Wo im Umkreis von rund 32 m gar kein Bodenpunkt liegt (außerhalb der Kacheln, Wasser ohne
   * Echo), bleibt das Raster leer statt eine erfundene Ebene zu zeigen: ist die Zelle der Stufe,
   * deren Zellen ≥ 32 m messen, leer, gilt die Zelle als außerhalb. */
  const L = Math.min(stufen.length - 1, Math.max(1, Math.ceil(Math.log2(32 / zelle))));
  for (let c = 0; c < N; c++) {
    if (art[c] !== 1) continue;
    const x = c % nx, y = (c / nx) | 0, o = stufen[L];
    const q = o.v[(y >> L) * o.w + (x >> L)];
    if (q !== q) art[c] = 2;
  }
  // … und wieder hinunter: Leeres bilinear aus der gröberen Stufe (nur belegte Nachbarn zählen)
  for (let k = stufen.length - 2; k >= 0; k--) {
    const u = stufen[k], o = stufen[k + 1];
    for (let y = 0; y < u.h; y++) for (let x = 0; x < u.w; x++) {
      const c = y * u.w + x;
      if (u.v[c] === u.v[c] || (k === 0 && art[c] === 2)) continue;
      const fx = (x + 0.5) / 2 - 0.5, fy = (y + 0.5) / 2 - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      let s = 0, gw = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const xx = Math.min(o.w - 1, Math.max(0, x0 + dx)), yy = Math.min(o.h - 1, Math.max(0, y0 + dy));
        const q = o.v[yy * o.w + xx];
        if (q !== q) continue;
        const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) + 1e-6;
        s += q * w; gw += w;
      }
      u.v[c] = gw ? s / gw : o.v[(y >> 1) * o.w + (x >> 1)];
    }
  }
  // Etwas glätten, nur in den gefüllten Zellen
  const offen = [];
  for (let c = 0; c < N; c++) if (art[c] === 1) offen.push(c);
  for (let runde = 0; runde < 6 && offen.length; runde++) {
    for (const c of offen) {
      const x = c % nx, y = (c / nx) | 0;
      let s = 0, a = 0;
      if (x > 0 && art[c - 1] !== 2) { s += z[c - 1]; a++; }
      if (x < nx - 1 && art[c + 1] !== 2) { s += z[c + 1]; a++; }
      if (y > 0 && art[c - nx] !== 2) { s += z[c - nx]; a++; }
      if (y < ny - 1 && art[c + nx] !== 2) { s += z[c + nx]; a++; }
      if (a) z[c] = s / a;
    }
  }
  for (let c = 0; c < N; c++) if (art[c] === 2) z[c] = NaN;
  /* Einzelne leere Zellen zwischen Bodenpunkten sind nur die Punktdichte, keine Lücke: als
   * „aufgefüllt“ (dunkler gezeichnet) zählt erst, was keinen gemessenen Nachbarn hat. */
  const nurDichte = offen.filter(c => {
    const x = c % nx, y = (c / nx) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && art[yy * nx + xx] === 0) return true;
    }
    return false;
  });
  for (const c of nurDichte) art[c] = 0;
  return { z, art, nx, ny, zelle, x0: e0 - ce, y0: n0 - cn };
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
async function lasBauen(LP, da, b, { nurBoden, getrennt, ziel, farbeFuer, maske }) {
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
          if ((i & 0xfffff) === 0) {
            senden({ art: 'schreiben', nr: t, von: da.length, gelesen: i, gesamt });
            await new Promise(r => setTimeout(r));          // Nachrichten (Abbrechen) durchlassen
            if (abbruch.signal.aborted) throw new Error(ABGEBROCHEN);
          }
          if (heap !== LP.HEAPU8) heap = LP.HEAPU8;          // nach dem Warten (siehe entpacken)
          q = punkt;
          const quelle = new DataView(heap.buffer, q, 40);
          const X = quelle.getInt32(0, true), Y = quelle.getInt32(4, true);
          if (X < X0 || X >= X1 || Y < Y0 || Y >= Y1) continue;
          if (maske && !inMaske(maske, X * sx + ox, Y * sy + oy)) continue;
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

async function exportieren({ kacheln, bereich, umriss, einzeln, nurBoden, getrennt, ziel, luftbild, gebaeude, name, zusatz, vorratMax }) {
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
    // Ausschnitt einer Freihand-Auswahl: nur, was im Umriss liegt
    const maske = !einzeln && umriss && umriss.length > 2 ? umrissMaske(umriss, b) : null;
    const ergebnis = await lasBauen(LP, da, b, { nurBoden, getrennt, ziel, farbeFuer, maske });
    if (!ergebnis.some(e => e.blob)) throw new Error(einzeln ? 'In den Kacheln liegen keine passenden Punkte.' : 'Im Ausschnitt liegen keine Laserpunkte.');
    const endung = getrennt ? ['_boden', '_rest'] : [''];
    ergebnis.forEach(({ blob, punkte }, i) => { if (blob) datei(`${name}${zusatz}${endung[i]}.las`, blob, punkte); });
  }
  if (gebaeude && gebaeude.wand.length) datei(`${name}_lod2${zusatz.replace('_rgb', '')}.dxf`, dxfBauen(gebaeude, ziel), 0);
  senden({ art: 'fertig', fehlen });
}

self.onmessage = async ev => {
  if (ev.data.art === 'abbrechen') { if (abbruch) abbruch.abort(); return; }
  if (ev.data.art === 'teilEntpacken') { teilAuftrag = ev.data; return; }       // Hilfs-Worker, siehe entpackPool
  const istExport = ev.data.art === 'export';
  // Eins nach dem anderen: Laden und Export teilen sich den Speicher von laz-perf
  if (abbruch) { if (istExport) self.postMessage({ art: 'fehler', text: 'Es läuft noch ein Auftrag.', export: true }); return; }
  abbruch = new AbortController();
  exportLaeuft = istExport;
  try {
    if (ev.data.art === 'speichern') await speichern(ev.data);
    else if (ev.data.art === 'entpacktSpeichern') await entpacktSpeichern(ev.data);
    else if (ev.data.art === 'teilDaten') await teilEntpacken(ev.data);
    else if (istExport) await exportieren(ev.data);
    else await ausschneiden(ev.data);
  } catch (err) {
    if (abbruch.signal.aborted) senden({ art: 'abgebrochen' });
    else senden({ art: 'fehler', text: String(err && err.message || err) });
  } finally {
    abbruch = null;
    exportLaeuft = false;
  }
};
