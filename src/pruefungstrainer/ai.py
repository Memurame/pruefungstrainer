"""Anbindung an die Claude API: Fragen erzeugen und Freitextantworten bewerten."""

import base64
import json
import re
from dataclasses import dataclass
from pathlib import Path

import anthropic
from pydantic import BaseModel, ValidationError

from .db import Question, exam_key
from .vault import Section, marked_text, pdf_excerpt

# Bei einer Ablehnung durch die Sicherheitsfilter beantwortet automatisch ein
# passendes Ersatzmodell die Anfrage, statt dass die Generierung abbricht.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class AIError(Exception):
    pass


class GeneratedQuestion(BaseModel):
    kind: str
    question: str
    options: list[str]
    correct_index: int
    answer: str
    explanation: str
    difficulty: int
    location: str


class GeneratedSet(BaseModel):
    questions: list[GeneratedQuestion]


class ExamItem(BaseModel):
    text: str
    choices: list[str]
    correct_index: int


class ExamTask(BaseModel):
    number: str
    heading: str
    kind: str
    question: str
    options: list[str]
    correct_index: int
    items: list[ExamItem]
    answer: str
    points: float
    page: int
    has_solution: bool


class ExamSet(BaseModel):
    minutes: int
    tasks: list[ExamTask]


@dataclass
class ExtractedExam:
    questions: list[Question]
    unsolved: int       # Aufgaben ohne (vollständige) Lösung
    minutes: int        # Prüfungszeit laut Deckblatt, 0 = unbekannt


class Grading(BaseModel):
    points: float
    feedback: str


GENERATE_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["mc", "frei"]},
                    "question": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                    "correct_index": {"type": "integer"},
                    "answer": {"type": "string"},
                    "explanation": {"type": "string"},
                    "difficulty": {"type": "integer"},
                    "location": {"type": "string"},
                },
                "required": ["kind", "question", "options", "correct_index", "answer",
                             "explanation", "difficulty", "location"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["questions"],
    "additionalProperties": False,
}

EXAM_SCHEMA = {
    "type": "object",
    "properties": {
        "minutes": {"type": "integer"},
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "number": {"type": "string"},
                    "heading": {"type": "string"},
                    "kind": {"type": "string", "enum": ["mc", "frei", "zuordnung"]},
                    "question": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                    "correct_index": {"type": "integer"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "choices": {"type": "array", "items": {"type": "string"}},
                                "correct_index": {"type": "integer"},
                            },
                            "required": ["text", "choices", "correct_index"],
                            "additionalProperties": False,
                        },
                    },
                    "answer": {"type": "string"},
                    "points": {"type": "number"},
                    "page": {"type": "integer"},
                    "has_solution": {"type": "boolean"},
                },
                "required": ["number", "heading", "kind", "question", "options", "correct_index", "items",
                             "answer", "points", "page", "has_solution"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["minutes", "tasks"],
    "additionalProperties": False,
}

GRADE_SCHEMA = {
    "type": "object",
    "properties": {
        "points": {"type": "number"},
        "feedback": {"type": "string"},
    },
    "required": ["points", "feedback"],
    "additionalProperties": False,
}

GENERATE_SYSTEM = """\
Du erstellst Prüfungsfragen aus Lernmaterial eines Studierenden bzw. Auszubildenden. \
Die Fragen dienen als Probeprüfung und sollen sich wie eine echte schriftliche Prüfung anfühlen.

Anforderungen:
- Jede Frage muss allein mit dem gegebenen Material beantwortbar sein.
- Prüfe Verständnis und Anwendung, nicht Formalien des Dokuments (keine Fragen wie \
"Was steht auf Seite 3?" oder "Wie heißt die Überschrift?").
- Verteile die Fragen über die wichtigsten Inhalte des Abschnitts statt mehrere Fragen \
zum selben Detail zu stellen. Wenn der Abschnitt kaum prüfungsrelevanten Inhalt hat \
(z. B. Inhaltsverzeichnis, Literaturliste, Deckblatt), erzeuge weniger oder gar keine Fragen.
- Schreibe in der Sprache des Materials; im Zweifel Deutsch. Formeln in Markdown/LaTeX ($...$), \
Code in Markdown-Codeblöcken.

Felder:
- kind "mc": genau 4 Antwortoptionen in "options", genau eine ist richtig, ihr Index (0–3) steht \
in "correct_index". Falsche Optionen sollen plausibel sein und typische Fehlvorstellungen abbilden, \
nicht offensichtlich falsch. Die Position der richtigen Antwort soll variieren. "answer" enthält \
die richtige Option als Text.
- kind "frei": "options" ist leer, "correct_index" ist -1. "answer" ist eine Musterlösung \
mit den Kernpunkten, die für volle Punktzahl (3 Punkte) genannt werden müssen.
- "explanation": kurze Begründung, warum die Antwort richtig ist (bei MC auch, warum die \
anderen falsch sind).
- "difficulty": 1 = leicht, 2 = mittel, 3 = schwer.
- "location": wo im Material die Antwort steht (Überschrift oder Seitenzahl).
"""

