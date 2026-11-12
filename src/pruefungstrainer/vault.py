"""Liest die Quellen eines Fachs: teilt Markdown und PDFs in Abschnitte auf und
findet manuell notierte Fragen. Die Dateien werden nie verändert."""

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from .db import Question, Source, note_key

MD_MAX_CHARS = 12_000   # Größe eines Markdown-Abschnitts für die KI
MD_MIN_CHARS = 300      # kürzere Notizen lohnen keine Fragen
PDF_PAGES = 15          # Seiten pro PDF-Abschnitt
EXAM_PAGES = 100        # Altklausuren am Stück; mehr Seiten nimmt die API pro PDF nicht an
SUFFIXES = (".md", ".pdf")

HEADING = re.compile(r"^(#{1,3})\s+(.+?)\s*#*$")
FENCE = re.compile(r"^\s*(```|~~~)")
# "Frage?::Antwort" – das Fragezeichen grenzt das Format von Dataview-Feldern (key:: value) ab
INLINE_QA = re.compile(r"^\s*(?:[-*]\s+)?(.+\?)\s*::\s*(.+)$")
CALLOUT_START = re.compile(r"^>\s*\[!frage\][-+]?\s*(.*)$", re.IGNORECASE)


@dataclass
class Section:
    key: str            # eindeutig: absoluter Pfad + Abschnitt
    path: str           # absoluter Pfad der Datei
    kind: str           # 'md', 'pdf' oder 'klausur'
    label: str          # Überschrift oder Seitenbereich
    subject_id: int
    hash: str
    text: str = ""                  # nur Markdown
    pages: tuple[int, int] = (0, 0)  # nur PDF, 0-basiert, Ende exklusiv


@dataclass
class ScanResult:
    files: dict[int, list[str]]       # Quelle-ID -> enthaltene Dateien
    sections: list[Section]
    note_questions: list[Question]
    errors: list[str]


