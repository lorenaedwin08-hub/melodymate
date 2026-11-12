# MelodyMate

MelodyMate is an accessible music learning application designed to make basic music practice easier to navigate for people who are blind or visually impaired. It combines voice-guided instructions, spoken feedback, keyboard controls, and an interactive piano keyboard.

**Live application:** [melodymate-ymbl.onrender.com](https://melodymate-ymbl.onrender.com)

## Learning modules

### Singing practice

Choose a musical exercise, listen to its reference notes, and record a singing attempt. MelodyMate analyzes the recording and presents a structured report with feedback on pitch, note sequence, and timing. The report is also read aloud.

### Keyboard learning

Explore all 88 notes on a standard piano, from A0 to C8. Choose an octave, select a note, hear it played, or have its name spoken.

### Guided note practice

Listen to a sequence of target notes and identify each note by speaking its name or entering a number. You can ask to hear a target note again and retry an answer before continuing.

## Accessibility

MelodyMate is designed for voice-first and keyboard-based use:

- The spoken guide begins when the page opens.
- Choose a module and answer prompts by speaking or entering a number.
- Press **R** to repeat a question and **Escape** to stop the voice guide.
- The page scrolls to the selected learning module and gives spoken instructions.
- Singing feedback is organized into sections and read at a slower pace.
- The app prefers an English voice with a feminine-sounding name when the browser provides one. The available voice and its sound depend on the operating system and browser.

Allow microphone access when prompted. Voice input works best in Chrome and requires an internet connection. Browser speech and audio settings may affect the experience.

## Technology

- **Python 3.13**
- **FastAPI** for the web application and API
- **Librosa, NumPy, and SoundFile** for audio and pitch analysis
- **HTML, CSS, and JavaScript** for the browser interface
- **Render** for hosting the live application

## Run locally

### Requirements

Install Python 3.13 and make sure the Python launcher (`py`) is available in Windows PowerShell or Command Prompt.

### Install web application dependencies

From the project folder, run:

```powershell
py -3.13 -m pip install -r requirements-web.txt
```

### Start the application

```powershell
py -3.13 -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in a browser. Keep the terminal window open while using the local application. Press **Ctrl+C** in that window to stop the server.
## Troubleshooting
### git checkout -b docs/troubleshooting-guide
### Application fails to start
- Verify that Python 3.13 is installed.
- Ensure web application dependencies are installed.
- Check the terminal output for missing packages or configuration errors.

### Audio upload fails
- Ensure the recording is a valid WAV file.
- Check that the recording is not empty.
- Verify that the recording is within the supported file size and duration limits.

### Voice input does not work
- Allow microphone access when prompted.
- Use Chrome for better speech recognition compatibility.
- Check your internet connection.

### Audio playback issues
- Check browser audio settings.
- Refresh the application if playback becomes unresponsive.
## API

The FastAPI application provides these endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Serves the MelodyMate web interface. |
| `GET` | `/api/melodies` | Lists the available singing exercises. |
| `GET` | `/api/piano/keys` | Returns the notes for all 88 piano keys. |
| `GET` | `/api/reference/{name}` | Generates reference audio for a supported exercise. |
| `POST` | `/api/analyze/singing` | Analyzes an uploaded WAV recording and returns detected notes and feedback. |

The singing analysis endpoint accepts a WAV file, an exercise ID, and an optional comparison mode. Supported modes are `exact`, `ignore_octave`, and `relative`. Recordings must be no larger than 10 MB and no longer than 60 seconds.

## Deployment

The live application is hosted on Render and connected to this GitHub repository. The service builds from the repository root with:

```text
pip install -r requirements-web.txt
```

It starts with:

```text
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Render can deploy new changes after they are pushed to the `main` branch.

## Privacy

Singing recordings are temporarily written to a file for analysis. The application deletes that temporary file after processing and does not keep recordings in an application database. Voice recognition is provided through the browser; its handling of speech depends on the browser and its service provider.

## Project structure

```text
app/
  main.py             FastAPI application and API endpoints
  simple_feedback.py  Concise singing feedback
  static/
    index.html        Accessible web interface
    app.js            Voice guide and interactive behavior
    style.css         Page styling
core/
  feedback.py         Pitch and note-sequence feedback
  melody.py           Exercise data and melody comparison
  midi_input.py       MIDI input support
  notes.py            Note names and piano key mappings
  pitch.py            Pitch tracking
  segment.py          Note segmentation
  synth.py            Reference note audio generation
  timing.py           Timing feedback
tests/                Automated tests
docs/                 Project and accessibility documentation
```
```
