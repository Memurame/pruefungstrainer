"""SQLite-Speicher für Fächer, Fragen, Übungssätze, generierte Abschnitte und Prüfungsergebnisse.

Jeder Aufruf öffnet eine eigene Verbindung, damit Hintergrund-Threads
(KI-Generierung, Bewertung) gefahrlos schreiben können.
"""

import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

SCHEMA_VERSION = 4

SCHEMA = """
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS subject_sources (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,              -- absoluter Pfad
    kind TEXT NOT NULL,              -- 'file' oder 'dir'
    mode TEXT NOT NULL DEFAULT 'lernstoff',  -- 'lernstoff' oder 'klausur'
    UNIQUE (subject_id, path)
);
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,              -- 'mc', 'frei' oder 'zuordnung'
    text TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    correct_index INTEGER NOT NULL DEFAULT -1,
    items TEXT NOT NULL DEFAULT '[]',       -- nur Zuordnung: [{text, choices, correct}]
    points REAL NOT NULL DEFAULT 0,         -- 0 = Standard des Fragetyps
    answer TEXT NOT NULL DEFAULT '',
    explanation TEXT NOT NULL DEFAULT '',
    difficulty INTEGER NOT NULL DEFAULT 2,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    source_path TEXT NOT NULL DEFAULT '',   -- absoluter Pfad
    source_loc TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL,            -- 'ki', 'manuell', 'notiz' oder 'klausur'
    approved INTEGER NOT NULL DEFAULT 0,
    ext_key TEXT UNIQUE,             -- Duplikatschutz für Fragen aus Notizen und Altklausuren
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS generated (
    subject_id INTEGER NOT NULL,
    section_key TEXT NOT NULL,
    hash TEXT NOT NULL,
    ts REAL NOT NULL,
    PRIMARY KEY (subject_id, section_key)
);
CREATE TABLE IF NOT EXISTS practice_sets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    minutes INTEGER NOT NULL DEFAULT 0,     -- 0 = kein Zeitlimit vorgegeben
    source_path TEXT,                       -- nur für Sätze aus Altklausuren
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS practice_set_questions (
    set_id INTEGER NOT NULL REFERENCES practice_sets(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    pos INTEGER NOT NULL,
    PRIMARY KEY (set_id, question_id)
);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    ts REAL NOT NULL,
    points REAL NOT NULL,
    max_points REAL NOT NULL
);
"""

KIND_LABEL = {"mc": "Multiple Choice", "frei": "Freitext", "zuordnung": "Zuordnung"}
ORIGIN_LABEL = {"ki": "KI", "manuell": "Manuell", "notiz": "Notiz (::)", "klausur": "Altklausur"}
DEFAULT_POINTS = {"mc": 1, "frei": 3}


def note_key(subject_id: int, path: str, question: str) -> str:
    return f"notiz:{subject_id}:{path}:{hashlib.sha256(question.encode()).hexdigest()[:16]}"


def exam_key(subject_id: int, path: str, number: str) -> str:
    return f"klausur:{subject_id}:{path}:{number}"


def rekey(key: str, subject_id: int) -> str:
    """Tauscht das Fach in einem ext_key ('herkunft:fach:rest') aus."""
    origin, _, rest = key.split(":", 2)
    return f"{origin}:{subject_id}:{rest}"


@dataclass
class Question:
    kind: str
    text: str
    options: list[str] = field(default_factory=list)
    correct_index: int = -1
    # Zuordnung: je Zeile {"text": str, "choices": [str], "correct": int}, 1 Entscheidung pro Zeile
    items: list[dict] = field(default_factory=list)
    points: float = 0
    answer: str = ""
    explanation: str = ""
    difficulty: int = 2
    subject_id: int | None = None
    source_path: str = ""
    source_loc: str = ""
    origin: str = "manuell"
    approved: bool = False
    ext_key: str | None = None
    id: int | None = None
    subject: str = ""    # nur zur Anzeige, kommt aus der subjects-Tabelle

    @property
    def max_points(self) -> float:
        if self.points:
            return self.points
        return len(self.items) if self.kind == "zuordnung" else DEFAULT_POINTS[self.kind]


