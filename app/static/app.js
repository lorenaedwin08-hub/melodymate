// MelodyMate singing page.
// Accessible hands-free music practice for blind and visually impaired users.
const $ = (id) => document.getElementById(id);
const status = $("status"), details = $("details");
const melody = $("melody"), mode = $("mode"), phones = $("phones"), speak = $("speak"), rate = $("rate");
const voiceBtn = $("voice"), practiceBtn = $("practice"), play = $("play"), start = $("start"), stop = $("stop");
const sessionInput = $("session-input");
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const NOTHING = "I did not hear any singing. Check that your microphone is on, and sing a little louder.";
let state = "idle"; // idle | busy | playing | recording
let rec = null, inSession = false, cancelled = false, talkToken = 0, onResult = null, abortListen = null;
let currentAudio = null;
let currentOptions = null;
let currentResolve = null;
let repeatHandler = null;
let yesNoLearned = false;
let melodyLearned = false;
let pendingDigits = "";
let pendingDigitTimer = null;
let preferredSpeechVoice = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setOn = (btn, on) => btn.setAttribute("aria-disabled", on ? "false" : "true");
const guard = () => { if (cancelled) throw new Error("cancelled"); };

function chooseSpeechVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const locale = (navigator.language || "en-US").toLowerCase();
  const language = locale.split("-")[0];
  const feminineNames = /\b(female|woman|zira|aria|jenny|samantha|victoria|hazel|susan|eva|ava|karen|moira|tessa|sara|sarah|olivia|allison|joanna|kendra|heather|lisa|julia|emily|amy|nicole|michelle|monica|elsa)\b/i;
  const masculineNames = /\b(male|man|david|mark|guy|daniel|james|richard)\b/i;
  const score = (voice) => {
    const name = voice.name || "";
    const lang = (voice.lang || "").toLowerCase();
    let value = 0;
    if (feminineNames.test(name)) value += 100;
    if (masculineNames.test(name)) value -= 120;
    if (/\b(natural|neural|premium|online)\b/i.test(name)) value += 20;
    if (lang === locale) value += 35;
    else if (lang.startsWith(language + "-")) value += 25;
    else if (lang.startsWith("en")) value += 15;
    if (voice.default) value += 3;
    return value;
  };
  const ranked = voices.map((voice) => ({ voice, score: score(voice) })).sort((a, b) => b.score - a.score);
  const namedFeminineEnglish = ranked.find(({ voice }) =>
    feminineNames.test(voice.name || "") && (voice.lang || "").toLowerCase().startsWith("en")
  );
  return (namedFeminineEnglish || ranked.find(({ voice }) => (voice.lang || "").toLowerCase().startsWith("en")) || ranked[0]).voice;
}

function waitForSpeechVoices() {
  if (!("speechSynthesis" in window) || speechSynthesis.getVoices().length) {
    preferredSpeechVoice = chooseSpeechVoice();
    return Promise.resolve();
  }
  return Promise.race([
    new Promise((resolve) => speechSynthesis.addEventListener("voiceschanged", resolve, { once: true })),
    sleep(700),
  ]).then(() => { preferredSpeechVoice = chooseSpeechVoice(); });
}

// ---- speaking (slow, one sentence at a time with short pauses) ----
function speakOne(s, voiceRate) {
  return new Promise((res) => {
    const u = new SpeechSynthesisUtterance(s);
    preferredSpeechVoice = preferredSpeechVoice || chooseSpeechVoice();
    u.voice = preferredSpeechVoice;
    u.rate = voiceRate ?? Number(rate.value);
    u.pitch = 1.04;
    u.volume = 1;
    u.lang = preferredSpeechVoice?.lang || navigator.language || "en-US";
    u.onend = res;
    u.onerror = (event) => {
      if (!event.error || !["canceled", "interrupted"].includes(event.error)) {
        status.setAttribute("aria-live", "polite");
      }
      res();
    };
    speechSynthesis.speak(u);
  });
}
async function talk(text, { voiceRate, pause = 550 } = {}) {
  if (inSession) status.textContent = text;
  if (!("speechSynthesis" in window)) return;
  const my = ++talkToken;
  speechSynthesis.cancel();
  for (const s of text.split(/(?<=[.?!])\s+/)) {
    if (my !== talkToken) return;
    await speakOne(s, voiceRate);
    await sleep(pause);
  }
}
function say(text) {
  status.textContent = text;
  if (!inSession && speak.checked) talk(text);   // opt-in speech for people without a screen reader
}

function refresh() {
  setOn(voiceBtn, state === "idle");
  setOn(play, state === "idle");
  setOn(practiceBtn, state === "idle" && phones.checked);
  setOn(start, state === "idle" && phones.checked);
  setOn(stop, state === "recording");
}
const idle = () => { state = inSession ? "busy" : "idle"; refresh(); };

// aria-disabled keeps the button focusable, so focus never jumps when a button turns off.
function onPress(btn, reason, fn) {
  btn.addEventListener("click", () => {
    if (btn.getAttribute("aria-disabled") === "true") { say(reason()); return; }
    fn();
  });
}
const idleReason = () => state === "idle"
  ? "Tick the headphones box first. Without headphones, the microphone hears the reference melody."
  : "Wait until the current step has finished.";

