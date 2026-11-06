"""PW-Viewer-Manager — Fenster zum Anlegen, Ansehen und Hochladen der Projekte.

Nachfolger des PowerShell-Managers (Windows) — läuft mit Python und Tkinter
unter Windows und Linux gleich. Start: manager.sh (Linux) bzw.
Punktwolken-Manager.bat (Windows), eingerichtet mit einrichten.sh/.bat.

Ein Projekt geht in zwei Schritten online:
  1. „Neues Projekt“ bzw. „Ändern“ bereitet alles in daten-lokal/<name>/ vor
     (LAZ, Modell zugeschnitten und verkleinert, Vorschaubild). „Ansehen“ öffnet
     es im Browser von diesem Rechner aus — online ist noch nichts.
  2. „Veröffentlichen“ lädt nach R2, trägt es in pointclouds.json ein und pusht.
"""
from __future__ import annotations

import functools
import http.server
import mimetypes
import queue
import subprocess
import threading
import tkinter as tk
import traceback
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import verarbeitung as V

GRUND, FLAECHE, LINIE, TEXT, BLASS, AKZENT = "#1a1d21", "#24282e", "#33383f", "#eef1f4", "#9aa0a6", "#1761a3"
VORSCHAU_PORT = 5193
BESCHREIBUNG = "Photogrammetrie aus Drohnenaufnahmen (WebODM)"


