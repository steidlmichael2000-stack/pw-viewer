/* PW-Viewer — Torwaechter vor dem R2-Bucket (Cloudflare Worker)

   WARUM
   -----
   Ueber die oeffentliche r2.dev-Adresse kann jeder beliebig viele Abfragen
   auf den Bucket schicken, und R2 rechnet jeden Lesezugriff ab (frei sind
   rund 10 Mio. im Monat, danach kostet es). Eine harte Kostengrenze bietet
   R2 nicht.

   Dieser Worker liest den Bucket ueber eine Bindung und ist danach der
   EINZIGE Weg hinein. Die Grenze setzt der kostenlose Workers-Plan selbst:
   100.000 Abfragen am Tag fuer das ganze Konto, darueber antwortet Cloudflare
   mit Fehler 1027 statt einer Rechnung. 100.000 × 31 Tage = 3,1 Mio.
   Lesezugriffe — das bleibt immer unter dem Freikontingent von R2.

   Das gilt nur, solange
     - das Konto auf dem kostenlosen Workers-Plan bleibt (nicht „Paid"),
     - die r2.dev-Adresse des Buckets abgeschaltet ist,
     - am Bucket keine eigene Domain haengt.

   WAS DURCHGEHT
   -------------
   Nur GET und HEAD auf feste Dateinamen je Projekt, Projektnamen nur aus
   a-z, 0-9, _ und -. Kein Auflisten, kein Schreiben.

     GET /geckenheim/metadata.json      Potree 2: Kopfdaten
     GET /geckenheim/hierarchy.bin      Potree 2: Baumstruktur (Bytebereiche)
     GET /geckenheim/octree.bin         Potree 2: Punkte (Bytebereiche)
     GET /geckenheim/model.glb          3D-Modell fuer model.html
     GET /geckenheim/thumb.jpg          Vorschaubild, auch fuer og:image

   Fremde Seiten bekommen nichts. Ohne Origin-Kopf (CSS-Hintergrundbild,
   Vorschau in Messengern, Adressfeld) kommt die Datei trotzdem — die
   Kostengrenze haengt am Plan, nicht an dieser Pruefung.

   EINRICHTEN
   ----------
   Siehe README.md in diesem Ordner. Lokal pruefen:
     node werkzeug/r2-proxy/test.mjs
   ═══════════════════════════════════════════════════════════════════════ */

const PFAD = /^\/([a-z0-9_-]{1,100})\/(metadata\.json|hierarchy\.bin|octree\.bin|model\.glb|thumb\.jpg)$/;
const BEREICH = /^bytes=(\d+)-(\d*)$|^bytes=-(\d+)$/;

const HERKUNFT = ['https://steidlmichael2000-stack.github.io'];
const LOKAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const TYP = {
  json: 'application/json',
  bin: 'application/octet-stream',
  glb: 'model/gltf-binary',
  jpg: 'image/jpeg'
};

export default {
  async fetch(request, env) {
    const herkunft = request.headers.get('Origin');
    if (herkunft && !HERKUNFT.includes(herkunft) && !LOKAL.test(herkunft)) {
      return new Response('Herkunft nicht freigegeben', { status: 403 });
    }
    const cors = herkunft ? {
      'Access-Control-Allow-Origin': herkunft,
      // Content-Range braucht Potree fuer die Teilantworten aus octree.bin
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag, Last-Modified',
      'Vary': 'Origin'
    } : {};

    // Potree schickt bei Bytebereichen „content-type: multipart/byteranges"
    // mit — das loest eine Vorabfrage aus.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD',
          'Access-Control-Allow-Headers': 'Range, Content-Type', 'Access-Control-Max-Age': '86400' }
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...cors, Allow: 'GET, HEAD, OPTIONS' } });
    }

    const t = PFAD.exec(new URL(request.url).pathname);
    if (!t) return new Response('Unbekannter Pfad', { status: 404, headers: cors });
    const schluessel = `${t[1]}/${t[2]}`;

    let bereich;
    const roh = request.headers.get('Range');
    if (roh && request.method === 'GET') {
      const b = BEREICH.exec(roh);
      if (!b) return new Response(null, { status: 416, headers: cors });
      bereich = b[3] !== undefined ? { suffix: Number(b[3]) }
        : b[2] ? { offset: Number(b[1]), length: Number(b[2]) - Number(b[1]) + 1 }
        : { offset: Number(b[1]) };
      if (bereich.length !== undefined && bereich.length < 1) return new Response(null, { status: 416, headers: cors });
    }

    let objekt;
    try {
      objekt = request.method === 'HEAD'
        ? await env.BUCKET.head(schluessel)
        : await env.BUCKET.get(schluessel, bereich ? { range: bereich } : {});
    } catch (e) {
      // R2 lehnt einen Bereich hinter dem Dateiende mit einem Fehler ab
      return new Response(null, { status: bereich ? 416 : 502, headers: cors });
    }
    if (!objekt) return new Response(null, { status: 404, headers: cors });

    const kopf = new Headers(cors);
    kopf.set('Content-Type', TYP[t[2].split('.').pop()]);
    kopf.set('ETag', objekt.httpEtag);
    kopf.set('Last-Modified', objekt.uploaded.toUTCString());
    kopf.set('Accept-Ranges', 'bytes');
    /* metadata.json zeigt eine neue Fassung sofort an (die Seiten haengen
     * ohnehin ?nocache= an), die grossen Dateien darf der Browser einen Tag
     * behalten — jede Wiederholung aus dem Browser-Cache spart eine Abfrage. */
    kopf.set('Cache-Control', t[2] === 'metadata.json' ? 'no-cache' : 'public, max-age=86400');

    if (request.method === 'HEAD') {
      kopf.set('Content-Length', String(objekt.size));
      return new Response(null, { status: 200, headers: kopf });
    }
    if (!bereich) {
      kopf.set('Content-Length', String(objekt.size));
      return new Response(objekt.body, { status: 200, headers: kopf });
    }

    // Tatsaechlich gelieferten Bereich aus der Antwort von R2 lesen
    const r = objekt.range || {};
    const start = r.suffix !== undefined ? Math.max(0, objekt.size - r.suffix) : (r.offset || 0);
    const laenge = r.suffix !== undefined ? objekt.size - start
      : Math.min(r.length ?? objekt.size - start, objekt.size - start);
    if (start >= objekt.size) {
      kopf.set('Content-Range', `bytes */${objekt.size}`);
      return new Response(null, { status: 416, headers: kopf });
    }
    kopf.set('Content-Range', `bytes ${start}-${start + laenge - 1}/${objekt.size}`);
    kopf.set('Content-Length', String(laenge));
    return new Response(objekt.body, { status: 206, headers: kopf });
  }
};
