// Doodle Guess for the game kit (shared/kit.js): one player draws a word, everyone else races to guess it, and the
// pen goes round the room. Online only; the game server (worker/) runs these rules for everyone.
// The drawer sends their strokes a piece at a time ({ t: "line", id, c, w, p }), undo and clear; the drawing goes to
// everyone as the game's feed (shared/feed.js). Guesses ({ t: "guess", text }) are checked here, so the word never
// reaches the guessers before they've got it.
import { WORDS } from "./words.js";

export const PICK_S = 15, DRAW_S = 80, REVEAL_S = 6;
export const GRID = 256;               // stroke points are 0..255 across and down
export const COLOURS = ["#1d1d1f", "#ffffff", "#e5484d", "#f5a524", "#f7d046", "#30a46c", "#3e83f8", "#8e4ec6", "#8d5a3b", "#f2a7c3"];
export const SIZES = [3, 8, 18];       // pen widths in grid units
const MAX_POINTS = 60;                 // per piece of a stroke
const MAX_ITEMS = 3000;                // per drawing
const MAX_CHAT = 30;
export const REACTIONS = ["😂", "👏", "🤯", "😍", "🙈"];
const REACT_GAP = 0.6, REACT_SHOW = 3;  // seconds between one player's reactions; how long they're sent for

