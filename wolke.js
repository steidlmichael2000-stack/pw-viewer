/* PW-Viewer — Punktwolke im 3D-Viewer aus Topovo
 *
 * wolke.html?p=<name> lädt <R2>/<name>/cloud.laz ganz in den Speicher
 * (topovo/wolke-werk.js) und zeigt sie mit laserAnsicht aus topovo/laser.js —
 * demselben Viewer wie die Laserpunkte in Topovo. Kein Nachladen beim
 * Zoomen wie bei Potree: einmal geladen, ist alles da.
 *
 * Am Handy wird beim Laden auf MAX_FINGER Punkte ausgedünnt (Arbeitsspeicher;
 * Topovo nimmt dort 2 Mio.), am Rechner bis MAX_MAUS.
 *
 * Lokal (localhost) wird zuerst daten-lokal/<name>/cloud.laz gefragt — dort
 * liegen Wolken zum Ansehen vor dem Hochladen (nicht im Repo).
 */
const R2_BASE = 'https://pwviewer-daten.steidl-michael2000.workers.dev';
const MAX_FINGER = 3e6, MAX_MAUS = 25e6;

const $ = s => document.querySelector(s);
const roh = new URLSearchParams(location.search).get('p') || '';
const name = /^[a-z0-9_-]+$/.test(roh) ? roh : '';
const finger = matchMedia('(pointer: coarse)').matches;
const zahl = (v, s = 0) => v.toLocaleString('de-DE', { minimumFractionDigits: s, maximumFractionDigits: s });

let werk = null;
// Die Normalen kommen nach der Wolke (topovo/wolke-werk.js), der Viewer schaltet sie dann zu
let normalenFertig;
const normalenVersprochen = new Promise(r => { normalenFertig = r; });

function stand(text, anteil) {
  $('.wl-stand').textContent = text;
  const lade = $('.laser-lade');
  lade.classList.toggle('unbestimmt', anteil == null);
  $('.laser-lade-balken').style.width = anteil == null ? '' : `${Math.round(anteil * 100)}%`;
}
function fehler(text) {
  stand(text, 0);
  $('.laser-lade').hidden = true;
  $('.wl-abbrechen').hidden = true;
  $('.wl-zurueck').hidden = false;
  if (werk) { werk.terminate(); werk = null; }
}

/** WGS84 → UTM Zone 32 (ETRS89), Rechtswert/Hochwert in m. Krüger-Reihe, mm-genau. */
function utm32(lat, lon) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, n = f / (2 - f);
  const A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
  const phi = lat * Math.PI / 180, dl = (lon - 9) * Math.PI / 180;
  const e = 2 * Math.sqrt(n) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  for (let j = 1; j <= 3; j++) {
    x += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    y += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [500000 + k0 * A * x, k0 * A * y];
}

const lokal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/** Eintrag aus pointclouds.json; lokal vorbereitete Projekte (Manager) stehen erst in daten-lokal/<name>/eintrag.json */
async function eintragHolen() {
  const holen = async (pfad, liste) => {
    try {
      const r = await fetch(pfad, { cache: 'no-cache' });
      const j = r.ok ? await r.json() : null;
      return liste ? (j && j.pointclouds || []).find(x => x.name === name) || null : j;
    } catch { return null; }
  };
  return (lokal && await holen(`daten-lokal/${name}/eintrag.json`)) || holen('pointclouds.json', true);
}

/** Lokal erst daten-lokal/, sonst R2 */
async function adresse() {
  if (lokal) {
    const lokal = `daten-lokal/${name}/cloud.laz`;
    try { if ((await fetch(lokal, { method: 'HEAD', cache: 'no-store' })).ok) return lokal; } catch { /* weiter zu R2 */ }
  }
  return `${R2_BASE}/${name}/cloud.laz`;
}

async function start() {
  if (!name) { fehler('Kein Projekt angegeben.'); return; }
  const eintrag = await eintragHolen();
  const titel = eintrag ? eintrag.title : name;
  document.title = titel;
  $('.wl-titel').textContent = titel;
  stand('Punktwolke wird geladen …', null);

  // laser-werk.js sucht seine Teile relativ zu sich — deshalb liegt der Worker in topovo/
  werk = new Worker('topovo/wolke-werk.js');
  const url = new URL(await adresse(), location.href).href;
  $('.wl-abbrechen').addEventListener('click', () => {
    if (werk) werk.postMessage({ art: 'abbrechen' });
    location.href = './';
  });
  werk.onmessage = async ev => {
    const m = ev.data;
    if (m.art === 'laden') {
      stand(m.gesamt ? `Laden ${zahl(m.geladen / 1e6)} von ${zahl(m.gesamt / 1e6)} MB` : `Laden ${zahl(m.geladen / 1e6)} MB`,
        m.gesamt ? m.geladen / m.gesamt : null);
    } else if (m.art === 'warten') {
      stand(`Verbindung unterbrochen — neuer Versuch in ${m.sekunden} s`, null);
    } else if (m.art === 'lesen') {
      stand(`Entpacken ${zahl(m.gelesen / 1e6, 1)} von ${zahl(m.gesamt / 1e6, 1)} Mio. Punkten`, m.gelesen / m.gesamt);
    } else if (m.art === 'normalen') {
      // Läuft nach dem Öffnen im Hintergrund weiter, der Ladeschirm ist dann weg
    } else if (m.art === 'normalenFertig') {
      normalenFertig(m.normalen);
      werk.terminate();
      werk = null;
    } else if (m.art === 'fehler' && $('.wl-laden').hidden) {
      // Fehler bei den Normalen: die Wolke steht, nur ohne Schattierung
      console.warn(m.text);
      normalenFertig(null);
    } else if (m.art === 'fehler') {
      fehler(/keine Laserkachel|HTTP 404/.test(m.text) ? 'Für dieses Projekt liegt keine Punktwolke vor.' : m.text);
    } else if (m.art === 'fertig') {
      stand('3D-Ansicht wird geöffnet …', 1);
      try {
        const { laserAnsicht } = await import('./topovo/laser.js');
        $('.wl-laden').hidden = true;
        const seite = Math.ceil(Math.max(m.breite, m.tiefe));
        laserAnsicht(m, {
          titel,
          unterzeile: `${zahl(m.breite)} × ${zahl(m.tiefe)} m`,
          quelle: eintrag && eintrag.description || 'Photogrammetrie aus Drohnenaufnahmen',
          datenName: 'Punktwolke',
          seite,
          utm: utm32,
          normalen: normalenVersprochen,
          zurueck: 'Zurück zur Übersicht'
        }, { beimSchliessen: () => { location.href = './'; } });
      } catch (err) {
        console.warn(err);
        $('.wl-laden').hidden = false;
        fehler(err && err.message === 'WebGL2' ? 'Dieses Gerät kann die 3D-Ansicht nicht zeigen (kein WebGL2).'
          : '3D-Ansicht ließ sich nicht öffnen.');
      }
    }
  };
  werk.onerror = ev => { console.warn(ev); fehler('Der Ladevorgang ist abgestürzt — vermutlich zu wenig Arbeitsspeicher.'); };
  werk.postMessage({ url, max: finger ? MAX_FINGER : MAX_MAUS });
}

start();