async function loadMelodies() {
  try {
    const r = await fetch("/api/melodies");
    if (!r.ok) throw new Error("Server error");
    const list = await r.json();
    melody.innerHTML = "";
    list.forEach((m) => melody.add(new Option(m.label, m.id)));
    return true;
  } catch {
    const msg = "Could not connect to the MelodyMate server. Make sure the server window is running.";
    say(msg);
    return false;
  }
}

async function playRef() {
  let r;
  try {
    r = await fetch("/api/reference/" + encodeURIComponent(melody.value));
  } catch {
    throw new Error("Could not connect to the MelodyMate server. Make sure the server window is running.");
  }
  if (!r.ok) throw new Error("The reference melody could not be loaded.");

const url = URL.createObjectURL(await r.blob());
const audio = new Audio(url);
currentAudio = audio;

try {
    await new Promise((resolve, reject) => {
  audio.onended = () => {
    currentAudio = null;
    resolve();
  };

  audio.onpause = () => {
    if (currentAudio !== audio) resolve();
  };

  audio.onerror = (e) => {
    currentAudio = null;
    reject(e);
  };

  audio.play().catch((e) => {
    currentAudio = null;
    reject(e);
  });
});
} finally {
    URL.revokeObjectURL(url);
}

}

async function beep(times) {
  const ctx = new AudioContext();
  for (let i = 0; i < times; i++) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.2;
    o.connect(g); g.connect(ctx.destination); o.start();
    await sleep(180); o.stop(); await sleep(150);
  }
  await ctx.close();
}

async function playReference() {
  state = "playing"; refresh(); say("Playing the reference melody.");
  try { await playRef(); say("The reference melody has finished."); }
  catch { say("The reference melody could not be played."); }
  idle();
}

