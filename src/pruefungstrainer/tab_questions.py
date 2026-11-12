"""Tab 'Fragen': generierte und eigene Fragen prüfen, bearbeiten, freigeben und zu
Übungssätzen zusammenstellen."""

import sqlite3

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView, QButtonGroup, QCheckBox, QComboBox, QDialog, QDialogButtonBox,
    QDoubleSpinBox, QFormLayout, QHBoxLayout, QHeaderView, QInputDialog, QLabel, QLineEdit, QMessageBox, QPlainTextEdit, QPushButton,
    QRadioButton, QSpinBox, QSplitter, QTableWidget, QTableWidgetItem, QTextBrowser, QVBoxLayout,
    QWidget,
)

from .db import KIND_LABEL, ORIGIN_LABEL, Database, Question, Subject
from .gui_common import hard_breaks, open_source, question_title, source_text

ALL = "Alle Fächer"
NEW_SET = "Neuer Übungssatz …"


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def items_markdown(q: Question, answers: list[int] | None = None,
                   with_solution: bool = True) -> str:
    """Zuordnungszeilen als Tabelle, mit Lösung und optional den Antworten des Prüflings."""
    head = ["Nr.", "Aussage"]
    if with_solution:
        head.append("Lösung")
    else:
        head.append("Auswahl")
    if answers is not None:
        head.append("Deine Wahl")
    md = "| " + " | ".join(head) + " |\n|" + "---|" * len(head) + "\n"
    for n, item in enumerate(q.items):
        row = [str(n + 1), _cell(item["text"])]
        if with_solution:
            row.append("**" + _cell(item["choices"][item["correct"]]) + "**"
                       if item["correct"] >= 0 else "?")
        else:
            row.append(_cell(" / ".join(item["choices"])))
        if answers is not None:
            a = answers[n]
            row.append("✓" if a == item["correct"]
                       else f"✗ {_cell(item['choices'][a]) if a >= 0 else '–'}")
        md += "| " + " | ".join(row) + " |\n"
    return md + "\n"


def items_to_text(items: list[dict]) -> str:
    return "\n".join(f"{i['text']} :: " + " | ".join(
        ("*" if n == i["correct"] else "") + c for n, c in enumerate(i["choices"])) for i in items)


def items_from_text(text: str) -> list[dict] | None:
    """Liest 'Aussage :: Wahl A | *Wahl B'-Zeilen; None bei Formatfehlern."""
    items = []
    for line in text.splitlines():
        if not line.strip():
            continue
        if "::" not in line:
            return None
        statement, _, rest = line.rpartition("::")
        choices = [c.strip() for c in rest.split("|") if c.strip()]
        marked = [n for n, c in enumerate(choices) if c.startswith("*")]
        if not statement.strip() or len(choices) < 2 or len(marked) != 1:
            return None
        items.append({"text": statement.strip(), "choices": [c.lstrip("*").strip() for c in choices],
                      "correct": marked[0]})
    return items


def question_markdown(q: Question, with_solution: bool = True) -> str:
    md = hard_breaks(q.text) + "\n\n"
    if q.kind == "mc":
        for i, opt in enumerate(q.options):
            mark = " **✓**" if with_solution and i == q.correct_index else ""
            md += f"{chr(65 + i)}) {opt}{mark}\n\n"
    if q.kind == "zuordnung":
        md += items_markdown(q, with_solution=with_solution)
    md += f"*{q.max_points:g} Punkte*\n\n"
    if with_solution:
        if q.kind != "mc" and q.answer:
            md += f"---\n\n**Musterlösung:**\n\n{hard_breaks(q.answer)}\n\n"
        if q.explanation:
            md += f"**Erläuterung:**\n\n{q.explanation}\n\n"
        if q.source_path:
            md += f"*Quelle: {source_text(q)}*\n"
    return md


def choose_set(db: Database, parent: QWidget) -> int | None:
    """Fragt nach einem bestehenden oder neuen Übungssatz; gibt seine ID zurück."""
    sets = db.practice_sets()
    names = [s.name for s in sets] + [NEW_SET]
    name, ok = QInputDialog.getItem(parent, "Zu Übungssatz hinzufügen", "Übungssatz:", names, 0,
                                    False)
    if not ok:
        return None
    if name != NEW_SET:
        return next(s.id for s in sets if s.name == name)
    name, ok = QInputDialog.getText(parent, "Neuer Übungssatz", "Name des Übungssatzes:")
    if not ok or not name.strip():
        return None
    try:
        return db.add_practice_set(name.strip())
    except sqlite3.IntegrityError:
        QMessageBox.warning(parent, "Übungssatz", f"Einen Übungssatz „{name.strip()}“ gibt es schon.")
        return None


