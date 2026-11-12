"""Tab 'Prüfung': Probeprüfung zusammenstellen, durchführen und auswerten."""

import random
import time
from dataclasses import dataclass

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QDoubleSpinBox, QFormLayout, QGridLayout, QGroupBox,
    QHBoxLayout, QHeaderView, QLabel, QListWidget, QListWidgetItem, QMessageBox, QPlainTextEdit,
    QProgressBar, QPushButton, QScrollArea, QSpinBox, QSplitter, QStackedWidget, QTableWidget,
    QTableWidgetItem, QTextBrowser, QTextEdit, QVBoxLayout, QWidget,
)

from . import ai, config
from .db import KIND_LABEL, Database, Question
from .gui_common import (
    Table, Worker, grade_for, hard_breaks, open_source, question_title, source_text, split_table,
)
from .tab_questions import items_markdown

# Antwort je Frage: MC Index, Freitext Text, Zuordnung ein Index je Zeile (-1 = offen)
Answer = int | str | list[int] | None


def answered(a: Answer) -> bool:
    if isinstance(a, list):
        return all(i >= 0 for i in a)
    return a not in (None, "")


@dataclass
class Result:
    q: Question
    answer: Answer
    points: float = 0
    feedback: str = ""
    by: str = ""          # 'auto', 'ki', 'selbst' oder 'offen'
    attempt_id: int | None = None


def fill_table(q: Question) -> tuple[str, Table, str] | None:
    """Freitextfrage mit Tabelle zum Ausfüllen: (Text davor, Tabelle, Text danach)."""
    if q.kind != "frei":
        return None
    parts = split_table(q.text)
    return parts if parts and parts[1].fillable() else None


def comparison_markdown(q: Question, answer: str) -> str | None:
    """Deine Tabelle und die Lösungstabelle Zeile für Zeile nebeneinander, falls die Lösung
    dieselbe Form wie die Frage hat."""
    parts, solution = fill_table(q), split_table(q.answer)
    if not parts or not solution:
        return None
    qt, st = parts[1], solution[1]
    if len(st.rows) != len(qt.rows) or len(st.header) != len(qt.header):
        return None
    mine = split_table(answer) if answer else None
    at = mine[1] if mine and len(mine[1].rows) == len(qt.rows) else None
    fill = [j for j in range(len(qt.header)) if any(not row[j] for row in qt.rows)]

    header = []
    for j, h in enumerate(qt.header):
        if j not in fill:
            header.append(h)
        elif len(fill) == 1:
            header += ["Deine Antwort", "Musterlösung"]
        else:
            header += [f"{h} – deine", f"{h} – Lösung"]
    rows = []
    for i, row in enumerate(qt.rows):
        cells = []
        for j, given in enumerate(row):
            if j not in fill:
                cells.append(given)
            elif given:            # vorgegebene Zelle in einer Ausfüllspalte
                cells += [given, given]
            else:
                cells += [(at.rows[i][j] if at else "") or "–", st.rows[i][j] or "–"]
        rows.append(cells)
    md = f"### Deine Antwort und Musterlösung\n\n{Table(header, rows).markdown()}\n\n"
    notes = "\n\n".join(t for t in (solution[0], solution[2]) if t)
    if notes:
        md += f"**Hinweise zur Lösung:**\n\n{notes}\n\n"
    return md


class CellEdit(QTextEdit):
    """Eingabefeld in einer Tabellenzelle; die Zeile wächst mit dem Text (Tab = nächstes Feld)."""

    def __init__(self, text: str, table: QTableWidget, row: int):
        super().__init__()
        self.table, self.row = table, row
        self.setAcceptRichText(False)
        self.setTabChangesFocus(True)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setPlaceholderText("…")
        self.setPlainText(text)
        self.textChanged.connect(self.fit)

    def fit(self) -> None:
        """Zeilenhöhe an den längsten Text der Zeile anpassen (mindestens zwei Zeilen)."""
        needed = 2 * self.fontMetrics().lineSpacing()
        for col in range(self.table.columnCount()):
            w = self.table.cellWidget(self.row, col)
            if isinstance(w, CellEdit):
                w.document().setTextWidth(w.viewport().width())
                needed = max(needed, int(w.document().size().height()))
        self.table.setRowHeight(self.row, needed + 2 * self.frameWidth() + 4)

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self.fit()


