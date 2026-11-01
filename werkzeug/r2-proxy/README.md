# R2-Torwächter

Ein Cloudflare Worker, der als einziger Weg in den R2-Bucket mit den
Punktwolken führt. Warum, steht oben in `worker.js`. Kurz: Über die offene
r2.dev-Adresse könnte jemand beliebig viele Abfragen schicken, und R2 rechnet
jede ab. Läuft alles über einen Worker im kostenlosen Plan, sind höchstens
3,1 Mio. Lesezugriffe im Monat möglich. Das liegt unter dem Freikontingent
von R2.

Lokal prüfen:

```bash
node werkzeug/r2-proxy/test.mjs
```

## Einrichten im Cloudflare-Dashboard

Die Reihenfolge ist wichtig: Die r2.dev-Adresse wird erst abgeschaltet, wenn
der Viewer schon über den Worker lädt. Sonst ist er zwischendurch leer.

1. **Plan prüfen:** Unter *Workers & Pages → Plans* muss **Free** stehen.
   Bei „Paid“ gibt es keine harte Obergrenze, dann wird über dem Kontingent
   abgerechnet.
2. **Worker anlegen:** *Workers & Pages → Create → Worker*, Name
   `pwviewer-daten`, *Deploy*. Danach *Edit code*, den Inhalt von `worker.js`
   einfügen und erneut *Deploy*.
3. **Bucket anbinden:** Im Worker unter *Settings → Bindings → Add → R2 bucket*
   als Variablenname `BUCKET` eintragen, den Punktwolken-Bucket wählen und
   speichern.
4. **Testen:** `https://pwviewer-daten.<konto>.workers.dev/geckenheim/thumb.jpg`
   im Browser öffnen. Das Vorschaubild muss erscheinen.
5. **Viewer umstellen:** Die Worker-Adresse ersetzt die r2.dev-Adresse in
   `index.html`, `view.html` und `model.html` (je `R2_BASE` und die
   Content-Security-Policy) sowie in den `og:image`-Angaben unter `p/`.
   Auch das Skript, das `p/*.html` beim Hochladen erzeugt, muss die neue
   Adresse eintragen.
6. **Erst wenn die neue Fassung live ist und lädt:** Im Dashboard unter
   *R2 → Bucket → Settings → Public access* die **r2.dev-Adresse abschalten**.
   Unter *Custom Domains* darf ebenfalls nichts stehen. Danach testen, ob die
   alte Adresse nichts mehr liefert.
7. **Benachrichtigung:** Unter *Manage Account → Notifications → Add* eine
   Meldung für nutzungsabhängige Abrechnung einrichten. Sie dient als zweite
   Absicherung, falls doch einmal etwas abgerechnet wird.

## Was die Grenze trägt

- Die 100.000 Abfragen am Tag gelten für das **ganze Konto**. Der
  Höhen-Proxy von TrackPilot (`trackpilot-hoehen`) teilt sie sich mit diesem
  Worker. Ein Angriff auf einen der beiden legt also beide bis Mitternacht
  (UTC) lahm, kostet aber nichts.
- Ein Aufruf einer Punktwolke braucht je nach Ausschnitt einige hundert
  Abfragen. Für normalen Firmengebrauch reicht das Tageskontingent.
- Die Prüfung der Herkunft hält nur fremde Webseiten fern. Skripte können
  sie umgehen. Die eigentliche Grenze ist der Plan.
