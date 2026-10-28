// A tiny space for testing the server itself (tests/space.test.mjs): everyone has a spot on a 10×10 grid, kept while
// they're away, and the area counts how many moves were ever made.
const SIZE = 10;
export default {
  areas: ["a", "b"],
  version: 1,
  create: () => ({ moves: 0, spots: {} }),
  join(w, person) {
    if (w.spots[person.id]) return null;
    w.spots[person.id] = [0, 0];
    return { id: person.id, at: [0, 0] };
  },
  input(w, id, msg) {
    if (msg.t !== "go" || !Number.isInteger(msg.x) || !Number.isInteger(msg.y)) return null;
    if (msg.x < 0 || msg.y < 0 || msg.x >= SIZE || msg.y >= SIZE) return null;
    w.spots[id] = [msg.x, msg.y];
    w.moves++;
    return { id, at: [msg.x, msg.y] };
  },
  view: (w) => ({ moves: w.moves, spots: w.spots }),
};
