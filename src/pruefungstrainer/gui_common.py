"""Gemeinsame Helfer der Oberfläche."""

import re
import threading
import traceback
from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import QObject, QUrl, Signal
from PySide6.QtGui import QDesktopServices

from .db import Question


class Worker(QObject):
    """Führt eine Funktion in einem Hintergrund-Thread aus.

    Die Funktion bekommt den Worker übergeben und kann darüber Fortschritt
    melden (worker.progress.emit) und Abbruch prüfen (worker.cancelled).
    """
    progress = Signal(int, int, str)
    finished = Signal(object)
    failed = Signal(str)

    def __init__(self, fn, parent=None):
        super().__init__(parent)
        self._fn = fn
        self._cancel = threading.Event()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def cancel(self) -> None:
        self._cancel.set()

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        try:
            self.finished.emit(self._fn(self))
        except Exception as e:
            traceback.print_exc()
            self.failed.emit(str(e))


def open_source(q: Question) -> None:
    if not q.source_path:
        return
    path = Path(q.source_path)
    if path.suffix.lower() == ".md":
        url = QUrl("obsidian://open")
        url.setQuery(f"path={QUrl.toPercentEncoding(str(path)).data().decode()}")
        if QDesktopServices.openUrl(url):
            return
    QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))


def grade_for(percent: float) -> str:
    """Note nach IHK-Notenschlüssel."""
    for limit, grade in ((92, "1 (sehr gut)"), (81, "2 (gut)"), (67, "3 (befriedigend)"),
                         (50, "4 (ausreichend)"), (30, "5 (mangelhaft)")):
        if percent >= limit:
            return grade
    return "6 (ungenügend)"


FENCE = re.compile(r"^\s*(```|~~~)")
BR = re.compile(r"<br\s*/?>", re.IGNORECASE)
# Aufzählungspunkt mitten in einer Zelle („• a • b“) beginnt eine neue Zeile
CELL_BULLET = re.compile(r"(?<=[^|\s])\s+•\s*")
TABLE_SEP = re.compile(r"^:?-+:?$")
CELL_SPLIT = re.compile(r"(?<!\\)\|")


def hard_breaks(md: str) -> str:
    """Einfache Zeilenumbrüche sichtbar machen (Markdown fasst sie sonst zusammen). In
    Tabellenzellen werden <br> und Aufzählungen zu Zeilenwechseln (U+2028), weil Qt <br>
    dort nicht kann."""
    out, in_code = [], False
    for line in md.split("\n"):
        if FENCE.match(line):
            in_code = not in_code
        elif in_code or not line.strip():
            pass
        elif line.lstrip().startswith("|"):
            line = CELL_BULLET.sub("\u2028• ", BR.sub("\u2028", line))
        else:
            line = line.rstrip() + "  "
        out.append(line)
    return "\n".join(out)


@dataclass
class Table:
    header: list[str]
    rows: list[list[str]]

    def fillable(self) -> bool:
        """Leere Zellen sind in der Prüfung zum Ausfüllen da."""
        return any(not c for row in self.rows for c in row)

    def markdown(self) -> str:
        def cell(text: str) -> str:
            return text.replace("|", "\\|").replace("\n", "<br>")
        lines = ["| " + " | ".join(cell(h) for h in self.header) + " |",
                 "|" + "---|" * len(self.header)]
        lines += ["| " + " | ".join(cell(c) for c in row) + " |" for row in self.rows]
        return "\n".join(lines)


def _cells(line: str) -> list[str]:
    s = line.strip().removeprefix("|")
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip().replace("\\|", "|") for c in CELL_SPLIT.split(s)]


def split_table(md: str) -> tuple[str, Table, str] | None:
    """Teilt Markdown an der ersten Tabelle in (Text davor, Tabelle, Text danach)."""
    lines = md.split("\n")
    start = next((i for i, line in enumerate(lines) if line.lstrip().startswith("|")), None)
    if start is None:
        return None
    end = start
    while end < len(lines) and lines[end].lstrip().startswith("|"):
        end += 1
    rows = [_cells(line) for line in lines[start:end]]
    if len(rows) < 3 or not all(TABLE_SEP.match(c) for c in rows[1]):
        return None
    header = rows[0]
    body = [(row + [""] * len(header))[:len(header)] for row in rows[2:]]
    return ("\n".join(lines[:start]).strip(), Table(header, body),
            "\n".join(lines[end:]).strip())


def question_title(q: Question) -> str:
    """Einzeilige Kurzfassung für Listen: die Überschrift (**Aufgabe …**) oder die erste Zeile."""
    lines = [line.strip() for line in q.text.splitlines() if line.strip()]
    return lines[0].strip("*# ").strip() if lines else ""


def source_text(q: Question) -> str:
    if not q.source_path:
        return ""
    name = Path(q.source_path).name
    return f"{name} – {q.source_loc}" if q.source_loc else name
