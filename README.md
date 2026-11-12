# Prüfungstrainer

Probeprüfungen aus Obsidian-Notizen und PDFs, organisiert in selbst angelegten Fächern. Fragen werden mit Claude
generiert, eigene Fragen lassen sich ergänzen.

## Starten

```bash
nix run .            # Flake
# oder
nix-build && ./result/bin/pruefungstrainer
```

Direkt von GitHub starten:

```bash
nix run github:Memurame/pruefungstrainer
```

Dauerhaft installieren (NixOS-Konfiguration mit Flakes):

```nix
# flake.nix
inputs.pruefungstrainer = {
  url = "github:Memurame/pruefungstrainer";
  inputs.nixpkgs.follows = "nixpkgs";
};

# in einem Modul (pruefungstrainer per specialArgs durchreichen):
nixpkgs.overlays = [ pruefungstrainer.overlays.default ];
environment.systemPackages = [ pkgs.pruefungstrainer ];
```

Aktualisieren: `nix flake update pruefungstrainer && sudo nixos-rebuild switch`.

## Ablauf

1. **Datei → Einstellungen:** API-Key eintragen (oder `ANTHROPIC_API_KEY` setzen).
2. **Fächer:** Fächer anlegen und ihnen beliebige Dateien (.md, .pdf) oder Ordner hinzufügen.
   Bei Ordnern kommen neue Dateien automatisch dazu. Notizen werden an Überschriften, PDFs in
   Blöcke zu 15 Seiten aufgeteilt. „Generieren“ verarbeitet nur neue oder geänderte Abschnitte.
   Fächer lassen sich umbenennen und zusammenführen.
   **Altklausuren:** Über „Altklausur hinzufügen …“ (oder „Altklausur ein/aus“ für vorhandene
   Dateien und Ordner) werden alte Prüfungen mit Lösung wörtlich übernommen statt neue Fragen zu
   erfinden: jede (Teil-)Aufgabe mit ihrer Originalpunktzahl, die offizielle Lösung als
   Musterlösung. Rot gedruckter Text gilt als Lösung; fehlt sie zu einer Aufgabe, steht das in der
   Erläuterung. Ankreuzen, Unterstreichen und Zuordnen werden zu „Zuordnung“-Fragen, die Zeile
   für Zeile automatisch bewertet werden. Erneutes Verarbeiten („Auswahl (neu) verarbeiten“)
   aktualisiert übernommene Aufgaben; Freigaben und Ergebnisse bleiben erhalten.
3. **Fragen:** Generierte Fragen prüfen, bearbeiten, freigeben; eigene Fragen anlegen.
   Markierte Fragen mit „Zu Übungssatz …“ in einen Übungssatz übernehmen.
   **Übungssätze:** feste Zusammenstellungen mit eigener Reihenfolge und Zeitlimit. Jede
   Altklausur wird automatisch zu einem Übungssatz (Zeitlimit laut Deckblatt).
4. **Prüfung:** Fächer, Anzahl, Fragetypen und Zeitlimit wählen – oder einen Übungssatz (angeboten werden die mit Fragen aus den gewählten
   Fächern), der dann
   vollständig in seiner Reihenfolge gestellt wird. Tabellen mit leeren Zellen füllst du direkt
   aus; im Ergebnis stehen deine Einträge Zeile für Zeile neben der Musterlösung. Multiple Choice und Zuordnungen werden direkt
   ausgewertet, Freitext von der KI nach der Punktzahl der Frage (mit Feedback). Bewertungen
   lassen sich anpassen.
5. **Statistik:** Erfolgsquote pro Fach und die schwächsten Fragen.

## Eigene Fragen direkt in Obsidian

```markdown
Welche drei Nachrichten bilden den TCP-Handshake?::SYN, SYN-ACK, ACK

> [!frage] Wozu dienen Sequenznummern bei TCP?
> Sie ermöglichen die richtige Reihenfolge und das Erkennen verlorener Segmente.
```

Die Frage vor `::` muss mit `?` enden. Damit werden Dataview-Felder (`status:: x`) nicht als Fragen erkannt.

## Export und Import

**Datei → Exportieren …** speichert die gewählten Fächer mit ihren Fragen und den zugehörigen
Übungssätzen als JSON-Datei. **Datei → Importieren …** liest sie wieder ein: Fächer und
Übungssätze mit gleichem Namen werden zusammengeführt, vorhandene Fragen nicht doppelt
angelegt. Quellen (Dateipfade) und Prüfungsergebnisse werden nicht übertragen.

## Daten

- Einstellungen: `~/.config/pruefungstrainer/config.json`
- Fragen und Ergebnisse: `~/.local/share/pruefungstrainer/fragen.sqlite3`
- Deine Dateien werden nur gelesen, nie verändert.
- Beim Update von Version 0.1 wird vorher eine Sicherung angelegt:
  `~/.local/share/pruefungstrainer/fragen.v1-backup.sqlite3`