class Manager(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Punktwolken-Manager")
        self.geometry("860x720")
        self.minsize(760, 600)
        self.configure(bg=GRUND)
        self.nachrichten: queue.Queue = queue.Queue()
        self.laeuft = False
        self.server = None
        self.je_projekt: dict = {}
        self.projekte: dict = {}
        self.liste_geaendert = False
        self._stil()
        self._bauen()
        self.after(100, self._post)
        self.after(200, self.aktualisieren)

    # ------------------------------------------------------------ Aussehen
    def _stil(self):
        s = ttk.Style(self)
        s.theme_use("clam")
        s.configure(".", background=GRUND, foreground=TEXT, fieldbackground=FLAECHE, bordercolor=LINIE,
                    font=("Segoe UI", 10) if V.WINDOWS else ("Sans", 10))
        s.configure("TButton", background=FLAECHE, foreground=TEXT, borderwidth=1, padding=(12, 7), relief="flat")
        s.map("TButton", background=[("disabled", GRUND), ("active", LINIE)], foreground=[("disabled", "#5b6168")])
        s.configure("Akzent.TButton", background=AKZENT, foreground="#ffffff")
        s.map("Akzent.TButton", background=[("disabled", GRUND), ("active", "#1f74c2")])
        s.configure("Treeview", background=FLAECHE, foreground=TEXT, fieldbackground=FLAECHE, rowheight=26, borderwidth=0)
        s.configure("Treeview.Heading", background=GRUND, foreground=BLASS, relief="flat")
        s.map("Treeview", background=[("selected", AKZENT)], foreground=[("selected", "#ffffff")])
        s.configure("TLabel", background=GRUND, foreground=TEXT)
        s.configure("Blass.TLabel", foreground=BLASS)
        s.configure("Status.TLabel", foreground="#55a5e7")
        s.configure("TCheckbutton", background=GRUND, foreground=TEXT)
        s.configure("TEntry", foreground=TEXT, insertcolor=TEXT)
        s.configure("Horizontal.TProgressbar", background=AKZENT, troughcolor=FLAECHE, bordercolor=LINIE)

    def _bauen(self):
        r = ttk.Frame(self, padding=16)
        r.pack(fill="both", expand=True)
        self.speicher_text = ttk.Label(r, text="Speicher wird geladen …")
        self.speicher_text.pack(anchor="w")
        self.speicher_balken = ttk.Progressbar(r, maximum=100)
        self.speicher_balken.pack(fill="x", pady=(4, 12))

        spalten = ("name", "groesse", "wolke", "modell", "stand")
        self.tabelle = ttk.Treeview(r, columns=spalten, height=11, selectmode="browse")
        self.tabelle.heading("#0", text="Projekt", anchor="w")
        self.tabelle.column("#0", width=230)
        for k, t, w in (("name", "Technischer Name", 200), ("groesse", "Größe", 70), ("wolke", "Punktwolke", 90),
                        ("modell", "3D-Modell", 80), ("stand", "Stand", 120)):
            self.tabelle.heading(k, text=t, anchor="w")
            self.tabelle.column(k, width=w, anchor="w")
        self.tabelle.pack(fill="both", expand=True)
        self.tabelle.bind("<<TreeviewSelect>>", lambda e: self._knoepfe())
        self.tabelle.bind("<Double-1>", lambda e: self.ansehen())

        def reihe(titel, knoepfe):
            ttk.Label(r, text=titel, style="Blass.TLabel").pack(anchor="w", pady=(12, 2))
            f = ttk.Frame(r)
            f.pack(fill="x")
            aus = []
            for text, befehl, stil in knoepfe:
                b = ttk.Button(f, text=text, command=befehl, style=stil or "TButton")
                b.pack(side="left", padx=(0, 8))
                aus.append(b)
            return aus

        (self.k_neu,) = reihe("Neues Projekt", [("+ Neues Projekt …", self.neu, "Akzent.TButton")])
        (self.k_aendern, self.k_ansehen, self.k_modell_ansehen, self.k_veroeff, self.k_umbenennen, self.k_loeschen) = reihe(
            "Ausgewähltes Projekt", [
                ("Wolke/Modell ändern …", self.aendern, None), ("Punktwolke ansehen", self.ansehen, None),
                ("Modell ansehen", self.modell_ansehen, None), ("Veröffentlichen", self.veroeffentlichen, "Akzent.TButton"),
                ("Umbenennen …", self.umbenennen, None), ("Löschen …", self.loeschen, None)])
        (self.k_hoch, self.k_runter, self.k_neu_laden, self.k_live) = reihe("Reihenfolge und Ansicht", [
            ("▲ Hoch", lambda: self.verschieben(-1), None), ("▼ Runter", lambda: self.verschieben(1), None),
            ("Aktualisieren", self.aktualisieren, None), ("Live-Seite", lambda: webbrowser.open(V.SEITE + "/"), None)])

        self.status = ttk.Label(r, text="Bereit.", style="Status.TLabel")
        self.status.pack(anchor="w", pady=(14, 4))
        self.log = tk.Text(r, height=8, bg=FLAECHE, fg="#d5d9de", insertbackground=TEXT, relief="flat",
                           highlightthickness=1, highlightbackground=LINIE, wrap="word")
        self.log.pack(fill="both")
        self.log.configure(state="disabled")

    # ------------------------------------------------------------ Hilfen
    def melden(self, text: str):
        """Aus jedem Faden: Status und Protokoll"""
        self.nachrichten.put(("melden", text))

    def _post(self):
        try:
            while True:
                art, wert = self.nachrichten.get_nowait()
                if art == "melden":
                    self.status.configure(text=wert)
                    self.log.configure(state="normal")
                    self.log.insert("end", wert + "\n")
                    self.log.see("end")
                    self.log.configure(state="disabled")
                elif art == "fertig":
                    self.laeuft = False
                    self._knoepfe()
                    if wert:
                        wert()
        except queue.Empty:
            pass
        self.after(100, self._post)

    def im_hintergrund(self, arbeit, danach=None):
        """arbeit() im Faden; Fehler als Meldung, danach() wieder im Fenster."""
        if self.laeuft:
            return
        self.laeuft = True
        self._knoepfe()

        def faden():
            try:
                arbeit()
            except V.Fehler as f:
                self.melden(f"FEHLER: {f}")
                self.nachrichten.put(("fertig", lambda: messagebox.showerror("Punktwolken-Manager", str(f), parent=self)))
                return
            except Exception:
                self.melden("FEHLER:\n" + traceback.format_exc())
                self.nachrichten.put(("fertig", None))
                return
            self.nachrichten.put(("fertig", danach))
        threading.Thread(target=faden, daemon=True).start()

    def gewaehlt(self) -> dict | None:
        sel = self.tabelle.selection()
        return self.projekte.get(sel[0]) if sel else None

    def _knoepfe(self):
        p = self.gewaehlt()
        frei = not self.laeuft
        for b in (self.k_neu, self.k_neu_laden):
            b.state(["!disabled"] if frei else ["disabled"])
        for b, an in ((self.k_aendern, p), (self.k_umbenennen, p), (self.k_loeschen, p and p["_online"]),
                      (self.k_ansehen, p and p.get("pointcloud") is not False),
                      (self.k_modell_ansehen, p and p.get("model")),
                      (self.k_veroeff, p and (p["_lokal"] or self.liste_geaendert)),
                      (self.k_hoch, p and p["_online"]), (self.k_runter, p and p["_online"])):
            b.state(["!disabled"] if frei and an else ["disabled"])

    # ------------------------------------------------------------ Liste
    def aktualisieren(self):
        self.projekte: dict = {}
        online = V.liste_lesen()
        lokal = {e["name"]: e for e in V.lokale_projekte()}
        for pc in online:
            self.projekte[pc["name"]] = {**pc, **lokal.get(pc["name"], {}), "_online": True, "_lokal": pc["name"] in lokal}
        for name, e in lokal.items():
            if name not in self.projekte:
                self.projekte[name] = {**e, "_online": False, "_lokal": True}
        try:
            self.liste_geaendert = bool(V.git("status", "--porcelain", "--", "pointclouds.json", "p").strip())
        except V.Fehler:
            self.liste_geaendert = False
        self._zeichnen()
        self.melden("Liste geladen. Speicher wird abgefragt …")

        def holen():
            try:
                gb, je = V.speicher()
            except V.Fehler as f:
                # ohne rclone oder r2: trotzdem arbeiten (vorbereiten, ansehen)
                self.melden(f"Speicher nicht abfragbar: {f}")
                return
            self.je_projekt = je
            self.nachrichten.put(("fertig", lambda: self._speicher(gb)))
        self.im_hintergrund(holen)

    def _speicher(self, gb):
        anteil = gb / V.LIMIT_GB * 100
        self.speicher_balken["value"] = min(100, anteil)
        self.speicher_text.configure(text=f"R2-Speicher: {gb:.2f} von {V.LIMIT_GB:.0f} GB belegt ({anteil:.0f} %)"
                                     + ("  —  Liste geändert, noch nicht veröffentlicht" if self.liste_geaendert else ""))
        self._zeichnen()
        self.melden("Bereit.")

    def _zeichnen(self):
        alt = self.tabelle.selection()
        self.tabelle.delete(*self.tabelle.get_children())
        for name, p in self.projekte.items():
            groesse = self.je_projekt.get(name)
            wolke = "–" if p.get("pointcloud") is False else ("LAZ" if p.get("laz") else "Potree")
            stand = "vorbereitet" if p["_lokal"] and not p["_online"] else ("online, geändert" if p["_lokal"] else "online")
            self.tabelle.insert("", "end", iid=name, text=p.get("title", name), values=(
                name, f"{groesse / 1e6:.0f} MB" if groesse else "", wolke, "ja" if p.get("model") else "–", stand))
        if alt and self.tabelle.exists(alt[0]):
            self.tabelle.selection_set(alt[0])
        self._knoepfe()

    # ------------------------------------------------------------ Aktionen
    def neu(self):
        Dialog(self, None)

    def aendern(self):
        p = self.gewaehlt()
        if p:
            Dialog(self, p)

    def vorbereiten(self, **auftrag):
        name = auftrag["name"]
        self.melden(f"— {auftrag['titel']} vorbereiten —")

        def danach():
            self.aktualisieren()
            self.tabelle.selection_set(name)
            if messagebox.askyesno("Punktwolken-Manager", "Fertig vorbereitet (noch nicht online).\n\nJetzt im Browser ansehen?", parent=self):
                self.ansehen()
        self.im_hintergrund(lambda: V.vorbereiten(melden=self.melden, **auftrag), danach)

    def _vorschau_server(self):
        if self.server:
            return
        mimetypes.add_type("application/wasm", ".wasm")
        mimetypes.add_type("text/javascript", ".js")
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(V.REPO))
        handler.log_message = lambda *a: None
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", VORSCHAU_PORT), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def ansehen(self):
        p = self.gewaehlt()
        if not p:
            return
        if p["_lokal"] or p.get("laz"):
            # Lokal: wolke.js nimmt daten-lokal/<name>/cloud.laz, sonst die Datei aus R2
            self._vorschau_server()
            webbrowser.open(f"http://localhost:{VORSCHAU_PORT}/wolke.html?p={p['name']}")
        else:
            webbrowser.open(f"{V.SEITE}/view.html?p={p['name']}")

    def modell_ansehen(self):
        p = self.gewaehlt()
        if p:
            self._vorschau_server()
            webbrowser.open(f"http://localhost:{VORSCHAU_PORT}/model.html?p={p['name']}")

    def veroeffentlichen(self):
        p = self.gewaehlt()
        if not p:
            return
        if p["_lokal"]:
            if not messagebox.askyesno("Veröffentlichen", f"„{p['title']}“ nach R2 hochladen und in der Galerie veröffentlichen?", parent=self):
                return
            self.im_hintergrund(lambda: V.hochladen(p["name"], self.melden), self.aktualisieren)
        else:
            self.im_hintergrund(lambda: V.git_veroeffentlichen("Projektliste geändert", ["pointclouds.json", "p"], self.melden),
                                self.aktualisieren)

    def umbenennen(self):
        p = self.gewaehlt()
        if not p:
            return
        neu = Eingabe(self, "Umbenennen", "Neuer Titel (Name und Link bleiben):", p.get("title", "")).wert
        if not neu or neu == p.get("title"):
            return
        if p["_lokal"]:
            e = V.eintrag_lokal(p["name"])
            e["title"] = neu
            (V.LOKAL / p["name"] / "eintrag.json").write_text(V.json.dumps(e, ensure_ascii=False, indent=2), encoding="utf-8")
        if p["_online"]:
            liste = V.liste_lesen()
            for pc in liste:
                if pc["name"] == p["name"]:
                    pc["title"] = neu
                    V.vorschauseite(pc)
            V.liste_schreiben(liste)
        self.aktualisieren()

    def verschieben(self, richtung):
        p = self.gewaehlt()
        if not p:
            return
        liste = V.liste_lesen()
        i = next((k for k, pc in enumerate(liste) if pc["name"] == p["name"]), None)
        j = (i or 0) + richtung
        if i is None or not 0 <= j < len(liste):
            return
        liste[i], liste[j] = liste[j], liste[i]
        V.liste_schreiben(liste)
        self.aktualisieren()
        self.tabelle.selection_set(p["name"])

    def loeschen(self):
        p = self.gewaehlt()
        if not p:
            return
        was = Loeschwahl(self, p).wert
        if not was:
            return
        text = {"alles": "das ganze Projekt", "wolke": "nur die Punktwolke", "modell": "nur das 3D-Modell"}[was]
        if not messagebox.askyesno("Löschen", f"„{p['title']}“: {text} aus R2 löschen und die Galerie aktualisieren?\n\nDas lässt sich nicht rückgängig machen.",
                                   icon="warning", parent=self):
            return
        self.im_hintergrund(lambda: V.loeschen(p["name"], was, self.melden), self.aktualisieren)


