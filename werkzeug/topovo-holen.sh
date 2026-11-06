#!/usr/bin/env bash
# Holt den 3D-Viewer aus Topovo in den PW-Viewer (Ordner topovo/).
#
# Der Viewer wird nur in Topovo gepflegt (laser.js, laser-werk.js, style.css,
# vendor/three, vendor/copc). Hier liegt eine Kopie, weil beide Apps getrennt
# auf GitHub Pages laufen und lokal unter anderem Pfad (trackpilot/ statt
# topovo/) — ein Verweis über Ordnergrenzen hinweg bräche an einer der Stellen.
#
# Nach jeder Änderung an laser.js in Topovo: dieses Skript laufen lassen und
# wolke.html im PW-Viewer prüfen. topovo/wolke-werk.js gehört dem PW-Viewer
# und wird nicht überschrieben.
#
# Aufruf: werkzeug/topovo-holen.sh [Pfad zu Topovo]   (Standard: ../trackpilot)
set -euo pipefail
hier="$(cd "$(dirname "$0")/.." && pwd)"
quelle="${1:-$hier/../trackpilot}"
ziel="$hier/topovo"
[ -f "$quelle/laser.js" ] || { echo "Topovo nicht gefunden unter $quelle" >&2; exit 1; }
mkdir -p "$ziel/vendor/three" "$ziel/vendor/copc"
cp "$quelle/laser.js" "$quelle/laser-werk.js" "$quelle/style.css" "$ziel/"
cp "$quelle/vendor/three/"{three.module.js,OrbitControls.js,LICENSE} "$ziel/vendor/three/"
cp "$quelle/vendor/copc/"{copc.js,laz-perf.wasm,LICENSE-copc.txt,LICENSE-laz-perf.txt,LIZENZ.txt} "$ziel/vendor/copc/"
stand="$(git -C "$quelle" log -1 --format='%h %cs' 2>/dev/null || echo unbekannt)"
aenderung="$(git -C "$quelle" status --porcelain -- laser.js laser-werk.js style.css 2>/dev/null | wc -l)"
echo "Topovo $stand$([ "$aenderung" -gt 0 ] && echo ' + lokale Änderungen')" > "$ziel/STAND.txt"
echo "Geholt: $(cat "$ziel/STAND.txt")"