// Guesses are compared in lower case, letters only, ignoring spaces and hyphens: "hotdog", "hot-dog" and "Hot Dog" all
// match "hot dog". `words` keeps the word breaks (a hyphen is one) to find the answer inside a longer guess.
const words = (t) => String(t).toLowerCase().replace(/-/g, " ").replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
const squash = (t) => words(t).join("");
// Right: the guess is the word, or has it as whole words in it ("a smoke", "it's a hotdog").
function isRight(text, word) {
  const w = squash(word), ws = words(text);
  if (!w) return false;
  for (let i = 0; i < ws.length; i++) {
    let run = "";
    for (let j = i; j < ws.length && run.length < w.length; j++) { run += ws[j]; if (run === w) return true; }
  }
  return false;
}
// One letter off (missing, extra or wrong): "close!".
function oneOff(a, b) {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const pick3 = (rand) => {
  const out = [];
  while (out.length < 3) { const w = WORDS[Math.floor(rand() * WORDS.length)]; if (!out.includes(w)) out.push(w); }
  return out;
};
// Points for guessing with `left` of DRAW_S seconds still to go: 50 to 300, in fives.
export const guessPoints = (left) => 50 + Math.round((250 * Math.max(0, left) / DRAW_S) / 5) * 5;
export const DRAWER_POINTS = 50;       // for each player who gets it

export function newGame(players, rand = Math.random) {
  return {
    rand, players,
    rounds: players <= 4 ? 2 : 1,      // each player draws this many times
    order: [], here: {}, drawn: {}, scores: {},
    phase: "wait", drawer: null, choices: [], word: "", left: 0, turnNo: 0,
    guessed: {}, gained: {}, shown: [], items: [], lastStroke: -1, chat: [], chatNo: 0, over: null,
    clock: 0, reacts: [], reactNo: 0, reactedAt: {},
  };
}

export function join(g, seat) {
  g.here[seat] = true;
  if (!g.order.includes(seat)) { g.order.push(seat); g.drawn[seat] = 0; g.scores[seat] = 0; }
  if (g.phase === "wait" && !g.over) nextTurn(g);
}
export function leave(g, seat) {
  delete g.here[seat];
  if (g.over) return;
  if (seat === g.drawer && (g.phase === "pick" || g.phase === "draw")) endTurn(g);
  else if (g.phase === "draw" && everyoneGuessed(g)) endTurn(g);
}

const present = (g) => g.order.filter((s) => g.here[s]);
const guessers = (g) => present(g).filter((s) => s !== g.drawer);
const everyoneGuessed = (g) => guessers(g).length > 0 && guessers(g).every((s) => s in g.guessed);
const say = (g, msg) => { g.chat.push({ n: g.chatNo++, ...msg }); if (g.chat.length > MAX_CHAT) g.chat.shift(); };

// The next player to draw: after the last drawer, in joining order, among those here who still have turns.
function nextTurn(g) {
  const people = present(g);
  if (people.length < 2) { g.phase = "wait"; g.drawer = null; return; }
  const from = g.drawer === null ? -1 : g.order.indexOf(g.drawer);
  let next = null;
  for (let k = 1; k <= g.order.length; k++) {
    const s = g.order[(from + k) % g.order.length];
    if (g.here[s] && g.drawn[s] < g.rounds) { next = s; break; }
  }
  if (next === null) return finish(g);
  Object.assign(g, { phase: "pick", drawer: next, choices: pick3(g.rand), word: "", left: PICK_S, guessed: {}, gained: {}, shown: [] });
  g.turnNo++;
  g.items = []; g.lastStroke = -1;
}
function startDrawing(g, word) {
  Object.assign(g, { phase: "draw", word, choices: [], left: DRAW_S });
  g.drawn[g.drawer]++;
}
function endTurn(g) {
  if (g.phase === "pick") {
    // The drawer left before picking: they lose that turn and, with no word to show, the pen moves straight on.
    // (`text` is for pages from before `gone`, which show it as "<name>: left".)
    g.drawn[g.drawer]++;
    say(g, { s: g.drawer, gone: true, text: "left" });
    return nextTurn(g);
  }
  const n = Object.keys(g.guessed).length;
  if (n && g.drawer !== null) { g.scores[g.drawer] += DRAWER_POINTS * n; g.gained[g.drawer] = DRAWER_POINTS * n; }
  g.phase = "reveal"; g.left = REVEAL_S;
  if (g.word) say(g, { word: g.word });
}
function finish(g) {
  const ranked = [...g.order].sort((a, b) => g.scores[b] - g.scores[a]);
  const best = ranked.filter((s) => g.scores[s] === g.scores[ranked[0]]);
  g.phase = "end"; g.drawer = null;
  g.over = { winner: best.length > 1 ? "draw" : best[0], ranked, scores: { ...g.scores } };
}

export function tick(g, dt) {
  g.clock += dt;
  if (g.reacts.length && g.clock - g.reacts[0].at > REACT_SHOW) g.reacts = g.reacts.filter((r) => g.clock - r.at <= REACT_SHOW);
  if (g.over || g.phase === "wait") return;
  g.left -= dt;
  if (g.phase === "draw") {
    // Hints: a letter shows at half time and another at a quarter (words of 4 letters or more).
    const letters = [...g.word].flatMap((ch, i) => (ch === " " ? [] : [i]));
    const want = letters.length < 4 ? 0 : g.left <= DRAW_S / 4 ? 2 : g.left <= DRAW_S / 2 ? 1 : 0;
    while (g.shown.length < want) {
      const hidden = letters.filter((i) => !g.shown.includes(i));
      g.shown.push(hidden[Math.floor(g.rand() * hidden.length)]);
    }
  }
  if (g.left > 0) return;
  if (g.phase === "pick") startDrawing(g, g.choices[Math.floor(g.rand() * g.choices.length)]);
  else if (g.phase === "draw") endTurn(g);
  else if (g.phase === "reveal") nextTurn(g);
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
export function input(g, seat, m) {
  if (g.over || !m || typeof m !== "object") return false;
  const drawing = g.phase === "draw" && seat === g.drawer;
  if (m.t === "pick") {
    if (g.phase !== "pick" || seat !== g.drawer || !isInt(m.i, 0, 2)) return false;
    startDrawing(g, g.choices[m.i]);
    return true;
  }
  if (m.t === "line") {
    // A piece of stroke `id` (ids only go up; a piece with the last id carries on that stroke).
    const p = m.p;
    if (!drawing || !isInt(m.id, g.lastStroke, 1e6) || !isInt(m.c, 0, COLOURS.length - 1) || !isInt(m.w, 0, SIZES.length - 1)) return false;
    if (!Array.isArray(p) || p.length < 2 || p.length > MAX_POINTS * 2 || p.length % 2 || !p.every((v) => isInt(v, 0, GRID - 1))) return false;
    if (g.items.length >= MAX_ITEMS) return false;
    g.lastStroke = m.id;
    g.items.push([m.id, m.c, m.w, ...p]);
    return true;
  }
  if (m.t === "undo" || m.t === "clear") {
    if (!drawing || g.items.length >= MAX_ITEMS) return false;
    g.items.push([m.t === "undo" ? "u" : "c"]);
    return true;
  }
  if (m.t === "react") {
    // An emoji everyone sees float up for a moment (at most one every REACT_GAP seconds each).
    if (!isInt(m.e, 0, REACTIONS.length - 1) || !g.here[seat] || g.clock - (g.reactedAt[seat] ?? -1e9) < REACT_GAP) return false;
    g.reactedAt[seat] = g.clock;
    g.reacts.push({ n: g.reactNo++, s: seat, e: m.e, at: g.clock });
    if (g.reacts.length > 20) g.reacts.shift();
    return true;
  }
  if (m.t === "guess") {
    const text = typeof m.text === "string" ? m.text.slice(0, 40).replace(/[<>&]/g, "").trim() : "";
    if (!text || seat === g.drawer || seat in g.guessed || !g.here[seat]) return false;
    if (g.phase === "draw" && isRight(text, g.word)) {
      const pts = guessPoints(g.left);
      g.guessed[seat] = pts; g.gained[seat] = pts; g.scores[seat] += pts;
      say(g, { s: seat, ok: true });
      if (everyoneGuessed(g)) endTurn(g);
      return true;
    }
    // Close (one letter off, or the word inside a longer one like "smokestack"): only its guesser sees it, since
    // everyone else would read the answer in it.
    const t = squash(text), w = squash(g.word);
    const close = g.phase === "draw" && t.length >= 3 && (oneOff(t, w) || t.includes(w));
    say(g, { s: seat, text, close: close || undefined });
    return true;
  }
  return false;
}

// What one player sees. The word only reaches the drawer, those who've guessed it, and everyone once the turn is over;
// a guess that was close (nearly the word) only reaches whoever typed it.
export function view(g, seat) {
  const knows = seat === g.drawer || seat in g.guessed || g.phase === "reveal" || g.phase === "end";
  const mask = [...g.word].map((ch, i) => (ch === " " ? " " : g.shown.includes(i) ? ch : "_")).join("");
  return {
    phase: g.phase, drawer: g.drawer, turn: g.turnNo, turns: g.order.length * g.rounds,
    left: Math.max(0, Math.ceil(g.left)),
    choices: seat === g.drawer && g.phase === "pick" ? g.choices : [],
    word: knows ? g.word : "", mask: g.phase === "draw" && !knows ? mask : "",
    scores: g.scores, guessed: Object.keys(g.guessed).map(Number), gained: g.phase === "reveal" ? g.gained : {},
    chat: g.chat.filter((c) => !c.close || c.s === seat).slice(-10),
    reacts: g.reacts.map(({ n, s, e }) => ({ n, s, e })),
  };
}

export default {
  id: "doodle",
  kind: "realtime",
  players: [2, 10],
  modes: ["online"],
  setup: ({ players }) => newGame(players),
  join, leave, input, tick, view,
  feed: (g) => ({ id: g.turnNo, items: g.items }),
  result: (g) => g.over,
  save: (g) => { const { rand, ...rest } = g; return rest; },
  load: (saved) => ({ clock: 0, reacts: [], reactNo: 0, reactedAt: {}, ...saved, rand: Math.random }),
  timeUp(g) { if (!g.over) finish(g); },
  // Shortcuts for the tests (the local test server only takes them): "skip" ends the current phase now.
  dev(g, what) { if (what === "skip" && !g.over && g.phase !== "wait") { g.left = 0; tick(g, 0); } },
};