class Dialog(tk.Toplevel):
    """Neues Projekt oder Wolke/Modell eines Projekts ändern."""

    def __init__(self, m: Manager, p: dict | None):
        super().__init__(m)
        self.m, self.p = m, p
        self.title("Neues Projekt" if not p else f"{p['title']} ändern")
        self.configure(bg=GRUND)
        self.transient(m)
        f = ttk.Frame(self, padding=16)
        f.pack(fill="both", expand=True)
        self.titel = tk.StringVar(value=p.get("title", "") if p else "")
        self.beschr = tk.StringVar(value=p.get("description", BESCHREIBUNG) if p else BESCHREIBUNG)
        self.name = tk.StringVar(value=p["name"] if p else "")
        self.wolke, self.modell = tk.StringVar(), tk.StringVar()
        self.schneiden = tk.BooleanVar(value=True)
        zeile = 0

        def feld(text, var, breit=46, **kw):
            nonlocal zeile
            ttk.Label(f, text=text).grid(row=zeile, column=0, sticky="w", pady=4, padx=(0, 10))
            e = ttk.Entry(f, textvariable=var, width=breit, **kw)
            e.grid(row=zeile, column=1, sticky="we", pady=4)
            zeile += 1
            return e

        e_titel = feld("Titel", self.titel)
        feld("Beschreibung", self.beschr)
        feld("Technischer Name", self.name, state="disabled" if p else "normal")
        if not p:
            self.titel.trace_add("write", lambda *a: self.name.set(V.name_aus_titel(self.titel.get())))

        def datei(text, var, typen):
            nonlocal zeile
            ttk.Label(f, text=text).grid(row=zeile, column=0, sticky="w", pady=4, padx=(0, 10))
            ttk.Entry(f, textvariable=var, width=46).grid(row=zeile, column=1, sticky="we", pady=4)
            ttk.Button(f, text="Wählen …", command=lambda: var.set(filedialog.askopenfilename(parent=self, filetypes=typen) or var.get())
                       ).grid(row=zeile, column=2, padx=(8, 0))
            zeile += 1

        datei("Punktwolke", self.wolke, [("Punktwolke", "*.laz *.las *.bin"), ("Alle", "*")])
        datei("3D-Modell", self.modell, [("WebODM-Modell", "*.zip *.obj"), ("Alle", "*")])
        ttk.Checkbutton(f, text="Modell auf die Fläche der Punktwolke zuschneiden", variable=self.schneiden
                        ).grid(row=zeile, column=1, sticky="w", pady=(6, 0))
        zeile += 1
        ttk.Label(f, text=("Leer gelassen bleibt, was schon da ist. " if p else "")
                  + f"Texturen bis {V.TEXTUR_MAX} px, WebP {V.WEBP_QUALITAET}.", style="Blass.TLabel"
                  ).grid(row=zeile, column=1, sticky="w", pady=(4, 12))
        zeile += 1
        k = ttk.Frame(f)
        k.grid(row=zeile, column=1, sticky="e")
        ttk.Button(k, text="Abbrechen", command=self.destroy).pack(side="right")
        ttk.Button(k, text="Vorbereiten", style="Akzent.TButton", command=self.ok).pack(side="right", padx=8)
        f.columnconfigure(1, weight=1)
        e_titel.focus_set()
        self.grab_set()

    def ok(self):
        titel, name = self.titel.get().strip(), self.name.get().strip()
        wolke = Path(self.wolke.get()) if self.wolke.get().strip() else None
        modell = Path(self.modell.get()) if self.modell.get().strip() else None
        if not titel:
            messagebox.showwarning("Neues Projekt", "Bitte einen Titel angeben.", parent=self); return
        if not self.p and name in self.m.projekte:
            messagebox.showwarning("Neues Projekt", f"Den Namen „{name}“ gibt es schon.", parent=self); return
        if not wolke and not modell and not self.p:
            messagebox.showwarning("Neues Projekt", "Bitte eine Punktwolke und/oder ein Modell wählen.", parent=self); return
        for d in (wolke, modell):
            if d and not d.exists():
                messagebox.showwarning("Datei", f"{d} gibt es nicht.", parent=self); return
        schneiden = bool(modell and self.schneiden.get() and (wolke or (self.p and self.p.get("laz"))))
        if schneiden and not wolke and self.p and not (V.LOKAL / name / "cloud.laz").exists():
            # Wolke liegt nur in R2: zum Schneiden einmal holen
            messagebox.showinfo("Zuschneiden", "Zum Zuschneiden bitte die Punktwolke mit auswählen.", parent=self); return
        self.destroy()
        self.m.vorbereiten(titel=titel, beschreibung=self.beschr.get().strip(), name=name,
                           wolke=wolke, modell=modell, schneiden=schneiden)