// ---- recording: raw audio to WAV, no extra converter needed ----
async function openMic() {
  if (!navigator.mediaDevices || !window.AudioWorkletNode) {
    throw Object.assign(new Error("This browser cannot record here. Use Chrome or Edge, opened at http://127.0.0.1:8000."), { name: "Unsupported" });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = new AudioContext();
  const code = "class R extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice());return true}}registerProcessor('rec',R)";
  const modUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  await ctx.audioWorklet.addModule(modUrl);
  URL.revokeObjectURL(modUrl);
  const r = { stream, ctx, chunks: [], active: false, auto: false, heard: false, last: 0, t0: 0, stopping: false };
  const node = new AudioWorkletNode(ctx, "rec");
  node.port.onmessage = (e) => {
    if (!r.active) return;
    r.chunks.push(e.data);
    if (!r.auto || r.stopping) return;
    let s = 0; for (const x of e.data) s += x * x;
    const now = performance.now();
    if (Math.sqrt(s / e.data.length) > 0.01) { r.heard = true; r.last = now; }
    const quiet = r.heard && now - r.last > 2000;      // two seconds of silence after singing
    const noSound = !r.heard && now - r.t0 > 12000;    // nothing sung for 12 seconds
    if (quiet || noSound || now - r.t0 > 45000) { r.stopping = true; stopAndAnalyze(); }
  };
  const mute = ctx.createGain(); mute.gain.value = 0;  // keeps the audio graph running, makes no sound
  ctx.createMediaStreamSource(stream).connect(node);
  node.connect(mute); mute.connect(ctx.destination);
  return r;
}
function beginCapture(auto) {
  rec.active = true; rec.auto = auto; rec.t0 = rec.last = performance.now();
  state = "recording"; refresh();
}
function closeMic() {
  if (!rec) return;
  rec.stream.getTracks().forEach((t) => t.stop());
  rec.ctx.close().catch(() => {});
  rec = null;
}
function micMessage(err) {
  const n = err && err.name;
  return n === "NotAllowedError" ? "Microphone permission was denied. Allow the microphone for this page in the browser, then try again."
    : n === "NotFoundError" ? "No microphone was found. Connect one and try again."
    : (err && err.message) || "Recording could not start.";
}

function encodeWav(chunks, total, rate) {
  const buf = new ArrayBuffer(44 + total * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + total * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, total * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, c[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

function finish(result) { if (onResult) { onResult(result); onResult = null; } }

function showStructuredReport(data) {
  const report = data.report || {
    score: data.feedback || "Analysis complete.",
    pitch_sequence: "See the full feedback below.",
    timing: "Timing feedback is not available.",
    notes: data.detected_notes || [],
  };
  const sections = [
    ["Score", report.score],
    ["Pitch and note sequence", report.pitch_sequence || "No additional pitch or note-sequence feedback."],
    ["Timing", report.timing || "Timing feedback is not available."],
    ["Notes heard", Array.isArray(report.notes) && report.notes.length ? report.notes.join(", ") : "No notes were detected."],
  ];
  details.replaceChildren();
  sections.forEach(([title, content]) => {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    const paragraph = document.createElement("p");
    heading.textContent = title;
    paragraph.textContent = content;
    section.append(heading, paragraph);
    details.append(section);
  });
  return `Singing report. ${sections.map(([title, content]) => `${title}. ${content}`).join(". ")}.`;
}

async function stopAndAnalyze() {
  if (!rec) return;
  const { chunks, auto } = rec; rec.active = false;
  const sampleRate = rec.ctx.sampleRate;
  state = "busy"; refresh();
  closeMic();
  if (auto) await beep(1);   // one beep tells the singer the recording has ended
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total < sampleRate) {
    say(NOTHING); finish({ simple: NOTHING, report: `Singing report. Score. ${NOTHING} Pitch and note sequence. No notes were detected. Timing. There were not enough detected notes to assess timing. Notes heard. No notes were detected.` }); idle(); return;
  }
  if (inSession) talk("Thank you. I am checking your singing now.");
  else say("Analyzing your singing. This takes a few seconds.");
  const form = new FormData();
  form.append("file", encodeWav(chunks, total, sampleRate), "recording.wav");
  form.append("melody", melody.value);
  form.append("mode", mode.value);
  try {
    const r = await fetch("/api/analyze/singing", { method: "POST", body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || "The server could not analyze the recording.");
    const fullReport = showStructuredReport(data);
    say(data.simple);
    finish({ simple: data.simple, report: fullReport });
  } catch (err) {
    const msg = (err.message && (err.message.includes("Failed to fetch") || err.message.includes("NetworkError")))
      ? "Analysis failed. Could not connect to the MelodyMate server. Make sure the server window is running."
      : "Analysis failed. " + err.message;
    say(msg);
    finish(null);
  }
  idle();
}

async function startRecording() {
  state = "busy"; refresh(); say("Waiting for the microphone.");
  try {
    rec = await openMic();
    beginCapture(false);
    say("Recording. Sing the melody, then press Stop and analyze.");
  } catch (err) { closeMic(); idle(); say(micMessage(err)); }
}

// One press: listen, two beeps, record until silence, analyze.
async function practice() {
  state = "busy"; refresh();
  say("Listen to the melody. After two beeps, sing it. Recording stops after two seconds of silence.");
  try {
    rec = await openMic();
    await sleep(speak.checked ? 7000 : 4500);   // time for the message to be heard before the melody starts
    state = "playing"; refresh();
    await playRef();
    await sleep(500);
    await beep(2);
    beginCapture(true);
  } catch (err) { closeMic(); idle(); say(micMessage(err)); }
}

// ---- voice session: questions answered by voice or by a key ----
let srError = "";

function stopEverything(msg = "Session stopped.") {
  cancelled = true;
  clearTimeout(pendingDigitTimer);
  pendingDigitTimer = null;
  pendingDigits = "";
  talkToken++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (abortListen) {
    const ab = abortListen;
    abortListen = null;
    ab(null);
  }
  if (currentAudio) {
    try { currentAudio.pause(); } catch {}
    currentAudio = null;
  }
  finish(null);
  closeMic();
  state = "idle";
  inSession = false;
  refresh();
  status.setAttribute("aria-live", "polite");
  status.textContent = msg;
  if (speak.checked) talk(msg);
  if (voiceBtn) {
    try { voiceBtn.focus(); } catch {}
  }
}

function handleKey(e) {
  const k = e.key.toLowerCase();

  // Escape always stops everything
  if (e.key === "Escape") {
    e.preventDefault();
    stopEverything("Stopped.");
    return;
  }

  // Any keypress stops currently playing speech
  if ("speechSynthesis" in window && speechSynthesis.speaking) {
    speechSynthesis.cancel();
    talkToken++;
  }

  if (!inSession) return;

  // 'r' key repeats the last question with full instructions
  if (k === "r") {
    e.preventDefault();
    if (repeatHandler) repeatHandler();
    return;
  }

  if (!currentOptions || !currentResolve) return;

  const choose = (opt) => {
    if (!opt) return;
    clearTimeout(pendingDigitTimer);
    pendingDigitTimer = null;
    pendingDigits = "";
    const resolve = currentResolve;
    const abort = abortListen;
    currentOptions = null;
    currentResolve = null;
    abortListen = null;
    if (abort) abort(opt.value);
    else resolve(opt.value);
  };

  if (/^\d$/.test(k) && currentOptions.some((option) => /^\d+$/.test(option.key))) {
    e.preventDefault();
    const candidateDigits = pendingDigits + k;
    const exact = currentOptions.find((option) => option.key === candidateDigits);
    const longer = currentOptions.some((option) => option.key.startsWith(candidateDigits) && option.key.length > candidateDigits.length);
    if (!exact && !currentOptions.some((option) => option.key.startsWith(candidateDigits))) {
      pendingDigits = k;
    } else {
      pendingDigits = candidateDigits;
    }
    const selected = currentOptions.find((option) => option.key === pendingDigits);
    const hasLonger = currentOptions.some((option) => option.key.startsWith(pendingDigits) && option.key.length > pendingDigits.length);
    clearTimeout(pendingDigitTimer);
    if (selected && !hasLonger) choose(selected);
    else if (selected || longer) {
      pendingDigitTimer = setTimeout(() => choose(selected), 750);
    }
    return;
  }

  if (k === "enter" && pendingDigits) {
    e.preventDefault();
    choose(currentOptions.find((option) => option.key === pendingDigits));
    return;
  }

  const opt = currentOptions.find((option) => option.key.toLowerCase() === k);
  if (opt) {
    e.preventDefault();
    choose(opt);
  }
}

document.addEventListener("keydown", handleKey);
function listenOnce(options) {
  return new Promise((resolve) => {
    let done = false, rc = null, timer;
    const end = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      abortListen = null;
      currentOptions = null;
      currentResolve = null;
      try { if (rc) rc.stop(); } catch {}
      resolve(v);
    };

    abortListen = end;
    currentOptions = options;
    currentResolve = end;

    const timeoutMs = (!SR || srError === "network") ? 6000 : 9000;
    timer = setTimeout(() => end(null), timeoutMs);

    if (!SR || srError === "network") return;

    try {
      rc = new SR();
      rc.lang = navigator.language || "en-US";
      rc.maxAlternatives = 3;
      rc.onresult = (e) => {
        const heard = [...e.results[0]].map((a) => a.transcript.toLowerCase()).join(" ");
        const o = options.find((x) => x.words.some((w) => new RegExp("\\b" + w + "\\b").test(heard)));
        end(o ? o.value : null);
      };
      rc.onerror = (e) => {
        srError = e.error || "";
        if (srError === "network" || srError === "not-allowed") {
          end(null);
        }
      };
      rc.onend = () => end(null);
      rc.start();
    } catch {
      end(null);
    }
  });
}

async function askQuestion(spec) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let repeated = false;
    repeatHandler = () => {
      repeated = true;
      talkToken++;
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      if (abortListen) {
        const ab = abortListen;
        abortListen = null;
        ab("repeat");
      }
    };

    let promptText = "";
    if (attempt === 0) {
      promptText = spec.learned ? spec.shortPrompt : spec.fullPrompt;
    } else {
      promptText = "Sorry, I did not catch that. " + spec.fullPrompt;
      if (srError === "network") {
        promptText = "Voice answers need an internet connection. You can press the keys instead. " + spec.fullPrompt;
      }
    }

    currentOptions = spec.options;
    let answeredEarly = null;
    currentResolve = (v) => { answeredEarly = v; };

    await talk(promptText);
    guard();

    if (repeated) continue;
    if (answeredEarly && answeredEarly !== "repeat") {
      if (spec.setLearned) spec.setLearned();
      currentOptions = null;
      currentResolve = null;
      repeatHandler = null;
      return answeredEarly;
    }

    if (spec.beep !== false) {
      try { await beep(1); } catch { /* Number and voice answers still work if audio is locked. */ }
    }
    guard();
    if (answeredEarly && answeredEarly !== "repeat") {
      if (spec.setLearned) spec.setLearned();
      currentOptions = null;
      currentResolve = null;
      repeatHandler = null;
      return answeredEarly;
    }

    const val = await listenOnce(spec.options);
    guard();

    if (val === "repeat" || repeated) continue;
    if (val) {
      if (spec.setLearned) spec.setLearned();
      currentOptions = null;
      currentResolve = null;
      repeatHandler = null;
      return val;
    }
  }
  currentOptions = null;
  currentResolve = null;
  repeatHandler = null;
  return null;
}

const YES_NO = [
  { value: "yes", key: "1", words: ["yes", "yeah", "yep", "okay", "ok", "sure", "ready", "again", "repeat"] },
  { value: "no", key: "2", words: ["no", "nope", "stop", "exit", "quit", "different", "next"] },
];
const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function melodyOptions() {
  // Build voice choices from the server-provided song library. No song is
  // hardwired to a particular number or treated as the standard selection.
  return Array.from(melody.options).slice(0, 9).map((option, index) => {
    const number = String(index + 1);
    const word = NUMBER_WORDS[index] || number;
    return {
      value: option.value,
      key: number,
      words: [word, number, option.label.toLowerCase()],
    };
  });
}

function askYesNo(questionText) {
  return askQuestion({
    fullPrompt: `${questionText} Say yes or press 1. Say no or press 2.`,
    shortPrompt: `${questionText} Yes or no?`,
    options: YES_NO,
    learned: yesNoLearned,
    setLearned: () => { yesNoLearned = true; },
  });
}

function askMelody() {
  const options = melodyOptions();
  const choices = options.map((option, index) => {
    const label = melody.options[index]?.textContent || option.value;
    return `Say ${NUMBER_WORDS[index] || option.key}, or press ${option.key}, for ${label}.`;
  });
  return askQuestion({
    fullPrompt: `Which melody? ${choices.join(" ")}`,
    shortPrompt: `Which melody? Choose from one to ${options.length}.`,
    options,
    learned: melodyLearned,
    setLearned: () => { melodyLearned = true; },
  });
}

async function attempt() {
  try {
    if (!rec) rec = await openMic();
    guard();
    await playRef(); guard();
    await sleep(500); await beep(2); guard();
  } catch (err) {
    closeMic();
    if (!cancelled) await talk(micMessage(err));
    return null;
  }
  const done = new Promise((res) => { onResult = res; });
  beginCapture(true);
  return done;
}

async function singingSession() {
  let on = null;
  for (let i = 0; i < 3 && on !== "yes"; i++) {
    on = await askYesNo("Are you wearing headphones?");
    if (on === "no") {
      await talk("Please put on your headphones first. Without them, the microphone hears the melody.");
    }
    guard();
  }
  if (on !== "yes") return "I could not confirm your headphones. Goodbye.";
  mode.value = "relative";   // beginners may sing in any key

  for (;;) {
    const m = await askMelody();
    if (!m) return "I did not hear a choice. Goodbye.";
    melody.value = m;
    for (;;) {
      await talk("Listen to the melody first. Then, after two beeps, sing it. I will stop listening when you are quiet for two seconds.");
      guard();
      const res = await attempt(); guard();
      if (!res) return "The recording did not work. Goodbye.";
      let again = true;
      for (let i = 0; i < 3 && again; i++) {
        await talk(res.report || res.simple, { voiceRate: 0.45, pause: 850 }); guard();
        again = (await askYesNo("Would you like to hear the full report again?")) === "yes";
      }
      if ((await askYesNo("Would you like to sing it again?")) !== "yes") break;
    }
    if ((await askYesNo("Would you like to try a different melody?")) !== "yes") {
      return "Well done for practicing. Goodbye.";
    }
  }
}

const MODULES = [
  { value: "singing", key: "1", words: ["singing", "singing practice", "practice singing"] },
  { value: "keyboard", key: "2", words: ["keyboard", "keyboard learning", "piano", "learn piano"] },
  { value: "guided", key: "3", words: ["guided", "guided practice", "guided note practice", "note practice"] },
  { value: "stop", key: "4", words: ["stop", "exit", "quit", "goodbye"] },
];

function focusSection(id) {
  const heading = $(id);
  if (!heading) return;
  heading.scrollIntoView({ behavior: "smooth", block: "start" });
  try { heading.focus({ preventScroll: true }); } catch {}
}

function chooseModuleQuestion() {
  return askQuestion({
    fullPrompt: "Which learning module would you like? Say singing practice or press 1. Say keyboard learning or press 2. Say guided note practice or press 3. Say stop or press 4.",
    shortPrompt: "Choose a module. Singing is 1. Keyboard learning is 2. Guided note practice is 3. Stop is 4.",
    options: MODULES,
    learned: false,
    beep: false,
  });
}

function octaveOptions() {
  return [
    { value: "0", key: "1", words: ["zero", "octave zero", "0"] },
    { value: "1", key: "2", words: ["one", "octave one", "1"] },
    { value: "2", key: "3", words: ["two", "octave two", "2"] },
    { value: "3", key: "4", words: ["three", "octave three", "3"] },
    { value: "4", key: "5", words: ["four", "octave four", "4"] },
    { value: "5", key: "6", words: ["five", "octave five", "5"] },
    { value: "6", key: "7", words: ["six", "octave six", "6"] },
    { value: "7", key: "8", words: ["seven", "octave seven", "7"] },
    { value: "8", key: "9", words: ["eight", "octave eight", "8"] },
    { value: "back", key: "0", words: ["back", "menu", "modules"] },
  ];
}

function pianoNoteOptions(keys) {
  const octaveWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return keys.map((item, index) => {
    const name = pianoSpokenName(item.note).toLowerCase();
    const spokenOctave = name.replace(/\d+$/, (digit) => octaveWords[Number(digit)] || digit);
    return {
      value: item.midi,
      key: String(index + 1),
      words: [name, spokenOctave, item.note.toLowerCase(), String(index + 1), ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"][index] || ""].filter(Boolean),
    };
  });
}

async function askOctave() {
  const options = octaveOptions();
  const menu = options.filter((item) => item.value !== "back").map((item) => `Press ${item.key} for octave ${item.value}.`).join(" ");
  return askQuestion({
    fullPrompt: `Choose an octave. Say the octave number or press its number. ${menu} Say back or press zero to return to modules.`,
    shortPrompt: "Choose an octave from zero to eight, or press zero for modules.",
    options,
    learned: false,
  });
}

async function keyboardLearningSession() {
  focusSection("keyboard-learning-title");
  await talk("Keyboard learning. I will guide you without a pointer. First choose an octave by saying its number or pressing a number. Then choose a note by saying its name or pressing its number. You can ask me to play or speak the selected note.");
  while (!cancelled) {
    const selectedOctave = await askOctave();
    guard();
    if (selectedOctave === "back" || selectedOctave === "stop") return;
    pianoOctave.value = selectedOctave;
    renderPianoKeys();
    const visible = pianoKeys.filter((item) => item.octave === Number(selectedOctave));
    if (!visible.length) {
      await talk("I could not find keys in that octave. Please choose another octave.");
      continue;
    }

    let changeOctave = false;
    while (!cancelled && !changeOctave) {
      const noteMenu = visible.map((item, index) => `Press ${index + 1} for ${pianoSpokenName(item.note)}.`).join(" ");
      const picked = await askQuestion({
        fullPrompt: `Choose a note in octave ${selectedOctave}. Say the note name or press its number. ${noteMenu}`,
        shortPrompt: `Choose a note in octave ${selectedOctave}. Say its name, or press its number from 1 to ${visible.length}.`,
        options: pianoNoteOptions(visible),
        learned: false,
      });
      guard();
      if (picked === null) { changeOctave = true; continue; }
      const key = visible.find((item) => item.midi === picked);
      if (!key) continue;
      selectPianoKey(key, false);
      await talk(`Selected ${pianoSpokenName(key.note)}.`);
      const action = await askQuestion({
        fullPrompt: "Choose what to do with the selected note. Say play or press 1. Say speak the note name or press 2. Say another note or press 3. Say change octave or press 4. Say modules or press 5.",
        shortPrompt: "Play is 1. Speak the note name is 2. Another note is 3. Change octave is 4. Modules is 5.",
        options: [
          { value: "play", key: "1", words: ["play", "play note", "hear note"] },
          { value: "speak", key: "2", words: ["speak", "speak note", "say note name"] },
          { value: "note", key: "3", words: ["another note", "choose note", "note"] },
          { value: "octave", key: "4", words: ["change octave", "another octave", "octave"] },
          { value: "back", key: "5", words: ["back", "modules", "menu"] },
        ],
        learned: false,
      });
      guard();
      if (action === "back") return;
      if (action === "octave") { changeOctave = true; continue; }
      if (action === "play") {
        playPianoMidi(key.midi);
        await talk(`Playing ${pianoSpokenName(key.note)}.`);
      } else if (action === "speak") {
        await talk(pianoSpokenName(key.note));
      }
    }
  }
}

function guidedNoteOptions() {
  const octaveWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return exerciseNotes.map((midi, index) => {
    const key = noteForMidi(midi);
    const name = pianoSpokenName(key?.note || String(midi)).toLowerCase();
    const spokenOctave = name.replace(/\d+$/, (digit) => octaveWords[Number(digit)] || digit);
    const numberNames = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
    return { value: midi, key: String(index + 1), words: [name, spokenOctave, String(index + 1), numberNames[index]] };
  });
}

async function guidedPracticeSession() {
  focusSection("guided-note-title");
  await talk("Guided note practice. I will play a note. Tell me which note you heard by saying its name, or press the number for that note. You can also ask to hear the target again.");
  let begin = await askQuestion({
    fullPrompt: "Would you like to start the guided exercise, hear the first target note again, or return to the modules? Say start or press 1. Say hear target again or press 2. Say modules or press 3.",
    shortPrompt: "Start is 1. Hear target again is 2. Modules is 3.",
    options: [
      { value: "start", key: "1", words: ["start", "begin", "exercise"] },
      { value: "hear", key: "2", words: ["hear", "hear target", "repeat target", "again"] },
      { value: "back", key: "3", words: ["modules", "back", "menu"] },
    ],
    learned: false,
  });
  if (begin === "back") return;
  if (begin === "hear") {
    playPianoMidi(exerciseNotes[0]);
    await sleep(950);
    await talk("Here is the first target note again. I have not told you its name yet.");
    begin = "start";
  }
  if (begin !== "start") return;

  for (let i = 0; i < exerciseNotes.length && !cancelled; i++) {
    const targetMidi = exerciseNotes[i];
    const targetKey = noteForMidi(targetMidi);
    let correct = false;
    while (!correct && !cancelled) {
      playPianoMidi(targetMidi);
      await sleep(950);
      const guidedOptions = guidedNoteOptions();
      const optionsText = guidedOptions.map((option, index) => {
        const key = noteForMidi(option.value);
        return `Press ${index + 1} for ${pianoSpokenName(key.note)}.`;
      }).join(" ");
      const answer = await askQuestion({
        fullPrompt: `Target note ${i + 1} of ${exerciseNotes.length}. Which note did you hear? Say the note name or use a number. ${optionsText} Say repeat target or press 9. Say modules or press 0.`,
        shortPrompt: `Note ${i + 1} of ${exerciseNotes.length}. Say the note name, or press 1 through 8. Repeat target is 9. Modules is 0.`,
        options: [
          ...guidedOptions,
          { value: "repeat", key: "9", words: ["repeat", "repeat target", "hear again"] },
          { value: "back", key: "0", words: ["modules", "back", "menu"] },
        ],
        learned: false,
      });
      guard();
      if (answer === "back") return;
      if (answer === "repeat" || answer === null) continue;
      if (answer === targetMidi) {
        correct = true;
        selectPianoKey(targetKey, false);
        await talk(i === exerciseNotes.length - 1 ? "Correct. You completed the guided exercise." : "Correct. Get ready for the next target note.");
      } else {
        const answeredKey = noteForMidi(answer);
        await talk(`You chose ${pianoSpokenName(answeredKey?.note || "that note")}. The target was ${pianoSpokenName(targetKey.note)}. Listen again and try once more, or say repeat target.`);
      }
    }
  }
}

async function runSingingModule() {
  focusSection("singing-title");
  try {
    rec = await openMic();
  } catch (err) {
    await talk(micMessage(err));
    return;
  }
  try {
    const ending = await singingSession();
    if (ending) await talk(ending);
  } finally {
    closeMic();
  }
}

async function voiceSession() {
  inSession = true;
  cancelled = false;
  state = "busy";
  refresh();
  status.setAttribute("aria-live", "speechSynthesis" in window ? "off" : "polite");
  details.setAttribute("aria-live", "off");
  try { $("page-title").focus({ preventScroll: true }); } catch {}

  try {
    await waitForSpeechVoices();
    await talk("Welcome to MelodyMate. The guide starts automatically. Answer by speaking or pressing a number. Press R to repeat a question. Press Escape to stop.", { voiceRate: 0.48, pause: 650 });
    while (!cancelled) {
      const choice = await chooseModuleQuestion();
      guard();
      if (choice === "stop") break;
      if (choice === "singing") await runSingingModule();
      else if (choice === "keyboard") await keyboardLearningSession();
      else if (choice === "guided") await guidedPracticeSession();
      else await talk("I did not hear a module choice. I will ask again. You can press 1 for singing, 2 for keyboard learning, or 3 for guided note practice.");
      guard();
      if (!cancelled) await talk("You are back at the module menu.");
    }
  } catch (err) {
    if (!cancelled) await talk("Sorry, something went wrong. " + (err.message || ""));
  } finally {
    inSession = false;
    closeMic();
    state = "idle";
    refresh();
    status.setAttribute("aria-live", "polite");
    details.setAttribute("aria-live", "polite");
    status.textContent = cancelled ? "The voice guide has stopped." : "The voice guide has ended. Choose Repeat welcome and choose a module to start again.";
    if (voiceBtn) try { voiceBtn.focus(); } catch {}
  }
}

onPress(voiceBtn, () => "Wait until the current step has finished.", voiceSession);
onPress(practiceBtn, idleReason, practice);
onPress(play, () => "Wait until the current step has finished.", playReference);
onPress(start, idleReason, startRecording);
onPress(stop, () => "Recording has not started.", stopAndAnalyze);
phones.addEventListener("change", refresh);
refresh();


// ---- Realistic and accessible 88-key piano learning panel ----
const pianoGrid = $("piano-keys");
const pianoOctave = $("keyboard-octave");
const pianoStatus = $("keyboard-status");
const playKeyButton = $("play-keyboard-note");
const announceKeyButton = $("announce-keyboard-note");
const startExerciseButton = $("start-note-exercise");
const repeatTargetButton = $("repeat-note-target");
const exercisePrompt = $("note-exercise-prompt");
let pianoKeys = [];
let selectedPianoKey = null;
let pianoAudioContext = null;
let exerciseActive = false;
let exerciseIndex = 0;
const exerciseNotes = [60, 62, 64, 65, 67, 69, 71, 72]; // C4 major scale, ending C5

function midiFrequency(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
function pianoSpokenName(note) { return note.replace("#", " sharp ").replace(/([A-G])(-?\d+)/, "$1 $2"); }
function noteForMidi(midi) { return pianoKeys.find((key) => key.midi === midi); }

function speakPianoMessage(message) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  preferredSpeechVoice = preferredSpeechVoice || chooseSpeechVoice();
  utterance.voice = preferredSpeechVoice;
  utterance.lang = preferredSpeechVoice?.lang || navigator.language || "en-US";
  utterance.rate = Number(rate?.value || 0.55);
  utterance.pitch = 1.04;
  utterance.volume = 1;
  speechSynthesis.speak(utterance);
}

function playPianoMidi(midi) {
  if (!Number.isInteger(midi) || midi < 21 || midi > 108) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) { pianoStatus.textContent = "Audio playback is not supported in this browser."; return; }
  pianoAudioContext = pianoAudioContext || new AudioCtx();
  if (pianoAudioContext.state === "suspended") pianoAudioContext.resume();
  const oscillator = pianoAudioContext.createOscillator();
  const gain = pianoAudioContext.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.value = midiFrequency(midi);
  const now = pianoAudioContext.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.22, now + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
  oscillator.connect(gain); gain.connect(pianoAudioContext.destination);
  oscillator.start(now); oscillator.stop(now + 0.92);
}

function highlightExerciseOctave() {
  if (!pianoGrid) return;
  const target = exerciseActive ? noteForMidi(exerciseNotes[exerciseIndex]) : null;
  pianoGrid.querySelectorAll(".piano-key").forEach((button) => {
    const key = pianoKeys.find((item) => item.midi === Number(button.dataset.midi));
    button.classList.toggle("target-octave", Boolean(target && key && key.octave === target.octave));
  });
}

function updateExercisePrompt() {
  if (!exerciseActive) return;
  const midi = exerciseNotes[exerciseIndex];
  const target = noteForMidi(midi);
  if (!target) return;
  const message = `Find ${pianoSpokenName(target.note)}. This is note ${exerciseIndex + 1} of ${exerciseNotes.length}.`;
  exercisePrompt.textContent = message;
  repeatTargetButton.disabled = false;
  highlightExerciseOctave();
  speakPianoMessage(message);
  playPianoMidi(midi);
}

function selectPianoKey(key, shouldPlay = false) {
  selectedPianoKey = key;
  pianoGrid.querySelectorAll(".piano-key").forEach((button) => {
    const active = Number(button.dataset.midi) === key.midi;
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  pianoStatus.textContent = `${pianoSpokenName(key.note)}, MIDI note ${key.midi}${shouldPlay ? ". Playing note." : ". Selected."}`;
  if (shouldPlay) playPianoMidi(key.midi);

  if (exerciseActive) {
    const expected = exerciseNotes[exerciseIndex];
    if (key.midi === expected) {
      exerciseIndex += 1;
      if (exerciseIndex >= exerciseNotes.length) {
        exerciseActive = false;
        exercisePrompt.textContent = "Excellent. You completed all eight notes of the C major scale.";
        repeatTargetButton.disabled = true;
        highlightExerciseOctave();
        speakPianoMessage("Excellent. You completed the guided exercise.");
      } else {
        exercisePrompt.textContent = `Correct. ${pianoSpokenName(key.note)}. Get ready for the next note.`;
        speakPianoMessage(`Correct. ${pianoSpokenName(key.note)}.`);
        updateExercisePrompt();
      }
    } else {
      const expectedKey = noteForMidi(expected);
      const message = `Not quite. Try again. Find ${pianoSpokenName(expectedKey.note)}.`;
      exercisePrompt.textContent = message;
      speakPianoMessage(message);
    }
  }
}

function renderPianoKeys() {
  if (!pianoGrid) return;
  const filter = pianoOctave.value;
  const visible = pianoKeys.filter((key) => filter === "all" || key.octave === Number(filter));
  pianoGrid.replaceChildren();
  let whiteIndex = 0;
  visible.forEach((key) => {
    const isBlack = key.note.includes("#");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "piano-key " + (isBlack ? "black-key" : "white-key");
    if (!isBlack && key.note.startsWith("C")) button.classList.add("octave-start");
    button.style.setProperty("--white-index", String(whiteIndex));
    button.textContent = key.note;
    button.dataset.midi = String(key.midi);
    button.setAttribute("aria-label", `${pianoSpokenName(key.note)}. ${isBlack ? "Black" : "White"} piano key. Play note.`);
    button.setAttribute("aria-pressed", selectedPianoKey && selectedPianoKey.midi === key.midi ? "true" : "false");
    button.addEventListener("click", () => selectPianoKey(key, true));
    pianoGrid.append(button);
    if (!isBlack) whiteIndex += 1;
  });
  pianoGrid.style.setProperty("--white-count", String(whiteIndex));
  pianoStatus.textContent = `Showing ${visible.length} piano keys. Range ${visible[0]?.note || "none"} to ${visible[visible.length - 1]?.note || "none"}.`;
  highlightExerciseOctave();
}

async function loadPianoKeys() {
  if (!pianoGrid) return;
  try {
    const response = await fetch("/api/piano/keys");
    if (!response.ok) throw new Error("Could not load piano keys.");
    const list = await response.json();
    pianoKeys = list.map((item) => ({ ...item, octave: Math.floor(item.midi / 12) - 1 }));
    pianoOctave.replaceChildren(new Option("All keys (A0–C8)", "all"));
    [...new Set(pianoKeys.map((key) => key.octave))].forEach((oct) => {
      const inOctave = pianoKeys.filter((key) => key.octave === oct);
      pianoOctave.add(new Option(`Octave ${oct} (${inOctave[0].note}–${inOctave[inOctave.length - 1].note})`, String(oct)));
    });
    selectedPianoKey = noteForMidi(60); // C4, middle C
    renderPianoKeys();
    selectPianoKey(selectedPianoKey, false);
    return true;
  } catch (error) { pianoStatus.textContent = error.message || "The piano keyboard could not be loaded."; return false; }
}

if (pianoOctave) pianoOctave.addEventListener("change", renderPianoKeys);
if (playKeyButton) playKeyButton.addEventListener("click", () => {
  if (!selectedPianoKey) { pianoStatus.textContent = "Select a piano key first."; return; }
  playPianoMidi(selectedPianoKey.midi);
  pianoStatus.textContent = `Playing ${pianoSpokenName(selectedPianoKey.note)}.`;
});
if (announceKeyButton) announceKeyButton.addEventListener("click", () => {
  if (!selectedPianoKey) { pianoStatus.textContent = "Select a piano key first."; return; }
  const message = pianoSpokenName(selectedPianoKey.note);
  pianoStatus.textContent = `Selected ${message}.`;
  speakPianoMessage(message);
});
if (startExerciseButton) startExerciseButton.addEventListener("click", () => {
  exerciseActive = true;
  exerciseIndex = 0;
  updateExercisePrompt();
});
if (repeatTargetButton) repeatTargetButton.addEventListener("click", () => {
  if (!exerciseActive) return;
  const midi = exerciseNotes[exerciseIndex];
  const target = noteForMidi(midi);
  if (target) {
    playPianoMidi(midi);
    speakPianoMessage(`Target note: ${pianoSpokenName(target.note)}.`);
  }
});
Promise.all([loadMelodies(), loadPianoKeys()]).then(([melodiesReady]) => {
  if (!melodiesReady) return;
  setTimeout(() => {
    try { $("page-title").focus({ preventScroll: true }); } catch {}
    voiceSession();
  }, 350);
});
