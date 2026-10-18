// A tiny turn-based kit game for tests/e2e/kit.cjs (never published): tic-tac-toe.
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
export default {
  id: "kit-turns",
  kind: "turns",
  players: [2, 2],
  modes: ["local", "online"],
  setup: () => ({ board: "---------", turn: 0, moves: 0 }),
  turn: (s) => s.turn,
  input(s, seat, { cell } = {}) {
    if (!(cell >= 0 && cell < 9) || s.board[cell] !== "-") return false;
    s.board = s.board.slice(0, cell) + "XO"[seat] + s.board.slice(cell + 1);
    s.turn = 1 - seat; s.moves++;
  },
  result(s) {
    for (const [a, b, c] of LINES) if (s.board[a] !== "-" && s.board[a] === s.board[b] && s.board[a] === s.board[c]) return { winner: "XO".indexOf(s.board[a]) };
    return s.moves === 9 ? { winner: "draw" } : null;
  },
};
