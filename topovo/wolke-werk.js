/* PW-Viewer — eine ganze Punktwolke (LAZ) laden und entpacken
 *
 * Gehört dem PW-Viewer, nicht Topovo: werkzeug/topovo-holen.sh überschreibt
 * diese Datei nicht. Sie liegt nur hier im Ordner, damit laser-werk.js und
 * laz-perf ihre Pfade (vendor/copc/…) relativ zu diesem Worker finden.
 *
 * Aus laser-werk.js (Topovo) kommen Laden mit Wiederholung (kachelnHolen),
 * der LAS-Kopf, die Normalen und die Meldungen; dessen onmessage wird unten
 * ersetzt. Anders als in Topovo gibt es keinen Ausschnitt: Die Datei wird
 * ganz gelesen, höchstens auf max Punkte gleichmäßig ausgedünnt, und dazu
 * kommen die Punktfarben (Drohnenwolken aus WebODM: Format 2 oder 3, RGB
 * 16 Bit).
 *
 * Auftrag { url, max } → Meldungen wie laser-werk.js ('laden', 'lesen',
 * 'normalen', 'warten', 'fertig', 'fehler', 'abgebrochen'); 'fertig' trägt
 * zusätzlich rgb (Uint8, sRGB) und breite/tiefe (m).
 */
importScripts('laser-werk.js');

// Wo im Punkt die Farbe steht, je Punktformat (LAS 1.4, Tabelle 7 ff.)
const RGB_AB = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