class QuestionDialog(QDialog):
    def __init__(self, q: Question, subjects: list[Subject], parent=None):
        super().__init__(parent)
        self.setWindowTitle("Frage bearbeiten" if q.id else "Neue Frage")
        self.resize(700, 650)
        self.q = q

        self.kind = QComboBox()
        self.kind.addItem("Multiple Choice", "mc")
        self.kind.addItem("Freitext", "frei")
        self.kind.addItem("Zuordnung / Ankreuzen", "zuordnung")
        self.kind.setCurrentIndex(self.kind.findData(q.kind))
        self.subject = QComboBox()
        for s in subjects:
            self.subject.addItem(s.name, s.id)
        if (i := self.subject.findData(q.subject_id)) >= 0:
            self.subject.setCurrentIndex(i)
        self.difficulty = QComboBox()
        self.difficulty.addItems(["leicht", "mittel", "schwer"])
        self.difficulty.setCurrentIndex(q.difficulty - 1)
        self.points = QDoubleSpinBox()
        self.points.setRange(0, 999)
        self.points.setDecimals(1)
        self.points.setSingleStep(0.5)
        self.points.setSpecialValueText("Standard (MC 1, Freitext 3, Zuordnung 1 je Zeile)")
        self.points.setValue(q.points)
        self.text = QPlainTextEdit(q.text)
        self.text.setPlaceholderText("Fragetext (Markdown möglich)")

        self.mc_box = QWidget()
        mc_lay = QVBoxLayout(self.mc_box)
        mc_lay.setContentsMargins(0, 0, 0, 0)
        mc_lay.addWidget(QLabel("Antwortoptionen (richtige markieren):"))
        self.correct = QButtonGroup(self)
        self.options: list[QLineEdit] = []
        for i in range(max(4, len(q.options))):
            row = QHBoxLayout()
            radio = QRadioButton(chr(65 + i))
            self.correct.addButton(radio, i)
            edit = QLineEdit(q.options[i] if i < len(q.options) else "")
            self.options.append(edit)
            row.addWidget(radio)
            row.addWidget(edit)
            mc_lay.addLayout(row)
        if 0 <= q.correct_index < len(self.options):
            self.correct.button(q.correct_index).setChecked(True)

        self.items_box = QWidget()
        items_lay = QVBoxLayout(self.items_box)
        items_lay.setContentsMargins(0, 0, 0, 0)
        items_lay.addWidget(QLabel("Eine Zeile je Aussage: <code>Aussage :: Wahl A | *Wahl B</code> "
                                   "– der Stern markiert die richtige Wahl."))
        self.items = QPlainTextEdit(items_to_text(q.items))
        self.items.setPlaceholderText("Typisch für EFQM ist das Prinzip der Selbstbewertung. :: "
                                      "*zutreffend | nicht zutreffend")
        items_lay.addWidget(self.items)

        self.answer_label = QLabel("Musterlösung:")
        self.answer = QPlainTextEdit(q.answer)
        self.explanation = QPlainTextEdit(q.explanation)
        self.explanation.setMaximumHeight(100)
        self.source = QLabel(source_text(q) or "–")
        self.approved = QCheckBox("Freigegeben (wird in Prüfungen verwendet)")
        self.approved.setChecked(q.approved or q.id is None)

        form = QFormLayout()
        form.addRow("Typ:", self.kind)
        form.addRow("Fach:", self.subject)
        form.addRow("Schwierigkeit:", self.difficulty)
        form.addRow("Punkte:", self.points)
        form.addRow("Quelle:", self.source)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save
                                   | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        lay = QVBoxLayout(self)
        lay.addLayout(form)
        lay.addWidget(QLabel("Frage:"))
        lay.addWidget(self.text, 2)
        lay.addWidget(self.mc_box)
        lay.addWidget(self.items_box, 2)
        lay.addWidget(self.answer_label)
        lay.addWidget(self.answer, 2)
        lay.addWidget(QLabel("Erläuterung (optional):"))
        lay.addWidget(self.explanation)
        lay.addWidget(self.approved)
        lay.addWidget(buttons)

        self.kind.currentIndexChanged.connect(self._kind_changed)
        self._kind_changed()

    def _kind_changed(self) -> None:
        kind = self.kind.currentData()
        self.mc_box.setVisible(kind == "mc")
        self.items_box.setVisible(kind == "zuordnung")
        self.answer_label.setVisible(kind == "frei")
        self.answer.setVisible(kind == "frei")

    def accept(self) -> None:
        kind = self.kind.currentData()
        text = self.text.toPlainText().strip()
        if not text:
            QMessageBox.warning(self, "Frage", "Bitte einen Fragetext eingeben.")
            return
        options = [e.text().strip() for e in self.options]
        if kind == "mc":
            filled = [o for o in options if o]
            idx = self.correct.checkedId()
            if len(filled) < 2 or idx < 0 or not options[idx]:
                QMessageBox.warning(self, "Frage", "Mindestens zwei Optionen ausfüllen und die "
                                    "richtige markieren.")
                return
            # Leere Optionen entfernen, Index nachziehen
            idx = sum(1 for o in options[:idx] if o)
            self.q.options, self.q.correct_index = filled, idx
            self.q.answer = filled[idx]
            self.q.items = []
        elif kind == "zuordnung":
            items = items_from_text(self.items.toPlainText())
            if not items:
                QMessageBox.warning(self, "Frage", "Bitte mindestens eine Zeile im Format "
                                    "„Aussage :: Wahl A | *Wahl B“ eingeben, mit genau einem Stern "
                                    "je Zeile.")
                return
            self.q.options, self.q.correct_index, self.q.items = [], -1, items
        else:
            self.q.options, self.q.correct_index, self.q.items = [], -1, []
            self.q.answer = self.answer.toPlainText().strip()
            if not self.q.answer:
                QMessageBox.warning(self, "Frage", "Bitte eine Musterlösung eingeben – sie wird "
                                    "zur Bewertung gebraucht.")
                return
        self.q.kind, self.q.text = kind, text
        self.q.subject_id = self.subject.currentData()
        self.q.difficulty = self.difficulty.currentIndex() + 1
        self.q.points = self.points.value()
        self.q.explanation = self.explanation.toPlainText().strip()
        self.q.approved = self.approved.isChecked()
        super().accept()