@dataclass
class Subject:
    id: int
    name: str


@dataclass
class PracticeSet:
    id: int
    name: str
    minutes: int
    source_path: str | None
    count: int = 0


@dataclass
class Source:
    id: int
    subject_id: int
    path: str
    kind: str
    mode: str = "lernstoff"


class Database:
    def __init__(self, path: Path, legacy_vault: str = ""):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            version = c.execute("PRAGMA user_version").fetchone()[0]
            cols = {r[1] for r in c.execute("PRAGMA table_info(questions)")}
            if "subject" in cols and "subject_id" not in cols:
                c.execute("VACUUM INTO ?", (str(path.with_suffix(".v1-backup.sqlite3")),))
                self._migrate_v1(c, legacy_vault)
            else:
                c.executescript(SCHEMA)
            self._add_columns(c)
            if version < 4:
                self._exam_sets(c)
            if version < SCHEMA_VERSION:
                c.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        return c

    @staticmethod
    def _add_columns(c: sqlite3.Connection) -> None:
        """Version 3: Punkte und Zuordnungen je Frage, Altklausuren als Quellen."""
        for table, col, decl in (
                ("questions", "items", "TEXT NOT NULL DEFAULT '[]'"),
                ("questions", "points", "REAL NOT NULL DEFAULT 0"),
                ("subject_sources", "mode", "TEXT NOT NULL DEFAULT 'lernstoff'")):
            if col not in {r[1] for r in c.execute(f"PRAGMA table_info({table})")}:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")

    @staticmethod
    def _exam_sets(c: sqlite3.Connection) -> None:
        """Version 4: bereits übernommene Altklausuren werden zu Übungssätzen."""
        paths = [r[0] for r in c.execute("SELECT DISTINCT source_path FROM questions"
                                         " WHERE origin='klausur'")]
        for path in paths:
            ids = [r[0] for r in c.execute("SELECT id FROM questions WHERE origin='klausur'"
                                           " AND source_path=? ORDER BY id", (path,))]
            Database._sync_exam_set(c, path, ids, 0)

    @staticmethod
    def _sync_exam_set(c: sqlite3.Connection, path: str, ids: list[int], minutes: int) -> None:
        """Legt den Übungssatz einer Altklausur an bzw. ergänzt fehlende Aufgaben am Ende."""
        row = c.execute("SELECT id, minutes FROM practice_sets WHERE source_path=?",
                        (path,)).fetchone()
        if row:
            set_id = row[0]
            if minutes and not row[1]:
                c.execute("UPDATE practice_sets SET minutes=? WHERE id=?", (minutes, set_id))
        else:
            base, name, n = Path(path).stem, Path(path).stem, 1
            while c.execute("SELECT 1 FROM practice_sets WHERE name=?", (name,)).fetchone():
                n += 1
                name = f"{base} ({n})"
            set_id = c.execute("INSERT INTO practice_sets (name, minutes, source_path, created)"
                               " VALUES (?,?,?,?)", (name, minutes, path, time.time())).lastrowid
        Database._append_to_set(c, set_id, ids)

    @staticmethod
    def _append_to_set(c: sqlite3.Connection, set_id: int, ids: list[int]) -> None:
        pos = c.execute("SELECT COALESCE(MAX(pos), -1) FROM practice_set_questions WHERE set_id=?",
                        (set_id,)).fetchone()[0]
        for qid in ids:
            cur = c.execute("INSERT OR IGNORE INTO practice_set_questions VALUES (?,?,?)",
                            (set_id, qid, pos + 1))
            pos += cur.rowcount

    @staticmethod
    def _migrate_v1(c: sqlite3.Connection, vault: str) -> None:
        """Version 1 leitete Fächer aus Vault-Ordnern ab und speicherte relative Pfade.
        Jedes alte Fach wird zu einem manuellen Fach mit dem Ordner als Quelle."""
        root = Path(vault) if vault else None

        def absolute(rel: str) -> str:
            if not rel or Path(rel).is_absolute() or root is None:
                return rel
            return str(root / rel)

        def subject_of(rel: str) -> str:
            parts = Path(rel).parts
            return parts[0] if len(parts) > 1 else "Allgemein"

        c.execute("ALTER TABLE generated RENAME TO generated_v1")
        c.executescript(SCHEMA)
        c.execute("ALTER TABLE questions ADD COLUMN subject_id INTEGER"
                  " REFERENCES subjects(id) ON DELETE CASCADE")

        old_generated = c.execute("SELECT section_key, hash, ts FROM generated_v1").fetchall()
        files: dict[str, set[str]] = {}
        for r in c.execute("SELECT DISTINCT subject, source_path FROM questions"):
            files.setdefault(r[0] or "Allgemein", set()).add(r[1])
        for r in old_generated:
            rel = r[0].rsplit("#", 1)[0]
            files.setdefault(subject_of(rel), set()).add(rel)

        ids: dict[str, int] = {}
        for name, rels in sorted(files.items()):
            ids[name] = c.execute("INSERT INTO subjects (name, created) VALUES (?,?)",
                                  (name, time.time())).lastrowid
            folder = root / name if root else None
            if folder and folder.is_dir():
                c.execute("INSERT INTO subject_sources (subject_id, path, kind) VALUES (?,?,?)",
                          (ids[name], str(folder), "dir"))
            else:
                for rel in sorted(r for r in rels if r):
                    c.execute("INSERT OR IGNORE INTO subject_sources (subject_id, path, kind)"
                              " VALUES (?,?,?)", (ids[name], absolute(rel), "file"))

        for r in c.execute("SELECT id, subject, source_path, text, origin FROM questions").fetchall():
            sid = ids[r["subject"] or "Allgemein"]
            path = absolute(r["source_path"])
            ext = note_key(sid, path, r["text"]) if r["origin"] == "notiz" else None
            c.execute("UPDATE questions SET subject_id=?, source_path=?, ext_key=? WHERE id=?",
                      (sid, path, ext, r["id"]))
        for key, hash_, ts in old_generated:
            rel, suffix = key.rsplit("#", 1)
            c.execute("INSERT OR REPLACE INTO generated VALUES (?,?,?,?)",
                      (ids[subject_of(rel)], f"{absolute(rel)}#{suffix}", hash_, ts))
        c.execute("DROP TABLE generated_v1")

    # --- Fächer -------------------------------------------------------

    def subjects(self) -> list[Subject]:
        with self._conn() as c:
            rows = c.execute("SELECT id, name FROM subjects ORDER BY name COLLATE NOCASE").fetchall()
        return [Subject(r[0], r[1]) for r in rows]

    def add_subject(self, name: str) -> int:
        with self._conn() as c:
            return c.execute("INSERT INTO subjects (name, created) VALUES (?,?)",
                             (name, time.time())).lastrowid

    def rename_subject(self, subject_id: int, name: str) -> None:
        with self._conn() as c:
            c.execute("UPDATE subjects SET name=? WHERE id=?", (name, subject_id))

    def delete_subject(self, subject_id: int) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM questions WHERE subject_id=?", (subject_id,))
            c.execute("DELETE FROM generated WHERE subject_id=?", (subject_id,))
            c.execute("DELETE FROM subjects WHERE id=?", (subject_id,))

    def merge_subjects(self, source_id: int, target_id: int) -> None:
        """Verschiebt Quellen, Fragen und Generierungsstand von source nach target."""
        with self._conn() as c:
            c.execute("INSERT OR IGNORE INTO subject_sources (subject_id, path, kind, mode)"
                      " SELECT ?, path, kind, mode FROM subject_sources WHERE subject_id=?",
                      (target_id, source_id))
            c.execute("INSERT OR IGNORE INTO generated SELECT ?, section_key, hash, ts"
                      " FROM generated WHERE subject_id=?", (target_id, source_id))
            for r in c.execute("SELECT id, ext_key FROM questions"
                               " WHERE subject_id=? AND ext_key IS NOT NULL", (source_id,)).fetchall():
                key = rekey(r["ext_key"], target_id)
                if c.execute("SELECT 1 FROM questions WHERE ext_key=?", (key,)).fetchone():
                    c.execute("DELETE FROM questions WHERE id=?", (r["id"],))
                else:
                    c.execute("UPDATE questions SET ext_key=? WHERE id=?", (key, r["id"]))
            c.execute("UPDATE questions SET subject_id=? WHERE subject_id=?", (target_id, source_id))
            c.execute("DELETE FROM generated WHERE subject_id=?", (source_id,))
            c.execute("DELETE FROM subjects WHERE id=?", (source_id,))

    def sources(self, subject_id: int | None = None) -> list[Source]:
        with self._conn() as c:
            if subject_id is None:
                rows = c.execute("SELECT * FROM subject_sources ORDER BY path").fetchall()
            else:
                rows = c.execute("SELECT * FROM subject_sources WHERE subject_id=? ORDER BY path",
                                 (subject_id,)).fetchall()
        return [Source(r["id"], r["subject_id"], r["path"], r["kind"], r["mode"]) for r in rows]

    def add_source(self, subject_id: int, path: str, kind: str, mode: str = "lernstoff") -> None:
        with self._conn() as c:
            c.execute("INSERT OR IGNORE INTO subject_sources (subject_id, path, kind, mode)"
                      " VALUES (?,?,?,?)", (subject_id, path, kind, mode))
            c.execute("UPDATE subject_sources SET mode=? WHERE subject_id=? AND path=?",
                      (mode, subject_id, path))

    def set_source_mode(self, source_id: int, mode: str) -> None:
        with self._conn() as c:
            c.execute("UPDATE subject_sources SET mode=? WHERE id=?", (mode, source_id))

    def remove_source(self, source: Source, files: list[str], delete_questions: bool) -> None:
        """Entfernt eine Quelle; optional samt der Fragen aus ihren Dateien."""
        with self._conn() as c:
            c.execute("DELETE FROM subject_sources WHERE id=?", (source.id,))
            if not delete_questions:
                return
            for f in files:
                c.execute("DELETE FROM questions WHERE subject_id=? AND source_path=?",
                          (source.subject_id, f))
                c.execute("DELETE FROM generated WHERE subject_id=? AND"
                          " substr(section_key, 1, ?) = ?", (source.subject_id, len(f) + 1, f + "#"))

    # --- Fragen -------------------------------------------------------

    @staticmethod
    def _row_to_question(r: sqlite3.Row) -> Question:
        return Question(
            id=r["id"], kind=r["kind"], text=r["text"], options=json.loads(r["options"]),
            correct_index=r["correct_index"], items=json.loads(r["items"]), points=r["points"],
            answer=r["answer"], explanation=r["explanation"],
            difficulty=r["difficulty"], subject_id=r["subject_id"], source_path=r["source_path"],
            source_loc=r["source_loc"], origin=r["origin"], approved=bool(r["approved"]),
            ext_key=r["ext_key"], subject=r["subject_name"] or "",
        )

    def save_question(self, q: Question) -> bool:
        """Speichert eine Frage. Gibt False zurück, wenn es sie (gleicher ext_key) schon gibt."""
        values = (q.kind, q.text, json.dumps(q.options, ensure_ascii=False), q.correct_index,
                  json.dumps(q.items, ensure_ascii=False), q.points, q.answer, q.explanation,
                  q.difficulty, q.subject_id, q.source_path, q.source_loc, q.origin,
                  int(q.approved), q.ext_key)
        with self._conn() as c:
            if q.id is None:
                cur = c.execute(
                    "INSERT OR IGNORE INTO questions (kind, text, options, correct_index, items,"
                    " points, answer, explanation, difficulty, subject_id, source_path, source_loc,"
                    " origin, approved, ext_key, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    values + (time.time(),))
                if not cur.rowcount:
                    return False
                q.id = cur.lastrowid
            else:
                c.execute(
                    "UPDATE questions SET kind=?, text=?, options=?, correct_index=?, items=?,"
                    " points=?, answer=?, explanation=?, difficulty=?, subject_id=?, source_path=?,"
                    " source_loc=?, origin=?, approved=?, ext_key=? WHERE id=?", values + (q.id,))
        return True

    def find_question(self, q: Question) -> int | None:
        """ID einer gleichen, schon gespeicherten Frage (gleicher ext_key bzw. gleiches Fach,
        gleicher Typ und Text)."""
        with self._conn() as c:
            if q.ext_key:
                row = c.execute("SELECT id FROM questions WHERE ext_key=?", (q.ext_key,)).fetchone()
            else:
                row = c.execute("SELECT id FROM questions WHERE subject_id=? AND kind=? AND text=?",
                                (q.subject_id, q.kind, q.text)).fetchone()
        return row[0] if row else None

    def upsert_exam_question(self, q: Question) -> bool:
        """Übernimmt eine Klausuraufgabe; eine schon vorhandene (gleiche Nummer) wird mit dem
        neuen Stand überschrieben, Freigabe und Ergebnisse bleiben. True, wenn sie neu ist."""
        with self._conn() as c:
            cur = c.execute(
                "UPDATE questions SET kind=?, text=?, options=?, correct_index=?, items=?, points=?,"
                " answer=?, explanation=?, source_loc=? WHERE ext_key=?",
                (q.kind, q.text, json.dumps(q.options, ensure_ascii=False), q.correct_index,
                 json.dumps(q.items, ensure_ascii=False), q.points, q.answer, q.explanation,
                 q.source_loc, q.ext_key))
            if cur.rowcount:
                return False
        return self.save_question(q)

    def upsert_note_questions(self, questions: list[Question]) -> int:
        """Übernimmt Fragen aus Notizen; bestehende werden aktualisiert. Gibt die Zahl neuer zurück."""
        new = 0
        with self._conn() as c:
            for q in questions:
                cur = c.execute("UPDATE questions SET answer=? WHERE ext_key=?", (q.answer, q.ext_key))
                if cur.rowcount == 0:
                    new += 1
                    c.execute(
                        "INSERT INTO questions (kind, text, answer, subject_id, source_path, origin,"
                        " approved, ext_key, created) VALUES (?,?,?,?,?,?,?,?,?)",
                        (q.kind, q.text, q.answer, q.subject_id, q.source_path, q.origin,
                         int(q.approved), q.ext_key, time.time()))
        return new

    def delete_questions(self, ids: list[int]) -> None:
        with self._conn() as c:
            c.executemany("DELETE FROM questions WHERE id=?", [(i,) for i in ids])

    def set_approved(self, ids: list[int], approved: bool) -> None:
        with self._conn() as c:
            c.executemany("UPDATE questions SET approved=? WHERE id=?",
                          [(int(approved), i) for i in ids])

    def questions(self) -> list[Question]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT q.*, s.name AS subject_name FROM questions q"
                " LEFT JOIN subjects s ON s.id = q.subject_id"
                " ORDER BY s.name COLLATE NOCASE, q.source_path, q.id").fetchall()
        return [self._row_to_question(r) for r in rows]

    def question_counts(self) -> dict[int, int]:
        with self._conn() as c:
            return {r[0]: r[1] for r in c.execute(
                "SELECT subject_id, COUNT(*) FROM questions GROUP BY subject_id")}

    # --- Übungssätze -------------------------------------------------

    def practice_sets(self) -> list[PracticeSet]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT s.id, s.name, s.minutes, s.source_path, COUNT(q.question_id)"
                " FROM practice_sets s LEFT JOIN practice_set_questions q ON q.set_id = s.id"
                " GROUP BY s.id ORDER BY s.name COLLATE NOCASE").fetchall()
        return [PracticeSet(*r) for r in rows]

    def set_subjects(self) -> dict[int, set[int]]:
        """Übungssatz-ID -> Fächer, aus denen er Fragen enthält."""
        result: dict[int, set[int]] = {}
        with self._conn() as c:
            for set_id, subject_id in c.execute(
                    "SELECT DISTINCT p.set_id, q.subject_id FROM practice_set_questions p"
                    " JOIN questions q ON q.id = p.question_id"):
                result.setdefault(set_id, set()).add(subject_id)
        return result

    def add_practice_set(self, name: str, minutes: int = 0, source_path: str | None = None) -> int:
        with self._conn() as c:
            return c.execute("INSERT INTO practice_sets (name, minutes, source_path, created)"
                             " VALUES (?,?,?,?)", (name, minutes, source_path, time.time())).lastrowid

    def rename_practice_set(self, set_id: int, name: str) -> None:
        with self._conn() as c:
            c.execute("UPDATE practice_sets SET name=? WHERE id=?", (name, set_id))

    def set_practice_minutes(self, set_id: int, minutes: int) -> None:
        with self._conn() as c:
            c.execute("UPDATE practice_sets SET minutes=? WHERE id=?", (minutes, set_id))

    def delete_practice_set(self, set_id: int) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM practice_sets WHERE id=?", (set_id,))

    def set_question_ids(self, set_id: int) -> list[int]:
        with self._conn() as c:
            return [r[0] for r in c.execute("SELECT question_id FROM practice_set_questions"
                                            " WHERE set_id=? ORDER BY pos", (set_id,))]

    def add_to_set(self, set_id: int, ids: list[int]) -> None:
        with self._conn() as c:
            self._append_to_set(c, set_id, ids)

    def reorder_set(self, set_id: int, ids: list[int]) -> None:
        """Setzt Inhalt und Reihenfolge eines Satzes (Entfernen = weglassen)."""
        with self._conn() as c:
            c.execute("DELETE FROM practice_set_questions WHERE set_id=?", (set_id,))
            c.executemany("INSERT INTO practice_set_questions VALUES (?,?,?)",
                          [(set_id, qid, pos) for pos, qid in enumerate(ids)])

    def sync_exam_set(self, path: str, ext_keys: list[str], minutes: int) -> None:
        with self._conn() as c:
            ids = [r[0] for key in ext_keys
                   for r in c.execute("SELECT id FROM questions WHERE ext_key=?", (key,))]
            self._sync_exam_set(c, path, ids, minutes)

    # --- Generierte Abschnitte ---------------------------------------

    def generated_hashes(self, subject_id: int) -> dict[str, str]:
        with self._conn() as c:
            return {r[0]: r[1] for r in c.execute(
                "SELECT section_key, hash FROM generated WHERE subject_id=?", (subject_id,))}

    def mark_generated(self, subject_id: int, key: str, hash_: str) -> None:
        with self._conn() as c:
            c.execute("INSERT OR REPLACE INTO generated VALUES (?,?,?,?)",
                      (subject_id, key, hash_, time.time()))

    # --- Statistik ----------------------------------------------------

    def record_attempt(self, question_id: int, points: float, max_points: float) -> int:
        with self._conn() as c:
            cur = c.execute("INSERT INTO attempts (question_id, ts, points, max_points)"
                            " VALUES (?,?,?,?)", (question_id, time.time(), points, max_points))
            return cur.lastrowid

    def update_attempt(self, attempt_id: int, points: float) -> None:
        with self._conn() as c:
            c.execute("UPDATE attempts SET points=? WHERE id=?", (points, attempt_id))

    def success_rates(self) -> dict[int, tuple[float, int]]:
        """question_id -> (Anteil erreichter Punkte, Anzahl Versuche)."""
        with self._conn() as c:
            rows = c.execute("SELECT question_id, SUM(points)/SUM(max_points), COUNT(*)"
                             " FROM attempts GROUP BY question_id").fetchall()
        return {r[0]: (r[1], r[2]) for r in rows}

    def subject_stats(self) -> list[tuple[str, int, int, float | None]]:
        """(Fach, Anzahl Fragen, Anzahl Versuche, Erfolgsquote)."""
        with self._conn() as c:
            rows = c.execute(
                "SELECT s.name, COUNT(DISTINCT q.id), COUNT(a.id), SUM(a.points)/SUM(a.max_points)"
                " FROM subjects s LEFT JOIN questions q ON q.subject_id = s.id"
                " LEFT JOIN attempts a ON a.question_id = q.id"
                " GROUP BY s.id ORDER BY s.name COLLATE NOCASE").fetchall()
        return [tuple(r) for r in rows]
