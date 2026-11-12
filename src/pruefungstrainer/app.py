"""Hauptfenster, Statistik, Einstellungen sowie Export und Import."""

import sys
import time
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDialog, QDialogButtonBox, QFileDialog, QFormLayout, QHeaderView,
    QLabel, QLineEdit, QListWidget, QListWidgetItem, QMainWindow, QMessageBox, QTableWidget,
    QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget,
)

from . import config, transfer
from .db import Database
from .gui_common import question_title
from .tab_exam import ExamTab
from .tab_questions import QuestionsTab
from .tab_sets import SetsTab
from .tab_subjects import SubjectsTab

MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]


class SettingsDialog(QDialog):
    def __init__(self, cfg: config.Config, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Einstellungen")
        self.resize(520, 0)
        self.cfg = cfg
        self.key = QLineEdit(cfg.api_key)
        self.key.setEchoMode(QLineEdit.EchoMode.Password)
        self.key.setPlaceholderText("sk-ant-… (leer = Umgebungsvariable ANTHROPIC_API_KEY)")
        self.model = QComboBox()
        self.model.setEditable(True)
        self.model.addItems(MODELS)
        self.model.setCurrentText(cfg.model)
        self.ignore = QLineEdit(cfg.ignore_dirs)
        hint = QLabel("Den API-Key bekommst du unter <a href='https://console.anthropic.com'>"
                      "console.anthropic.com</a>. Er wird nur lokal in "
                      f"<code>{config.CONFIG_FILE}</code> gespeichert.")
        hint.setOpenExternalLinks(True)
        hint.setWordWrap(True)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save
                                   | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form = QFormLayout()
        form.addRow("API-Key:", self.key)
        form.addRow("Modell:", self.model)
        form.addRow("Ignorierte Ordner:", self.ignore)
        lay = QVBoxLayout(self)
        lay.addLayout(form)
        lay.addWidget(hint)
        lay.addWidget(buttons)

    def accept(self) -> None:
        self.cfg.api_key = self.key.text().strip()
        self.cfg.model = self.model.currentText().strip() or MODELS[0]
        self.cfg.ignore_dirs = self.ignore.text()
        config.save(self.cfg)
        super().accept()


class ExportDialog(QDialog):
    """Auswahl der Fächer für den Export."""

    def __init__(self, db: Database, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Exportieren")
        self.resize(420, 400)
        counts = db.question_counts()
        self.list = QListWidget()
        for s in db.subjects():
            item = QListWidgetItem(f"{s.name}  ({counts.get(s.id, 0)} Fragen)")
            item.setData(Qt.ItemDataRole.UserRole, s.id)
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            item.setCheckState(Qt.CheckState.Checked)
            self.list.addItem(item)
        hint = QLabel("Exportiert werden die gewählten Fächer mit ihren Fragen und die "
                      "Übungssätze, die Fragen daraus enthalten. Quellen und Prüfungsergebnisse "
                      "gehören nicht dazu.")
        hint.setWordWrap(True)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok
                                   | QDialogButtonBox.StandardButton.Cancel)
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("Exportieren …")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel("<b>Fächer</b>"))
        lay.addWidget(self.list, 1)
        lay.addWidget(hint)
        lay.addWidget(buttons)

    def subject_ids(self) -> set[int]:
        items = (self.list.item(i) for i in range(self.list.count()))
        return {it.data(Qt.ItemDataRole.UserRole) for it in items
                if it.checkState() == Qt.CheckState.Checked}