class Eingabe(tk.Toplevel):
    def __init__(self, m, titel, frage, vorgabe=""):
        super().__init__(m)
        self.title(titel)
        self.configure(bg=GRUND)
        self.transient(m)
        self.wert = None
        f = ttk.Frame(self, padding=16)
        f.pack(fill="both")
        ttk.Label(f, text=frage).pack(anchor="w")
        var = tk.StringVar(value=vorgabe)
        e = ttk.Entry(f, textvariable=var, width=50)
        e.pack(fill="x", pady=8)
        e.focus_set()

        def ok(*_):
            self.wert = var.get().strip()
            self.destroy()
        e.bind("<Return>", ok)
        ttk.Button(f, text="OK", style="Akzent.TButton", command=ok).pack(side="right")
        self.grab_set()
        self.wait_window()


class Loeschwahl(tk.Toplevel):
    def __init__(self, m, p):
        super().__init__(m)
        self.title("Löschen")
        self.configure(bg=GRUND)
        self.transient(m)
        self.wert = None
        f = ttk.Frame(self, padding=16)
        f.pack(fill="both")
        ttk.Label(f, text=f"Was soll von „{p['title']}“ weg?").pack(anchor="w", pady=(0, 8))
        for text, w, an in (("Ganzes Projekt", "alles", True), ("Nur Punktwolke", "wolke", p.get("pointcloud") is not False and p.get("model")),
                            ("Nur 3D-Modell", "modell", p.get("model") and p.get("pointcloud") is not False)):
            b = ttk.Button(f, text=text, command=lambda w=w: self._w(w))
            b.pack(fill="x", pady=2)
            if not an:
                b.state(["disabled"])
        ttk.Button(f, text="Abbrechen", command=self.destroy).pack(fill="x", pady=(10, 0))
        self.grab_set()
        self.wait_window()

    def _w(self, w):
        self.wert = w
        self.destroy()


if __name__ == "__main__":
    Manager().mainloop()