EXTRACT_SYSTEM = """\
Du überträgst eine alte Prüfung (Altklausur) mit offizieller Lösung in einen Prüfungstrainer. \
Du schreibst ab, du erfindest nichts: Aufgabentexte und Lösungen werden wörtlich übernommen.

Du bekommst das PDF und zusätzlich seinen Text. Im Text steht alles, was im PDF rot gedruckt ist, \
in ⟦…⟧ – das ist die offizielle Lösung. Alles andere ist die Aufgabenstellung. Ist nichts markiert, \
erkenne die Lösung am Layout (andere Farbe, Handschrift, Abschnitt „Lösungen“ am Ende o. Ä.).

Aufteilung:
- Jede Aufgabe bzw. Teilaufgabe mit eigener Punktzahl wird eine eigene Frage (z. B. 2.1, 2.2 \
oder 7a, 7b). "number" ist die Nummer aus der Klausur ohne Leerzeichen ("4.1", "7b").
- "heading" ist die Überschrift aus der Klausur, bei Teilaufgaben mit der Überschrift der \
Hauptaufgabe davor, z. B. "Aufgabe 11: Vertragslehre – a)" oder \
"Aufgabe 4: Fallbeispiel „Hotel Alpenstern“ – 4.1 Zielgrössen". Sie wird über der Frage \
angezeigt und gehört nicht zusätzlich in "question".
- Gehört eine Ausgangslage oder ein Fallbeispiel zu mehreren Teilaufgaben, steht sie vollständig \
am Anfang jeder dieser Fragen.
- Deckblatt, Punktetabelle, Kopf- und Fußzeilen und Hinweise wie „Lösung“ weglassen.

"question": der vollständige Aufgabentext, wörtlich, ohne jede Lösung. Silbentrennungen am \
Zeilenende zusammenfügen. Tabellen als Markdown-Tabelle, in die der Prüfling schreiben würde \
(Lösungsspalten leer lassen; die leeren Zellen werden in der Prüfung zu Eingabefeldern). Formeln in LaTeX ($...$). Verweist die Aufgabe auf eine Abbildung, \
beschreibe sie knapp in eckigen Klammern, z. B. „[Abbildung: Angebots- und Nachfragekurve …]“.

"kind":
- "zuordnung" für alles, was aus festen Antworten gewählt wird und je Zeile bewertet wird: \
Ankreuzen von Aussagen („Kreuzen Sie alle zutreffenden Aussagen an“), Unterstreichen \
(„tiefer/höher“), Zuordnen von Begriffen, Tabellen mit Auswahl wie „VR, GV oder RS“. \
Jede Zeile bzw. Aussage ist ein Eintrag in "items": "text" ist die Aussage (beim Unterstreichen \
mit „…“ an der Stelle der Auswahl), "choices" die Auswahlmöglichkeiten, "correct_index" die \
richtige. Beim Ankreuzen ist "choices" immer ["zutreffend", "nicht zutreffend"]. Beim Zuordnen \
von Begriffen a–f sind die choices die Begriffe mit Buchstaben, z. B. "a) Produktivität". \
Die Aussagen selbst gehören nicht zusätzlich in "question".
- "mc": klassisches Multiple Choice mit genau einer richtigen Antwort aus "options" \
(so viele Optionen wie in der Klausur), "correct_index" zeigt auf sie.
- "frei": alles andere (Erklären, Nennen, Berechnen, Tabellen mit freien Einträgen).

"answer": die offizielle Lösung wörtlich, inklusive Punkteangaben wie „(1 P.)“ und Hinweisen \
wie „Individuelle Antworten“. Tabellenlösungen als Markdown-Tabelle mit denselben Zeilen und \
Spalten wie die Tabelle der Frage, mehrere Punkte in einer Zelle mit „<br>“ trennen. Bei "mc" und "zuordnung" \
darf "answer" leer bleiben.

"points": Punktzahl der Frage laut Klausur. "page": Seite im PDF, auf der die Aufgabe beginnt.
"has_solution": false, wenn die Klausur zu dieser Aufgabe keine Lösung enthält. Dann bleibt \
"answer" leer und bei "mc"/"zuordnung" ist der jeweilige "correct_index" -1 – nicht selbst lösen.
"minutes" (oberste Ebene): Prüfungszeit in Minuten laut Deckblatt, 0 wenn nicht angegeben.
Unbenutzte Felder: "options" [] und "correct_index" -1 außer bei "mc", "items" [] außer bei \
"zuordnung".
"""