class QuestionsTab(QWidget):
    questions_changed = Signal()
    sets_changed = Signal()

    def __init__(self, db: Database, parent=None):
        super().__init__(parent)
        self.db = db
        self.all: list[Question] = []
        self.shown: list[Question] = []

        self.subject = QComboBox()
        self.status = QComboBox()
        self.status.addItems(["Alle", "Nicht freigegeben", "Freigegeben"])
        self.search = QLineEdit()
        self.search.setPlaceholderText("Suchen …")
        for w in (self.subject, self.status):
            w.currentIndexChanged.connect(self.apply_filter)
        self.search.textChanged.connect(self.apply_filter)
        filt = QHBoxLayout()
        filt.addWidget(self.subject)
        filt.addWidget(self.status)
        filt.addWidget(self.search, 1)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["✓", "Typ", "Fach", "Frage", "Herkunft"])
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.setWordWrap(False)
        hdr = self.table.horizontalHeader()
        hdr.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        for col in (0, 1, 2, 4):
            hdr.setSectionResizeMode(col, QHeaderView.ResizeMode.ResizeToContents)
        self.table.itemSelectionChanged.connect(self.show_preview)
        self.table.doubleClicked.connect(self.edit)

        self.preview = QTextBrowser()
        self.preview.setOpenLinks(False)
        split = QSplitter(Qt.Orientation.Vertical)
        split.addWidget(self.table)
        split.addWidget(self.preview)
        split.setSizes([400, 250])

        btns = QHBoxLayout()
        for label, slot in (("Neue Frage", self.new), ("Bearbeiten", self.edit),
                            ("Freigeben", lambda: self.approve(True)),
                            ("Freigabe entziehen", lambda: self.approve(False)),
                            ("Alle angezeigten freigeben", self.approve_all),
                            ("Zu Übungssatz …", self.add_to_set),
                            ("Löschen", self.delete), ("Quelle öffnen", self.open_source)):
            b = QPushButton(label)
            b.clicked.connect(slot)
            btns.addWidget(b)
        btns.addStretch()
        self.count = QLabel()
        btns.addWidget(self.count)

        lay = QVBoxLayout(self)
        lay.addLayout(filt)
        lay.addWidget(split, 1)
        lay.addLayout(btns)

    def reload(self) -> None:
        self.all = self.db.questions()
        current = self.subject.currentData()
        self.subject.blockSignals(True)
        self.subject.clear()
        self.subject.addItem(ALL, None)
        for s in self.db.subjects():
            self.subject.addItem(s.name, s.id)
        self.subject.setCurrentIndex(max(0, self.subject.findData(current)))
        self.subject.blockSignals(False)
        self.apply_filter()

    def apply_filter(self) -> None:
        subj, status = self.subject.currentData(), self.status.currentIndex()
        needle = self.search.text().lower()
        self.shown = [
            q for q in self.all
            if (subj is None or q.subject_id == subj)
            and (status == 0 or (status == 1) != q.approved)
            and (not needle or needle in q.text.lower() or needle in q.source_path.lower())
        ]
        self.table.setRowCount(len(self.shown))
        for row, q in enumerate(self.shown):
            for col, val in enumerate(("✓" if q.approved else "", KIND_LABEL[q.kind], q.subject,
                                       question_title(q), ORIGIN_LABEL.get(q.origin, q.origin))):
                item = QTableWidgetItem(val)
                if col == 3:
                    item.setToolTip(source_text(q))
                self.table.setItem(row, col, item)
        pending = sum(not q.approved for q in self.all)
        self.count.setText(f"{len(self.shown)} von {len(self.all)} Fragen · {pending} nicht freigegeben")
        self.show_preview()

    def selected(self) -> list[Question]:
        rows = sorted({i.row() for i in self.table.selectedIndexes()})
        return [self.shown[r] for r in rows]

    def show_preview(self) -> None:
        sel = self.selected()
        self.preview.setMarkdown(question_markdown(sel[0]) if sel else "")

    def _changed(self) -> None:
        self.reload()
        self.questions_changed.emit()

    def new(self) -> None:
        subjects = self.db.subjects()
        if not subjects:
            QMessageBox.information(self, "Fach", "Lege zuerst im Tab „Fächer“ ein Fach an.")
            return
        q = Question(kind="frei", text="", origin="manuell", subject_id=self.subject.currentData())
        if QuestionDialog(q, self.db.subjects(), self).exec():
            self.db.save_question(q)
            self._changed()

    def edit(self) -> None:
        sel = self.selected()
        if not sel:
            return
        q = sel[0]
        if QuestionDialog(q, self.db.subjects(), self).exec():
            self.db.save_question(q)
            self._changed()

    def approve(self, value: bool) -> None:
        self.db.set_approved([q.id for q in self.selected()], value)
        self._changed()

    def approve_all(self) -> None:
        if QMessageBox.question(self, "Freigeben", f"{len(self.shown)} angezeigte Fragen "
                                "freigeben?") == QMessageBox.StandardButton.Yes:
            self.db.set_approved([q.id for q in self.shown], True)
            self._changed()

    def add_to_set(self) -> None:
        sel = self.selected()
        if not sel:
            QMessageBox.information(self, "Übungssatz", "Markiere zuerst eine oder mehrere Fragen.")
            return
        set_id = choose_set(self.db, self)
        if set_id is not None:
            self.db.add_to_set(set_id, [q.id for q in sel])
            self.sets_changed.emit()

    def delete(self) -> None:
        sel = self.selected()
        if not sel:
            return
        note = any(q.origin == "notiz" for q in sel)
        msg = f"{len(sel)} Frage(n) löschen?"
        if note:
            msg += ("\n\nFragen aus Notizen kommen beim nächsten Einlesen wieder – "
                    "entferne sie dafür in Obsidian.")
        if QMessageBox.question(self, "Löschen", msg) == QMessageBox.StandardButton.Yes:
            self.db.delete_questions([q.id for q in sel])
            self._changed()

    def open_source(self) -> None:
        if sel := self.selected():
            open_source(sel[0])
