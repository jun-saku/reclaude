// The Plaza's rules: a small square where people with an account walk around and wave. It runs on the game server
// (worker/src/spaces.js lists it; worker/SPACES.md) and, with ?backend=fake, in the page itself (shared/space.js).
// No DOM here: the server bundles this file.
//
// The map is fixed (MAP below); the world remembers where everyone last stood, so you come back to your spot.
// Input: { t: "go", x, y } walks to a tile (the server finds the way round the fountain and trees), and
// { t: "react", i } shows one of REACTIONS over your head (no free text: strangers can't write anything).

// . grass  - path  ~ water  T tree  * flowers  = bench   (water and trees can't be walked on)
export const MAP = [
  "TT..*......TT",
  "T....-----..T",
  "..*..-...-...",
  "..=..-...-.=.",
  ".----~~~----.",
  ".-..~~~~~..-.",
  ".-..~~~~~..-.",
  ".----~~~----.",
  "..=..-...-.=.",
  "..*..-...-...",
  "T....-----..T",
  "TT......*..TT",
];
export const W = MAP[0].length, H = MAP.length;
export const REACTIONS = ["👋", "😄", "❤️", "👍", "😂", "🎉", "😮", "☕"];
const REACT_MS = 1000; // one reaction a second each
const SPAWN = [[6, 1], [6, 10], [1, 6], [11, 6], [5, 1], [7, 10]];

export const walkable = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !"~T".includes(MAP[y][x]);

// The shortest way from one tile to another (breadth first, 4 directions), as the tiles after `from`; null if none.
export function route([fx, fy], [tx, ty]) {
  if (!walkable(tx, ty)) return null;
  const prev = new Map([[fy * W + fx, -1]]);
  const queue = [fy * W + fx];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    if (at === ty * W + tx) {
      const path = [];
      for (let p = at; p !== fy * W + fx; p = prev.get(p)) path.unshift([p % W, Math.floor(p / W)]);
      return path;
    }
    const x = at % W, y = Math.floor(at / W);
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (walkable(nx, ny) && !prev.has(ny * W + nx)) { prev.set(ny * W + nx, at); queue.push(ny * W + nx); }
    }
  }
  return null;
}

export default {
  areas: ["main"],
  version: 1,
  maxPeople: 30,
  create: () => ({ spots: {} }),
  join(w, person) {
    const spot = w.spots[person.id];
    if (spot && walkable(spot[0], spot[1])) return null;
    const taken = new Set(Object.values(w.spots).map(([x, y]) => `${x},${y}`));
    w.spots[person.id] = SPAWN.find(([x, y]) => !taken.has(`${x},${y}`)) || SPAWN[0];
    return { id: person.id, at: w.spots[person.id] };
  },
  leave(w, id) { delete w.reacted?.[id]; return null; },
  input(w, id, msg, { now }) {
    const from = w.spots[id];
    if (!from) return null;
    if (msg.t === "go" && Number.isInteger(msg.x) && Number.isInteger(msg.y)) {
      const path = route(from, [msg.x, msg.y]);
      if (!path?.length) return null;
      w.spots[id] = path.at(-1);
      return { id, path };
    }
    if (msg.t === "react" && Number.isInteger(msg.i) && REACTIONS[msg.i]) {
      w.reacted ||= {};
      if (now - (w.reacted[id] || 0) < REACT_MS) return null;
      w.reacted[id] = now;
      return { id, react: msg.i };
    }
    return null;
  },
  view: (w) => ({ spots: w.spots }),
};