class StatsTab(QWidget):
    def __init__(self, db: Database, parent=None):
        super().__init__(parent)
        self.db = db
        self.subjects = QTableWidget(0, 4)
        self.subjects.setHorizontalHeaderLabels(["Fach", "Fragen", "Beantwortet", "Erfolgsquote"])
        self.weak = QTableWidget(0, 4)
        self.weak.setHorizontalHeaderLabels(["Quote", "Versuche", "Fach", "Frage"])
        for t in (self.subjects, self.weak):
            t.verticalHeader().setVisible(False)
            t.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.subjects.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.weak.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel("<h3>Nach Fach</h3>"))
        lay.addWidget(self.subjects, 1)
        lay.addWidget(QLabel("<h3>Schwächste Fragen</h3>"))
        lay.addWidget(self.weak, 2)

    def reload(self) -> None:
        stats = self.db.subject_stats()
        self.subjects.setRowCount(len(stats))
        for row, (subject, n, attempts, rate) in enumerate(stats):
            vals = (subject, str(n), str(attempts), "–" if rate is None else f"{100 * rate:.0f} %")
            for col, v in enumerate(vals):
                self.subjects.setItem(row, col, QTableWidgetItem(v))

        rates = self.db.success_rates()
        qs = {q.id: q for q in self.db.questions()}
        weak = sorted(((r, n, qs[i]) for i, (r, n) in rates.items() if i in qs and r < 1),
                      key=lambda x: (x[0], -x[1]))[:30]
        self.weak.setRowCount(len(weak))
        for row, (rate, n, q) in enumerate(weak):
            vals = (f"{100 * rate:.0f} %", str(n), q.subject, question_title(q))
            for col, v in enumerate(vals):
                self.weak.setItem(row, col, QTableWidgetItem(v))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Prüfungstrainer")
        self.resize(1100, 780)
        self.cfg = config.load()
        self.db = Database(config.DB_FILE, legacy_vault=self.cfg.vault_path)

        self.subjects = SubjectsTab(self.db, self.cfg)
        self.questions = QuestionsTab(self.db)
        self.sets = SetsTab(self.db)
        self.exam = ExamTab(self.db, self.cfg)
        self.stats = StatsTab(self.db)
        self.tabs = QTabWidget()
        self.tabs.addTab(self.subjects, "Fächer")
        self.tabs.addTab(self.questions, "Fragen")
        self.tabs.addTab(self.sets, "Übungssätze")
        self.tabs.addTab(self.exam, "Prüfung")
        self.tabs.addTab(self.stats, "Statistik")
        self.setCentralWidget(self.tabs)

        self.subjects.questions_changed.connect(self.questions.reload)
        self.subjects.subjects_changed.connect(self.exam.reload)
        self.questions.questions_changed.connect(self.exam.reload)
        self.questions.questions_changed.connect(self.subjects.reload_subjects)
        # Übungssätze ändern sich auch beim Übernehmen von Altklausuren und beim Löschen von Fragen
        for signal in (self.subjects.questions_changed, self.questions.questions_changed,
                       self.questions.sets_changed):
            signal.connect(self.sets.reload)
        self.questions.sets_changed.connect(self.exam.reload)
        self.sets.sets_changed.connect(self.exam.reload)
        self.tabs.currentChanged.connect(self._tab_changed)

        menu = self.menuBar().addMenu("&Datei")
        menu.addAction("Exportieren …", self.export)
        menu.addAction("Importieren …", self.import_)
        menu.addSeparator()
        menu.addAction("Einstellungen …", self.settings)
        menu.addSeparator()
        menu.addAction("Beenden", self.close)

        self.questions.reload()
        self.sets.reload()
        self.exam.reload()
        self.subjects.scan()
        if not self.cfg.effective_api_key():
            self.statusBar().showMessage("Kein API-Key hinterlegt – KI-Funktionen sind aus. "
                                         "Datei → Einstellungen.")

    def _tab_changed(self, i: int) -> None:
        w = self.tabs.widget(i)
        if w is self.exam and self.exam.stack.currentIndex() == 0:
            self.exam.reload()
        elif w is self.stats:
            self.stats.reload()

    def export(self) -> None:
        if not self.db.subjects():
            QMessageBox.information(self, "Exportieren", "Es gibt noch keine Fächer.")
            return
        dialog = ExportDialog(self.db, self)
        if not dialog.exec() or not (ids := dialog.subject_ids()):
            return
        name = f"pruefungstrainer-{time.strftime('%Y-%m-%d')}.json"
        start = Path(self.cfg.last_dir or Path.home()) / name
        path, _ = QFileDialog.getSaveFileName(self, "Exportieren", str(start), "Export (*.json)")
        if not path:
            return
        path = Path(path).with_suffix(".json")
        try:
            data = transfer.write_export(self.db, ids, path)
        except OSError as e:
            QMessageBox.warning(self, "Exportieren", f"Datei konnte nicht geschrieben werden: {e}")
            return
        self.statusBar().showMessage(
            f"{len(data['subjects'])} Fächer, {len(data['questions'])} Fragen und "
            f"{len(data['sets'])} Übungssätze nach {path.name} exportiert.", 8000)

    def import_(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Importieren",
                                              self.cfg.last_dir or str(Path.home()),
                                              "Export (*.json)")
        if not path:
            return
        try:
            result = transfer.read_import(self.db, Path(path))
        except ValueError as e:
            QMessageBox.warning(self, "Importieren", str(e))
            return
        self.subjects.reload_subjects()
        self.subjects.scan()
        self.questions.reload()
        self.sets.reload()
        self.exam.reload()
        QMessageBox.information(self, "Importieren", f"Import abgeschlossen: {result.summary()}")

    def settings(self) -> None:
        if SettingsDialog(self.cfg, self).exec():
            self.statusBar().clearMessage()
            if self.cfg.effective_api_key():
                self.statusBar().showMessage("Einstellungen gespeichert.", 3000)


def main() -> None:
    app = QApplication(sys.argv)
    app.setApplicationName("Prüfungstrainer")
    app.setDesktopFileName("pruefungstrainer")
    win = MainWindow()
    win.show()
    sys.exit(app.exec())