GRADE_SYSTEM = """\
Du bewertest eine Freitextantwort in einer Probeprüfung. Die Höchstpunktzahl steht in \
<max_punkte>; vergib 0 bis zu dieser Zahl, halbe Punkte sind erlaubt.

- Enthält die Musterlösung ein Punkteschema (z. B. „(1 P.)“, „je 2 P.“, „4 x 2 P.“), bewerte \
danach. Sonst gilt: volle Punktzahl, wenn alle Kernpunkte der Musterlösung korrekt genannt sind \
(Formulierung egal), anteilig weniger für fehlende oder ungenaue Kernpunkte, 0 für falsche, \
leere oder themenfremde Antworten.
- Steht in der Musterlösung „Individuelle Antworten“, „Mögliche Überlegungen“ oder eine Liste \
mit mehr Punkten als verlangt, sind das Beispiele: andere fachlich richtige Antworten zählen \
genauso.
- Verlangt die Frage eine Anzahl („Nennen Sie drei …“), werden höchstens so viele Nennungen \
gewertet, in der Reihenfolge der Antwort.

Bewerte fachlich und fair wie ein Prüfer. Das Feedback richtet sich direkt an den Prüfling \
(du-Form), ist kurz und nennt konkret, was gefehlt hat oder falsch war. Antworte in der \
Sprache der Frage.
"""


def make_client(api_key: str) -> anthropic.Anthropic:
    if not api_key:
        raise AIError("Kein API-Key hinterlegt. Trage ihn unter Einstellungen ein.")
    return anthropic.Anthropic(api_key=api_key)


def _call(client: anthropic.Anthropic, model: str, system: str, content: list, schema: dict,
          max_tokens: int) -> dict:
    try:
        with client.beta.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": content}],
            thinking={"type": "adaptive"},
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        ) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError:
        raise AIError("API-Key ungültig.")
    except anthropic.PermissionDeniedError:
        raise AIError("Der API-Key hat keine Berechtigung für dieses Modell.")
    except anthropic.RateLimitError:
        raise AIError("Rate-Limit erreicht. Bitte später erneut versuchen.")
    except anthropic.APIConnectionError:
        raise AIError("Keine Verbindung zur Claude API.")
    except anthropic.APIStatusError as e:
        raise AIError(f"API-Fehler {e.status_code}: {e.message}")

    if msg.stop_reason == "refusal":
        raise AIError("Die Anfrage wurde vom Modell abgelehnt.")
    if msg.stop_reason == "max_tokens":
        raise AIError("Antwort wurde abgeschnitten (max_tokens erreicht).")

    # Nach einem Modellwechsel zählt nur der Text des Ersatzmodells
    text = ""
    for block in msg.content:
        if block.type == "fallback":
            text = ""
        elif block.type == "text":
            text += block.text
    try:
        return json.loads(text)
    except ValueError:
        raise AIError("Antwort der KI war kein gültiges JSON.")


def generate_questions(client: anthropic.Anthropic, model: str, section: Section,
                       count: int, kinds: set[str]) -> list[Question]:
    kinds_text = {
        frozenset({"mc"}): "nur Multiple-Choice-Fragen (kind \"mc\")",
        frozenset({"frei"}): "nur Freitextfragen (kind \"frei\")",
    }.get(frozenset(kinds), "eine Mischung aus Multiple-Choice- (\"mc\") und Freitextfragen (\"frei\")")

    instruction = (f"Erstelle bis zu {count} Prüfungsfragen zu diesem Material, {kinds_text}. "
                   f"Quelle: {Path(section.path).name} ({section.label}).")
    if section.kind == "pdf":
        data = pdf_excerpt(Path(section.path), section.pages)
        offset = section.pages[0]
        instruction += (f" Das PDF ist ein Auszug: Seite 1 des Auszugs ist Seite {offset + 1} "
                        f"des Originals. Gib in \"location\" die Originalseitenzahl an (z. B. \"S. {offset + 2}\").")
        content = [
            {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                            "data": base64.standard_b64encode(data).decode()}},
            {"type": "text", "text": instruction},
        ]
    else:
        content = [{"type": "text",
                    "text": f"<material>\n{section.text}\n</material>\n\n{instruction}"}]

    raw = _call(client, model, GENERATE_SYSTEM, content, GENERATE_SCHEMA, max_tokens=32000)
    try:
        generated = GeneratedSet.model_validate(raw).questions
    except ValidationError as e:
        raise AIError(f"Unerwartetes Antwortformat: {e}")

    questions = []
    for g in generated:
        if g.kind not in kinds:
            continue
        if g.kind == "mc" and not (len(g.options) >= 2 and 0 <= g.correct_index < len(g.options)):
            continue  # unbrauchbare MC-Frage verwerfen
        questions.append(Question(
            kind=g.kind, text=g.question,
            options=g.options if g.kind == "mc" else [],
            correct_index=g.correct_index if g.kind == "mc" else -1,
            answer=g.answer, explanation=g.explanation,
            difficulty=min(3, max(1, g.difficulty)), subject_id=section.subject_id,
            source_path=section.path, source_loc=g.location or section.label,
            origin="ki", approved=False,
        ))
    return questions


