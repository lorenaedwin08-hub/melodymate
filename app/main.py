"""
app/main.py
-----------
Local web server for MelodyMate (singing path).
Run from the project root:
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
Binds to 127.0.0.1 only, so nobody else on the network can reach it.
Recordings are written to a temporary file, analysed, and deleted. Nothing is stored.
"""
from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from app.simple_feedback import simple_feedback
from core.feedback import generate_feedback
from core.melody import MELODIES, MELODY_BEATS, compare
from core.pitch import track_pitch
from core.notes import piano_key_numbers, midi_to_note_name
from core.segment import segment_notes
from core.synth import NOTE_DURATION, write_melody_wav
from core.timing import timing_feedback

MAX_BYTES = 10 * 1024 * 1024
MAX_SECONDS = 60
MIN_SECONDS = 1.0
MODES = ("exact", "ignore_octave", "relative")
LABELS = {
    "c_major_up": "C major scale, going up",
    "c_major_down": "C major scale, going down",
    "mary_lamb": "Mary Had a Little Lamb",
}
STATIC = Path(__file__).parent / "static"

app = FastAPI(title="MelodyMate")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def spoken(name: str) -> str:
    """'C#4' -> 'C sharp 4', 'C4' -> 'C 4' (reads well in a screen reader)."""
    m = re.fullmatch(r"([A-G])(#?)(-?\d+)", name)
    if not m:
        return name
    letter, sharp, octave = m.groups()
    return f"{letter} sharp {octave}" if sharp else f"{letter} {octave}"


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/melodies")
def melodies():
    return [{"id": k, "label": LABELS.get(k, k)} for k in MELODIES]


@app.get("/api/piano/keys")
def piano_keys():
    """Return all 88 standard piano keys for keyboard-learning clients."""
    return [
        {"midi": midi, "note": midi_to_note_name(midi)}
        for midi in piano_key_numbers()
    ]


@app.get("/api/reference/{name}")
def reference(name: str):
    if name not in MELODIES:
        raise HTTPException(404, "That melody does not exist.")
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        durations = [NOTE_DURATION * beats for beats in MELODY_BEATS[name]]
        write_melody_wav(MELODIES[name], path, note_durations=durations)
        data = Path(path).read_bytes()
    finally:
        os.unlink(path)
    return Response(data, media_type="audio/wav")


# A plain "def" (not async) so FastAPI runs the slow analysis in a worker thread.
@app.post("/api/analyze/singing")
def analyze_singing(
    file: UploadFile = File(...),
    melody: str = Form(...),
    mode: str = Form("exact"),
):
    if not data:
    raise HTTPException(
        status_code=400,
        detail="The uploaded recording is empty. Please record again."
    )
    if melody not in MELODIES:
        raise HTTPException(400, "Unknown melody. Pick one from the list.")
    if mode not in MODES:
        raise HTTPException(400, "Unknown comparison mode. Pick Exact, Any octave or Any key.")
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "The recording is larger than 10 megabytes. Record a shorter take.")

    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        Path(path).write_bytes(data)
        try:
            info = sf.info(path)
        except Exception:
            raise HTTPException(400, "The file is not a readable WAV recording.")
        if info.duration > MAX_SECONDS:
            raise HTTPException(400, "The recording is longer than 60 seconds. Record a shorter take.")
        if info.duration < MIN_SECONDS:
            raise HTTPException(400, "The recording is too short. Record at least one second.")
        notes = segment_notes(track_pitch(path))
    finally:
        os.unlink(path)

    results = compare(MELODIES[melody], [n.midi_float for n in notes], mode)
    text = generate_feedback(results, input_type="singing", shift_used=results.shift_used)
    timing = timing_feedback(results, notes, MELODY_BEATS[melody])
    score, separator, pitch_feedback = text.partition(". ")
    if timing:
        text = f"{text} {timing}"
    simple = simple_feedback(results)
    if timing:
        simple = f"{simple} {timing}"
    return {
        "detected_notes": [spoken(n.note_name) for n in notes],
        "feedback": text,
        "report": {
            "score": score + ("." if not score.endswith(".") else ""),
            "pitch_sequence": pitch_feedback if separator else "No additional pitch or note-sequence feedback.",
            "timing": timing or "There were not enough detected notes to assess timing.",
            "notes": [spoken(n.note_name) for n in notes],
        },
        "simple": simple,
        "shift_used": results.shift_used,
    }
