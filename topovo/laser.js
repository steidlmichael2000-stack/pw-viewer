/* Topovo — Ansicht der Laserpunkte (3D)
 *
 * Als Modul nachgeladen (app.js, laserZeigen), erst wenn jemand Laserpunkte
 * ansieht: three.js ist rund 1,2 MB. Bedienung angelehnt an den PW-Viewer
 * (Potree): runde Knöpfe in den Ecken — Einstellungen links oben, Schließen
 * rechts oben, Messen links unten, Vollbild rechts unten — und dieselbe
 * Kantenschattierung (Eye-Dome-Lighting), die die Punkte plastisch macht.
 *
 * Koordinaten: x nach Osten, y nach Norden (m, relativ zur Mitte des
 * Ausschnitts), z die Höhe über dem tiefsten Punkt. Die Höhe über NHN ist
 * z + zMin.
 */
import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

/* Punktklassen der BVV (Beschreibung der Punktklassen, Stand September 2023).
 * Farben nach dem Brauch der Laser-Viewer: Boden braun, Bewuchs grün, Gebäude rot. */
const KLASSEN = {
  1: ['Unklassifiziert', '#9aa3ad'],
  2: ['Boden', '#b9824d'],
  6: ['Gebäude', '#e2543e'],
  9: ['Gewässer', '#3d86e0'],
  20: ['Objekte, Bewuchs', '#4fb35a'],
  22: ['Brücke / Kellerabgang', '#a274e3'],
  23: ['Boden, abgeleitet', '#d8ad7c'],
  24: ['Boden aus bDOM', '#cbb08f']
};
const klasseName = k => (KLASSEN[k] || [`Klasse ${k}`])[0];
const klasseFarbe = k => (KLASSEN[k] || [0, '#c8c8c8'])[1];
// Dieselben Töne wie die Höhenfarben auf der Karte (HOEHEN_RAMPE in app.js)
const RAMPE = ['#2c3e94', '#2a7dc4', '#33b2b0', '#7ccc6c', '#e6dd55', '#f19a3c', '#c8382f'];

const zahl = (v, s = 2) => v.toLocaleString('de-DE', { minimumFractionDigits: s, maximumFractionDigits: s });

const PUNKT_VS = `
  attribute vec3 farbe, normale;
  attribute float klasse;
  uniform float groesse, skala, masken[32], licht, ortho, orthoSkala, maxPx;
  uniform vec3 lichtRichtung;
  varying vec3 vFarbe;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Schummerung wie beim Relief: Licht von Nordwesten, 45° hoch
    float hell = 0.25 + 0.95 * max(dot(normalize(normale), lichtRichtung), 0.0);
    vFarbe = min(farbe * mix(1.0, hell, licht), vec3(1.0));
    // Ausgeblendete Klasse: hinter die ferne Ebene, wird nicht gezeichnet
    if (masken[int(klasse) & 31] < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    // Perspektive: kleiner mit der Entfernung; orthografisch: fest je Meter
    // Ganz nah heran nicht zu Scheiben aufblähen: höchstens 24 Bildpunkte (am Handy mal Pixeldichte)
    gl_PointSize = clamp(ortho > 0.5 ? groesse * orthoSkala : groesse * skala / -mv.z, 1.5, maxPx);
  }`;
const PUNKT_FS = `
  varying vec3 vFarbe;
  void main() {
    // Runde Punkte
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    if (dot(p, p) > 1.0) discard;
    gl_FragColor = vec4(vFarbe, 1.0);
  }`;
/* Eye-Dome-Lighting nach Boucheny (2009), wie in Potree: je Bildpunkt die
 * logarithmische Tiefe gegen acht Nachbarn — liegt ein Nachbar näher, wird
 * es dunkler. So treten Kanten hervor, ohne dass die Punkte Normalen brauchen.
 *
 * Gelesen wird mit texelFetch an ganzen Bildpunkten (three.js übersetzt für
 * WebGL2 als GLSL 3.00), nicht über Bildkoordinaten 0…1: Am Handy (Xiaomi
 * 15T Pro, 04.11.2026) lagen bei hoher Stärke Linien fest im Bild, die sich
 * beim Drehen nicht mitbewegten — die Koordinaten waren dort zu ungenau, um
 * bei 2400 Bildpunkten Höhe jeden Nachbarn zu treffen. */
const EDL_FS = `
  precision highp float;
  precision highp int;
  uniform highp sampler2D farbe, tiefe;
  uniform ivec2 groesse;
  uniform float nah, fern, staerke, schwelle, ortho;
  uniform int radius;
  // Lineare Tiefe in m; 0 = kein Punkt
  float tiefeM(ivec2 p) {
    p = clamp(p, ivec2(0), groesse - 1);
    float d = texelFetch(tiefe, p, 0).r;
    if (d >= 1.0) return 0.0;
    // Orthografisch ist die Tiefe schon linear, perspektivisch nicht
    return ortho > 0.5 ? nah + d * (fern - nah) : nah * fern / (fern - d * (fern - nah));
  }
  ivec2 nachbar(int i) {
    return i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : i == 3 ? ivec2(0, -1)
      : i == 4 ? ivec2(1, 1) : i == 5 ? ivec2(-1, 1) : i == 6 ? ivec2(1, -1) : ivec2(-1, -1);
  }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float z = tiefeM(p);
    if (z == 0.0) {
      /* Kleine Löcher zwischen den Punkten füllen: Ist ein leerer Bildpunkt fast
       * ringsum belegt, bekommt er die mittlere Farbe der Nachbarn, leicht
       * abgedunkelt. Sonst schien auf hellem Grund jede Lücke weiß durch. */
      vec3 summe = vec3(0.0);
      int belegt = 0;
      for (int i = 0; i < 8; i++) {
        ivec2 q = clamp(p + nachbar(i), ivec2(0), groesse - 1);
        if (texelFetch(tiefe, q, 0).r < 1.0) { summe += texelFetch(farbe, q, 0).rgb; belegt++; }
      }
      if (belegt < 6) discard;
      gl_FragColor = vec4(summe / float(belegt) * 0.8, 1.0);
      return;
    }
    float l = log2(z), summe = 0.0;
    for (int i = 0; i < 8; i++) {
      float n = tiefeM(p + nachbar(i) * radius);
      // Erst ab schwelle Meter näher dunkelt ein Nachbar ab — Rauschen im Zentimeterbereich bleibt hell
      if (n != 0.0) summe += max(0.0, l - log2(n + schwelle));
    }
    float schatten = exp(-summe / 8.0 * 300.0 * staerke);
    gl_FragColor = vec4(texelFetch(farbe, p, 0).rgb * schatten, 1.0);
  }`;
const EDL_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
/* Gebäude (LoD2): halb durchsichtig über dem fertigen Bild der Punkte. Die
 * Punkte liegen dann schon nur noch als Bild vor — verdeckt wird deshalb von
 * Hand gegen deren Tiefe (dieselbe Kamera, dasselbe Ziel wie EDL_FS). Erst ab
 * 30 cm vor der Fläche verdeckt ein Punkt: Die Dachpunkte liegen auf dem Dach
 * und hätten es sonst zersiebt. */
const GEB_VS = `
  uniform vec3 lichtRichtung;
  uniform float kante;
  varying float vHell;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vHell = kante > 0.5 ? 1.0 : 0.6 + 0.4 * abs(dot(normal, lichtRichtung));
  }`;
const GEB_FS = `
  precision highp float;
  uniform highp sampler2D tiefe;
  uniform float nah, fern, ortho, deckung;
  uniform vec3 farbe;
  varying float vHell;
  float linear(float d) { return ortho > 0.5 ? nah + d * (fern - nah) : nah * fern / (fern - d * (fern - nah)); }
  void main() {
    float t = texelFetch(tiefe, ivec2(gl_FragCoord.xy), 0).r;
    if (t < 1.0 && linear(gl_FragCoord.z) > linear(t) + 0.3) discard;
    gl_FragColor = vec4(farbe * vHell, deckung);
  }`;
/* Streckenachsen der DB InfraGO: der helle Lapis-Ton (wie im Dunkelmodus der
 * App), Ziel der Suche rot wie ein Kartenpin — Orange trägt schon das Messen. */
const ACHS_FARBE = '#55a5e7';
const ZIEL_FARBE = '#ff453a';
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Boden im Sinne der BVV: Boden, Gewässer, abgeleiteter Boden (wie in laser-werk.js)
const BODEN = new Set([2, 9, 23, 24]);

/** Öffnet die Ansicht über der Karte. d: Ergebnis aus laser-werk.js,
 *  info: { kachel, quelle, seite }. Gibt eine Funktion zum Schließen zurück.
 *
 *  Auch der PW-Viewer zeigt damit seine Drohnenwolken (Kopie unter
 *  pw-viewer/topovo/, geholt mit werkzeug/topovo-holen.sh). Dafür ist alles,
 *  was an Topovo hängt, nur da, wenn info es mitbringt: luftbild, gebaeude,
 *  achsen, kml, exportieren, utm (Standort). Dazu kommen von dort titel,
 *  unterzeile, datenName (vor der Quellenangabe) und in d die Punktfarben rgb
 *  (Uint8, sRGB) — dann gibt es die Färbung „Farbe“ und sie ist die erste. */