def _sha(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def source_files(source: Source, ignored: set[str]) -> list[Path]:
    root = Path(source.path)
    if source.kind == "file":
        return [root] if root.is_file() else []
    files = []
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if any(part in ignored or part.startswith(".") for part in rel.parts[:-1]):
            continue
        if p.is_file() and p.suffix.lower() in SUFFIXES:
            files.append(p)
    return files


def scan(sources: list[Source], ignored: set[str]) -> ScanResult:
    result = ScanResult({}, [], [], [])
    seen: set[tuple[int, Path]] = set()   # Datei doppelt im selben Fach (Ordner + Einzeldatei)
    # Altklausuren zuerst, damit eine Klausur im Lernstoff-Ordner als Klausur gilt
    for src in sorted(sources, key=lambda s: s.mode != "klausur"):
        if not Path(src.path).exists():
            result.errors.append(f"Nicht gefunden: {src.path}")
        files = source_files(src, ignored)
        result.files[src.id] = [str(f) for f in files]
        for path in files:
            if (src.subject_id, path) in seen:
                continue
            seen.add((src.subject_id, path))
            try:
                if path.suffix.lower() == ".md":
                    text = path.read_text(encoding="utf-8", errors="replace")
                    result.sections += split_markdown(path, text, src.subject_id)
                    result.note_questions += note_questions(path, text, src.subject_id)
                elif src.mode == "klausur":
                    result.sections += split_exam(path, src.subject_id)
                else:
                    result.sections += split_pdf(path, src.subject_id)
            except Exception as e:  # eine kaputte Datei soll den Scan nicht abbrechen
                result.errors.append(f"{path}: {e}")
    return result


# --- Markdown ---------------------------------------------------------

def strip_frontmatter(text: str) -> str:
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            return text[end + 4:].lstrip("\n")
    return text


def _blocks(text: str) -> list[tuple[str, str]]:
    """Teilt an Überschriften (außerhalb von Codeblöcken) in (Überschrift, Inhalt)."""
    blocks: list[tuple[str, list[str]]] = [("Anfang", [])]
    in_code = False
    for line in text.splitlines():
        if FENCE.match(line):
            in_code = not in_code
        m = None if in_code else HEADING.match(line)
        if m:
            blocks.append((m.group(2), [line]))
        else:
            blocks[-1][1].append(line)
    return [(h, "\n".join(lines).strip()) for h, lines in blocks if "\n".join(lines).strip()]


def split_markdown(path: Path, text: str, subject_id: int) -> list[Section]:
    text = strip_frontmatter(text)
    if len(text.strip()) < MD_MIN_CHARS:
        return []
    chunks: list[tuple[str, str]] = []
    label, buf = "", ""
    for heading, body in _blocks(text):
        # Überlange Einzelabschnitte an Absätzen weiter zerteilen
        pieces = [body]
        if len(body) > MD_MAX_CHARS:
            pieces, cur = [], ""
            for para in body.split("\n\n"):
                if cur and len(cur) + len(para) > MD_MAX_CHARS:
                    pieces.append(cur)
                    cur = ""
                cur += para + "\n\n"
            pieces.append(cur)
        for piece in pieces:
            if buf and len(buf) + len(piece) > MD_MAX_CHARS:
                chunks.append((label, buf))
                label, buf = "", ""
            label = label or heading
            buf += piece + "\n\n"
    if buf.strip():
        chunks.append((label, buf))

    sections = []
    for i, (label, body) in enumerate(chunks):
        body = f"# {path.stem}\n\n{body.strip()}"
        if len(chunks) > 1 and len(body) < MD_MIN_CHARS:
            continue
        sections.append(Section(
            key=f"{path}#{i}", path=str(path), kind="md", label=label,
            subject_id=subject_id, hash=_sha(body), text=body))
    return sections


def note_questions(path: Path, text: str, subject_id: int) -> list[Question]:
    """Findet 'Frage?::Antwort'-Zeilen und '> [!frage]'-Callouts."""
    found: list[tuple[str, str]] = []
    lines = strip_frontmatter(text).splitlines()
    in_code = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if FENCE.match(line):
            in_code = not in_code
        elif not in_code:
            if m := CALLOUT_START.match(line):
                question, answer = m.group(1).strip(), []
                i += 1
                while i < len(lines) and lines[i].startswith(">"):
                    answer.append(lines[i][1:].strip())
                    i += 1
                if question and any(answer):
                    found.append((question, "\n".join(answer).strip()))
                continue
            if m := INLINE_QA.match(line):
                found.append((m.group(1).strip(), m.group(2).strip()))
        i += 1

    return [Question(
        kind="frei", text=q, answer=a, subject_id=subject_id, source_path=str(path),
        origin="notiz", approved=True, ext_key=note_key(subject_id, str(path), q),
    ) for q, a in found]


# --- PDF --------------------------------------------------------------

def split_pdf(path: Path, subject_id: int) -> list[Section]:
    data = path.read_bytes()
    file_hash = _sha(data)
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        n = doc.page_count
    sections = []
    for start in range(0, n, PDF_PAGES):
        end = min(start + PDF_PAGES, n)
        sections.append(Section(
            key=f"{path}#S{start + 1}", path=str(path), kind="pdf",
            label=f"S. {start + 1}–{end}", subject_id=subject_id,
            hash=_sha(f"{file_hash}:{start}:{end}"), pages=(start, end)))
    return sections


def pdf_excerpt(path: Path, pages: tuple[int, int]) -> bytes:
    """Gibt die Seiten eines Abschnitts als eigenes PDF zurück."""
    with pymupdf.open(path) as src, pymupdf.open() as out:
        out.insert_pdf(src, from_page=pages[0], to_page=pages[1] - 1)
        return out.tobytes(garbage=3, deflate=True)


# --- Altklausuren -----------------------------------------------------

def split_exam(path: Path, subject_id: int) -> list[Section]:
    """Eine Altklausur bleibt am Stück, damit Aufgaben und Lösungen zusammen bleiben."""
    data = path.read_bytes()
    file_hash = _sha(data)
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        n = doc.page_count
    sections = []
    for start in range(0, n, EXAM_PAGES):
        end = min(start + EXAM_PAGES, n)
        label = "Altklausur" if n <= EXAM_PAGES else f"Altklausur S. {start + 1}–{end}"
        sections.append(Section(
            key=f"{path}#K{start + 1}", path=str(path), kind="klausur", label=label,
            subject_id=subject_id, hash=_sha(f"klausur:{file_hash}:{start}:{end}"),
            pages=(start, end)))
    return sections


def _is_red(color: int) -> bool:
    r, g, b = (color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF
    return r >= 150 and g <= 90 and b <= 90


def marked_text(path: Path, pages: tuple[int, int]) -> tuple[str, int]:
    """Text der Seiten, roter Text (Lösungen) in ⟦…⟧. Gibt auch die Zahl roter Zeichen zurück."""
    out, red_chars = [], 0
    with pymupdf.open(path) as doc:
        for pno in range(pages[0], pages[1]):
            out.append(f"--- Seite {pno + 1} ---")
            for block in doc[pno].get_text("dict")["blocks"]:
                for line in block.get("lines", []):
                    text, in_red = "", False
                    for span in line["spans"]:
                        # Leerzeichen gehören zum laufenden Abschnitt, egal welche Farbe
                        blank = not span["text"].strip()
                        red = in_red if blank else _is_red(span["color"])
                        if red != in_red:
                            text += "⟦" if red else "⟧"
                            in_red = red
                        text += span["text"]
                        if red:
                            red_chars += len(span["text"].strip())
                    if in_red:
                        text += "⟧"
                    if text.strip("⟦⟧ "):
                        out.append(text.rstrip())
    return "\n".join(out), red_chars