def extract_exam(client: anthropic.Anthropic, model: str, section: Section) -> ExtractedExam:
    """Übernimmt die Aufgaben einer Altklausur wörtlich."""
    path = Path(section.path)
    data = pdf_excerpt(path, section.pages)
    text, red_chars = marked_text(path, section.pages)
    offset = section.pages[0]
    hint = "" if red_chars else ("\nIm Text ist nichts rot markiert – erkenne die Lösungen am Layout "
                                 "oder setze has_solution auf false.")
    instruction = (f"Übertrage alle Aufgaben dieser Altklausur ({path.name}). Seite 1 des PDFs ist "
                   f"Seite {offset + 1} des Originals; gib in \"page\" die Originalseite an.{hint}"
                   f"\n\n<text>\n{text}\n</text>")
    content = [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                        "data": base64.standard_b64encode(data).decode()}},
        {"type": "text", "text": instruction},
    ]
    raw = _call(client, model, EXTRACT_SYSTEM, content, EXAM_SCHEMA, max_tokens=64000)
    try:
        exam = ExamSet.model_validate(raw)
    except ValidationError as e:
        raise AIError(f"Unerwartetes Antwortformat: {e}")

    questions, unsolved = [], 0
    for t in exam.tasks:
        text = t.question.strip()
        if t.heading.strip():
            text = f"**{t.heading.strip()}**\n\n{text}"
        q = Question(
            kind=t.kind, text=text, answer=t.answer.strip(), points=max(0, t.points),
            subject_id=section.subject_id, source_path=section.path,
            source_loc=f"Aufgabe {t.number}, S. {t.page}", origin="klausur", approved=False,
            ext_key=exam_key(section.subject_id, section.path, t.number))
        if t.kind == "mc":
            q.options = t.options
            q.correct_index = t.correct_index if 0 <= t.correct_index < len(t.options) else -1
            q.answer = q.answer or (t.options[q.correct_index] if q.correct_index >= 0 else "")
            solved = q.correct_index >= 0
        elif t.kind == "zuordnung":
            # Zeilennummern wie „1:“ ergänzt die Anzeige selbst
            q.items = [{"text": re.sub(r"^\s*\d+\s*[.:)]\s+", "", i.text), "choices": i.choices,
                        "correct": i.correct_index if 0 <= i.correct_index < len(i.choices) else -1}
                       for i in t.items if i.choices]
            solved = bool(q.items) and all(i["correct"] >= 0 for i in q.items)
        else:
            solved = bool(q.answer)
        if not (t.has_solution and solved):
            unsolved += 1
            q.explanation = "Die Altklausur enthält zu dieser Aufgabe keine (vollständige) Lösung."
        questions.append(q)
    return ExtractedExam(questions=questions, unsolved=unsolved, minutes=max(0, exam.minutes))


def grade_answer(client: anthropic.Anthropic, model: str, q: Question, user_answer: str) -> Grading:
    if not user_answer.strip():
        return Grading(points=0, feedback="Keine Antwort abgegeben.")
    text = (f"<frage>\n{q.text}\n</frage>\n<max_punkte>{q.max_points:g}</max_punkte>\n"
            f"<musterloesung>\n{q.answer}\n</musterloesung>\n"
            f"<erlaeuterung>\n{q.explanation}\n</erlaeuterung>\n"
            f"<antwort_pruefling>\n{user_answer}\n</antwort_pruefling>")
    raw = _call(client, model, GRADE_SYSTEM, [{"type": "text", "text": text}], GRADE_SCHEMA,
                max_tokens=8000)
    try:
        g = Grading.model_validate(raw)
    except ValidationError as e:
        raise AIError(f"Unerwartetes Antwortformat: {e}")
    g.points = min(q.max_points, max(0, round(g.points * 2) / 2))
    return g