export function laserAnsicht(d, info, { beimSchliessen } = {}) {
  const wurzel = document.createElement('div');
  wurzel.className = 'laser-ansicht';
  wurzel.innerHTML = `
    <canvas class="lz-flaeche"></canvas>
    <!-- Ab 1010 px wie Topovo: Symbolspalte und Glasleiste links (laser.js, anordnen) -->
    <nav class="lz-schiene" aria-label="Bereiche">
      <button type="button" data-lz="karte" aria-label="Zurück zur Karte"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"/></svg><span>Zurück</span></button>
      <button type="button" data-lz="darstellung"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg><span>Darstellung</span></button>
      <button type="button" data-lz="messen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 16.5 16.5 3.5l4 4-13 13z"/><path d="M7 13l1.8 1.8M10 10l1.8 1.8M13 7l1.8 1.8"/></svg><span>Messen</span></button>
      <button type="button" data-lz="export"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 16v3.5h14V16"/></svg><span>Export</span></button>
      <button type="button" data-lz="heim" class="lz-schiene-heim"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 4.5l8 7"/><path d="M6.5 9.5V19h11V9.5"/></svg><span>Ansicht</span></button>
    </nav>
    <aside class="lz-seite">
      <div class="lz-seite-kopf"><p class="bb-title lz-seite-titel-text"></p><p class="bb-sub lz-seite-unter"></p></div>
      <section data-bereich="darstellung"><h2 class="lz-seite-titel">Darstellung</h2></section>
      <section data-bereich="messen"><h2 class="lz-seite-titel">Messen</h2></section>
      <section data-bereich="export"><h2 class="lz-seite-titel">Export</h2>
        <p class="pal-label">Umfang</p>
        <div class="seg seg-paar" role="group" aria-label="Umfang">
          <button type="button" class="seg-btn is-on" data-ex-umfang="ausschnitt">Ausschnitt</button>
          <button type="button" class="seg-btn" data-ex-umfang="kacheln">Ganze Kacheln</button>
        </div>
        <p class="pal-label">Punkte</p>
        <div class="seg seg-paar" role="group" aria-label="Punkte">
          <button type="button" class="seg-btn is-on" data-ex-boden="0">Alle</button>
          <button type="button" class="seg-btn" data-ex-boden="1">Nur Boden</button>
        </div>
        <p class="pal-label">Farbe</p>
        <div class="seg seg-paar" role="group" aria-label="Farbe">
          <button type="button" class="seg-btn is-on" data-ex-farbe="0">Ohne</button>
          <button type="button" class="seg-btn" data-ex-farbe="1">Luftbild</button>
        </div>
        <p class="pal-label">Koordinaten</p>
        <div class="seg seg-paar" role="group" aria-label="Koordinaten">
          <button type="button" class="seg-btn is-on" data-ex-ziel="utm">UTM32</button>
          <button type="button" class="seg-btn" data-ex-ziel="3">DB_REF GK3</button>
          <button type="button" class="seg-btn" data-ex-ziel="4">DB_REF GK4</button>
        </div>
        <p class="pal-label">Gebäude</p>
        <button type="button" class="seg-btn lz-klasse lz-ex-geb" aria-pressed="false">
          <span class="lz-feld" style="background:#e4e7ec"></span><span class="lz-name">LoD2 als DXF dazu</span><small>aus</small></button>
        <p class="bb-sub lz-ex-umfang"></p>
        <div class="lz-ex-lauf" hidden><div class="laser-lade"><div class="laser-lade-balken"></div></div><p class="bb-note plain lz-ex-stand"></p></div>
        <div class="bb-actions knapp"><button type="button" class="maps lz-ex-los">Herunterladen</button></div>
        <p class="fine lz-ex-hinweis"></p>
      </section>
    </aside>
    <button type="button" class="lz-knopf lz-einst" aria-label="Darstellung" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg>
    </button>
    <button type="button" class="lz-knopf lz-zu" aria-label="Laseransicht schließen">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <button type="button" class="lz-knopf lz-messen" aria-label="Messen" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 16.5 16.5 3.5l4 4-13 13z"/><path d="M7 13l1.8 1.8M10 10l1.8 1.8M13 7l1.8 1.8"/></svg>
    </button>
    <button type="button" class="lz-knopf lz-ort" aria-label="Standort zeigen" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle class="voll" cx="12" cy="12" r="3.4"/><circle cx="12" cy="12" r="7.4" class="ring"/><path d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3"/></svg>
    </button>
    <button type="button" class="lz-knopf lz-heim" aria-label="Ansicht zurücksetzen">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 4.5l8 7"/><path d="M6.5 9.5V19h11V9.5"/></svg>
    </button>
    <div class="lz-tafel" hidden>
      <p class="pal-label">Färbung</p>
      <div class="seg seg-paar lz-faerbung" role="group" aria-label="Färbung">
        <button type="button" class="seg-btn" data-faerbung="rgb">Farbe</button>
        <button type="button" class="seg-btn is-on" data-faerbung="klasse">Klasse</button>
        <button type="button" class="seg-btn" data-faerbung="hoehe">Höhe</button>
        <button type="button" class="seg-btn" data-faerbung="intensitaet">Intensität</button>
        <button type="button" class="seg-btn" data-faerbung="normalen">Normalen</button>
        <button type="button" class="seg-btn" data-faerbung="luftbild">Luftbild</button>
      </div>
      <p class="pal-label lz-klassen-titel">Klassen</p>
      <div class="lz-klassen"></div>
      <p class="pal-label lz-geb-titel">Gebäude</p>
      <button type="button" class="seg-btn lz-klasse lz-geb" aria-pressed="false">
        <span class="lz-feld" style="background:#e4e7ec"></span><span class="lz-name">3D-Gebäudemodell LoD2</span><small></small></button>
      <p class="pal-label lz-aufl-titel">Auflagen</p>
      <div class="lz-klassen lz-aufl">
        <button type="button" class="seg-btn lz-klasse lz-achsen" aria-pressed="false">
          <span class="lz-feld" style="background:${ACHS_FARBE}"></span><span class="lz-name">Streckenachsen</span><small></small></button>
        <button type="button" class="seg-btn lz-klasse lz-kml" aria-pressed="false" hidden>
          <span class="lz-feld" style="background:#ffffff"></span><span class="lz-name">KML</span><small></small></button>
      </div>
      <label class="slider-row">Schatten
        <input type="range" class="lz-licht" min="0" max="100" step="5" value="50">
        <span class="slider-val lz-licht-wert"></span>
      </label>
      <label class="slider-row">Kanten
        <input type="range" class="lz-edl" min="0" max="100" step="5" value="40">
        <span class="slider-val lz-edl-wert"></span>
      </label>
      <label class="slider-row">Punkte
        <input type="range" class="lz-groesse" min="5" max="150" step="5" value="25">
        <span class="slider-val lz-groesse-wert"></span>
      </label>
      <p class="pal-label">Kamera</p>
      <div class="seg seg-paar" role="group" aria-label="Kamera">
        <button type="button" class="seg-btn is-on" data-kamera="perspektive">Perspektive</button>
        <button type="button" class="seg-btn" data-kamera="ortho">Orthografisch</button>
      </div>
      <p class="pal-label">Hintergrund</p>
      <div class="seg seg-paar" role="group" aria-label="Hintergrund">
        <button type="button" class="seg-btn is-on" data-grund="verlauf">Verlauf</button>
        <button type="button" class="seg-btn" data-grund="schwarz">Schwarz</button>
        <button type="button" class="seg-btn" data-grund="weiss">Weiß</button>
      </div>
      <p class="pal-label">Ausschnitt</p>
      <div class="lz-info"></div>
    </div>
    <div class="lz-skala" hidden><div class="hoehen-balken"></div><div class="hoehen-werte"><span></span><span></span><span></span></div></div>
    <div class="lz-mess-menue mess-menue" role="menu" aria-label="Messen" hidden>
      <button type="button" role="menuitem" data-mess="distanz">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18 10 8l5 7 5-9"/><circle class="voll" cx="4" cy="18" r="1.8"/><circle class="voll" cx="10" cy="8" r="1.8"/><circle class="voll" cx="15" cy="15" r="1.8"/><circle class="voll" cx="20" cy="6" r="1.8"/></svg>
        <span><b>Distanz</b><small>Linienzug, Länge je Abschnitt</small></span>
      </button>
      <button type="button" role="menuitem" data-mess="flaeche">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 3 9.5 11.5 4 20.5 9 18 18.5z"/><circle class="voll" cx="5" cy="19" r="1.7"/><circle class="voll" cx="3" cy="9.5" r="1.7"/><circle class="voll" cx="11.5" cy="4" r="1.7"/><circle class="voll" cx="20.5" cy="9" r="1.7"/><circle class="voll" cx="18" cy="18.5" r="1.7"/></svg>
        <span><b>Fläche</b><small>Waagerecht, mit Seitenlängen</small></span>
      </button>
      <button type="button" role="menuitem" data-mess="hoehe">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 4v16M14.5 6.5 17 4l2.5 2.5M14.5 17.5 17 20l2.5-2.5"/><path d="M4 20h9" stroke-dasharray="2 2"/><circle class="voll" cx="17" cy="4" r="1.7"/><circle class="voll" cx="5" cy="20" r="1.7"/></svg>
        <span><b>Höhe</b><small>Höhenunterschied zweier Punkte</small></span>
      </button>
      <button type="button" role="menuitem" class="lz-loeschen" disabled>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>
        <span><b>Messungen löschen</b><small>Alle Linien und Werte weg</small></span>
      </button>
    </div>
    <div class="lz-leiste" hidden>
      <button type="button" class="bb-close lz-mess-ende" aria-label="Messen beenden">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <div class="bb-head"><p class="bb-title lz-mess-titel"></p></div>
      <p class="bb-coord mess-zahl lz-mess-wert"></p>
      <p class="bb-note plain lz-mess-hinweis"></p>
      <div class="bb-actions knapp">
        <button type="button" class="lz-zurueck">Zurück</button>
        <button type="button" class="lz-fertig maps">Fertig</button>
      </div>
    </div>
    <div class="lz-marken"></div>
    <p class="lz-tipp"></p>
    <p class="lz-fuss"></p>`;
  wurzel.dataset.grund = 'verlauf';
  document.body.appendChild(wurzel);
  const $ = s => wurzel.querySelector(s);

  /* Was info nicht mitbringt, gibt es nicht (PW-Viewer: kein Luftbild, keine
   * Gebäude, keine Auflagen, kein Export) — die Knöpfe gar nicht erst zeigen. */
  const weg = sel => wurzel.querySelectorAll(sel).forEach(el => { el.hidden = true; });
  if (!d.rgb) weg('[data-faerbung="rgb"]');
  if (!d.iMax) weg('[data-faerbung="intensitaet"]');
  // Drohnenwolken ohne Klassen (alles Klasse 0): Farbe statt einer einzigen Klassenfarbe
  if (d.rgb && d.klassen.length < 2) weg('[data-faerbung="klasse"], .lz-klassen-titel, .lz-klassen:not(.lz-aufl)');
  if (!info.luftbild) weg('[data-faerbung="luftbild"]');
  if (!info.gebaeude) weg('.lz-geb, .lz-geb-titel');
  if (!info.achsen) weg('.lz-achsen');
  if (!info.achsen && !info.kml) weg('.lz-aufl, .lz-aufl-titel');
  if (!info.exportieren) weg('[data-lz="export"], [data-bereich="export"]');
  if (!info.utm) weg('.lz-ort');
  $('.lz-seite-titel-text').textContent = info.titel || 'Laserpunkte';
  if (info.zurueck) $('[data-lz="karte"]').setAttribute('aria-label', info.zurueck);

  /* ---------- Szene ---------- */
  const flaeche = $('.lz-flaeche');
  const renderer = new THREE.WebGLRenderer({ canvas: flaeche, antialias: false, alpha: true });
  /* Die Kantenschattierung braucht WebGL2 (texelFetch, Float-Tiefe). three.js fiele
   * sonst still auf WebGL1 zurück, und die Ansicht bliebe schwarz. */
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    renderer.forceContextLoss();
    wurzel.remove();
    throw new Error('WebGL2');
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  const szene = new THREE.Scene();
  /* Zwei Kameras wie im PW-Viewer: perspektivisch (Standard) und orthografisch —
   * ohne Fluchtpunkt, maßstäblich wie ein Plan, etwa für eine Böschung von der
   * Seite. `kamera` ist immer die gerade benutzte. */
  const perspektive = new THREE.PerspectiveCamera(55, 1, 0.5, 5000);
  perspektive.up.set(0, 0, 1);
  const orthoKamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  orthoKamera.up.set(0, 0, 1);
  let kamera = perspektive;

  const n = d.anzahl;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(d.xyz, 3));
  const farben = new Float32Array(n * 3);
  geo.setAttribute('farbe', new THREE.BufferAttribute(farben, 3));
  geo.setAttribute('klasse', new THREE.BufferAttribute(Float32Array.from(d.klasse), 1));
  /* Normalen aus laser-werk.js, als Int8 ×127 — normalized liefert −1…1 im Shader.
   * Der PW-Viewer reicht sie nach (info.normalen, ein Promise): bis dahin alle
   * senkrecht, Schatten und „Normalen“ gesperrt (unten bei den Reglern). */
  let normalenDa = d.normalen;
  if (!normalenDa) {
    normalenDa = new Int8Array(n * 3);
    for (let i = 2; i < n * 3; i += 3) normalenDa[i] = 127;
  }
  geo.setAttribute('normale', new THREE.BufferAttribute(normalenDa, 3, true));
  geo.computeBoundingSphere();
  const masken = new Array(32).fill(1);
  const material = new THREE.ShaderMaterial({
    vertexShader: PUNKT_VS, fragmentShader: PUNKT_FS,
    uniforms: { groesse: { value: 0.25 }, skala: { value: 1 }, masken: { value: masken }, licht: { value: 0.5 },
      ortho: { value: 0 }, orthoSkala: { value: 1 }, maxPx: { value: 24 },
      lichtRichtung: { value: new THREE.Vector3(-0.5, 0.5, Math.SQRT1_2) } }
  });
  const wolke = new THREE.Points(geo, material);
  szene.add(wolke);

  // Messlinien und -punkte: in einer eigenen Szene, über allem
  const messSzene = new THREE.Scene();

  // EDL: erst in ein Ziel mit Tiefe, dann über eine Fläche auf den Schirm
  const ziel = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) });
  /* Tiefe als Gleitkommazahl: Am Handy (Xiaomi 15T Pro, 04.11.2026) war die
   * ganzzahlige Tiefe so grob, dass die Kantenschattierung bei hoher Stärke
   * ihre Stufen als Linien über den Boden zog. Dazu der enge Bereich in
   * tiefeAnpassen. */
  ziel.depthTexture.type = THREE.FloatType;
  const edl = new THREE.ShaderMaterial({
    vertexShader: EDL_VS, fragmentShader: EDL_FS, depthTest: false, depthWrite: false, transparent: true,
    uniforms: { farbe: { value: ziel.texture }, tiefe: { value: ziel.depthTexture }, groesse: { value: [1, 1] },
      nah: { value: kamera.near }, fern: { value: kamera.far }, staerke: { value: 0.4 }, radius: { value: 1 }, schwelle: { value: 0.05 }, ortho: { value: 0 } }
  });
  const schirm = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edl);
  const schirmSzene = new THREE.Scene();
  schirmSzene.add(schirm);
  const schirmKamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Gebäude (LoD2), nach den Punkten über das fertige Bild gezeichnet (GEB_FS)
  const gebSzene = new THREE.Scene();
  const gebUniforms = () => ({ tiefe: edl.uniforms.tiefe, nah: edl.uniforms.nah, fern: edl.uniforms.fern,
    ortho: edl.uniforms.ortho, lichtRichtung: material.uniforms.lichtRichtung });
  const gebFlaecheMat = new THREE.ShaderMaterial({ vertexShader: GEB_VS, fragmentShader: GEB_FS, transparent: true,
    side: THREE.DoubleSide, depthWrite: true,
    uniforms: { ...gebUniforms(), kante: { value: 0 }, deckung: { value: 0.5 }, farbe: { value: new THREE.Color(0.86, 0.88, 0.92) } } });
  const gebKanteMat = new THREE.ShaderMaterial({ vertexShader: GEB_VS, fragmentShader: GEB_FS, transparent: true,
    uniforms: { ...gebUniforms(), kante: { value: 1 }, deckung: { value: 0.9 }, farbe: { value: new THREE.Color(1, 1, 1) } } });

  const steuerung = new OrbitControls(kamera, flaeche);
  steuerung.enableDamping = true;
  steuerung.dampingFactor = 0.12;
  steuerung.screenSpacePanning = true;
  steuerung.maxPolarAngle = Math.PI * 0.98;
  /* Schieben: rechte Maustaste, Shift/Strg + linke (kann OrbitControls von
   * Haus aus), zwei Finger, Pfeiltasten. Der Hinweis unten sagt es. */
  steuerung.listenToKeyEvents(window);
  steuerung.keyPanSpeed = 20;

  const halb = info.seite / 2, hoch = d.zMax - d.zMin;
  function heim() {
    /* Im Gebirge ist der Ausschnitt höher als breit (Zugspitze: 900 m auf 200 m),
     * dann zählt die Höhe als Größe und der Blick zielt auf die Mitte */
    const gross = Math.max(halb, hoch * 0.6);
    steuerung.target.set(0, 0, hoch > halb ? hoch / 2 : hoch / 3);
    /* Von Süden, schräg von oben, der ganze Ausschnitt im Bild. Hochkant (Handy)
     * ist das Bild schmaler als hoch: dann weiter weg, sonst fehlen links und rechts. */
    const w = wurzel.clientWidth, h = wurzel.clientHeight;
    const weiter = (w && h ? Math.max(1, 1.1 * h / w) : 1) * gross;
    kamera.position.set(-0.5 * weiter, -2.3 * weiter, steuerung.target.z + 1.7 * weiter);
    if (kamera === orthoKamera) { orthoKamera.zoom = 1; orthoRahmen(); }
    steuerung.update();
  }

  /* Der orthografische Ausschnitt so groß, wie die Perspektive ihn am Zielpunkt
   * zeigte — beim Umschalten springt die Wolke nicht. */
  function orthoRahmen() {
    const w = wurzel.clientWidth, h = wurzel.clientHeight;
    const abstand = orthoKamera.position.distanceTo(steuerung.target);
    const hh = abstand * Math.tan(perspektive.fov * Math.PI / 360);
    orthoKamera.top = hh; orthoKamera.bottom = -hh;
    orthoKamera.left = -hh * w / h; orthoKamera.right = hh * w / h;
    orthoKamera.updateProjectionMatrix();
  }
  function ansichtSetzen(art) {
    const neuK = art === 'ortho' ? orthoKamera : perspektive;
    if (neuK === kamera) return;
    if (neuK === orthoKamera) {
      orthoKamera.position.copy(perspektive.position);
      orthoKamera.quaternion.copy(perspektive.quaternion);
      orthoKamera.zoom = 1;
    } else {
      // Zurück: so weit weg, wie der orthografische Zoom zuletzt zeigte
      const richtung = orthoKamera.position.clone().sub(steuerung.target);
      perspektive.position.copy(steuerung.target).add(richtung.divideScalar(orthoKamera.zoom));
      perspektive.quaternion.copy(orthoKamera.quaternion);
    }
    kamera = neuK;
    steuerung.object = kamera;
    material.uniforms.ortho.value = edl.uniforms.ortho.value = kamera === orthoKamera ? 1 : 0;
    groesseSetzen();
    steuerung.update();
  }
  heim();

  /* ---------- Färbung ---------- */
  let faerbung = d.rgb ? 'rgb' : 'klasse';
  if (d.rgb) wurzel.querySelectorAll('[data-faerbung]').forEach(b => b.classList.toggle('is-on', b.dataset.faerbung === 'rgb'));
  const tmp = new THREE.Color();
  // Intensität: zwischen dem 2. und 98. Prozent strecken, sonst ist fast alles dunkel
  /* Intensität per Histogrammausgleich: Jeder Wert wird zu seinem Rang unter allen
   * Punkten (0…1). Die Werte ballen sich unten, wenige helle Dächer und Markierungen
   * zogen die lineare Streckung (2.–98. Prozent) nach oben — fast alles war dunkel
   * (so bemängelt, 04.11.2026). Tabelle über alle Werte bis iMax (höchstens 65 536). */
  const iRang = new Float32Array((d.iMax || 0) + 1);
  {
    const zaehl = new Uint32Array(iRang.length);
    for (let i = 0; i < n; i++) zaehl[d.staerke[i]]++;
    let summe = 0;
    for (let w = 0; w < zaehl.length; w++) { iRang[w] = (summe + zaehl[w] / 2) / (n || 1); summe += zaehl[w]; }
  }
  const zSort = Float32Array.from({ length: Math.min(n, 200000) }, (_, i) => d.xyz[3 * Math.floor(i * n / Math.min(n, 200000)) + 2]).sort();
  const zLo = zSort[Math.floor(zSort.length * 0.01)] || 0, zHi = zSort[Math.floor(zSort.length * 0.99)] || hoch;
  const rampe = RAMPE.map(f => new THREE.Color(f));
  const klassenFarben = new Map(d.klassen.map(([k]) => [k, new THREE.Color(klasseFarbe(k))]));

  function faerben() {
    for (let i = 0; i < n; i++) {
      let c;
      if (faerbung === 'luftbild' || faerbung === 'rgb') {
        // Unverändert durchgereicht: Bild und Punktfarben sind schon sRGB, die Shader rechnen nicht um
        const q = faerbung === 'rgb' ? d.rgb : luftbild;
        farben[3 * i] = q[3 * i] / 255; farben[3 * i + 1] = q[3 * i + 1] / 255; farben[3 * i + 2] = q[3 * i + 2] / 255;
        continue;
      }
      if (faerbung === 'klasse') c = klassenFarben.get(d.klasse[i]);
      else if (faerbung === 'hoehe') {
        const t = Math.min(1, Math.max(0, (d.xyz[3 * i + 2] - zLo) / (zHi - zLo || 1))) * (rampe.length - 1);
        const j = Math.min(rampe.length - 2, Math.floor(t));
        c = tmp.copy(rampe[j]).lerp(rampe[j + 1], t - j);
      } else if (faerbung === 'normalen') {
        /* Grau, das Licht macht die Form — wie das Schräglicht der BVV. Die
         * Richtung als Farbe (CloudCompare) war fast überall lila: Fast alles
         * zeigt nach oben, und Böschungen gingen darin unter. */
        c = tmp.setRGB(0.82, 0.82, 0.82);
      } else {
        // Etwas Grundhelligkeit, damit die dunkelsten Punkte nicht im Hintergrund verschwinden
        const g = 0.08 + 0.92 * iRang[d.staerke[i]];
        c = tmp.setRGB(g, g, g);
      }
      farben[3 * i] = c.r; farben[3 * i + 1] = c.g; farben[3 * i + 2] = c.b;
    }
    geo.attributes.farbe.needsUpdate = true;
    const skala = $('.lz-skala');
    skala.hidden = faerbung !== 'hoehe';
    if (!skala.hidden) {
      const w = skala.querySelectorAll('span');
      w[0].textContent = zahl(zLo + d.zMin, 1);
      w[1].textContent = zahl((zLo + zHi) / 2 + d.zMin, 1);
      w[2].textContent = zahl(zHi + d.zMin, 1) + ' m';
    }
    neu = true;
  }

  /* ---------- Klassen ein/aus ---------- */
  // Als Knöpfe wie die Auflagen in Topovo: gefüllt = an, das Farbfeld davor wie bei den Parzellen
  $('.lz-klassen').innerHTML = d.klassen.map(([k, anzahl]) => `
    <button type="button" class="seg-btn is-on lz-klasse" data-klasse="${k}" aria-pressed="true">
      <span class="lz-feld" style="background:${klasseFarbe(k)}"></span><span class="lz-name">${klasseName(k)}</span>
      <small>${anzahl.toLocaleString('de-DE')}</small></button>`).join('');
  wurzel.querySelectorAll('[data-klasse]').forEach(b => b.addEventListener('click', () => {
    const an = !b.classList.contains('is-on');
    b.classList.toggle('is-on', an);
    b.setAttribute('aria-pressed', String(an));
    masken[Number(b.dataset.klasse) & 31] = an ? 1 : 0;
    neu = true;
  }));

  /* Kurzer Hinweis über der Fußzeile, wo beim Öffnen die Bedienung steht */
  let hinweisUhr = 0;
  function hinweis(text) {
    const t = $('.lz-tipp');
    t.textContent = text;
    t.classList.remove('weg');
    clearTimeout(hinweisUhr);
    hinweisUhr = setTimeout(() => t.classList.add('weg'), 5000);
  }
  const quellenNeu = () => {
    const was = [info.datenName || 'Laserdaten', luftbild && 'Luftbild', geb && 'Gebäude LoD2'].filter(Boolean);
    $('.lz-fuss').textContent = `${was.join(', ').replace(/, ([^,]*)$/, ' und $1')}: ${info.quelle}` +
      (achsen && achsen.anzahl ? ' · Streckenachsen: DB InfraGO (CC BY 4.0), bearbeitet' : '');
  };

  /* ---------- Färbung nach Luftbild ----------
   * Die Kacheln der BVV haben keine Farbe (Punktformat 1). Das DOP20 der BVV
   * im Ausschnitt geholt (app.js, laserLuftbildUrl), jeder Punkt bekommt den
   * Bildpunkt unter sich. Das DOP ist kein True-Ortho: Hauswände bekommen die
   * Farbe von Dach oder Straße, der Boden unter Bäumen die der Krone. Höchstens
   * 3000 Bildpunkte je Seite (bei 1 km also 33 cm), in Stücken zu 1500. */
  let luftbild = null, luftbildLaeuft = null;
  async function luftbildHolen() {
    const res = Math.max(0.2, info.seite / 3000), px = Math.round(info.seite / res);
    const e0 = d.mitte[0] - halb, n1 = d.mitte[1] + halb, STUECK = 1500;
    const lw = document.createElement('canvas');
    lw.width = lw.height = px;
    const g = lw.getContext('2d', { willReadFrequently: true });
    const teile = [];
    for (let y = 0; y < px; y += STUECK) for (let x = 0; x < px; x += STUECK) {
      const w = Math.min(STUECK, px - x), h = Math.min(STUECK, px - y);
      const url = info.luftbild(e0 + x * res, n1 - (y + h) * res, e0 + (x + w) * res, n1 - y * res, w, h);
      teile.push(fetch(url).then(r => {
        if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) throw new Error(`Luftbild: HTTP ${r.status}`);
        return r.blob();
      }).then(createImageBitmap).then(b => { g.drawImage(b, x, y, w, h); b.close(); }));
    }
    await Promise.all(teile);
    const pix = g.getImageData(0, 0, px, px).data;
    lw.width = lw.height = 0;
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const sp = Math.min(px - 1, Math.max(0, Math.floor((d.xyz[3 * i] + halb) / res)));
      const ze = Math.min(px - 1, Math.max(0, Math.floor((halb - d.xyz[3 * i + 1]) / res)));
      const k = (ze * px + sp) * 4;
      rgb[3 * i] = pix[k]; rgb[3 * i + 1] = pix[k + 1]; rgb[3 * i + 2] = pix[k + 2];
    }
    return rgb;
  }
  function luftbildLaden(knopf) {
    if (!luftbildLaeuft) luftbildLaeuft = (async () => {
      knopf.textContent = 'Luftbild …';
      try {
        luftbild = await luftbildHolen();
        quellenNeu();
        return true;
      } catch (err) {
        console.warn(err);
        hinweis('Das Luftbild ließ sich nicht laden.');
        return false;
      } finally {
        knopf.textContent = 'Luftbild';
        luftbildLaeuft = null;
      }
    })();
    return luftbildLaeuft;
  }

  /* ---------- Standort ----------
   * Lage aus dem GNSS des Geräts, die Höhe aber vom Laserboden darunter: der
   * Median der Bodenpunkte (BODEN) im Umkreis von 1 m. So schwankt der Punkt
   * nicht mit der GNSS-Höhe. Ohne Boden dort (im Haus, unter dichtem Bewuchs)
   * wird interpoliert: eine ausgeglichene Ebene durch die Bodenpunkte rundum,
   * erst wenn sie auf mindestens drei Seiten liegen — der Median im weiteren
   * Umkreis lag am Hang zu hoch oder zu tief, wenn nur eine Seite Punkte hatte.
   * Die Bodenpunkte in einem Raster zu 1 m, beim ersten Gebrauch gebaut. */
  let bodenGitter = null;
  function bodenGitterBauen() {
    const b = Math.ceil(info.seite) + 2, zelle = new Int32Array(n).fill(-1), start = new Int32Array(b * b + 1);
    for (let i = 0; i < n; i++) {
      if (!BODEN.has(d.klasse[i])) continue;
      const cx = Math.min(b - 1, Math.max(0, Math.floor(d.xyz[3 * i] + halb) + 1));
      const cy = Math.min(b - 1, Math.max(0, Math.floor(d.xyz[3 * i + 1] + halb) + 1));
      zelle[i] = cy * b + cx;
      start[zelle[i] + 1]++;
    }
    for (let k = 0; k < b * b; k++) start[k + 1] += start[k];
    const idx = new Int32Array(start[b * b]), voll = start.slice(0, b * b);
    for (let i = 0; i < n; i++) if (zelle[i] >= 0) idx[voll[zelle[i]]++] = i;
    return { b, start, idx };
  }
  /** { z, interpoliert } oder null, wenn im Umkreis von 32 m kein Boden reicht. */
  function bodenHoehe(x, y) {
    if (!bodenGitter) bodenGitter = bodenGitterBauen();
    const { b, start, idx } = bodenGitter;
    for (const r of [1, 2, 4, 8, 16, 32]) {
      const z = [], px = [], py = [];
      const x0 = Math.max(0, Math.floor(x - r + halb) + 1), x1 = Math.min(b - 1, Math.floor(x + r + halb) + 1);
      const y0 = Math.max(0, Math.floor(y - r + halb) + 1), y1 = Math.min(b - 1, Math.floor(y + r + halb) + 1);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const k = cy * b + cx;
        for (let j = start[k]; j < start[k + 1]; j++) {
          const i = idx[j], dx = d.xyz[3 * i] - x, dy = d.xyz[3 * i + 1] - y;
          if (dx * dx + dy * dy <= r * r) { z.push(d.xyz[3 * i + 2]); px.push(dx); py.push(dy); }
        }
      }
      if (r === 1) {
        if (z.length >= 3) { z.sort((a, b) => a - b); return { z: z[z.length >> 1], interpoliert: false }; }
        continue;
      }
      const ebene = ebeneDurch(px, py, z);
      if (ebene != null) return { z: ebene, interpoliert: true };
    }
    return null;
  }
  /** Höhe der ausgeglichenen Ebene z = a + b·x + c·y an der Stelle (0, 0) —
   *  nur, wenn Punkte in mindestens drei der vier Viertel rundum liegen.
   *  Begrenzt auf die Spanne der Punkte: Eine Ebene schießt sonst übers Ziel. */
  function ebeneDurch(px, py, z) {
    const m = z.length;
    if (m < 8) return null;
    const viertel = new Set();
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < m; i++) {
      const xi = px[i], yi = py[i], zi = z[i];
      viertel.add((xi >= 0 ? 1 : 0) + (yi >= 0 ? 2 : 0));
      sx += xi; sy += yi; sxx += xi * xi; syy += yi * yi; sxy += xi * yi; sz += zi; sxz += xi * zi; syz += yi * zi;
      lo = Math.min(lo, zi); hi = Math.max(hi, zi);
    }
    if (viertel.size < 3) return null;
    // Normalgleichungen nach Cramer, gelöst nur nach a
    const det = m * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
    if (Math.abs(det) < 1e-9 * m * m * m) return null;
    const a = (sz * (sxx * syy - sxy * sxy) - sx * (sxz * syy - sxy * syz) + sy * (sxz * sxy - sxx * syz)) / det;
    return Math.min(hi, Math.max(lo, a));
  }

  // Blau wie der Standort auf der Karte (.me-dot), mit weißem Rand; immer obenauf
  const ortGruppe = new THREE.Group();
  ortGruppe.visible = false;
  const ortRandMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  const ortMat = new THREE.MeshBasicMaterial({ color: 0x2f81f7, depthTest: false });
  const ortRand = new THREE.Mesh(kugelGeoOrt(), ortRandMat), ortKern = new THREE.Mesh(ortRand.geometry, ortMat);
  ortRand.renderOrder = 10; ortKern.renderOrder = 11;
  const ortFlaecheGeo = new THREE.CircleGeometry(1, 64);
  const ortFlaecheMat = new THREE.MeshBasicMaterial({ color: 0x2f81f7, transparent: true, opacity: 0.25, depthTest: false, side: THREE.DoubleSide });
  const ortKreis = new THREE.Mesh(ortFlaecheGeo, ortFlaecheMat);
  const ortRingMat = new THREE.LineBasicMaterial({ color: 0x2f81f7, transparent: true, opacity: 0.8, depthTest: false });
  const ortRing = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 64 }, (_, k) => new THREE.Vector3(Math.cos(k / 32 * Math.PI), Math.sin(k / 32 * Math.PI), 0))), ortRingMat);
  ortGruppe.add(ortKreis, ortRing, ortRand, ortKern);
  function kugelGeoOrt() { return new THREE.SphereGeometry(1, 16, 12); }
  messSzene.add(ortGruppe);
  let ortWatch = null, ortStelle = null, ortErst = false, ortDraussen = null, ortSchild = null;
  function ortKnopf(an, busy) {
    const k = $('.lz-ort');
    k.classList.toggle('is-on', an);
    k.classList.toggle('busy', busy);
    k.setAttribute('aria-pressed', String(an));
  }
  function ortAus() {
    if (ortWatch != null) navigator.geolocation.clearWatch(ortWatch);
    ortWatch = null; ortStelle = null; ortDraussen = null;
    ortGruppe.visible = false;
    if (ortSchild) { ortSchild.el.remove(); ortSchild = null; }
    ortKnopf(false, false);
    neu = true;
  }
  /* Blick auf den Standort: Drehpunkt dorthin, die Kamera um dasselbe Stück
   * mit — gleitend in 0,4 s (fahrtSchritt in bild), damit man sieht, wohin es geht. */
  let fahrt = null;
  function aufOrt() {
    fahrt = { dv: ortStelle.clone().sub(steuerung.target), t0: performance.now(), weg: 0 };
    neu = true;
  }
  function fahrtSchritt() {
    if (!fahrt) return;
    const t = Math.min(1, (performance.now() - fahrt.t0) / 400), e = 1 - (1 - t) ** 3;
    const schritt = fahrt.dv.clone().multiplyScalar(e - fahrt.weg);
    fahrt.weg = e;
    steuerung.target.add(schritt);
    kamera.position.add(schritt);
    if (t >= 1) fahrt = null;
    neu = true;
  }
  /* Nachziehen wie auf der Karte: nur wenn der Standort in den Rand (15 %) der
   * freien Fläche oder aus dem Bild läuft — und nicht, solange jemand die Ansicht
   * bewegt oder in den 4 s danach, sonst kämpfte es gegen jedes Drehen. */
  let bedient = false, bedientUhr = 0;
  steuerung.addEventListener('start', () => { bedient = true; clearTimeout(bedientUhr); fahrt = null; });
  steuerung.addEventListener('end', () => { clearTimeout(bedientUhr); bedientUhr = setTimeout(() => { bedient = false; }, 4000); });
  const ortV = new THREE.Vector3();
  function ortAusDemBild() {
    ortV.copy(ortStelle).project(kamera);
    if (ortV.z > 1) return true;            // hinter der Kamera
    const w = wurzel.clientWidth, h = wurzel.clientHeight, links = freiLinks();
    const x = (ortV.x + 1) / 2 * w, y = (1 - ortV.y) / 2 * h;
    const rx = (w - links) * 0.15, ry = h * 0.15;
    return x < links + rx || x > w - rx || y < ry || y > h - ry;
  }
  function ortNeu(pos) {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    const [e, nn] = info.utm(lat, lon);
    const x = e - d.mitte[0], y = nn - d.mitte[1];
    ortKnopf(true, false);
    if (Math.abs(x) > halb || Math.abs(y) > halb) {
      const weg = Math.round(Math.hypot(Math.max(0, Math.abs(x) - halb), Math.max(0, Math.abs(y) - halb)));
      if (ortDraussen !== true) hinweis(`Der Standort liegt ${weg.toLocaleString('de-DE')} m außerhalb des Ausschnitts.`);
      ortDraussen = true;
      ortStelle = null;
      ortGruppe.visible = false;
      if (ortSchild) ortSchild.el.hidden = true;
      neu = true;
      return;
    }
    ortDraussen = false;
    const boden = bodenHoehe(x, y);
    const z = boden ? boden.z : zLo;      // kein Boden im Umkreis von 32 m: auf den unteren Rand der Wolke
    ortStelle = new THREE.Vector3(x, y, z);
    ortGruppe.position.copy(ortStelle);
    const genau = Math.max(1, accuracy || 0);
    ortKreis.scale.setScalar(genau); ortRing.scale.setScalar(genau);
    ortGruppe.visible = true;
    const text = `Standort ±${zahl(genau, 0)} m${boden ? ` · Boden ${nhn(z)}${boden.interpoliert ? ' (interpoliert)' : ''}` : ''}`;
    if (!ortSchild) ortSchild = schild(ortStelle, text, '', 'unten');
    else { ortSchild.p.copy(ortStelle); ortSchild.el.textContent = text; }
    ortSchild.el.hidden = false;
    if (ortErst) { ortErst = false; aufOrt(); }
    else if (!bedient && !fahrt && ortAusDemBild()) aufOrt();
    neu = true;
  }
  function ortUmschalten() {
    if (ortWatch != null) {
      // Wie der Standortknopf der Karte: steht der Standort nicht im Blick, holt ihn der Tipp her
      if (ortStelle && steuerung.target.distanceTo(ortStelle) > 3) { aufOrt(); return; }
      ortAus();
      return;
    }
    if (!navigator.geolocation || !window.isSecureContext) { hinweis('Der Standort geht nur über HTTPS.'); return; }
    ortErst = true;
    ortKnopf(true, true);
    ortWatch = navigator.geolocation.watchPosition(ortNeu, err => {
      if (!ortStelle && ortDraussen == null) { ortAus(); hinweis('Standort nicht verfügbar: ' + (err.message || 'unbekannt')); }
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 25000 });
  }
  $('.lz-ort').addEventListener('click', ortUmschalten);

  /* ---------- Gebäude (LoD2) ----------
   * Aus gebaeude.js über app.js (laserGebaeude), dort samt Vorrat auf dem
   * Gerät. Gelesen sind nur die Dachflächen: Wände entstehen unter jeder
   * Dachkante, die kein zweites Dach teilt, bis HoeheGrund hinunter. Gebäude
   * am Rand des Ausschnitts bleiben ganz. */
  let geb = null, gebLaeuft = false;
  const gebKnopf = $('.lz-geb');
  gebKnopf.querySelector('small').textContent = 'aus';
  /** Dächer und Wände als Dreiecke in UTM32 und NHN: ecken (x, y, z, drei je
   *  Dreieck), wand je Dreieck, kanten als Linienpaare. grundVon(b, top) gibt
   *  die Höhe des Geländes am Gebäude. Für die Ansicht und den Export (DXF). */
  function gebaeudeDreiecke(liste, grundVon) {
    const ecken = [], wand = [], kanten = [];
    const v2 = [];
    for (const b of liste) {
      let top = -Infinity;
      for (const r of b.d) for (const h of r.h) top = Math.max(top, h);
      const gz = grundVon(b, top);
      // Dachkanten zählen: geteilte (gleiche Lage und Höhe) bekommen keine Wand
      const schluessel = (a, c) => { const s1 = a.join(','), s2 = c.join(','); return s1 < s2 ? s1 + '|' + s2 : s2 + '|' + s1; };
      const zahlK = new Map(), ringe = [];
      for (const r of b.d) {
        const p = [];
        for (let i = 0; i < r.h.length; i++) p.push([r.p[2 * i], r.p[2 * i + 1], r.h[i]]);
        if (p.length > 3 && p[0].join() === p[p.length - 1].join()) p.pop();
        if (p.length < 3) continue;
        ringe.push(p);
        for (let i = 0; i < p.length; i++) { const k = schluessel(p[i], p[(i + 1) % p.length]); zahlK.set(k, (zahlK.get(k) || 0) + 1); }
      }
      for (const p of ringe) {
        // In Dreiecke: in die Ebene gelegt, in der das Dach am größten erscheint (Newell)
        let nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < p.length; i++) {
          const a = p[i], c = p[(i + 1) % p.length];
          nx += (a[1] - c[1]) * (a[2] + c[2]); ny += (a[2] - c[2]) * (a[0] + c[0]); nz += (a[0] - c[0]) * (a[1] + c[1]);
        }
        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        const [u, w] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [0, 2];
        v2.length = 0;
        for (const q of p) v2.push(new THREE.Vector2(q[u] - p[0][u], q[w] - p[0][w]));
        for (const t of THREE.ShapeUtils.triangulateShape(v2, [])) { for (const k of t) ecken.push(...p[k]); wand.push(0); }
        for (let i = 0; i < p.length; i++) {
          const a = p[i], c = p[(i + 1) % p.length];
          const k = schluessel(a, c);
          if (zahlK.get(k) > 0) { kanten.push(...a, ...c); }
          if (zahlK.get(k) === 1) {
            const a0 = [a[0], a[1], gz], c0 = [c[0], c[1], gz];
            ecken.push(...a, ...c, ...c0, ...a, ...c0, ...a0);
            wand.push(1, 1);
            kanten.push(...a, ...a0);
          }
          zahlK.set(k, -1);        // jede Kante nur einmal zeichnen
        }
      }
    }
    return { ecken, wand, kanten };
  }
  /** Höhe des Geländes am Gebäude: aus dem LoD2, sonst vom Laserboden (nur im Ausschnitt). */
  function grundVon(b, top) {
    const grund = b.gr ?? (b.h ? top - b.h : null);
    if (grund != null) return grund;
    const x = (b.bb[0] + b.bb[2]) / 2 - d.mitte[0], y = (b.bb[1] + b.bb[3]) / 2 - d.mitte[1];
    const bh = Math.abs(x) <= halb && Math.abs(y) <= halb ? bodenHoehe(x, y) : null;
    return bh ? bh.z + d.zMin : top - 3;
  }
  function gebaeudeBauen(liste) {
    const { ecken, kanten } = gebaeudeDreiecke(liste, grundVon);
    const ox = d.mitte[0], oy = d.mitte[1], oz = d.zMin;
    const relativ = a => { const f = new Float32Array(a.length); for (let i = 0; i < a.length; i += 3) { f[i] = a[i] - ox; f[i + 1] = a[i + 1] - oy; f[i + 2] = a[i + 2] - oz; } return f; };
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(relativ(ecken), 3));
    fg.computeVertexNormals();
    const kg = new THREE.BufferGeometry();
    kg.setAttribute('position', new THREE.BufferAttribute(relativ(kanten), 3));
    const gruppe = new THREE.Group();
    gruppe.add(new THREE.Mesh(fg, gebFlaecheMat), new THREE.LineSegments(kg, gebKanteMat));
    // Nah und Fern (tiefeAnpassen) auch um hinausragende Gebäude
    fg.computeBoundingSphere();
    if (fg.boundingSphere.radius > 0) kugelWolke.union(fg.boundingSphere);
    return { gruppe, anzahl: liste.length };
  }
  function gebZeigen(an) {
    gebKnopf.classList.toggle('is-on', an);
    gebKnopf.setAttribute('aria-pressed', String(an));
    if (geb) geb.gruppe.visible = an;
    gebKnopf.querySelector('small').textContent = !an ? 'aus' : `${geb.anzahl.toLocaleString('de-DE')} Gebäude`;
    neu = true;
  }
  gebKnopf.addEventListener('click', async () => {
    if (geb) { gebZeigen(!geb.gruppe.visible); return; }
    if (gebLaeuft) return;
    gebLaeuft = true;
    gebKnopf.classList.add('laedt');
    gebKnopf.querySelector('small').textContent = 'lädt …';
    try {
      const roh = await info.gebaeude(d.mitte[0] - halb, d.mitte[1] - halb, d.mitte[0] + halb, d.mitte[1] + halb);
      if (!laeuft) return;
      // Nur Gebäude mit der Mitte im Ausschnitt — die übrigen stünden neben der Wolke in der Luft
      const liste = roh.filter(b => Math.abs((b.bb[0] + b.bb[2]) / 2 - d.mitte[0]) <= halb && Math.abs((b.bb[1] + b.bb[3]) / 2 - d.mitte[1]) <= halb);
      geb = gebaeudeBauen(liste);
      gebSzene.add(geb.gruppe);
      quellenNeu();
      gebZeigen(true);
      if (!liste.length) hinweis('Im Ausschnitt steht kein Gebäude des LoD2.');
    } catch (err) {
      console.warn(err);
      gebKnopf.querySelector('small').textContent = 'aus';
      hinweis('Die Gebäude ließen sich nicht laden.');
    } finally {
      gebLaeuft = false;
      gebKnopf.classList.remove('laedt');
    }
  });

  /* ---------- Auflagen: Streckenachsen, KML, gesuchte Stelle ----------
   * Alles kommt zweidimensional aus app.js (laserAchsen, laserKml: UTM32) und
   * wird hier auf den Laserboden gelegt (bodenHoehe), alle SCHRITT Meter ein
   * Stützpunkt, damit die Linie dem Gelände folgt statt durch Dämme und
   * Einschnitte zu schneiden. Wo im Umkreis von 32 m kein Boden ist, setzt
   * die Linie aus. Immer obenauf (ohne Tiefentest): Die Achse soll auch unter
   * Bäumen und Oberleitung zu sehen sein. */
  const auflSzene = new THREE.Scene();
  const SCHRITT = halb > 150 ? 2 : 1;
  const ANHEBEN = 0.05;               // knapp über dem Boden, sonst flimmert sie mit den Bodenpunkten
  const auflKugeln = [];              // bleiben auf dem Schirm gleich groß (bild)
  let achsen = null, kmlAufl = null, zielAufl = null;
  const achsKnopf = $('.lz-achsen'), kmlKnopf = $('.lz-kml');

  /** Linienzug in UTM32 → Stücke auf dem Boden (Vector3, lokal), auf den Ausschnitt beschnitten. */
  function aufBoden(pts) {
    const stuecke = [];
    let lauf = [];
    const setzen = (x, y) => {
      const b = Math.abs(x) <= halb && Math.abs(y) <= halb ? bodenHoehe(x, y) : null;
      if (b) { lauf.push(new THREE.Vector3(x, y, b.z + ANHEBEN)); return; }
      if (lauf.length > 1) stuecke.push(lauf);
      lauf = [];
    };
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i][0] - d.mitte[0], y = pts[i][1] - d.mitte[1];
      if (i === 0) { setzen(x, y); continue; }
      const x0 = pts[i - 1][0] - d.mitte[0], y0 = pts[i - 1][1] - d.mitte[1];
      // Kanten ganz außerhalb überspringen, ohne sie abzutasten
      if (Math.max(x0, x) < -halb || Math.min(x0, x) > halb || Math.max(y0, y) < -halb || Math.min(y0, y) > halb) {
        if (lauf.length > 1) stuecke.push(lauf);
        lauf = [];
        continue;
      }
      const teile = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / SCHRITT));
      for (let k = 1; k <= teile; k++) setzen(x0 + (x - x0) * k / teile, y0 + (y - y0) * k / teile);
    }
    if (lauf.length > 1) stuecke.push(lauf);
    return stuecke;
  }
  function auflLinie(punkte, mat) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(punkte), mat);
    l.renderOrder = 5;
    return l;
  }
  function auflZeigen(a, knopf, an, text) {
    knopf.classList.toggle('is-on', an);
    knopf.setAttribute('aria-pressed', String(an));
    knopf.querySelector('small').textContent = an ? text : 'aus';
    if (a) {
      a.gruppe.visible = an;
      for (const sch of a.schilder) sch.el.hidden = true;     // bild zeigt die sichtbaren wieder
    }
    neu = true;
  }

  /* Streckenachsen: je Strecke eine Nummer am längsten Stück, parallele
   * Strecken im Ausschnitt alle (laserAchsen nimmt jede, die ihn berührt). */
  const achsMat = new THREE.LineBasicMaterial({ color: ACHS_FARBE, depthTest: false });
  async function achsenLaden() {
    if (!info.achsen) return;
    achsKnopf.classList.add('laedt');
    achsKnopf.querySelector('small').textContent = 'lädt …';
    let liste = [];
    try { liste = await info.achsen(d.mitte[0] - halb, d.mitte[1] - halb, d.mitte[0] + halb, d.mitte[1] + halb); }
    catch (err) { console.warn(err); }
    if (!laeuft) return;
    achsKnopf.classList.remove('laedt');
    const gruppe = new THREE.Group(), schilder = [], laengste = new Map();
    for (const a of liste) {
      for (const st of aufBoden(a.pts)) {
        gruppe.add(auflLinie(st, achsMat));
        const l = st.length;
        if (!laengste.has(a.nr) || laengste.get(a.nr).length < l) laengste.set(a.nr, st);
      }
    }
    /* Die Nummer nicht in die Mitte, da steht die gesuchte Stelle: an den
     * Punkt des Stücks, der gut halbwegs zum Rand liegt. */
    for (const [nr, st] of laengste) {
      const p = st.reduce((a, q) => Math.abs(Math.hypot(q.x, q.y) - halb * 0.6) < Math.abs(Math.hypot(a.x, a.y) - halb * 0.6) ? q : a);
      schilder.push(schild(p, `Strecke ${nr}`, 'achse'));
    }
    auflSzene.add(gruppe);
    achsen = { gruppe, schilder, anzahl: laengste.size };
    quellenNeu();
    const text = laengste.size ? `${laengste.size} ${laengste.size === 1 ? 'Strecke' : 'Strecken'}` : 'keine';
    auflZeigen(achsen, achsKnopf, true, text);
    if (!laengste.size) hinweis(liste.length ? 'Unter den Streckenachsen liegen hier keine Bodenpunkte.' : 'Im Ausschnitt liegt keine Streckenachse der DB InfraGO.');
  }
  achsKnopf.addEventListener('click', () => {
    if (!achsen) return;
    const an = !achsen.gruppe.visible;
    auflZeigen(achsen, achsKnopf, an, `${achsen.anzahl} ${achsen.anzahl === 1 ? 'Strecke' : 'Strecken'}`);
  });

  /* KML: Punkte als Kugel in der Farbe der Datei, Linien und Flächenränder auf
   * dem Boden. Namen nur bis KML_NAMEN_MAX — sonst deckt Text die Wolke zu. */
  const KML_NAMEN_MAX = 150;
  const kmlMats = new Map();
  const kmlMat = (farbe, art) => {
    const k = art + farbe;
    if (!kmlMats.has(k)) kmlMats.set(k, art === 'p'
      ? new THREE.MeshBasicMaterial({ color: farbe, depthTest: false })
      : new THREE.LineBasicMaterial({ color: farbe, depthTest: false }));
    return kmlMats.get(k);
  };
  function kmlBauen() {
    const liste = info.kml ? info.kml(d.mitte[0] - halb, d.mitte[1] - halb, d.mitte[0] + halb, d.mitte[1] + halb) : [];
    const gruppe = new THREE.Group(), schilder = [];
    let punkte = 0;
    for (const o of liste) {
      if (o.art === 'p') {
        const x = o.pts[0][0] - d.mitte[0], y = o.pts[0][1] - d.mitte[1];
        if (Math.abs(x) > halb || Math.abs(y) > halb) continue;
        const b = bodenHoehe(x, y);
        const p = new THREE.Vector3(x, y, (b ? b.z : zLo) + ANHEBEN);
        const k = new THREE.Mesh(kugelGeo, kmlMat(o.farbe, 'p'));
        k.position.copy(p);
        k.renderOrder = 6;
        k.userData.faktor = 0.7;
        gruppe.add(k);
        auflKugeln.push(k);
        punkte++;
        if (o.name) schilder.push(schild(p, esc(o.name), 'kml', 'rechts'));
      } else {
        for (const st of aufBoden(o.pts)) gruppe.add(auflLinie(st, kmlMat(o.farbe, 'l')));
      }
    }
    if (schilder.length > KML_NAMEN_MAX) { for (const s of schilder) s.el.remove(); schilder.length = 0; }
    auflSzene.add(gruppe);
    kmlAufl = { gruppe, schilder, anzahl: liste.length, punkte };
    if (!liste.length) return;
    kmlKnopf.hidden = false;
    auflZeigen(kmlAufl, kmlKnopf, true, `${liste.length.toLocaleString('de-DE')}`);
  }
  kmlKnopf.addEventListener('click', () => {
    if (!kmlAufl) return;
    auflZeigen(kmlAufl, kmlKnopf, !kmlAufl.gruppe.visible, `${kmlAufl.anzahl.toLocaleString('de-DE')}`);
  });

  /* Die gesuchte Stelle (Knopf „3D“ am Ergebnis): roter Stab 6 m hoch über dem
   * Boden, Kugel am Fuß, Schild mit dem Kilometer obendrüber. */
  const zielMat = new THREE.MeshBasicMaterial({ color: ZIEL_FARBE, depthTest: false });
  const zielLinieMat = new THREE.LineBasicMaterial({ color: ZIEL_FARBE, depthTest: false });
  function zielBauen() {
    const z = info.ziel;
    if (!z) return;
    const x = z.e - d.mitte[0], y = z.n - d.mitte[1];
    if (Math.abs(x) > halb || Math.abs(y) > halb) return;
    const b = bodenHoehe(x, y);
    const fuss = new THREE.Vector3(x, y, (b ? b.z : zLo) + ANHEBEN), kopf = fuss.clone().setZ(fuss.z + 6);
    const gruppe = new THREE.Group();
    const k = new THREE.Mesh(kugelGeo, zielMat);
    k.position.copy(fuss);
    k.renderOrder = 7;
    k.userData.faktor = 1.6;
    auflKugeln.push(k);
    gruppe.add(k, auflLinie([fuss, kopf], zielLinieMat));
    auflSzene.add(gruppe);
    const text = `<b>${esc(z.text || 'Gesuchte Stelle')}</b>${b ? `<br>Boden ${nhn(fuss.z - ANHEBEN)} m` : ''}`;
    zielAufl = { gruppe, schilder: [schild(kopf, text, 'gross ziel')] };
  }

  /* ---------- Export (nur am Desktop, Spalte „Export“) ----------
   * Gerechnet wird in laser-werk.js aus den Kacheln im Vorrat, mit voller
   * Dichte — nicht aus den ausgedünnten Punkten der Ansicht. Ohne Änderung geht
   * das LAZ der BVV hinaus, sonst LAS (Format 3 bzw. 7 mit Farbe). DB_REF nach
   * Ril 883.9010, Höhen bleiben DHHN2016 (= DB_REF2016). Jede Datei kommt einzeln
   * als Download, sobald sie fertig ist. */
  const ex = { umfang: 'ausschnitt', boden: !!info.nurBoden, farbe: false, ziel: 'utm', geb: false, laeuft: false };
  {
    // Vorwahl des Streifens nach der Lage: Grenze bei 10,5° O, grob aus dem UTM-Rechtswert
    const breite = d.mitte[1] / 111132 * Math.PI / 180;
    const laenge = 9 + (d.mitte[0] - 500000) / (111320 * Math.cos(breite));
    ex.vorschlag = laenge < 10.5 ? '3' : '4';
  }
  const exSek = $('[data-bereich="export"]');
  const exKacheln = d.kacheln || [];
  const MB = b => b >= 1e9 ? `${zahl(b / 1e9, 1)} GB` : `${Math.max(1, Math.round(b / 1e6)).toLocaleString('de-DE')} MB`;
  const ZIEL_NAME = { utm: 'UTM32', 3: 'DB_REF GK3', 4: 'DB_REF GK4' };
  // Anteil der Bodenpunkte, aus der Ansicht geschätzt (war die schon „Nur Boden“, gut die Hälfte)
  const bodenAnteil = info.nurBoden ? 0.55
    : d.klassen.reduce((s, [k, a]) => s + (BODEN.has(k) ? a : 0), 0) / Math.max(1, d.klassen.reduce((s, [, a]) => s + a, 0));
  const exOriginal = () => ex.umfang === 'kacheln' && !ex.boden && !ex.farbe && ex.ziel === 'utm';
  function exUmfangZeigen() {
    const neuFormat = exKacheln.some(k => k.format >= 6);
    const L = ex.farbe || exKacheln.some(k => [2, 3, 5, 7, 8, 10].includes(k.format)) ? (neuFormat ? 36 : 34) : (neuFormat ? 30 : 28);
    let text;
    if (exOriginal()) {
      const g = exKacheln.reduce((s, k) => s + k.groesse, 0);
      text = `${exKacheln.length} × LAZ der BVV, unverändert · ${MB(g)}`;
    } else {
      let punkte = 0;
      if (ex.umfang === 'kacheln') punkte = exKacheln.reduce((s, k) => s + k.anzahl, 0);
      else {
        const b = info.bereich;
        for (const k of exKacheln) {
          const [ke, kn] = k.kachel.split('_').map(Number);
          const ueber = Math.max(0, Math.min(b.e1, ke * 1000 + 1000) - Math.max(b.e0, ke * 1000)) * Math.max(0, Math.min(b.n1, kn * 1000 + 1000) - Math.max(b.n0, kn * 1000));
          punkte += k.anzahl * ueber / 1e6;
        }
      }
      if (ex.boden) punkte *= bodenAnteil;
      text = `LAS${ex.umfang === 'kacheln' && exKacheln.length > 1 ? ` aus ${exKacheln.length} Kacheln` : ''} · etwa ${zahl(punkte / 1e6, 1)} Mio. Punkte · etwa ${MB(punkte * L)}`;
    }
    $('.lz-ex-umfang').textContent = text + (ex.geb ? ' · dazu DXF' : '');
    $('.lz-ex-hinweis').textContent = [
      ex.ziel !== 'utm' && 'DB_REF nach Ril 883.9010 (7 Parameter, Gauß-Krüger 3°). Höhen bleiben DHHN2016 = DB_REF2016.',
      ex.farbe && 'Farbe aus dem DOP20 (20 cm): kein True-Ortho, Wände tragen die Farbe von Dach oder Boden.',
      !exOriginal() && 'LAS ohne Kompression — eine ganze Kachel kann über 1 GB groß werden.'
    ].filter(Boolean).join(' ');
  }
  function exWahlZeigen() {
    exSek.querySelectorAll('[data-ex-umfang]').forEach(b => b.classList.toggle('is-on', b.dataset.exUmfang === ex.umfang));
    exSek.querySelectorAll('[data-ex-boden]').forEach(b => b.classList.toggle('is-on', (b.dataset.exBoden === '1') === ex.boden));
    exSek.querySelectorAll('[data-ex-farbe]').forEach(b => b.classList.toggle('is-on', (b.dataset.exFarbe === '1') === ex.farbe));
    exSek.querySelectorAll('[data-ex-ziel]').forEach(b => b.classList.toggle('is-on', b.dataset.exZiel === ex.ziel));
    const gk = $('.lz-ex-geb');
    gk.classList.toggle('is-on', ex.geb);
    gk.setAttribute('aria-pressed', String(ex.geb));
    gk.querySelector('small').textContent = ex.geb ? 'an' : 'aus';
    exSek.querySelectorAll('.seg-btn').forEach(b => { b.disabled = ex.laeuft; });
    exUmfangZeigen();
  }
  exSek.querySelectorAll('[data-ex-umfang]').forEach(b => b.addEventListener('click', () => { ex.umfang = b.dataset.exUmfang; exWahlZeigen(); }));
  exSek.querySelectorAll('[data-ex-boden]').forEach(b => b.addEventListener('click', () => { ex.boden = b.dataset.exBoden === '1'; exWahlZeigen(); }));
  exSek.querySelectorAll('[data-ex-farbe]').forEach(b => b.addEventListener('click', () => { ex.farbe = b.dataset.exFarbe === '1'; exWahlZeigen(); }));
  exSek.querySelectorAll('[data-ex-ziel]').forEach(b => b.addEventListener('click', () => { ex.ziel = b.dataset.exZiel; exWahlZeigen(); }));
  $('.lz-ex-geb').addEventListener('click', () => { ex.geb = !ex.geb; exWahlZeigen(); });
  // GK-Knöpfe: der zur Lage passende Streifen zuerst genannt ist nicht nötig, aber angedeutet
  exSek.querySelector(`[data-ex-ziel="${ex.vorschlag}"]`).title = 'Passt zur Lage des Ausschnitts';

  /** Die Stücke des DOP20 für eine Fläche, 20 cm je Bildpunkt, in Stücken zu 2500. */
  function luftbildTeile(e0, n0, e1, n1) {
    const res = 0.2, breite = Math.round((e1 - e0) / res), hoehe = Math.round((n1 - n0) / res), STUECK = 2500, teile = [];
    for (let y = 0; y < hoehe; y += STUECK) for (let x = 0; x < breite; x += STUECK) {
      const w = Math.min(STUECK, breite - x), h = Math.min(STUECK, hoehe - y);
      teile.push({ url: info.luftbild(e0 + x * res, n1 - (y + h) * res, e0 + (x + w) * res, n1 - y * res, w, h), x, y, w, h });
    }
    return { e0, n1, res, breite, hoehe, teile };
  }
  const kachelFlaeche = k => { const [e, n] = k.split('_').map(Number); return { e0: e * 1000, n0: n * 1000, e1: e * 1000 + 1000, n1: n * 1000 + 1000 }; };

  function speichern(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Erst später freigeben: Der Browser liest große Dateien noch eine Weile
    setTimeout(() => URL.revokeObjectURL(a.href), 300000);
  }
  function exStand(text, anteil) {
    $('.lz-ex-stand').textContent = text;
    const balken = $('.lz-ex-lauf .laser-lade-balken');
    balken.parentElement.classList.toggle('unbestimmt', anteil == null);
    balken.style.width = anteil == null ? '' : Math.round(anteil * 100) + '%';
  }
  function exLaeuft(an) {
    ex.laeuft = an;
    $('.lz-ex-lauf').hidden = !an;
    const los = $('.lz-ex-los');
    los.textContent = an ? 'Abbrechen' : 'Herunterladen';
    los.classList.toggle('maps', !an);
    exWahlZeigen();
  }
  async function exportStarten() {
    ex.abbrechen = false;
    exLaeuft(true);
    exStand('Vorbereiten …', null);
    const einzeln = ex.umfang === 'kacheln', ziel = ex.ziel === 'utm' ? 'utm' : Number(ex.ziel);
    const b = info.bereich;
    const name = einzeln ? `laser_${info.kacheln.map(k => k.kachel).join('_')}` : `laser_${Math.round(b.e0)}_${Math.round(b.n0)}_${Math.round(b.e1 - b.e0)}m`;
    const zusatz = (ziel === 'utm' ? '_utm32' : `_dbref_gk${ziel}`) + (ex.farbe ? '_rgb' : '') + (ex.boden ? '_boden' : '');
    let luftbild = null;
    if (ex.farbe) luftbild = einzeln ? Object.fromEntries(info.kacheln.map(k => { const f = kachelFlaeche(k.kachel); return [k.kachel, luftbildTeile(f.e0, f.n0, f.e1, f.n1)]; }))
      : luftbildTeile(b.e0, b.n0, b.e1, b.n1);
    let gebaeude = null;
    if (ex.geb) {
      exStand('Gebäude laden …', null);
      try {
        const flaechen = einzeln ? info.kacheln.map(k => kachelFlaeche(k.kachel)) : [b];
        const roh = await info.gebaeude(Math.min(...flaechen.map(f => f.e0)), Math.min(...flaechen.map(f => f.n0)),
          Math.max(...flaechen.map(f => f.e1)), Math.max(...flaechen.map(f => f.n1)));
        // Wie in der Ansicht: nur Gebäude mit der Mitte in der Fläche
        const liste = roh.filter(g => { const x = (g.bb[0] + g.bb[2]) / 2, y = (g.bb[1] + g.bb[3]) / 2;
          return flaechen.some(f => x >= f.e0 && x < f.e1 && y >= f.n0 && y < f.n1); });
        const { ecken, wand } = gebaeudeDreiecke(liste, grundVon);
        gebaeude = { ecken: Float64Array.from(ecken), wand: Uint8Array.from(wand) };
      } catch (err) {
        console.warn(err);
        hinweis('Die Gebäude ließen sich nicht laden — die Punkte kommen trotzdem.');
      }
      if (!laeuft || ex.abbrechen) return exLaeuft(false);
    }
    let dateien = 0;
    info.exportieren({ kacheln: info.kacheln, bereich: b, einzeln, nurBoden: ex.boden, ziel, luftbild, gebaeude, name, zusatz }, m => {
      if (!laeuft) return;
      const von = m.von > 1 ? ` (Kachel ${m.nr + 1} von ${m.von})` : '';
      if (m.art === 'laden') exStand(`Laden${von} … ${MB(m.geladen)}${m.gesamt ? ` von ${MB(m.gesamt)}` : ''}`, m.gesamt ? (m.nr + m.geladen / m.gesamt) / m.von : null);
      else if (m.art === 'warten') exStand(`Verbindung unterbrochen — neuer Versuch in ${m.sekunden} s.`, null);
      else if (m.art === 'luftbild') exStand(`Luftbild laden${von} …`, null);
      else if (m.art === 'schreiben') exStand(`Schreiben${von} …`, (m.nr + m.gelesen / m.gesamt) / m.von);
      else if (m.art === 'datei') { dateien++; speichern(m.name, m.blob); }
      else {
        exLaeuft(false);
        if (m.art === 'fertig') hinweis(`${dateien} ${dateien === 1 ? 'Datei' : 'Dateien'} gespeichert.`);
        else if (m.art === 'fehler') hinweis(m.text);
        else hinweis('Export abgebrochen.');
      }
    });
  }
  $('.lz-ex-los').addEventListener('click', () => {
    if (!ex.laeuft) { exportStarten(); return; }
    ex.abbrechen = true;
    exStand('Abbrechen …', null);
    info.exportAbbrechen();
  });
  exWahlZeigen();

  /* ---------- Bedienung ---------- */
  const tafel = $('.lz-tafel'), einst = $('.lz-einst');
  function tafelZeigen(an) {
    tafel.hidden = !an;
    einst.setAttribute('aria-expanded', String(an));
    einst.classList.toggle('is-on', an);
  }
  einst.addEventListener('click', () => {
    tafelZeigen(tafel.hidden);
    // Am Handy liegen Tafel und Messmenü übereinander: immer nur eins offen
    if (!tafel.hidden) menueZeigen(false);
  });
  let faerbungWahl = faerbung;
  wurzel.querySelectorAll('[data-faerbung]').forEach(b => b.addEventListener('click', async () => {
    faerbungWahl = b.dataset.faerbung;
    // Das Luftbild erst beim ersten Mal holen; bis es da ist, bleibt die alte Färbung stehen
    if (faerbungWahl === 'luftbild' && !luftbild && !(await luftbildLaden(b))) return;
    if (faerbungWahl !== b.dataset.faerbung || !laeuft) return;     // inzwischen anders gewählt oder geschlossen
    faerbung = b.dataset.faerbung;
    // Ohne Licht wäre die Normalenansicht eine graue Fläche
    if (faerbung === 'normalen' && lichtRegler.value < 100) { lichtRegler.value = 100; reglerZeigen(); }
    // Die Intensität ist selbst ein Grauwert — Schatten darüber macht sie nur dunkler
    if (faerbung === 'intensitaet' && lichtRegler.value > 0) { lichtRegler.value = 0; reglerZeigen(); }
    wurzel.querySelectorAll('[data-faerbung]').forEach(x => x.classList.toggle('is-on', x === b));
    faerben();
  }));
  wurzel.querySelectorAll('[data-kamera]').forEach(b => b.addEventListener('click', () => {
    ansichtSetzen(b.dataset.kamera);
    wurzel.querySelectorAll('[data-kamera]').forEach(x => x.classList.toggle('is-on', x === b));
  }));
  wurzel.querySelectorAll('[data-grund]').forEach(b => b.addEventListener('click', () => {
    if (b.closest('.lz-tafel')) {
      wurzel.dataset.grund = b.dataset.grund;
      wurzel.querySelectorAll('.lz-tafel [data-grund]').forEach(x => x.classList.toggle('is-on', x === b));
    }
  }));
  const groesse = $('.lz-groesse'), edlRegler = $('.lz-edl'), lichtRegler = $('.lz-licht');
  /* Punktgröße am Anfang nach dem Abstand der Punkte: so groß, dass sich die
   * Scanreihen berühren — Lücken dazwischen zeichnete die Kantenschattierung
   * sonst ebenfalls als feine Linien. */
  const abstandPunkte = 1 / Math.sqrt(Math.max(0.01, n / (info.seite * info.seite)));
  groesse.value = String(Math.min(150, Math.max(15, Math.round(abstandPunkte * 1.25 * 20) * 5)));
  const reglerZeigen = () => {
    material.uniforms.licht.value = lichtRegler.value / 100;
    $('.lz-licht-wert').textContent = `${lichtRegler.value} %`;
    material.uniforms.groesse.value = groesse.value / 100;
    $('.lz-groesse-wert').textContent = `${zahl(groesse.value / 100, 2)} m`;
    edl.uniforms.staerke.value = edlRegler.value / 100;
    $('.lz-edl-wert').textContent = `${edlRegler.value} %`;
    neu = true;
  };
  groesse.addEventListener('input', reglerZeigen);
  edlRegler.addEventListener('input', reglerZeigen);
  lichtRegler.addEventListener('input', reglerZeigen);
  if (!d.normalen && info.normalen) {
    const normKnopf = $('[data-faerbung="normalen"]'), lichtWert = lichtRegler.value;
    normKnopf.disabled = lichtRegler.disabled = true;
    lichtRegler.value = 0;
    info.normalen.then(a => {
      if (!laeuft || !a) return;
      geo.attributes.normale.array.set(a);
      geo.attributes.normale.needsUpdate = true;
      normKnopf.disabled = lichtRegler.disabled = false;
      lichtRegler.value = lichtWert;
      reglerZeigen();
    }, err => console.warn(err));
  }
  $('.lz-heim').addEventListener('click', heim);

  /* ---------- Antippen: Punkt im Bild suchen ----------
   * Ohne Raycaster über alle Punkte der Szene: die sichtbaren Punkte auf den
   * Schirm rechnen und den nächsten im Umkreis von 10 Bildpunkten nehmen —
   * bei gleicher Nähe den vorderen. Rund 20 ms für eine Million Punkte. */
  const mvp = new THREE.Matrix4();
  function punktAn(cx, cy) {
    const r = flaeche.getBoundingClientRect();
    const x = (cx - r.left) / r.width * 2 - 1, y = -((cy - r.top) / r.height * 2 - 1);
    mvp.multiplyMatrices(kamera.projectionMatrix, kamera.matrixWorldInverse);
    const m = mvp.elements, px = 2 / r.width, py = 2 / r.height, tol = 10;
    let best = -1, bestWert = Infinity;
    for (let i = 0; i < n; i++) {
      if (!masken[d.klasse[i] & 31]) continue;
      const a = d.xyz[3 * i], b = d.xyz[3 * i + 1], c = d.xyz[3 * i + 2];
      const w = m[3] * a + m[7] * b + m[11] * c + m[15];
      if (w <= 0) continue;
      const sx = (m[0] * a + m[4] * b + m[8] * c + m[12]) / w;
      const sy = (m[1] * a + m[5] * b + m[9] * c + m[13]) / w;
      const dx = (sx - x) / px, dy = (sy - y) / py, q = dx * dx + dy * dy;
      if (q > tol * tol) continue;
      const wert = q + w * 0.05;     // bei gleicher Nähe der vordere
      if (wert < bestWert) { bestWert = wert; best = i; }
    }
    return best < 0 ? null : new THREE.Vector3(d.xyz[3 * best], d.xyz[3 * best + 1], d.xyz[3 * best + 2]);
  }

  /* ---------- Messen: Distanz, Fläche, Höhe ----------
   * Wie die Messwerkzeuge von Potree im PW-Viewer: Distanz ist ein Linienzug
   * mit der Länge je Abschnitt und der Summe, Fläche ein geschlossener Zug mit
   * Seitenlängen und waagerechter Fläche, Höhe der Unterschied zweier Punkte —
   * waagerechte Linie oben vom höheren, senkrechte hinunter zum tieferen, Δh daneben. Eine
   * Messung läuft in der Leiste unten (Zurück, Fertig); die Art bleibt an, bis
   * man sie mit × beendet. Linien in der Messfarbe von Topovo (--warn).
   * Gerechnet in UTM32 und NHN: die Punkte stehen relativ zu d.mitte und d.zMin. */
  const MESS = {
    distanz: { titel: 'Distanz', min: 2, hinweis: 'Punkte antippen — Fertig schließt den Linienzug ab.' },
    flaeche: { titel: 'Fläche', min: 3, hinweis: 'Eckpunkte antippen — Fertig oder Tipp auf den ersten Punkt schließt sie.' },
    hoehe: { titel: 'Höhe', min: 2, hinweis: 'Zwei Punkte antippen, etwa Fuß und Krone einer Böschung.' }
  };
  // Immer das helle Messorange der App (--warn im Dunkelmodus): Der Grund ist stets dunkel,
  // das dunklere Orange des hellen Modus ging auf braunem Boden unter
  const messFarbe = () => new THREE.Color('#ff9f0a');
  const kugelGeo = new THREE.SphereGeometry(1, 14, 10);
  const kugelMat = new THREE.MeshBasicMaterial({ color: messFarbe(), depthTest: false });
  const linieMat = new THREE.LineBasicMaterial({ color: messFarbe(), depthTest: false });
  const strichMat = new THREE.LineDashedMaterial({ color: messFarbe(), depthTest: false, dashSize: 0.6, gapSize: 0.4 });
  const kugeln = [];
  const messungen = [];          // { teile: [Object3D], schilder: [{ p, el }] }
  let messArt = null, offen = null, zuletzt = null;   // zuletzt: die eben abgeschlossene, ihr Wert bleibt in der Leiste
  const marken = $('.lz-marken'), leiste = $('.lz-leiste'), menue = $('.lz-mess-menue');
  const loeschen = $('.lz-loeschen');

  const ost = x => (x + d.mitte[0]).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  const nord = y => (y + d.mitte[1]).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  const nhn = z => zahl(z + d.zMin);

  function kugel(p) {
    const k = new THREE.Mesh(kugelGeo, kugelMat);
    k.position.copy(p);
    messSzene.add(k);
    kugeln.push(k);
    return k;
  }
  function linie(punkte, { zu = false, gestrichelt = false } = {}) {
    const g = new THREE.BufferGeometry().setFromPoints(punkte);
    const l = zu ? new THREE.LineLoop(g, linieMat) : new THREE.Line(g, gestrichelt ? strichMat : linieMat);
    if (gestrichelt) l.computeLineDistances();
    messSzene.add(l);
    return l;
  }
  // lage: wohin das Schild vom Punkt aus rückt — darüber, darunter oder rechts daneben
  const LAGE = { oben: 'translate(-50%, -125%)', unten: 'translate(-50%, 35%)', rechts: 'translate(12px, -50%)' };
  function schild(p, html, art = '', lage = 'oben') {
    const el = document.createElement('div');
    el.className = 'lz-marke' + (art ? ' ' + art : '');
    el.innerHTML = html;
    marken.appendChild(el);
    return { p: p.clone(), el, lage: LAGE[lage] };
  }
  function wegNehmen(m) {
    for (const t of m.teile) {
      messSzene.remove(t);
      const i = kugeln.indexOf(t);
      if (i >= 0) kugeln.splice(i, 1);
      if (t.geometry && t.geometry !== kugelGeo) t.geometry.dispose();
    }
    for (const s of m.schilder) s.el.remove();
    m.teile = []; m.schilder = [];
  }

  /** Zeichnet die laufende oder fertige Messung aus ihren Punkten neu. */
  function zeichnen(m) {
    wegNehmen(m);
    const p = m.punkte;
    for (const q of p) m.teile.push(kugel(q));
    let wert = '';
    if (m.art === 'hoehe' && p.length === 2) {
      const [tief, hoch] = p[0].z <= p[1].z ? p : [p[1], p[0]];
      /* Waagerecht oben vom höheren Punkt bis über den tieferen, dort senkrecht
       * hinunter — so steht Δh am tieferen Punkt (so gewünscht, 04.11.2026). */
      const ecke = new THREE.Vector3(tief.x, tief.y, hoch.z);
      const dh = hoch.z - tief.z, waag = Math.hypot(hoch.x - tief.x, hoch.y - tief.y);
      m.teile.push(linie([hoch, ecke], { gestrichelt: true }), linie([ecke, tief]));
      m.schilder.push(schild(ecke.clone().add(tief).multiplyScalar(0.5), `<b>Δh ${zahl(dh)} m</b>`, 'gross', 'rechts'));
      m.schilder.push(schild(hoch, `H ${nhn(hoch.z)}`), schild(tief, `H ${nhn(tief.z)}`, '', 'unten'));
      wert = `Δh ${zahl(dh)} m · waagerecht ${zahl(waag)} m · Neigung ${waag ? zahl(dh / waag * 100, 1) : '–'} %`;
    } else if (p.length === 1) {
      m.schilder.push(schild(p[0], `H ${nhn(p[0].z)}`));
      wert = `H ${nhn(p[0].z)} m · E ${ost(p[0].x)} · N ${nord(p[0].y)}`;
    } else if (p.length > 1) {
      const zu = m.art === 'flaeche' && m.fertig;
      m.teile.push(linie(p, { zu }));
      const seiten = zu ? p.length : p.length - 1;
      let summe = 0;
      for (let i = 0; i < seiten; i++) {
        const a = p[i], b = p[(i + 1) % p.length], l = a.distanceTo(b);
        summe += l;
        m.schilder.push(schild(a.clone().add(b).multiplyScalar(0.5), `${zahl(l)} m`));
      }
      if (m.art === 'flaeche' && p.length >= 3) {
        let f = 0;
        const mitte = new THREE.Vector3();
        p.forEach((a, i) => { const b = p[(i + 1) % p.length]; f += a.x * b.y - b.x * a.y; mitte.add(a); });
        mitte.divideScalar(p.length);
        f = Math.abs(f) / 2;
        if (zu) m.schilder.push(schild(mitte, `<b>${zahl(f)} m²</b>`, 'gross'));
        wert = `${zahl(f)} m² · Umfang ${zahl(summe + (zu ? 0 : p[p.length - 1].distanceTo(p[0])))} m`;
      } else {
        if (seiten > 1) m.schilder.push(schild(p[p.length - 1], `<b>Σ ${zahl(summe)} m</b>`, 'gross'));
        const dh = p[p.length - 1].z - p[0].z;
        wert = `${zahl(summe)} m · Δh Anfang–Ende ${dh >= 0 ? '+' : '−'}${zahl(Math.abs(dh))} m`;
      }
    }
    m.wert = wert;
    neu = true;
  }

  function leisteZeigen() {
    leiste.hidden = !messArt;
    $('.lz-messen').classList.toggle('is-on', !!messArt);
    if (!messArt) return;
    const def = MESS[messArt], n = offen ? offen.punkte.length : 0;
    $('.lz-mess-titel').textContent = def.titel;
    const wert = offen ? offen.wert : zuletzt && zuletzt.art === messArt ? zuletzt.wert : '';
    $('.lz-mess-wert').textContent = wert;
    $('.lz-mess-wert').hidden = !wert;
    $('.lz-mess-hinweis').textContent = def.hinweis;
    $('.lz-zurueck').disabled = !n;
    $('.lz-fertig').disabled = n < def.min || messArt === 'hoehe';
    $('.lz-fertig').hidden = messArt === 'hoehe';
  }

  function abschliessen() {
    if (!offen || offen.punkte.length < MESS[offen.art].min) return;
    offen.fertig = true;
    zeichnen(offen);
    messungen.push(offen);
    zuletzt = offen;
    offen = null;
    loeschen.disabled = false;
    leisteZeigen();
  }
  function messArtSetzen(art) {
    if (offen) { wegNehmen(offen); offen = null; }
    messArt = art;
    menue.querySelectorAll('[data-mess]').forEach(b => b.classList.toggle('is-on', b.dataset.mess === art));
    leisteZeigen();
    neu = true;
  }
  function menueZeigen(an) {
    if (desktop.matches) an = true;          // in der Leiste steht die Wahl immer da
    else if (an) tafelZeigen(false);
    menue.hidden = !an;
    $('.lz-messen').setAttribute('aria-expanded', String(an));
  }
  $('.lz-messen').addEventListener('click', () => menueZeigen(menue.hidden));
  menue.querySelectorAll('[data-mess]').forEach(b => b.addEventListener('click', () => { messArtSetzen(b.dataset.mess); menueZeigen(false); }));
  $('.lz-mess-ende').addEventListener('click', () => messArtSetzen(null));
  $('.lz-fertig').addEventListener('click', abschliessen);
  $('.lz-zurueck').addEventListener('click', () => {
    if (!offen) return;
    offen.punkte.pop();
    if (offen.punkte.length) zeichnen(offen); else { wegNehmen(offen); offen = null; }
    leisteZeigen();
  });
  loeschen.addEventListener('click', () => {
    if (offen) { wegNehmen(offen); offen = null; }
    for (const m of messungen) wegNehmen(m);
    messungen.length = 0;
    zuletzt = null;
    loeschen.disabled = true;
    menueZeigen(false);
    leisteZeigen();
    neu = true;
  });

  function messTipp(p) {
    // Ein Tipp auf einen Messpunkt kommt hier nicht an: den greift das Ziehen (zugEnde)
    if (!offen) offen = { art: messArt, punkte: [], teile: [], schilder: [], fertig: false, wert: '' };
    offen.punkte.push(p);
    zeichnen(offen);
    if (messArt === 'hoehe' && offen.punkte.length === 2) abschliessen();
    leisteZeigen();
  }

  /* Messpunkte verschieben, wie in Potree: einen Punkt greifen (bis 18 Bildpunkte
   * daneben), ziehen — er rastet auf dem Laserpunkt unter dem Finger ein, und die
   * Messung rechnet sich mit. Greift vor OrbitControls (Einfangphase an der
   * Wurzel), damit die Ansicht dabei stillsteht. Gesucht wird höchstens einmal
   * je Bild; das Suchen kostet bei einer Million Punkte rund 20 ms. */
  function messpunktAn(cx, cy) {
    const r = flaeche.getBoundingClientRect();
    let best = null, bestAbstand = 18;
    for (const m of offen ? [...messungen, offen] : messungen) {
      m.punkte.forEach((q, i) => {
        v.copy(q).project(kamera);
        if (v.z >= 1) return;
        const a = Math.hypot((v.x + 1) / 2 * r.width + r.left - cx, (1 - v.y) / 2 * r.height + r.top - cy);
        if (a < bestAbstand) { bestAbstand = a; best = { m, i }; }
      });
    }
    return best;
  }
  let gezogen = null, zugZiel = null, zugBild = 0;
  wurzel.addEventListener('pointerdown', ev => {
    if (ev.target !== flaeche || ev.button > 0) return;
    const treffer = messpunktAn(ev.clientX, ev.clientY);
    if (!treffer) return;
    ev.stopPropagation();
    ev.preventDefault();
    gezogen = { ...treffer, id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    steuerung.enabled = false;
    flaeche.setPointerCapture(ev.pointerId);
    flaeche.classList.add('zieht');
  }, true);
  flaeche.addEventListener('pointermove', ev => {
    if (!gezogen || ev.pointerId !== gezogen.id) return;
    zugZiel = [ev.clientX, ev.clientY];
    if (zugBild) return;
    zugBild = requestAnimationFrame(() => {
      zugBild = 0;
      const p = zugZiel && punktAn(zugZiel[0], zugZiel[1]);
      if (!p || !gezogen) return;
      gezogen.m.punkte[gezogen.i] = p;
      zeichnen(gezogen.m);
      if (gezogen.m !== offen) zuletzt = gezogen.m;      // ihr Wert erscheint in der Leiste
      leisteZeigen();
    });
  });
  const zugEnde = ev => {
    if (!gezogen || ev.pointerId !== gezogen.id) return;
    // Der letzte Zug, falls sein Bild noch aussteht
    if (zugBild) { cancelAnimationFrame(zugBild); zugBild = 0; }
    /* Nicht bewegt: ein Tipp auf den Punkt. Auf dem ersten Punkt einer offenen
     * Fläche schließt er sie — sonst bleibt der Punkt, wo er war. */
    const getippt = Math.hypot(ev.clientX - gezogen.x, ev.clientY - gezogen.y) <= 6;
    const schliessen = getippt && gezogen.m === offen && offen.art === 'flaeche' && gezogen.i === 0 && offen.punkte.length >= 3;
    const p = !getippt && punktAn(ev.clientX, ev.clientY);
    if (p) {
      gezogen.m.punkte[gezogen.i] = p;
      zeichnen(gezogen.m);
      if (gezogen.m !== offen) zuletzt = gezogen.m;
      leisteZeigen();
    }
    gezogen = null;
    steuerung.enabled = true;
    flaeche.classList.remove('zieht');
    runter = null;           // kein Tipp hinterher
    if (schliessen) abschliessen();
  };
  flaeche.addEventListener('pointerup', zugEnde, true);
  flaeche.addEventListener('pointercancel', zugEnde, true);

  /* Tippen, nicht Ziehen: unter 6 Bildpunkten Weg, nur linke Taste bzw. ein Finger.
   * Kam ein zweiter Finger dazu (Zoomen), zählt das Loslassen nicht als Tipp —
   * sonst setzte ein ruhender Finger beim Zoomen einen Messpunkt. */
  let runter = null, letzterTipp = 0;
  const zeiger = new Set();
  flaeche.addEventListener('pointerdown', ev => {
    zeiger.add(ev.pointerId);
    runter = zeiger.size === 1 && ev.button === 0 ? { x: ev.clientX, y: ev.clientY, id: ev.pointerId } : null;
  });
  const fingerWeg = ev => zeiger.delete(ev.pointerId);
  flaeche.addEventListener('pointercancel', fingerWeg);
  flaeche.addEventListener('pointerup', ev => {
    fingerWeg(ev);
    const tipp = runter && runter.id === ev.pointerId && Math.hypot(ev.clientX - runter.x, ev.clientY - runter.y) <= 6;
    runter = null;
    if (!tipp) return;
    const jetzt = Date.now(), doppelt = jetzt - letzterTipp < 320;
    letzterTipp = jetzt;
    const p = punktAn(ev.clientX, ev.clientY);
    if (!p) return;
    if (messArt) messTipp(p);
    // Doppeltipp: um diesen Punkt drehen
    else if (doppelt) { steuerung.target.copy(p); steuerung.update(); neu = true; }
  });

  /* ---------- Desktop: Spalte und Leiste wie in Topovo ----------
   * Ab 1010 px (dieselbe Grenze wie SEITENLEISTE in app.js) wandern Tafel,
   * Messwahl und Messleiste in die Glasleiste links; die runden Knöpfe in den
   * Ecken treten zurück. Ein Tipp aufs gewählte Symbol klappt die Leiste zu.
   * Die Wolke rückt per setViewOffset in die Mitte der freien Fläche. */
  const desktop = window.matchMedia('(min-width: 1010px)');
  const seite = $('.lz-seite'), fussVor = $('.lz-marken');
  let bereich = 'darstellung', seiteZu = false;
  const freiLinks = () => !desktop.matches ? 0 : seiteZu ? 64 : 384;
  function anordnen() {
    if (desktop.matches) {
      seite.querySelector('[data-bereich="darstellung"]').appendChild(tafel);
      const m = seite.querySelector('[data-bereich="messen"]');
      m.appendChild(menue);
      m.appendChild(leiste);
      tafel.hidden = false;
      menue.hidden = false;
    } else {
      for (const el of [tafel, menue, leiste]) wurzel.insertBefore(el, fussVor);
      tafel.hidden = true;
      menue.hidden = true;
      einst.classList.remove('is-on');
    }
    bereichZeigen();
  }
  function bereichZeigen() {
    wurzel.classList.toggle('seite-zu', seiteZu);
    seite.querySelectorAll('[data-bereich]').forEach(sec => { sec.hidden = sec.dataset.bereich !== bereich; });
    wurzel.querySelectorAll('.lz-schiene [data-lz]').forEach(b =>
      b.classList.toggle('is-on', !seiteZu && b.dataset.lz === bereich));
    groesseSetzen();
  }
  wurzel.querySelectorAll('.lz-schiene [data-lz]').forEach(b => b.addEventListener('click', () => {
    const was = b.dataset.lz;
    if (was === 'karte') return schliessen();
    if (was === 'heim') return heim();
    if (was === bereich && !seiteZu) seiteZu = true;
    else { bereich = was; seiteZu = false; }
    bereichZeigen();
  }));
  desktop.addEventListener('change', anordnen);
  $('.lz-seite-unter').textContent = info.unterzeile || `Kachel ${info.kachel} · ${info.seite} × ${info.seite} m`;

  /* ---------- Zeichnen ---------- */
  let neu = true, laeuft = true;
  steuerung.addEventListener('change', () => { neu = true; });
  function groesseSetzen() {
    const w = wurzel.clientWidth, h = wurzel.clientHeight;
    renderer.setSize(w, h, false);
    perspektive.aspect = w / h;
    if (kamera === orthoKamera) orthoRahmen();
    // Die Mitte des Bildes in die Mitte der freien Fläche rechts der Leiste
    const links = freiLinks();
    if (links) kamera.setViewOffset(w, h, -links / 2, 0, w, h);
    else kamera.clearViewOffset();
    kamera.updateProjectionMatrix();
    const pr = renderer.getPixelRatio();
    // Das Ziel genau so groß wie die Zeichenfläche — Bildpunkt für Bildpunkt
    const flaecheGr = renderer.getDrawingBufferSize(new THREE.Vector2());
    ziel.setSize(flaecheGr.x, flaecheGr.y);
    edl.uniforms.groesse.value = [flaecheGr.x, flaecheGr.y];   // ivec2: als Liste, nicht als Vector2
    // Bei hoher Pixeldichte (Handy) die Nachbarn zwei Bildpunkte weit: sonst wirken die Kanten haarfein
    edl.uniforms.radius.value = pr >= 2 ? 2 : 1;
    material.uniforms.skala.value = h * pr / (2 * Math.tan(perspektive.fov * Math.PI / 360));
    material.uniforms.maxPx.value = 24 * pr;
    neu = true;
  }
  const beobachter = new ResizeObserver(groesseSetzen);
  beobachter.observe(wurzel);
  anordnen();

  const v = new THREE.Vector3();
  /* Nah- und Fernebene eng um die Wolke: Die Genauigkeit der Tiefe verteilt
   * sich auf diesen Bereich, und 0,5 m bis 5 km verschenkte fast alles. */
  const kugelWolke = geo.boundingSphere;
  function tiefeAnpassen() {
    const abstand = kamera.position.distanceTo(kugelWolke.center), r = kugelWolke.radius;
    kamera.near = Math.max(0.1, (abstand - r) * 0.9, abstand * 0.002);
    kamera.far = abstand + r * 1.1;
    kamera.updateProjectionMatrix();
    if (kamera === orthoKamera) {
      // Bildpunkte je Meter für die Punktgröße
      const hoehePx = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
      material.uniforms.orthoSkala.value = hoehePx * orthoKamera.zoom / (orthoKamera.top - orthoKamera.bottom);
    }
    edl.uniforms.nah.value = kamera.near;
    edl.uniforms.fern.value = kamera.far;
  }

  function bild() {
    if (!laeuft) return;
    requestAnimationFrame(bild);
    fahrtSchritt();
    steuerung.update();
    if (!neu) return;
    neu = false;
    tiefeAnpassen();
    // Messkugeln bleiben auf dem Schirm gleich groß
    for (const k of [...kugeln, ...auflKugeln]) k.scale.setScalar((k.userData.faktor || 1) * (kamera === orthoKamera
      ? (orthoKamera.top - orthoKamera.bottom) / orthoKamera.zoom * 0.0045
      : kamera.position.distanceTo(k.position) * 0.006));
    if (ortGruppe.visible) {
      const s = kamera === orthoKamera ? (orthoKamera.top - orthoKamera.bottom) / orthoKamera.zoom * 0.007
        : kamera.position.distanceTo(ortGruppe.position) * 0.009;
      ortKern.scale.setScalar(s); ortRand.scale.setScalar(s * 1.4);
    }
    renderer.setRenderTarget(ziel);
    renderer.clear();
    renderer.render(szene, kamera);
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(schirmSzene, schirmKamera);
    renderer.autoClear = false;
    if (geb && geb.gruppe.visible) renderer.render(gebSzene, kamera);
    renderer.render(auflSzene, kamera);
    renderer.render(messSzene, kamera);
    renderer.autoClear = true;
    // Beschriftungen der Messungen an ihre Stelle im Bild
    const r = flaeche.getBoundingClientRect();
    const mitOrt = ortSchild && ortGruppe.visible ? [{ schilder: [ortSchild] }] : [];
    const aufl = [achsen, kmlAufl, zielAufl].filter(a => a && a.gruppe.visible);
    for (const m of [...aufl, ...messungen, ...(offen ? [offen] : []), ...mitOrt]) {
      for (const sch of m.schilder) {
        v.copy(sch.p).project(kamera);
        const sicht = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
        sch.el.hidden = !sicht;
        if (sicht) sch.el.style.transform = `translate(${(v.x + 1) / 2 * r.width}px, ${(1 - v.y) / 2 * r.height}px) ${sch.lage}`;
      }
    }
    /* Bei schmalen Flächen lagen die Seitenlängen unter der Fläche in der Mitte:
     * Ein kleines Schild, das ein großes (Fläche, Σ, Δh, gesuchte Stelle) berührt,
     * tritt zurück — über alle Messungen und Auflagen hinweg. */
    const alle = [...aufl, ...messungen, ...(offen ? [offen] : []), ...mitOrt].flatMap(m => m.schilder).filter(s => !s.el.hidden);
    const gross = alle.filter(s => s.el.classList.contains('gross')).map(s => s.el.getBoundingClientRect());
    if (gross.length) {
      for (const sch of alle) {
        if (sch.el.classList.contains('gross')) continue;
        const k = sch.el.getBoundingClientRect();
        if (gross.some(g => k.left < g.right && k.right > g.left && k.top < g.bottom && k.bottom > g.top)) sch.el.hidden = true;
      }
    }
  }

  /* Unten steht nur die Pflichtangabe (CC BY 4.0). Bedienung, Kachel, Punkte
   * und Zeiten stehen in der Tafel unter „Ausschnitt"; die Bedienung zeigt sich
   * beim Öffnen einige Sekunden über der Fußzeile — alles zusammen waren unten
   * fünf Zeilen (so nicht gewollt, 04.11.2026). */
  const finger = window.matchMedia('(pointer: coarse)').matches;
  const bedienung = finger ? 'Ein Finger drehen · zwei Finger schieben und zoomen · Doppeltipp: Drehpunkt'
    : 'Ziehen: drehen · rechte Taste oder Shift: schieben · Rad: zoomen · Doppelklick: Drehpunkt';
  quellenNeu();
  $('.lz-info').innerHTML = [
    info.kachel ? `Kachel ${info.kachel}` : '',
    `${d.anzahl.toLocaleString('de-DE')} Punkte${d.schritt > 1 ? `, jeder ${d.schritt}.` : ''} · ${info.unterzeile || `${info.seite} × ${info.seite} m`}`,
    d.zeiten ? [d.zeiten.megabyte ? `Laden ${zahl(d.zeiten.laden, 0)} s (${zahl(d.zeiten.megabyte, 0)} MB)` : 'Kacheln aus dem Speicher',
      `Entpacken ${zahl(d.zeiten.lesen, 0)} s`, d.normalen ? `Normalen ${zahl(d.zeiten.normalen, 0)} s` : 'Normalen im Hintergrund'].join(' · ') : '',
    bedienung
  ].filter(Boolean).map(z => `<p class="fine">${z}</p>`).join('');
  const tipp = $('.lz-tipp');
  tipp.textContent = bedienung;
  setTimeout(() => tipp.classList.add('weg'), 6000);
  reglerZeigen();
  faerben();
  zielBauen();
  kmlBauen();
  achsenLaden();
  bild();

  function schliessen() {
    laeuft = false;
    beobachter.disconnect();
    desktop.removeEventListener('change', anordnen);
    steuerung.stopListenToKeyEvents();
    steuerung.dispose();
    for (const m of offen ? [...messungen, offen] : messungen) wegNehmen(m);
    ortAus();
    clearTimeout(hinweisUhr); clearTimeout(bedientUhr);
    ortRand.geometry.dispose(); ortRandMat.dispose(); ortMat.dispose(); ortFlaecheGeo.dispose(); ortFlaecheMat.dispose();
    ortRing.geometry.dispose(); ortRingMat.dispose();
    if (geb) geb.gruppe.children.forEach(c => c.geometry.dispose());
    auflSzene.traverse(o => { if (o.geometry && o.geometry !== kugelGeo) o.geometry.dispose(); });
    achsMat.dispose(); zielMat.dispose(); zielLinieMat.dispose(); kmlMats.forEach(m => m.dispose());
    gebFlaecheMat.dispose(); gebKanteMat.dispose();
    geo.dispose(); material.dispose(); edl.dispose(); ziel.dispose(); schirm.geometry.dispose();
    kugelGeo.dispose(); kugelMat.dispose(); linieMat.dispose(); strichMat.dispose();
    /* dispose() gibt den WebGL-Kontext nicht frei: Browser halten nur rund 16, danach
     * verliert der älteste — womöglich der von MapLibre oder dem Radar. */
    renderer.dispose();
    renderer.forceContextLoss();
    document.removeEventListener('keydown', taste);
    wurzel.remove();
    if (beimSchliessen) beimSchliessen();
  }
  const taste = ev => { if (ev.key === 'Escape') schliessen(); };
  document.addEventListener('keydown', taste);
  $('.lz-zu').addEventListener('click', schliessen);
  return schliessen;
}
