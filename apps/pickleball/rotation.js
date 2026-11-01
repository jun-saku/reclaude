// Pickleball rotation: who plays next. Pure functions on the session's queue state (saved in pickleball.sessions.state
// by shared/pickleball.js); every function returns a new state and never changes the one it's given.
//   state: { order: [ids waiting, first in line first; away players keep their place],
//            away: [ids on a break], pairs: [[id, id]: play together], skipped: [ids left out of the next pick],
//            games: { id: matches started }, streak: { id: wins in a row (winners stay) }, stay: [ids] | null (winners
//            who stay on, as a side),
//            next: { a: [ids], b: [ids], manual } | null (the next match, 1 or 2 a side; manual: changed by hand) }
//   tidy(state, here, onCourt)          fits the state to who's here (ids) and who's on a court (ids) now
//   refresh(state, algorithm)           picks the next match (unless it was changed by hand)
//   startNext(state, algorithm)         { state, match: { a, b } }: the next match goes on a court
//   finish(state, algorithm, match, winner)   a match ended ({ a, b }; winner "a", "b" or null): back in line
//   skip / setAway / pair / unpair / swap / addToNext / removeFromNext / moveInLine / repick: the overrides
export const ALGORITHMS = [
  { id: "fair", title: "Fair", hint: "Whoever has played least goes next." },
  { id: "queue", title: "Queue", hint: "Off the court, back of the line." },
  { id: "winners_stay", title: "Winners stay", hint: "Winners stay on (up to 2 wins); the rest go to the back." },
];
export const MAX_STREAK = 2;

const uniq = (ids) => [...new Set(ids)];
const without = (ids, gone) => ids.filter((id) => !gone.includes(id));

export function empty() {
  return { order: [], away: [], pairs: [], skipped: [], games: {}, streak: {}, stay: null, next: null };
}

function clean(state) {
  const s = { ...empty(), ...(state || {}) };
  return {
    order: uniq(s.order || []), away: uniq(s.away || []), pairs: (s.pairs || []).filter((p) => Array.isArray(p) && p.length === 2),
    skipped: uniq(s.skipped || []), games: { ...(s.games || {}) }, streak: { ...(s.streak || {}) },
    stay: s.stay ? [...s.stay] : null,
    next: s.next ? { a: [...s.next.a], b: [...s.next.b], manual: !!s.next.manual } : null,
  };
}

// Who's here and who's playing now: newcomers join the back of the line; whoever left drops out of everything.
export function tidy(state, here, onCourt = []) {
  const s = clean(state);
  const waiting = without(here, onCourt);
  s.order = [...s.order.filter((id) => waiting.includes(id)), ...waiting.filter((id) => !s.order.includes(id))];
  s.away = s.away.filter((id) => waiting.includes(id));
  s.skipped = s.skipped.filter((id) => waiting.includes(id));
  s.pairs = s.pairs.filter(([x, y]) => here.includes(x) && here.includes(y));
  if (s.stay) s.stay = s.stay.filter((id) => waiting.includes(id));
  if (!s.stay?.length) s.stay = null;
  if (s.next && ![...s.next.a, ...s.next.b].every((id) => waiting.includes(id) && !s.away.includes(id))) s.next = null;
  return s;
}

const partnerOf = (s, id) => s.pairs.find((p) => p.includes(id))?.find((x) => x !== id);
// Who can play now, best first: everyone in line and not away; skipped ones last.
function ranked(s, algorithm) {
  const free = s.order.filter((id) => !s.away.includes(id));
  const pos = (id) => s.order.indexOf(id);
  const score = algorithm === "fair" ? (id) => (s.games[id] || 0) * 1000 + pos(id) : pos;
  const sorted = [...free].sort((x, y) => score(x) - score(y));
  return [...sorted.filter((id) => !s.skipped.includes(id)), ...sorted.filter((id) => s.skipped.includes(id))];
}

// Splits players into two sides of these sizes, keeping pairs together where they fit.
function sides(s, chosen, size) {
  const a = [], b = [];
  const left = [...chosen];
  const place = (side, max, ids) => { if (side.length + ids.length <= max) { side.push(...ids); return true; } return false; };
  for (const id of chosen) {
    if (!left.includes(id)) continue;
    const mate = partnerOf(s, id);
    if (mate && left.includes(mate) && (place(a, size.a, [id, mate]) || place(b, size.b, [id, mate]))) {
      left.splice(left.indexOf(id), 1); left.splice(left.indexOf(mate), 1);
    }
  }
  // The rest alternate, first and last together (1st + 4th vs 2nd + 3rd), so the line's front is spread out.
  const rest = left.length === 4 ? [left[0], left[3], left[1], left[2]] : left;
  for (const id of rest) { if (!place(a, size.a, [id])) place(b, size.b, [id]); }
  return { a, b };
}

function pick(s, algorithm) {
  let size = { a: 2, b: 2 };
  const stay = algorithm === "winners_stay" && s.stay?.length ? s.stay.filter((id) => !s.away.includes(id)) : [];
  if (stay.length) size.a = stay.length;
  const pool = ranked(s, algorithm).filter((id) => !stay.includes(id));
  const need = size.a + size.b - stay.length;
  const chosen = [];
  for (const id of pool) {
    if (chosen.length >= need) break;
    if (chosen.includes(id)) continue;
    const mate = partnerOf(s, id);
    if (mate && pool.includes(mate) && !chosen.includes(mate)) {
      if (chosen.length + 2 <= need) chosen.push(id, mate);
      continue; // a pair that doesn't fit waits for the next match together
    }
    chosen.push(id);
  }
  const total = stay.length + chosen.length;
  if (total < 2) return null;
  if (total < size.a + size.b) { // not enough for the sizes asked: 2 v 1, or 1 v 1
    if (stay.length) size = { a: stay.length, b: total - stay.length };
    else size = total === 3 ? { a: 2, b: 1 } : { a: 1, b: 1 };
    if (size.b < 1) return null;
  }
  if (stay.length) return { a: stay, b: sides(s, chosen, { a: size.b, b: 0 }).a, manual: false };
  const out = sides(s, chosen.slice(0, size.a + size.b), size);
  return out.a.length && out.b.length ? { ...out, manual: false } : null;
}

