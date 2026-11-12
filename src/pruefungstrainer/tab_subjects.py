"""Tab 'Fächer': Fächer anlegen, Dateien/Ordner zuordnen, Fragen per KI generieren
bzw. aus Altklausuren übernehmen."""

import sqlite3
from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QFileDialog, QHBoxLayout, QHeaderView, QInputDialog, QLabel,
    QListWidget, QListWidgetItem, QMessageBox, QPlainTextEdit, QProgressBar, QPushButton,
    QSpinBox, QSplitter, QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget,
)

from . import ai, config, vault
from .db import Database, Source
from .gui_common import Worker

STATUS_NEW, STATUS_DONE, STATUS_CHANGED, STATUS_OPEN = "neu", "erledigt", "geändert", "offen"
ROLE = Qt.ItemDataRole.UserRole


class SubjectsTab(QWidget):
    questions_changed = Signal()
    subjects_changed = Signal()

    def __init__(self, db: Database, cfg: config.Config, parent=None):
        super().__init__(parent)
        self.db, self.cfg = db, cfg
        self.scan_result: vault.ScanResult | None = None
        self.by_file: dict[tuple[int, str], list[vault.Section]] = {}
        self.worker: Worker | None = None

        # --- links: Fächer
        self.list = QListWidget()
        self.list.currentRowChanged.connect(lambda _: self.refresh_tree())
        left_btns = QVBoxLayout()
        for label, slot in (("Neues Fach …", self.new_subject), ("Umbenennen …", self.rename_subject),
                            ("Zusammenführen …", self.merge_subject), ("Löschen", self.delete_subject)):
            b = QPushButton(label)
            b.clicked.connect(slot)
            left_btns.addWidget(b)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(QLabel("<b>Fächer</b>"))
        ll.addWidget(self.list, 1)
        ll.addLayout(left_btns)

        # --- rechts: Quellen des Fachs
        self.title = QLabel()
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Quelle / Abschnitt", "Status"])
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.tree.header().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.summary = QLabel()
        self.src_btns = []
        src_row = QHBoxLayout()
        for label, slot in (("Dateien hinzufügen …", self.add_files),
                            ("Ordner hinzufügen …", self.add_folder),
                            ("Altklausur hinzufügen …", self.add_exams),
                            ("Altklausur ein/aus", self.toggle_exam),
                            ("Entfernen", self.remove_sources)):
            b = QPushButton(label)
            b.clicked.connect(slot)
            src_row.addWidget(b)
            self.src_btns.append(b)
        src_row.addStretch()
        self.scan_btn = QPushButton("Neu einlesen")
        self.scan_btn.clicked.connect(self.scan)
        src_row.addWidget(self.scan_btn)
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addWidget(self.title)
        rl.addWidget(self.tree, 1)
        rl.addWidget(self.summary)
        rl.addLayout(src_row)

        split = QSplitter()
        split.addWidget(left)
        split.addWidget(right)
        split.setSizes([260, 840])

        # --- unten: Generierung
        self.count = QSpinBox()
        self.count.setRange(1, 20)
        self.count.setValue(cfg.questions_per_section)
        self.mc = QCheckBox("Multiple Choice")
        self.mc.setChecked(True)
        self.frei = QCheckBox("Freitext")
        self.frei.setChecked(True)
        self.gen_subject = QPushButton("Neue/geänderte Abschnitte dieses Fachs verarbeiten")
        self.gen_subject.clicked.connect(lambda: self.generate("subject"))
        self.gen_sel = QPushButton("Auswahl (neu) verarbeiten")
        self.gen_sel.clicked.connect(lambda: self.generate("selection"))
        self.gen_all = QPushButton("Alle Fächer")
        self.gen_all.setToolTip("Neue/geänderte Abschnitte aller Fächer verarbeiten")
        self.gen_all.clicked.connect(lambda: self.generate("all"))
        self.cancel_btn = QPushButton("Abbrechen")
        self.cancel_btn.setEnabled(False)
        self.cancel_btn.clicked.connect(self.cancel)
        opts = QHBoxLayout()
        opts.addWidget(QLabel("Fragen pro Abschnitt:"))
        opts.addWidget(self.count)
        opts.addWidget(self.mc)
        opts.addWidget(self.frei)
        opts.addStretch()
        opts.addWidget(QLabel("<i>Altklausuren werden immer vollständig übernommen.</i>"))
        gen = QHBoxLayout()
        for b in (self.gen_subject, self.gen_sel, self.gen_all):
            gen.addWidget(b)
        gen.addStretch()
        gen.addWidget(self.cancel_btn)

        self.progress = QProgressBar()
        self.progress.setVisible(False)
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumHeight(110)

        lay = QVBoxLayout(self)
        lay.addWidget(split, 1)
        lay.addLayout(opts)
        lay.addLayout(gen)
        lay.addWidget(self.progress)
        lay.addWidget(self.log)

        self.reload_subjects()

    # --- Fächer -------------------------------------------------------

    def current_subject(self) -> int | None:
        item = self.list.currentItem()
        return item.data(ROLE) if item else None

    def reload_subjects(self, select: int | None = None) -> None:
        select = select if select is not None else self.current_subject()
        counts = self.db.question_counts()
        self.list.blockSignals(True)
        self.list.clear()
        for s in self.db.subjects():
            item = QListWidgetItem(f"{s.name}  ({counts.get(s.id, 0)})")
            item.setData(ROLE, s.id)
            item.setToolTip(f"{counts.get(s.id, 0)} Fragen")
            self.list.addItem(item)
            if s.id == select:
                self.list.setCurrentItem(item)
        if self.list.currentRow() < 0 and self.list.count():
            self.list.setCurrentRow(0)
        self.list.blockSignals(False)
        self.refresh_tree()

    def _subject_name(self, sid: int) -> str:
        return next((s.name for s in self.db.subjects() if s.id == sid), "")

    def _changed(self, select: int | None = None) -> None:
        self.reload_subjects(select)
        self.subjects_changed.emit()
        self.questions_changed.emit()

    def new_subject(self) -> None:
        name, ok = QInputDialog.getText(self, "Neues Fach", "Name des Fachs:")
        if ok and name.strip():
            try:
                sid = self.db.add_subject(name.strip())
            except sqlite3.IntegrityError:
                QMessageBox.warning(self, "Fach", f"Ein Fach „{name.strip()}“ gibt es schon.")
                return
            self._changed(sid)

    def rename_subject(self) -> None:
        sid = self.current_subject()
        if sid is None:
            return
        name, ok = QInputDialog.getText(self, "Fach umbenennen", "Neuer Name:",
                                        text=self._subject_name(sid))
        if ok and name.strip():
            try:
                self.db.rename_subject(sid, name.strip())
            except sqlite3.IntegrityError:
                QMessageBox.warning(self, "Fach", f"Ein Fach „{name.strip()}“ gibt es schon.")
                return
            self._changed(sid)

    def merge_subject(self) -> None:
        sid = self.current_subject()
        others = [s for s in self.db.subjects() if s.id != sid]
        if sid is None or not others:
            QMessageBox.information(self, "Zusammenführen", "Dafür braucht es mindestens zwei Fächer.")
            return
        name = self._subject_name(sid)
        target, ok = QInputDialog.getItem(
            self, "Zusammenführen", f"„{name}“ mit allen Quellen und Fragen verschieben nach:",
            [s.name for s in others], 0, False)
        if not ok:
            return
        tid = next(s.id for s in others if s.name == target)
        self.db.merge_subjects(sid, tid)
        self.log.appendPlainText(f"„{name}“ in „{target}“ zusammengeführt.")
        self._changed(tid)
        self.scan()

    def delete_subject(self) -> None:
        sid = self.current_subject()
        if sid is None:
            return
        n = self.db.question_counts().get(sid, 0)
        if QMessageBox.question(
                self, "Fach löschen", f"Fach „{self._subject_name(sid)}“ mit {n} Fragen und allen "
                "Ergebnissen löschen?\n\nDie Dateien selbst bleiben unverändert.") \
                != QMessageBox.StandardButton.Yes:
            return
        self.db.delete_subject(sid)
        self._changed()

    # --- Quellen ------------------------------------------------------

    def _start_dir(self) -> str:
        return self.cfg.last_dir or self.cfg.vault_path or str(Path.home())

    def _remember_dir(self, path: str) -> None:
        self.cfg.last_dir = path
        config.save(self.cfg)

    def add_files(self) -> None:
        sid = self.current_subject()
        if sid is None:
            QMessageBox.information(self, "Fach", "Lege zuerst links ein Fach an.")
            return
        files, _ = QFileDialog.getOpenFileNames(self, "Dateien hinzufügen", self._start_dir(),
                                                "Notizen und PDFs (*.md *.pdf)")
        if files:
            for f in files:
                self.db.add_source(sid, str(Path(f).resolve()), "file")
            self._remember_dir(str(Path(files[0]).parent))
            self.scan()

    def add_exams(self) -> None:
        sid = self.current_subject()
        if sid is None:
            QMessageBox.information(self, "Fach", "Lege zuerst links ein Fach an.")
            return
        files, _ = QFileDialog.getOpenFileNames(self, "Altklausuren mit Lösungen hinzufügen",
                                                self._start_dir(), "PDFs (*.pdf)")
        if files:
            for f in files:
                self.db.add_source(sid, str(Path(f).resolve()), "file", "klausur")
            self._remember_dir(str(Path(files[0]).parent))
            self.scan()

    def toggle_exam(self) -> None:
        sources = {s.id: s for s in self.db.sources(self.current_subject())}
        chosen = [sources[i.data(0, ROLE)[1]] for i in self.tree.selectedItems()
                  if i.data(0, ROLE) and i.data(0, ROLE)[0] == "src"]
        if not chosen:
            QMessageBox.information(self, "Altklausur", "Wähle oben eine Datei oder einen Ordner "
                                    "(oberste Ebene) aus. Bei Ordnern gelten alle PDFs darin als "
                                    "Altklausuren.")
            return
        for src in chosen:
            self.db.set_source_mode(src.id, "lernstoff" if src.mode == "klausur" else "klausur")
        self.scan()

    def add_folder(self) -> None:
        sid = self.current_subject()
        if sid is None:
            QMessageBox.information(self, "Fach", "Lege zuerst links ein Fach an.")
            return
        folder = QFileDialog.getExistingDirectory(self, "Ordner hinzufügen", self._start_dir())
        if folder:
            self.db.add_source(sid, str(Path(folder).resolve()), "dir")
            self._remember_dir(str(Path(folder).parent))
            self.scan()

    def remove_sources(self) -> None:
        sources = {s.id: s for s in self.db.sources(self.current_subject())}
        chosen = [sources[i.data(0, ROLE)[1]] for i in self.tree.selectedItems()
                  if i.data(0, ROLE) and i.data(0, ROLE)[0] == "src"]
        if not chosen:
            QMessageBox.information(self, "Entfernen", "Wähle oben eine Datei oder einen Ordner "
                                    "(oberste Ebene) aus.")
            return
        answer = QMessageBox.question(
            self, "Entfernen", f"{len(chosen)} Quelle(n) aus dem Fach entfernen.\n\n"
            "Sollen auch die Fragen aus diesen Dateien gelöscht werden?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
            | QMessageBox.StandardButton.Cancel)
        if answer == QMessageBox.StandardButton.Cancel:
            return
        files_by_src = self.scan_result.files if self.scan_result else {}
        for src in chosen:
            files = files_by_src.get(src.id, []) or ([src.path] if src.kind == "file" else [])
            self.db.remove_source(src, files, answer == QMessageBox.StandardButton.Yes)
        self._changed()
        self.scan()

    # --- Einlesen -----------------------------------------------------

    def _busy(self, busy: bool) -> None:
        for w in (self.scan_btn, self.gen_subject, self.gen_sel, self.gen_all, *self.src_btns):
            w.setEnabled(not busy)
        self.cancel_btn.setEnabled(busy)
        self.progress.setVisible(busy)

    def scan(self) -> None:
        if self.worker and self.cancel_btn.isEnabled():
            return
        sources, ignored = self.db.sources(), self.cfg.ignored()
        self._busy(True)
        self.progress.setRange(0, 0)
        self.worker = Worker(lambda w: vault.scan(sources, ignored), self)
        self.worker.finished.connect(self._scan_done)
        self.worker.failed.connect(self._failed)
        self.worker.start()

    def _scan_done(self, result: vault.ScanResult) -> None:
        self._busy(False)
        self.scan_result = result
        self.by_file = {}
        for s in result.sections:
            self.by_file.setdefault((s.subject_id, s.path), []).append(s)
        new_notes = self.db.upsert_note_questions(result.note_questions)
        for err in result.errors:
            self.log.appendPlainText(f"Fehler: {err}")
        if new_notes:
            self.log.appendPlainText(f"{new_notes} neue Fragen aus Notizen übernommen.")
            self.reload_subjects()
            self.questions_changed.emit()
        else:
            self.refresh_tree()

    @staticmethod
    def _status(s: vault.Section, done: dict[str, str]) -> str:
        if s.key not in done:
            return STATUS_NEW
        return STATUS_DONE if done[s.key] == s.hash else STATUS_CHANGED

    def _add_sections(self, parent: QTreeWidgetItem, sid: int, path: str,
                      done: dict[str, str]) -> set[str]:
        states = set()
        for s in self.by_file.get((sid, path), []):
            status = self._status(s, done)
            states.add(status)
            item = QTreeWidgetItem([s.label, status])
            item.setData(0, ROLE, ("sec", s.key))
            if status != STATUS_DONE:
                item.setForeground(1, Qt.GlobalColor.darkYellow)
            parent.addChild(item)
        return states

    @staticmethod
    def _aggregate(states: set[str]) -> str:
        if not states:
            return "–"
        return STATUS_DONE if states == {STATUS_DONE} else STATUS_OPEN

    def refresh_tree(self) -> None:
        self.tree.clear()
        sid = self.current_subject()
        if sid is None:
            self.title.setText("<i>Noch kein Fach – lege links eines an.</i>")
            self.summary.clear()
            return
        sources = self.db.sources(sid)
        self.title.setText(f"<h3>{self._subject_name(sid)}</h3>")
        done = self.db.generated_hashes(sid)
        files_by_src = self.scan_result.files if self.scan_result else {}
        total = pending = 0
        for src in sources:
            path = Path(src.path)
            icon = "📁 " if src.kind == "dir" else "📄 "
            suffix = "  (Altklausur)" if src.mode == "klausur" else ""
            top = QTreeWidgetItem([icon + path.name + suffix, ""])
            top.setToolTip(0, src.path)
            top.setData(0, ROLE, ("src", src.id))
            self.tree.addTopLevelItem(top)
            if src.kind == "dir":
                states = set()
                for f in files_by_src.get(src.id, []):
                    child = QTreeWidgetItem([str(Path(f).relative_to(path)), ""])
                    child.setToolTip(0, f)
                    s = self._add_sections(child, sid, f, done)
                    child.setText(1, self._aggregate(s))
                    top.addChild(child)
                    states |= s
            else:
                states = self._add_sections(top, sid, src.path, done)
            top.setText(1, self._aggregate(states) if path.exists() else "nicht gefunden")
        for (file_sid, _), secs in self.by_file.items():
            if file_sid == sid:
                total += len(secs)
                pending += sum(self._status(s, done) != STATUS_DONE for s in secs)
        if not sources:
            self.summary.setText("Noch keine Quellen. Füge Dateien oder Ordner hinzu.")
        else:
            self.summary.setText(f"{len(sources)} Quellen, {total} Abschnitte, "
                                 f"davon {pending} ohne aktuelle Fragen.")

    # --- Generieren ---------------------------------------------------

    def _selected_keys(self) -> set[str]:
        keys: set[str] = set()

        def collect(item: QTreeWidgetItem) -> None:
            data = item.data(0, ROLE)
            if data and data[0] == "sec":
                keys.add(data[1])
            for i in range(item.childCount()):
                collect(item.child(i))
        for item in self.tree.selectedItems():
            collect(item)
        return keys

    def generate(self, scope: str) -> None:
        kinds = {k for k, box in (("mc", self.mc), ("frei", self.frei)) if box.isChecked()}
        if not self.scan_result:
            QMessageBox.information(self, "Generieren", "Die Quellen werden noch eingelesen.")
            return
        sections = self.scan_result.sections
        sid = self.current_subject()
        if scope == "selection":
            keys = self._selected_keys()
            targets = [s for s in sections if s.subject_id == sid and s.key in keys]
        else:
            done = {}
            targets = []
            for s in sections:
                if scope == "subject" and s.subject_id != sid:
                    continue
                if s.subject_id not in done:
                    done[s.subject_id] = self.db.generated_hashes(s.subject_id)
                if self._status(s, done[s.subject_id]) != STATUS_DONE:
                    targets.append(s)
        if not targets:
            QMessageBox.information(self, "Generieren", "Keine Abschnitte zu bearbeiten. Füge "
                                    "Quellen hinzu oder wähle Abschnitte aus.")
            return
        if not kinds and any(s.kind != "klausur" for s in targets):
            QMessageBox.information(self, "Fragetypen", "Bitte mindestens einen Fragetyp wählen.")
            return
        try:
            client = ai.make_client(self.cfg.effective_api_key())
        except ai.AIError as e:
            QMessageBox.warning(self, "KI", str(e))
            return

        self.cfg.questions_per_section = self.count.value()
        config.save(self.cfg)
        count, model = self.count.value(), self.cfg.model

        def run(w: Worker):
            total = 0
            for i, s in enumerate(targets):
                if w.cancelled:
                    break
                w.progress.emit(i, len(targets), f"{Path(s.path).name} ({s.label}) …")
                try:
                    exam = ai.extract_exam(client, model, s) if s.kind == "klausur" else None
                    qs = exam.questions if exam else ai.generate_questions(client, model, s, count,
                                                                           kinds)
                except ai.AIError as e:
                    w.progress.emit(i, len(targets), f"  Fehler: {e}")
                    if "API-Key" in str(e) or "Verbindung" in str(e):
                        break
                    continue
                # Bereits übernommene Klausuraufgaben (gleiche Nummer) werden aktualisiert
                save = self.db.upsert_exam_question if s.kind == "klausur" else self.db.save_question
                new = sum(save(q) for q in qs)
                if exam:
                    self.db.sync_exam_set(s.path, [q.ext_key for q in qs], exam.minutes)
                self.db.mark_generated(s.subject_id, s.key, s.hash)
                total += new
                if exam:
                    msg = f"  {len(qs)} Aufgaben erkannt ({sum(q.max_points for q in qs):g} P.)"
                    if new < len(qs):
                        msg += f", davon {len(qs) - new} aktualisiert"
                    if exam.unsolved:
                        msg += f", {exam.unsolved} ohne Lösung"
                    msg += f" – Übungssatz „{Path(s.path).stem}“"
                else:
                    msg = f"  {new} Fragen erzeugt"
                w.progress.emit(i + 1, len(targets), msg)
            return total

        self._busy(True)
        self.progress.setRange(0, len(targets))
        self.progress.setValue(0)
        self.worker = Worker(run, self)
        self.worker.progress.connect(self._progress)
        self.worker.finished.connect(self._gen_done)
        self.worker.failed.connect(self._failed)
        self.worker.start()

    def _progress(self, done: int, total: int, msg: str) -> None:
        self.progress.setValue(done)
        self.log.appendPlainText(msg)
        if msg.startswith("  "):
            self.questions_changed.emit()

    def _gen_done(self, total: int) -> None:
        self._busy(False)
        self.log.appendPlainText(f"Fertig: {total} neue Fragen. Prüfe sie im Tab „Fragen“ und gib sie frei.")
        self.reload_subjects()
        self.questions_changed.emit()

    def _failed(self, msg: str) -> None:
        self._busy(False)
        self.log.appendPlainText(f"Fehler: {msg}")

    def cancel(self) -> None:
        if self.worker:
            self.worker.cancel()
            self.log.appendPlainText("Wird nach dem aktuellen Abschnitt abgebrochen …")
