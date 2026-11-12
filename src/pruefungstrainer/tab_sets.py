"""Tab 'Übungssätze': feste Zusammenstellungen von Fragen, z. B. eine Altklausur."""

import sqlite3

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView, QHBoxLayout, QHeaderView, QInputDialog, QLabel, QListWidget,
    QListWidgetItem, QMessageBox, QPushButton, QSpinBox, QSplitter, QTableWidget,
    QTableWidgetItem, QTextBrowser, QVBoxLayout, QWidget,
)

from .db import KIND_LABEL, Database, Question
from .gui_common import question_title
from .tab_questions import question_markdown

ROLE = Qt.ItemDataRole.UserRole


class SetsTab(QWidget):
    sets_changed = Signal()

    def __init__(self, db: Database, parent=None):
        super().__init__(parent)
        self.db = db
        self.questions: list[Question] = []

        # --- links: Sätze
        self.list = QListWidget()
        self.list.currentRowChanged.connect(lambda _: self.show_set())
        left_btns = QVBoxLayout()
        for label, slot in (("Neuer Übungssatz …", self.new_set), ("Umbenennen …", self.rename_set),
                            ("Löschen", self.delete_set)):
            b = QPushButton(label)
            b.clicked.connect(slot)
            left_btns.addWidget(b)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(QLabel("<b>Übungssätze</b>"))
        ll.addWidget(self.list, 1)
        ll.addLayout(left_btns)

        # --- rechts: Fragen des Satzes
        self.title = QLabel()
        self.minutes = QSpinBox()
        self.minutes.setRange(0, 600)
        self.minutes.setSuffix(" min")
        self.minutes.setSpecialValueText("keins")
        self.minutes.valueChanged.connect(self._minutes_changed)
        head = QHBoxLayout()
        head.addWidget(self.title, 1)
        head.addWidget(QLabel("Zeitlimit:"))
        head.addWidget(self.minutes)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["Nr.", "Typ", "Punkte", "Fach", "Frage"])
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.setWordWrap(False)
        hdr = self.table.horizontalHeader()
        hdr.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        for col in range(4):
            hdr.setSectionResizeMode(col, QHeaderView.ResizeMode.ResizeToContents)
        self.table.itemSelectionChanged.connect(self.show_preview)
        self.preview = QTextBrowser()
        self.summary = QLabel()

        btns = QHBoxLayout()
        for label, slot in (("▲ Nach oben", lambda: self.move(-1)),
                            ("▼ Nach unten", lambda: self.move(1)),
                            ("Aus dem Satz entfernen", self.remove)):
            b = QPushButton(label)
            b.clicked.connect(slot)
            btns.addWidget(b)
        btns.addStretch()
        btns.addWidget(QLabel("<i>Fragen fügst du im Tab „Fragen“ mit „Zu Übungssatz …“ hinzu.</i>"))

        vsplit = QSplitter(Qt.Orientation.Vertical)
        vsplit.addWidget(self.table)
        vsplit.addWidget(self.preview)
        vsplit.setSizes([400, 250])
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addLayout(head)
        rl.addWidget(vsplit, 1)
        rl.addWidget(self.summary)
        rl.addLayout(btns)

        split = QSplitter()
        split.addWidget(left)
        split.addWidget(right)
        split.setSizes([260, 840])
        QVBoxLayout(self).addWidget(split)

    def current_set(self) -> int | None:
        item = self.list.currentItem()
        return item.data(ROLE) if item else None

    def reload(self, select: int | None = None) -> None:
        select = select if select is not None else self.current_set()
        self.list.blockSignals(True)
        self.list.clear()
        for s in self.db.practice_sets():
            item = QListWidgetItem(f"{s.name}  ({s.count})")
            item.setData(ROLE, s.id)
            self.list.addItem(item)
            if s.id == select:
                self.list.setCurrentItem(item)
        if self.list.currentRow() < 0 and self.list.count():
            self.list.setCurrentRow(0)
        self.list.blockSignals(False)
        self.show_set()

    def _changed(self, select: int | None = None) -> None:
        self.reload(select)
        self.sets_changed.emit()

    def show_set(self, select_row: int | None = None) -> None:
        set_id = self.current_set()
        sets = {s.id: s for s in self.db.practice_sets()}
        if set_id is None or set_id not in sets:
            self.title.setText("<i>Noch kein Übungssatz – lege links einen an.</i>")
            self.questions = []
        else:
            s = sets[set_id]
            self.title.setText(f"<h3>{s.name}</h3>")
            self.minutes.blockSignals(True)
            self.minutes.setValue(s.minutes)
            self.minutes.blockSignals(False)
            by_id = {q.id: q for q in self.db.questions()}
            self.questions = [by_id[i] for i in self.db.set_question_ids(set_id) if i in by_id]
        self.minutes.setEnabled(set_id is not None)

        self.table.setRowCount(len(self.questions))
        for row, q in enumerate(self.questions):
            for col, val in enumerate((str(row + 1), KIND_LABEL[q.kind], f"{q.max_points:g}",
                                       q.subject, question_title(q))):
                self.table.setItem(row, col, QTableWidgetItem(val))
        self.summary.setText(f"{len(self.questions)} Fragen, "
                             f"{sum(q.max_points for q in self.questions):g} Punkte")
        if select_row is not None:
            self.table.selectRow(select_row)
        self.show_preview()

    def show_preview(self) -> None:
        rows = sorted({i.row() for i in self.table.selectedIndexes()})
        self.preview.setMarkdown(question_markdown(self.questions[rows[0]]) if rows else "")

    def _minutes_changed(self, value: int) -> None:
        if (set_id := self.current_set()) is not None:
            self.db.set_practice_minutes(set_id, value)
            self.sets_changed.emit()

    # --- Sätze --------------------------------------------------------

    def new_set(self) -> None:
        name, ok = QInputDialog.getText(self, "Neuer Übungssatz", "Name des Übungssatzes:")
        if ok and name.strip():
            try:
                set_id = self.db.add_practice_set(name.strip())
            except sqlite3.IntegrityError:
                QMessageBox.warning(self, "Übungssatz", f"Einen Übungssatz „{name.strip()}“ gibt "
                                    "es schon.")
                return
            self._changed(set_id)

    def rename_set(self) -> None:
        set_id = self.current_set()
        if set_id is None:
            return
        old = next(s.name for s in self.db.practice_sets() if s.id == set_id)
        name, ok = QInputDialog.getText(self, "Übungssatz umbenennen", "Neuer Name:", text=old)
        if ok and name.strip():
            try:
                self.db.rename_practice_set(set_id, name.strip())
            except sqlite3.IntegrityError:
                QMessageBox.warning(self, "Übungssatz", f"Einen Übungssatz „{name.strip()}“ gibt "
                                    "es schon.")
                return
            self._changed(set_id)

    def delete_set(self) -> None:
        set_id = self.current_set()
        if set_id is None:
            return
        if QMessageBox.question(self, "Übungssatz löschen", "Übungssatz löschen?\n\nDie Fragen "
                                "selbst und deine Ergebnisse bleiben erhalten.") \
                == QMessageBox.StandardButton.Yes:
            self.db.delete_practice_set(set_id)
            self._changed()

    # --- Fragen im Satz -----------------------------------------------

    def _selected_rows(self) -> list[int]:
        return sorted({i.row() for i in self.table.selectedIndexes()})

    def move(self, step: int) -> None:
        set_id, rows = self.current_set(), self._selected_rows()
        if set_id is None or len(rows) != 1:
            return
        i, j = rows[0], rows[0] + step
        if not 0 <= j < len(self.questions):
            return
        ids = [q.id for q in self.questions]
        ids[i], ids[j] = ids[j], ids[i]
        self.db.reorder_set(set_id, ids)
        self.show_set(select_row=j)
        self.sets_changed.emit()

    def remove(self) -> None:
        set_id, rows = self.current_set(), self._selected_rows()
        if set_id is None or not rows:
            return
        ids = [q.id for n, q in enumerate(self.questions) if n not in rows]
        self.db.reorder_set(set_id, ids)
        self._changed(set_id)