export function refresh(state, algorithm) {
  const s = clean(state);
  if (!s.next?.manual) s.next = pick(s, algorithm);
  return s;
}

export function startNext(state, algorithm) {
  const s = refresh(state, algorithm);
  if (!s.next?.a.length || !s.next?.b.length) return { state: s, match: null };
  const match = { a: s.next.a, b: s.next.b };
  const playing = [...match.a, ...match.b];
  s.order = without(s.order, playing);
  for (const id of playing) s.games[id] = (s.games[id] || 0) + 1;
  s.skipped = [];
  s.stay = null;
  s.next = null;
  return { state: refresh(s, algorithm), match };
}

export function finish(state, algorithm, match, winner = null) {
  const s = clean(state);
  const { a, b } = match;
  const won = winner === "a" ? a : winner === "b" ? b : null;
  const lost = winner === "a" ? b : winner === "b" ? a : null;
  if (algorithm === "winners_stay" && won) {
    for (const id of lost) s.streak[id] = 0;
    for (const id of won) s.streak[id] = (s.streak[id] || 0) + 1;
    if (Math.max(...won.map((id) => s.streak[id])) < MAX_STREAK) {
      s.order = [...won, ...without(s.order, [...won, ...lost]), ...lost];
      s.stay = [...won];
      if (s.next && !s.next.manual) s.next = null;
      return refresh(s, algorithm);
    }
    for (const id of won) s.streak[id] = 0;
  } else {
    for (const id of [...a, ...b]) s.streak[id] = 0;
  }
  // Back of the line in the order they played (winners first, when known).
  const back = won ? [...won, ...lost] : [...a, ...b];
  s.order = [...without(s.order, back), ...back];
  return refresh(s, algorithm);
}

// ---------- overrides ----------
// Not available for the next match: left out of this pick, and first in line after it.
export function skip(state, algorithm, id) {
  const s = clean(state);
  s.skipped = uniq([...s.skipped, id]);
  s.next = null;
  return refresh(s, algorithm);
}
// On a break (or back): keeps their place in line.
export function setAway(state, algorithm, id, away) {
  const s = clean(state);
  s.away = away ? uniq([...s.away, id]) : without(s.away, [id]);
  if (s.next && [...s.next.a, ...s.next.b].includes(id)) s.next = null;
  return refresh(s, algorithm);
}
// Play together (each player in one pair at most).
export function pair(state, algorithm, x, y) {
  const s = clean(state);
  if (x === y) return s;
  s.pairs = [...s.pairs.filter((p) => !p.includes(x) && !p.includes(y)), [x, y]];
  if (s.next && !s.next.manual) s.next = null;
  return refresh(s, algorithm);
}
export function unpair(state, algorithm, id) {
  const s = clean(state);
  s.pairs = s.pairs.filter((p) => !p.includes(id));
  if (s.next && !s.next.manual) s.next = null;
  return refresh(s, algorithm);
}
// In the next match, `out` makes way for `inn` (someone waiting, or in the match: then they change places).
export function swap(state, algorithm, out, inn) {
  const s = refresh(state, algorithm);
  if (!s.next || out === inn) return s;
  const { a, b } = s.next;
  const put = (side) => side.map((id) => (id === out ? inn : id === inn ? out : id));
  s.next = { a: put(a), b: put(b), manual: true };
  return s;
}
// Takes someone out of the next match (a side may be left empty, to fill by hand).
export function removeFromNext(state, algorithm, id) {
  const s = refresh(state, algorithm);
  if (!s.next) return s;
  s.next = { a: without(s.next.a, [id]), b: without(s.next.b, [id]), manual: true };
  return s;
}
// Puts someone waiting (or from the other side) on a side of the next match, if it has room (2 a side at most).
export function addToNext(state, algorithm, side, id) {
  const s = refresh(state, algorithm);
  const next = s.next ? { a: without(s.next.a, [id]), b: without(s.next.b, [id]) } : { a: [], b: [] };
  if (next[side].length >= 2 || s.away.includes(id) || !s.order.includes(id)) return s;
  next[side] = [...next[side], id];
  s.next = { ...next, manual: true };
  return s;
}
// Moves someone in the line to just before `before` (null: the end), back from a break if they were on one.
export function moveInLine(state, algorithm, id, before = null) {
  const s = clean(state);
  if (!s.order.includes(id) || id === before) return s;
  const rest = without(s.order, [id]);
  const at = before && rest.includes(before) ? rest.indexOf(before) : rest.length;
  s.order = [...rest.slice(0, at), id, ...rest.slice(at)];
  s.away = without(s.away, [id]);
  if (s.next && !s.next.manual) s.next = null;
  return refresh(s, algorithm);
}
// Forget changes by hand: the algorithm picks again.
export function repick(state, algorithm) {
  const s = clean(state);
  s.next = null;
  return refresh(s, algorithm);
}
