#!/usr/bin/env bash
# Richtet den Punktwolken-Manager unter Linux ein (einmalig, und nach Updates).
# Danach: ./manager.sh oder „Punktwolken-Manager“ im Startmenü.
set -euo pipefail
cd "$(dirname "$0")"

fehlt=()
python3 -c "import tkinter" 2>/dev/null || fehlt+=(python3-tk)
python3 -c "import ensurepip" 2>/dev/null || fehlt+=(python3-venv)
command -v node >/dev/null || fehlt+=(nodejs npm)
command -v rclone >/dev/null || fehlt+=(rclone)
if [ ${#fehlt[@]} -gt 0 ]; then
  echo "Bitte erst installieren:"
  echo "  sudo apt install ${fehlt[*]}"
  exit 1
fi

[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.txt
npm install --no-audit --no-fund --silent

# Eintrag im Startmenü (und damit auch für Plank)
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/pw-manager.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Punktwolken-Manager
Comment=Punktwolken und 3D-Modelle für den PW-Viewer vorbereiten und hochladen
Exec=$(pwd)/manager.sh
Icon=$(cd ../.. && pwd)/icon-192.png
Terminal=false
Categories=Graphics;
EOF

if ! rclone listremotes | grep -q '^r2:$'; then
  echo
  echo "Hinweis: rclone kennt noch kein „r2:“. Entweder die rclone.conf vom Windows-Rechner"
  echo "(%APPDATA%\\rclone\\rclone.conf) nach ~/.config/rclone/rclone.conf kopieren"
  echo "oder mit „rclone config“ neu anlegen (Typ s3, Anbieter Cloudflare)."
fi
echo "Fertig. Start: $(pwd)/manager.sh"