async function wolkeLesen({ url, max }) {
  if (!lazPerf) lazPerf = await Copc.Las.PointData.createLazPerf({ locateFile: f => 'vendor/copc/' + f });
  const LP = lazPerf;
  const zeiten = { laden: 0, megabyte: 0, lesen: 0, normalen: 0 };
  let uhr = performance.now();
  const { da } = await kachelnHolen(LP, [{ kachel: 'wolke', url }], 4e9);
  const { zeiger, groesse, kopf: k } = da[0];
  zeiten.megabyte = groesse / 1e6;
  zeiten.laden = (performance.now() - uhr) / 1000;
  uhr = performance.now();

  const anzahl = k.anzahl, schritt = Math.max(1, Math.ceil(anzahl / max));
  const platz = Math.ceil(anzahl / schritt) + 1;
  const xyz = new Float32Array(platz * 3), klasse = new Uint8Array(platz), staerke = new Uint16Array(platz);
  const rgbAb = RGB_AB[k.format];
  const rgb16 = rgbAb ? new Uint16Array(platz * 3) : null;
  const ce = (k.min[0] + k.max[0]) / 2, cn = (k.min[1] + k.max[1]) / 2;
  const [sx, sy, sz] = k.skala, [ox, oy, oz] = k.versatz;
  const klassen = new Map();
  let n = 0, zMin = Infinity, zMax = -Infinity, iMax = 0, farbeMax = 0;
  const punkt = LP._malloc(64);
  const laszip = new LP.LASZip();
  try {
    laszip.open(zeiger, groesse);
    let puffer = null, d = null;
    for (let i = 0; i < anzahl; i++) {
      laszip.getPoint(punkt);
      if ((i & 0xfffff) === 0) {
        senden({ art: 'lesen', nr: 0, von: 1, gelesen: i, gesamt: anzahl });
        await new Promise(r => setTimeout(r));          // Abbrechen durchlassen
        if (abbruch.signal.aborted) throw new Error(ABGEBROCHEN);
      }
      if (i % schritt) continue;
      if (puffer !== LP.HEAPU8.buffer) { puffer = LP.HEAPU8.buffer; d = new DataView(puffer, punkt, k.laenge); }
      const z = d.getInt32(8, true) * sz + oz;
      xyz[3 * n] = d.getInt32(0, true) * sx + ox - ce;
      xyz[3 * n + 1] = d.getInt32(4, true) * sy + oy - cn;
      xyz[3 * n + 2] = z;
      const kl = k.format >= 6 ? d.getUint8(16) : d.getUint8(15) & 31;
      klasse[n] = kl;
      klassen.set(kl, (klassen.get(kl) || 0) + 1);
      staerke[n] = d.getUint16(12, true);
      if (staerke[n] > iMax) iMax = staerke[n];
      if (rgb16) for (let c = 0; c < 3; c++) {
        const w = d.getUint16(rgbAb + 2 * c, true);
        rgb16[3 * n + c] = w;
        if (w > farbeMax) farbeMax = w;
      }
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
      n++;
    }
  } finally {
    laszip.delete();
    LP._free(punkt);
    // Die Datei wird nicht noch einmal gebraucht
    LP._free(zeiger);
    vorrat.delete('wolke');
  }
  if (!n) throw new Error('In der Datei liegen keine Punkte.');
  for (let j = 0; j < n; j++) xyz[3 * j + 2] -= zMin;
  /* Farben: LAS speichert 16 Bit, viele Programme schreiben trotzdem 0…255.
   * Liegt alles unter 256, unverändert, sonst das obere Byte. */
  let rgb = null;
  if (rgb16 && farbeMax > 0) {
    rgb = new Uint8Array(n * 3);
    const shift = farbeMax > 255 ? 8 : 0;
    for (let j = 0; j < n * 3; j++) rgb[j] = rgb16[j] >> shift;
  }
  zeiten.lesen = (performance.now() - uhr) / 1000;
  /* Erst die Wolke zeigen, dann die Normalen nachreichen: Die brauchen bei
   * Millionen Punkten ein Vielfaches des Entpackens (Schrebergärten 15 s gegen
   * 4 s). xyz geht deshalb als Kopie hinaus — der Worker rechnet damit weiter. */
  const breite = k.max[0] - k.min[0], tiefe = k.max[1] - k.min[1];
  const ergebnis = {
    art: 'fertig', anzahl: n, schritt, fehlen: [], zeiten, breite, tiefe,
    mitte: [ce, cn], zMin, zMax, iMax,
    xyz: xyz.slice(0, n * 3), klasse: klasse.slice(0, n), staerke: staerke.slice(0, n), normalen: null, rgb,
    klassen: [...klassen].sort((a, b) => a[0] - b[0])
  };
  const weiter = [ergebnis.xyz.buffer, ergebnis.klasse.buffer, ergebnis.staerke.buffer];
  if (rgb) weiter.push(rgb.buffer);
  self.postMessage(ergebnis, weiter);
  uhr = performance.now();
  /* Umkreis für die Normalen nach der Dichte: rund ein Dutzend Nachbarn. Drohnen-
   * wolken sind viel dichter als die Laserdaten der BVV (Tausende Punkte je m²),
   * die 0,8 m aus Topovo wären hier viel zu weit. Die Rechenzeit wächst mit der
   * Zahl der Nachbarn: Schrebergärten (6,8 Mio., 4700 je m²) brauchten mit 5 cm
   * Untergrenze 16 s, nach der Dichte (rund 3 cm) deutlich weniger. */
  const dichte = n / Math.max(1, breite * tiefe);
  const normalen = normalenRechnen(xyz, n, Math.max(0.015, Math.sqrt(12 / (Math.PI * dichte))));
  self.postMessage({ art: 'normalenFertig', normalen, sekunden: (performance.now() - uhr) / 1000 }, [normalen.buffer]);
}

self.onmessage = async ev => {
  if (ev.data.art === 'abbrechen') { if (abbruch) abbruch.abort(); return; }
  if (abbruch) return;
  abbruch = new AbortController();
  try {
    await wolkeLesen(ev.data);
  } catch (err) {
    if (abbruch.signal.aborted) senden({ art: 'abgebrochen' });
    else senden({ art: 'fehler', text: String(err && err.message || err) });
  } finally {
    abbruch = null;
  }
};