def pick_questions(pool: list[Question], n: int, rates: dict[int, tuple[float, int]],
                   prefer_weak: bool) -> list[Question]:
    if not prefer_weak:
        return random.sample(pool, min(n, len(pool)))

    # Gewichtete Ziehung ohne Zurücklegen: schwache und unbekannte Fragen häufiger
    def weight(q: Question) -> float:
        if q.id not in rates:
            return 2.0
        return 1.0 + 4.0 * (1.0 - rates[q.id][0])
    keyed = sorted(pool, key=lambda q: random.random() ** (1.0 / weight(q)), reverse=True)
    picked = keyed[:n]
    random.shuffle(picked)
    return picked


class ExamTab(QWidget):
    def __init__(self, db: Database, cfg: config.Config, parent=None):
        super().__init__(parent)
        self.db, self.cfg = db, cfg
        self.questions: list[Question] = []
        self.answers: list[Answer] = []
        self.results: list[Result] = []
        self.index = 0
        self.remaining = 0
        self.started = 0.0
        self.worker: Worker | None = None
        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)

        self.stack = QStackedWidget()
        self.stack.addWidget(self._build_setup())
        self.stack.addWidget(self._build_run())
        self.stack.addWidget(self._build_grading())
        self.stack.addWidget(self._build_result())
        QVBoxLayout(self).addWidget(self.stack)

    # --- Einrichtung --------------------------------------------------

    def _build_setup(self) -> QWidget:
        w = QWidget()
        self.subjects = QListWidget()
        self.subjects.itemChanged.connect(self._fill_sets)
        self.count = QSpinBox()
        self.count.setRange(1, 200)
        self.count.setValue(20)
        self.minutes = QSpinBox()
        self.minutes.setRange(0, 600)
        self.minutes.setValue(30)
        self.minutes.setSpecialValueText("ohne Zeitlimit")
        self.minutes.setSuffix(" min")
        self.use_mc = QCheckBox("Multiple Choice")
        self.use_mc.setChecked(True)
        self.use_frei = QCheckBox("Freitext")
        self.use_frei.setChecked(True)
        self.use_zu = QCheckBox("Zuordnung / Ankreuzen")
        self.use_zu.setChecked(True)
        self.only_exam = QCheckBox("Nur Aufgaben aus Altklausuren")
        self.pset = QComboBox()
        self.pset.currentIndexChanged.connect(self._set_changed)
        self.only_approved = QCheckBox("Nur freigegebene Fragen")
        self.only_approved.setChecked(True)
        self.prefer_weak = QCheckBox("Schwächen bevorzugen (oft falsch beantwortete Fragen häufiger)")
        for box in (self.use_mc, self.use_frei, self.use_zu, self.only_exam, self.only_approved):
            box.toggled.connect(self._update_available)
        self.available = QLabel()
        start = QPushButton("Prüfung starten")
        start.setMinimumHeight(40)
        start.clicked.connect(self.start)

        types = QHBoxLayout()
        types.addWidget(self.use_mc)
        types.addWidget(self.use_frei)
        types.addWidget(self.use_zu)
        types.addStretch()
        form = QFormLayout()
        form.addRow("Übungssatz:", self.pset)
        form.addRow("Anzahl Fragen:", self.count)
        form.addRow("Zeitlimit:", self.minutes)
        form.addRow("Fragetypen:", types)
        form.addRow("", self.only_exam)
        form.addRow("", self.only_approved)
        form.addRow("", self.prefer_weak)

        box = self.subjects_box = QGroupBox("Fächer")
        QVBoxLayout(box).addWidget(self.subjects)
        lay = QVBoxLayout(w)
        lay.addWidget(QLabel("<h2>Probeprüfung</h2>"))
        lay.addWidget(box, 1)
        lay.addLayout(form)
        lay.addWidget(self.available)
        lay.addWidget(start)
        return w

    def _subject_ids(self, only_checked: bool) -> set[int]:
        items = (self.subjects.item(i) for i in range(self.subjects.count()))
        return {it.data(Qt.ItemDataRole.UserRole) for it in items
                if not only_checked or it.checkState() == Qt.CheckState.Checked}

    def reload(self) -> None:
        known, checked = self._subject_ids(False), self._subject_ids(True)
        self.subjects.blockSignals(True)
        self.subjects.clear()
        for s in self.db.subjects():
            item = QListWidgetItem(s.name)
            item.setData(Qt.ItemDataRole.UserRole, s.id)
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            # Neue Fächer sind angehakt, bei bekannten bleibt die Auswahl erhalten
            item.setCheckState(Qt.CheckState.Checked if s.id in checked or s.id not in known
                               else Qt.CheckState.Unchecked)
            self.subjects.addItem(item)
        self.subjects.blockSignals(False)

        self._fill_sets()

    def _fill_sets(self) -> None:
        """Nur Übungssätze anbieten, die Fragen aus den angehakten Fächern enthalten."""
        current = self.pset.currentData()
        self.sets = {s.id: s for s in self.db.practice_sets()}
        subjects, set_subjects = self._subject_ids(True), self.db.set_subjects()
        self.pset.blockSignals(True)
        self.pset.clear()
        self.pset.addItem("Keiner – Fragen aus den Fächern mischen", None)
        for s in self.sets.values():
            if set_subjects.get(s.id, set()) & subjects:
                self.pset.addItem(f"{s.name}  ({s.count} Fragen)", s.id)
        self.pset.setCurrentIndex(max(0, self.pset.findData(current)))
        self.pset.blockSignals(False)
        self._set_changed(keep_minutes=self.pset.currentData() == current)

    def _set_changed(self, _=None, keep_minutes: bool = False) -> None:
        set_id = self.pset.currentData()
        for w in (self.count, self.use_mc, self.use_frei, self.use_zu,
                  self.only_exam, self.only_approved, self.prefer_weak):
            w.setEnabled(set_id is None)
        if set_id is not None and self.sets[set_id].minutes and not keep_minutes:
            self.minutes.setValue(self.sets[set_id].minutes)
        self._update_available()

    def _pool(self) -> list[Question]:
        if (set_id := self.pset.currentData()) is not None:
            # Übungssatz: alle Fragen in seiner Reihenfolge, auch nicht freigegebene
            by_id = {q.id: q for q in self.db.questions()}
            return [by_id[i] for i in self.db.set_question_ids(set_id) if i in by_id]
        subjects = self._subject_ids(True)
        kinds = {k for k, b in (("mc", self.use_mc), ("frei", self.use_frei),
                                ("zuordnung", self.use_zu)) if b.isChecked()}
        return [q for q in self.db.questions()
                if q.subject_id in subjects and q.kind in kinds
                and (q.approved or not self.only_approved.isChecked())
                and (q.origin == "klausur" or not self.only_exam.isChecked())]

    def _update_available(self) -> None:
        pool = self._pool()
        if self.pset.currentData() is not None:
            self.available.setText(f"{len(pool)} Fragen, {sum(q.max_points for q in pool):g} "
                                   "Punkte. Der Übungssatz wird vollständig in seiner Reihenfolge "
                                   "gestellt.")
        else:
            self.available.setText(f"{len(pool)} passende Fragen verfügbar.")

    def start(self, _=None, questions: list[Question] | None = None) -> None:
        if questions is None:
            pool = self._pool()
            if not pool:
                QMessageBox.information(self, "Prüfung", "Keine passenden Fragen. Generiere Fragen "
                                        "im Tab „Fächer“ und gib sie im Tab „Fragen“ frei.")
                return
            if self.pset.currentData() is not None:
                questions = pool
            else:
                questions = pick_questions(pool, self.count.value(), self.db.success_rates(),
                                           self.prefer_weak.isChecked())
        if any(q.kind == "frei" for q in questions) and not self.cfg.effective_api_key():
            QMessageBox.information(self, "Freitext", "Ohne API-Key werden Freitextantworten nicht "
                                    "automatisch bewertet. Du kannst sie nach der Prüfung selbst "
                                    "bewerten.")
        self.questions = questions
        self.answers = [[-1] * len(q.items) if q.kind == "zuordnung" else None for q in questions]
        self.index = 0
        self.nav.clear()
        for i, q in enumerate(questions):
            self.nav.addItem(f"{i + 1}. {KIND_LABEL[q.kind]}")
        self.remaining = self.minutes.value() * 60
        self.started = time.time()
        self._tick(advance=False)
        if self.remaining:
            self.timer.start(1000)
        self.stack.setCurrentIndex(1)
        self._show_question()

    # --- Durchführung -------------------------------------------------

    def _build_run(self) -> QWidget:
        w = QWidget()
        self.header = QLabel()
        self.clock = QLabel()
        self.clock.setStyleSheet("font-size: 16pt; font-weight: bold;")
        head = QHBoxLayout()
        head.addWidget(self.header, 1)
        head.addWidget(self.clock)

        self.nav = QListWidget()
        self.nav.setMaximumWidth(170)
        self.nav.currentRowChanged.connect(self._jump)
        self.qtext = QTextBrowser()
        self.options = QListWidget()
        self.options.setWordWrap(True)
        self.options.setSpacing(4)
        self.options.itemSelectionChanged.connect(self._store_answer)
        self.free = QPlainTextEdit()
        self.free.setPlaceholderText("Deine Antwort …")
        self.free.textChanged.connect(self._store_answer)
        self.fill = QTableWidget()
        self.fill.setWordWrap(True)
        self.fill.verticalHeader().setVisible(False)
        self.fill.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.fill.setSelectionMode(QAbstractItemView.SelectionMode.NoSelection)
        self.fill.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.choices = QScrollArea()
        self.choices.setWidgetResizable(True)
        self.combos: list[QComboBox] = []

        prev = QPushButton("◀ Zurück")
        prev.clicked.connect(lambda: self._go(self.index - 1))
        nxt = QPushButton("Weiter ▶")
        nxt.clicked.connect(lambda: self._go(self.index + 1))
        submit = QPushButton("Abgeben")
        submit.clicked.connect(lambda: self.submit(confirm=True))
        abort = QPushButton("Abbrechen")
        abort.clicked.connect(self.abort)
        btns = QHBoxLayout()
        btns.addWidget(abort)
        btns.addStretch()
        btns.addWidget(prev)
        btns.addWidget(nxt)
        btns.addWidget(submit)

        right = QVBoxLayout()
        right.addWidget(self.qtext, 2)
        right.addWidget(self.options, 2)
        right.addWidget(self.free, 2)
        right.addWidget(self.fill, 3)
        right.addWidget(self.choices, 3)
        right.addLayout(btns)
        body = QHBoxLayout()
        body.addWidget(self.nav)
        body.addLayout(right, 1)
        lay = QVBoxLayout(w)
        lay.addLayout(head)
        lay.addLayout(body, 1)
        return w

    def _show_question(self) -> None:
        q, ans = self.questions[self.index], self.answers[self.index]
        self.header.setText(f"<b>Frage {self.index + 1} von {len(self.questions)}</b> · {q.subject}"
                            f" · {KIND_LABEL[q.kind]} ({q.max_points:g} P.)")
        table = fill_table(q)
        text = f"{table[0]}\n\n{table[2]}" if table else q.text
        self.qtext.setMarkdown(hard_breaks(text))
        self.nav.blockSignals(True)
        self.nav.setCurrentRow(self.index)
        self.nav.blockSignals(False)
        self.options.blockSignals(True)
        self.free.blockSignals(True)
        self.options.clear()
        self.options.setVisible(q.kind == "mc")
        self.free.setVisible(q.kind == "frei" and not table)
        self.fill.setVisible(bool(table))
        self.choices.setVisible(q.kind == "zuordnung")
        if q.kind == "mc":
            for i, opt in enumerate(q.options):
                self.options.addItem(f"{chr(65 + i)})  {opt}")
            if isinstance(ans, int):
                self.options.setCurrentRow(ans)
        elif q.kind == "zuordnung":
            self._build_choices(q, ans)
        elif table:
            self._build_fill(table[1], ans)
        else:
            self.free.setPlainText(ans if isinstance(ans, str) else "")
            self.free.setFocus()
        self.options.blockSignals(False)
        self.free.blockSignals(False)

    def _build_choices(self, q: Question, ans: list[int]) -> None:
        grid_w = QWidget()
        grid = QGridLayout(grid_w)
        self.combos = []
        for n, item in enumerate(q.items):
            label = QLabel(f"{n + 1}. {item['text']}")
            label.setWordWrap(True)
            combo = QComboBox()
            combo.addItem("–")
            combo.addItems(item["choices"])
            combo.setCurrentIndex(ans[n] + 1)
            combo.currentIndexChanged.connect(self._store_answer)
            grid.addWidget(label, n, 0)
            grid.addWidget(combo, n, 1, Qt.AlignmentFlag.AlignTop)
            self.combos.append(combo)
        grid.setColumnStretch(0, 1)
        grid.setRowStretch(len(q.items), 1)
        self.choices.setWidget(grid_w)

    def _build_fill(self, table: Table, ans: str | None) -> None:
        saved = split_table(ans)[1] if ans else None
        if saved and len(saved.rows) != len(table.rows):
            saved = None
        self.fill.clear()
        self.fill.setColumnCount(len(table.header))
        self.fill.setRowCount(len(table.rows))
        self.fill.setHorizontalHeaderLabels(table.header)
        hdr = self.fill.horizontalHeader()
        for j in range(len(table.header)):
            empty = any(not row[j] for row in table.rows)
            hdr.setSectionResizeMode(j, QHeaderView.ResizeMode.Stretch if empty
                                     else QHeaderView.ResizeMode.ResizeToContents)
        first = None
        for i, row in enumerate(table.rows):
            for j, given in enumerate(row):
                if given:
                    item = QTableWidgetItem(given)
                    item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
                    item.setBackground(self.palette().window())
                    self.fill.setItem(i, j, item)
                else:
                    edit = CellEdit(saved.rows[i][j].replace("<br>", "\n") if saved else "",
                                    self.fill, i)
                    edit.textChanged.connect(self._store_answer)
                    self.fill.setCellWidget(i, j, edit)
                    first = first or edit
        for i in range(len(table.rows)):
            self.fill.setRowHeight(i, 2 * self.fontMetrics().lineSpacing() + 10)
        if first:
            first.setFocus()

    def _store_answer(self) -> None:
        q = self.questions[self.index]
        if parts := fill_table(q):
            table = parts[1]
            def cell(i: int, j: int) -> str:
                w = self.fill.cellWidget(i, j)
                return w.toPlainText().strip() if w else table.rows[i][j]
            rows = [[cell(i, j) for j in range(len(table.header))] for i in range(len(table.rows))]
            # Nur ausgefüllte (nicht vorgegebene) Zellen zählen als Antwort
            filled = any(rows[i][j] for i, row in enumerate(table.rows)
                         for j, given in enumerate(row) if not given)
            self.answers[self.index] = Table(table.header, rows).markdown() if filled else None
        elif q.kind == "mc":
            row = self.options.currentRow()
            self.answers[self.index] = row if self.options.selectedItems() else None
        elif q.kind == "zuordnung":
            self.answers[self.index] = [c.currentIndex() - 1 for c in self.combos]
        elif q.kind == "frei":
            self.answers[self.index] = self.free.toPlainText()
        done = answered(self.answers[self.index])
        self.nav.item(self.index).setText(f"{self.index + 1}. {KIND_LABEL[q.kind]}{' ✓' if done else ''}")

    def _go(self, i: int) -> None:
        if 0 <= i < len(self.questions):
            self.index = i
            self._show_question()

    def _jump(self, row: int) -> None:
        if row >= 0:
            self._go(row)

    def _tick(self, advance: bool = True) -> None:
        if not self.remaining and not self.timer.isActive():
            self.clock.setText("")
            return
        if advance:
            self.remaining -= 1
        m, s = divmod(max(self.remaining, 0), 60)
        self.clock.setText(f"⏱ {m:02d}:{s:02d}")
        self.clock.setStyleSheet("font-size: 16pt; font-weight: bold;"
                                 + (" color: #c0392b;" if self.remaining < 60 else ""))
        if advance and self.remaining <= 0:
            self.timer.stop()
            QMessageBox.information(self, "Zeit abgelaufen", "Die Zeit ist um – die Prüfung wird "
                                    "abgegeben.")
            self.submit(confirm=False)

    def abort(self) -> None:
        if QMessageBox.question(self, "Abbrechen", "Prüfung abbrechen? Antworten werden nicht "
                                "gewertet.") == QMessageBox.StandardButton.Yes:
            self.timer.stop()
            self.stack.setCurrentIndex(0)

    # --- Bewertung ----------------------------------------------------

    def _build_grading(self) -> QWidget:
        w = QWidget()
        self.grade_label = QLabel("Freitextantworten werden bewertet …")
        self.grade_bar = QProgressBar()
        lay = QVBoxLayout(w)
        lay.addStretch()
        lay.addWidget(self.grade_label, 0, Qt.AlignmentFlag.AlignCenter)
        lay.addWidget(self.grade_bar)
        lay.addStretch()
        return w

    def submit(self, confirm: bool) -> None:
        open_count = sum(not answered(a) for a in self.answers)
        if confirm:
            msg = "Prüfung abgeben?"
            if open_count:
                msg += f"\n\n{open_count} Frage(n) sind noch unbeantwortet."
            if QMessageBox.question(self, "Abgeben", msg) != QMessageBox.StandardButton.Yes:
                return
        self.timer.stop()
        self.duration = time.time() - self.started

        self.results = []
        for q, a in zip(self.questions, self.answers):
            r = Result(q, a)
            if q.kind == "mc":
                r.by = "auto"
                r.points = q.max_points if a == q.correct_index else 0
            elif q.kind == "zuordnung":
                r.by = "auto"
                right = sum(x == item["correct"] for x, item in zip(a, q.items))
                r.points = round(q.max_points * right / len(q.items), 2) if q.items else 0
            else:
                r.by = "offen"
            self.results.append(r)

        to_grade = [r for r in self.results if r.by == "offen"]
        key = self.cfg.effective_api_key()
        if not to_grade or not key:
            self._grading_done()
            return

        client, model = ai.make_client(key), self.cfg.model

        def run(w: Worker):
            errors = []
            for i, r in enumerate(to_grade):
                w.progress.emit(i, len(to_grade), "")
                try:
                    g = ai.grade_answer(client, model, r.q, r.answer or "")
                    r.points, r.feedback, r.by = g.points, g.feedback, "ki"
                except ai.AIError as e:
                    errors.append(str(e))
            return errors

        self.grade_bar.setRange(0, len(to_grade))
        self.grade_bar.setValue(0)
        self.stack.setCurrentIndex(2)
        self.worker = Worker(run, self)
        self.worker.progress.connect(lambda done, total, _: self.grade_bar.setValue(done))
        self.worker.finished.connect(self._grading_done)
        self.worker.failed.connect(lambda msg: self._grading_done([msg]))
        self.worker.start()

    def _grading_done(self, errors: list[str] | None = None) -> None:
        for r in self.results:
            if r.by == "offen":
                r.feedback = ("Nicht automatisch bewertet – vergleiche mit der Musterlösung und "
                              "vergib die Punkte unten selbst.")
            r.attempt_id = self.db.record_attempt(r.q.id, r.points, r.q.max_points)
        if errors:
            QMessageBox.warning(self, "Bewertung", "Einige Antworten konnten nicht bewertet werden:\n"
                                + "\n".join(sorted(set(errors))))
        self._show_results()

    # --- Ergebnis -----------------------------------------------------

    def _build_result(self) -> QWidget:
        w = QWidget()
        self.summary = QLabel()
        self.summary.setTextFormat(Qt.TextFormat.RichText)
        self.rtable = QTableWidget(0, 5)
        self.rtable.setHorizontalHeaderLabels(["Nr.", "Punkte", "Typ", "Fach", "Frage"])
        self.rtable.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.rtable.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.rtable.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.rtable.verticalHeader().setVisible(False)
        self.rtable.setWordWrap(False)
        hdr = self.rtable.horizontalHeader()
        hdr.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        for col in range(4):
            hdr.setSectionResizeMode(col, QHeaderView.ResizeMode.ResizeToContents)
        self.rtable.itemSelectionChanged.connect(self._show_detail)
        self.detail = QTextBrowser()

        self.self_points = QDoubleSpinBox()
        self.self_points.setDecimals(1)
        self.self_points.setSingleStep(0.5)
        self.self_points.setSuffix(" Punkte")
        set_points = QPushButton("Punkte übernehmen")
        set_points.clicked.connect(self._override_points)
        self.override_row = QWidget()
        orow = QHBoxLayout(self.override_row)
        orow.setContentsMargins(0, 0, 0, 0)
        orow.addWidget(QLabel("Bewertung anpassen:"))
        orow.addWidget(self.self_points)
        orow.addWidget(set_points)
        orow.addStretch()

        src = QPushButton("Quelle öffnen")
        src.clicked.connect(self._open_source)
        retry = QPushButton("Falsche Fragen wiederholen")
        retry.clicked.connect(self._retry_wrong)
        new = QPushButton("Neue Prüfung")
        new.clicked.connect(lambda: self.stack.setCurrentIndex(0))
        btns = QHBoxLayout()
        btns.addWidget(src)
        btns.addStretch()
        btns.addWidget(retry)
        btns.addWidget(new)

        bottom = QWidget()
        bl = QVBoxLayout(bottom)
        bl.setContentsMargins(0, 0, 0, 0)
        bl.addWidget(self.detail, 1)
        bl.addWidget(self.override_row)
        split = QSplitter(Qt.Orientation.Vertical)
        split.addWidget(self.rtable)
        split.addWidget(bottom)
        split.setSizes([250, 400])
        lay = QVBoxLayout(w)
        lay.addWidget(self.summary)
        lay.addWidget(split, 1)
        lay.addLayout(btns)
        return w

    def _show_results(self) -> None:
        got = sum(r.points for r in self.results)
        total = sum(r.q.max_points for r in self.results)
        pct = 100 * got / total if total else 0
        m, s = divmod(int(self.duration), 60)
        open_n = sum(r.by == "offen" for r in self.results)
        text = (f"<h2>Ergebnis: {got:g} / {total:g} Punkte ({pct:.0f} %) – Note {grade_for(pct)}</h2>"
                f"Bearbeitungszeit: {m} min {s} s")
        if open_n:
            text += f" · <b>{open_n} Freitextantwort(en) noch selbst bewerten</b>"
        self.summary.setText(text)

        self.rtable.setRowCount(len(self.results))
        for row, r in enumerate(self.results):
            full = r.points >= r.q.max_points
            mark = "✓" if full else ("◐" if r.points > 0 else "✗")
            if r.by == "offen":
                mark = "?"
            for col, val in enumerate((str(row + 1), f"{mark} {r.points:g}/{r.q.max_points:g}",
                                       KIND_LABEL[r.q.kind], r.q.subject, question_title(r.q))):
                self.rtable.setItem(row, col, QTableWidgetItem(val))
        self.stack.setCurrentIndex(3)
        self.rtable.selectRow(0)

    def _current(self) -> Result | None:
        rows = {i.row() for i in self.rtable.selectedIndexes()}
        return self.results[rows.pop()] if rows else None

    def _show_detail(self) -> None:
        r = self._current()
        if not r:
            return
        q = r.q
        md = f"### Frage\n\n{hard_breaks(q.text)}\n\n"
        if q.kind == "mc":
            for i, opt in enumerate(q.options):
                tags = []
                if i == q.correct_index:
                    tags.append("**✓ richtig**")
                if i == r.answer:
                    tags.append("*← deine Antwort*")
                md += f"{chr(65 + i)}) {opt} {' '.join(tags)}\n\n"
            if r.answer is None:
                md += "*Nicht beantwortet.*\n\n"
        elif q.kind == "zuordnung":
            md += items_markdown(q, r.answer)
            if q.answer:
                md += f"### Musterlösung\n\n{hard_breaks(q.answer)}\n\n"
        elif compared := comparison_markdown(q, r.answer or ""):
            parts = fill_table(q)
            md = f"### Frage\n\n{hard_breaks(parts[0])}\n\n{hard_breaks(parts[2])}\n\n"
            md += hard_breaks(compared)
        else:
            answer = (r.answer or "").strip() or "*(keine Antwort)*"
            md += (f"### Deine Antwort\n\n{hard_breaks(answer)}\n\n"
                   f"### Musterlösung\n\n{hard_breaks(q.answer)}\n\n")
        if q.kind == "frei" and r.feedback:
            md += f"### Bewertung ({r.points:g}/{q.max_points:g})\n\n{r.feedback}\n\n"
        if q.explanation:
            md += f"### Erläuterung\n\n{q.explanation}\n\n"
        if q.source_path:
            md += f"*Quelle: {source_text(q)}*\n"
        self.detail.setMarkdown(md)
        self.override_row.setVisible(q.kind == "frei")
        self.self_points.setRange(0, q.max_points)
        self.self_points.setValue(r.points)

    def _override_points(self) -> None:
        r = self._current()
        if not r:
            return
        row = self.results.index(r)
        r.points, r.by = self.self_points.value(), "selbst"
        if r.feedback.startswith("Nicht automatisch"):
            r.feedback = "Selbst bewertet."
        self.db.update_attempt(r.attempt_id, r.points)
        self._show_results()
        self.rtable.selectRow(row)

    def _open_source(self) -> None:
        if r := self._current():
            open_source(r.q)

    def _retry_wrong(self) -> None:
        wrong = [r.q for r in self.results if r.points < r.q.max_points]
        if not wrong:
            QMessageBox.information(self, "Wiederholen", "Alles richtig – nichts zu wiederholen!")
            return
        random.shuffle(wrong)
        self.start(questions=wrong)
