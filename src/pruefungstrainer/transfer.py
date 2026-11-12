"""Export und Import von Fächern, Fragen und Übungssätzen als JSON-Datei.

Quellen (Dateipfade) und Prüfungsergebnisse gehören nicht dazu. Beim Import werden Fächer
und Übungssätze über ihren Namen zusammengeführt, vorhandene Fragen nicht doppelt angelegt.
"""

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from .db import Database, Question, rekey

FORMAT = "pruefungstrainer-export"
VERSION = 1
QUESTION_FIELDS = ("kind", "text", "options", "correct_index", "items", "points", "answer",
                   "explanation", "difficulty", "source_path", "source_loc", "origin", "approved",
                   "ext_key")


@dataclass
class ImportResult:
    subjects_new: int = 0
    questions_new: int = 0
    questions_known: int = 0
    sets_new: int = 0
    sets_extended: int = 0

    def summary(self) -> str:
        return (f"{self.questions_new} neue Fragen ({self.questions_known} waren schon vorhanden), "
                f"{self.subjects_new} neue Fächer, {self.sets_new} neue und "
                f"{self.sets_extended} ergänzte Übungssätze.")


def export_data(db: Database, subject_ids: set[int]) -> dict:
    subjects = [s for s in db.subjects() if s.id in subject_ids]
    questions = [q for q in db.questions() if q.subject_id in subject_ids]
    keys = {q.id: n for n, q in enumerate(questions)}
    sets = []
    for s in db.practice_sets():
        refs = [keys[i] for i in db.set_question_ids(s.id) if i in keys]
        if refs:
            sets.append({"name": s.name, "minutes": s.minutes, "source_path": s.source_path,
                         "questions": refs})
    return {
        "format": FORMAT, "version": VERSION,
        "exported": time.strftime("%Y-%m-%d %H:%M"),
        "subjects": [{"name": s.name} for s in subjects],
        "questions": [{"subject": q.subject, **{f: getattr(q, f) for f in QUESTION_FIELDS}}
                      for q in questions],
        "sets": sets,
    }


def write_export(db: Database, subject_ids: set[int], path: Path) -> dict:
    data = export_data(db, subject_ids)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return data


def read_import(db: Database, path: Path) -> ImportResult:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ValueError(f"Datei konnte nicht gelesen werden: {e}")
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise ValueError("Das ist keine Exportdatei des Prüfungstrainers.")
    if data.get("version", 0) > VERSION:
        raise ValueError("Die Datei stammt aus einer neueren Version des Prüfungstrainers.")
    try:
        return import_data(db, data)
    except (KeyError, TypeError, IndexError) as e:
        raise ValueError(f"Die Exportdatei ist unvollständig oder beschädigt ({e}).")


def import_data(db: Database, data: dict) -> ImportResult:
    result = ImportResult()
    subject_ids = {s.name: s.id for s in db.subjects()}
    for s in data["subjects"]:
        if s["name"] not in subject_ids:
            subject_ids[s["name"]] = db.add_subject(s["name"])
            result.subjects_new += 1

    ids: list[int | None] = []    # Index in der Datei -> Frage-ID hier
    for raw in data["questions"]:
        sid = subject_ids.get(raw["subject"])
        if sid is None:
            sid = subject_ids[raw["subject"]] = db.add_subject(raw["subject"])
            result.subjects_new += 1
        q = Question(subject_id=sid, **{f: raw[f] for f in QUESTION_FIELDS if f in raw})
        q.approved = bool(q.approved)
        if q.ext_key:
            q.ext_key = rekey(q.ext_key, sid)
        existing = db.find_question(q)
        if existing is not None:
            ids.append(existing)
            result.questions_known += 1
        else:
            db.save_question(q)
            ids.append(q.id)
            result.questions_new += 1

    sets = {s.name: s for s in db.practice_sets()}
    for raw in data["sets"]:
        qids = [ids[n] for n in raw["questions"] if ids[n] is not None]
        if raw["name"] in sets:
            before = sets[raw["name"]].count
            db.add_to_set(sets[raw["name"]].id, qids)
            if len(db.set_question_ids(sets[raw["name"]].id)) > before:
                result.sets_extended += 1
        else:
            try:
                set_id = db.add_practice_set(raw["name"], raw.get("minutes", 0),
                                             raw.get("source_path"))
            except sqlite3.IntegrityError:
                continue
            db.add_to_set(set_id, qids)
            result.sets_new += 1
    return result
