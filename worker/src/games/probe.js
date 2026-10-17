// A tiny game for testing the server itself (tests/e2e/server.cjs): each player sets a number, and everyone sees
// everyone's number, who's connected, and a tick counter that only moves while someone is connected.
export default {
  create: () => ({ ticks: 0, values: {}, here: {} }),
  load: (saved) => ({ ...saved, here: {} }),
  save: (s) => ({ ticks: s.ticks, values: s.values }),
  join(s, seat) { s.here[seat] = true; },
  leave(s, seat) { delete s.here[seat]; },
  input(s, seat, msg) { if (msg.t === "set" && Number.isFinite(msg.v)) s.values[seat] = msg.v; },
  tick(s) { s.ticks++; },
  view: (s, seat) => ({ me: seat, ticks: s.ticks, values: s.values, here: Object.keys(s.here).map(Number) }),
};
