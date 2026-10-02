// Checks firebase/database.rules.json against the Firebase emulator, as several anonymous users.
// Run: cd tests && npm install && npm run rules   (needs Java; CI runs it on every push and PR)

import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInAnonymously } from "firebase/auth";
import { getDatabase, connectDatabaseEmulator, ref, set, get, update, remove, query, orderByChild, limitToLast, serverTimestamp } from "firebase/database";

let n = 0, fails = 0;
async function user(name) {
  const app = initializeApp({ apiKey: "fake", projectId: "demo-reclaude", databaseURL: "http://127.0.0.1:9000?ns=demo-reclaude-default-rtdb" }, name + (n++));
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = getDatabase(app); connectDatabaseEmulator(db, "127.0.0.1", 9000);
  const { user } = await signInAnonymously(auth);
  return { uid: user.uid, db, r: (p) => ref(db, p) };
}
async function expect(label, allowed, op) {
  let ok; try { await op(); ok = true; } catch (e) { ok = false; if (!/permission|PERMISSION/i.test(e.message)) console.log('   (error)', e.message); }
  const pass = ok === allowed; if (!pass) fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${allowed ? 'allows' : 'blocks'} ${label}`);
}
const A = await user('A'), B = await user('B'), C = await user('C'), D = await user('D');
const room = (host, extra = {}) => ({ game: 'test', host, seats: 3, min: 2, auto: false, teams: 0, players: { s0: host }, status: 'waiting', turn: 0, round: 0, createdAt: Date.now(), ...extra });
const CODE = 'ABCD';

console.log('-- creating');
await expect('creating a room as its host', true, () => set(A.r(`rooms/${CODE}`), room(A.uid)));
await expect('creating a room naming someone else as host', false, () => set(B.r('rooms/ZZZZ'), room(A.uid)));
await expect('creating a room seating someone else in s0', false, () => set(B.r('rooms/ZZZY'), { ...room(B.uid), players: { s0: A.uid } }));
await expect('a malformed room code', false, () => set(A.r('rooms/abcd'), room(A.uid)));
await expect('a room with missing fields', false, () => set(A.r('rooms/ZZZX'), { game: 'test' }));
await expect('a room with an unknown field', false, () => set(A.r('rooms/ZZZW'), { ...room(A.uid), cheat: 1 }));
await expect('a room with 7 seats', false, () => set(A.r('rooms/ZZZV'), { ...room(A.uid), seats: 7 }));

console.log('-- joining');
await expect('a stranger editing the board without a seat', false, () => update(B.r(`rooms/${CODE}`), { board: 'x' }));
await expect('B taking empty seat s1', true, () => update(B.r(`rooms/${CODE}`), { 'players/s1': B.uid }));
await expect('C taking occupied seat s1', false, () => update(C.r(`rooms/${CODE}`), { 'players/s1': C.uid }));
await expect('C putting someone else in empty s2', false, () => update(C.r(`rooms/${CODE}`), { 'players/s2': D.uid }));
await expect('C taking seat s3 in a 3-seat room', false, () => update(C.r(`rooms/${CODE}`), { 'players/s3': C.uid }));
await expect('C taking empty seat s2', true, () => update(C.r(`rooms/${CODE}`), { 'players/s2': C.uid }));
await expect('A moving B out of seat s1', false, () => update(A.r(`rooms/${CODE}`), { 'players/s1': A.uid }));
await expect('B changing the host', false, () => update(B.r(`rooms/${CODE}`), { host: B.uid }));
await expect('B changing the seat count', false, () => update(B.r(`rooms/${CODE}`), { seats: 6 }));
await expect('B changing the game', false, () => update(B.r(`rooms/${CODE}`), { game: 'other' }));
await expect('B emptying the host\'s seat', false, () => remove(B.r(`rooms/${CODE}/players/s0`)));
await expect('B setting up the board before the start', false, () => update(B.r(`rooms/${CODE}`), { board: 'xxx' }));
await expect('B starting a host-started room', false, () => update(B.r(`rooms/${CODE}`), { status: 'playing' }));
await expect('B deleting the room', false, () => remove(B.r(`rooms/${CODE}`)));
await expect('B setting the host\'s online flag', false, () => set(B.r(`rooms/${CODE}/online/s0`), true));
await expect('the host setting up the board', true, () => update(A.r(`rooms/${CODE}`), { board: '---' }));

console.log('-- playing');
await expect('the host starting the game', true, () => update(A.r(`rooms/${CODE}`), { status: 'playing', teams: 0, state: { deck: 'QH,2S' } }));
await expect('D joining after the game started', false, () => update(D.r(`rooms/${CODE}`), { 'players/s2': D.uid }));
await expect('B moving when it is A\'s turn', false, () => update(B.r(`rooms/${CODE}`), { board: '-x-', turn: 1 }));
await expect('B taking the turn when it is A\'s', false, () => update(B.r(`rooms/${CODE}`), { turn: 1 }));
await expect('B declaring a winner on A\'s turn', false, () => update(B.r(`rooms/${CODE}`), { status: 'done', winner: 1 }));
await expect('B changing the game state on A\'s turn', false, () => set(B.r(`rooms/${CODE}/state/deck`), 'AS'));
await expect('B deleting the game state on A\'s turn', false, () => remove(B.r(`rooms/${CODE}/state`)));
await expect('B deleting the board on A\'s turn', false, () => remove(B.r(`rooms/${CODE}/board`)));
await expect('A (whose turn it is) making a move', true, () => update(A.r(`rooms/${CODE}`), { board: '-x-', turn: 1, last: 1 }));
await expect('B making a move on their turn', true, () => update(B.r(`rooms/${CODE}`), { board: '-xo', turn: 2, last: 2, 'state/deck': '2S' }));
await expect('a non-player making a move', false, () => update(D.r(`rooms/${CODE}`), { turn: 0 }));
await expect('a turn outside 0–5', false, () => update(C.r(`rooms/${CODE}`), { turn: 9 }));
await expect('a seated player setting their online flag', true, () => set(C.r(`rooms/${CODE}/online/s2`), true));
await expect('another player clearing their online flag', false, () => remove(A.r(`rooms/${CODE}/online/s2`)));
await expect('a bad online seat key', false, () => set(C.r(`rooms/${CODE}/online/s9`), true));
await expect('a seated player asking to play again', true, () => set(C.r(`rooms/${CODE}/again/s2`), true));
await expect("a player setting someone else's play-again flag", false, () => set(A.r(`rooms/${CODE}/again/s2`), false));
await expect('a non-boolean play-again flag', false, () => set(B.r(`rooms/${CODE}/again/s1`), 'yes'));
await expect('the player on turn rewriting the room with the others\' flags as they were', true, async () => {
  const cur = (await get(C.r(`rooms/${CODE}`))).val();
  await set(C.r(`rooms/${CODE}`), { ...cur, board: 'xxo', turn: 0 });
});
await expect('a winner like "everyone"', false, () => update(A.r(`rooms/${CODE}`), { winner: 'everyone' }));
await expect('a winner of "draw"', true, () => update(A.r(`rooms/${CODE}`), { status: 'done', winner: 'draw', line: '1,2,3' }));
await expect('changing the result after the game', false, () => update(B.r(`rooms/${CODE}`), { winner: 1 }));
await expect('changing the board after the game', false, () => update(A.r(`rooms/${CODE}`), { board: '---' }));
await expect('a next round that skips a round number', false, () => update(B.r(`rooms/${CODE}`), { status: 'playing', round: 5 }));
await expect('a seated player reading the room', true, () => get(C.r(`rooms/${CODE}`)));
await expect('anyone signed in reading a room by its code', true, () => get(D.r(`rooms/${CODE}`)));
await expect('listing all rooms', false, () => get(D.r('rooms')));

await expect('clearing everyone\'s play-again flags without a new round', false, () => update(B.r(`rooms/${CODE}`), { again: null }));
await expect('any player starting the next round, clearing the play-again flags', true, () => update(B.r(`rooms/${CODE}`), { status: 'playing', round: 1, turn: 1, board: '---', winner: null, line: null, again: null }));

console.log('-- private hands');
await expect('B writing their own hand', true, () => set(B.r(`private/${CODE}/s1`), 'QH,2S,7D'));
await expect('B reading their own hand', true, () => get(B.r(`private/${CODE}/s1`)));
await expect("A reading B's hand", false, () => get(A.r(`private/${CODE}/s1`)));
await expect("D (not in the room) reading B's hand", false, () => get(D.r(`private/${CODE}/s1`)));
await expect("A overwriting B's hand", false, () => set(A.r(`private/${CODE}/s1`), 'AS'));
await expect('reading all hands in a room', false, () => get(A.r(`private/${CODE}`)));
await expect('a hand that is not a string', false, () => set(B.r(`private/${CODE}/s1`), { cards: 1 }));
await expect('B taking over A\'s seat to read the hand there', false, () => update(B.r(`rooms/${CODE}`), { 'players/s0': B.uid }));
await expect('the host clearing hands once the game started', false, () => remove(A.r(`private/${CODE}`)));
await expect('B clearing all hands', false, () => remove(B.r(`private/${CODE}`)));

console.log('-- cleaning up');
await expect('a room dated two hours ago', false, () => set(A.r('rooms/QLDA'), room(A.uid, { createdAt: Date.now() - 7200000 })));
await expect('a room dated in the future', false, () => set(A.r('rooms/QLDA'), room(A.uid, { createdAt: Date.now() + 7200000 })));
await expect('changing createdAt', false, () => update(A.r(`rooms/${CODE}`), { createdAt: 1 }));
await expect('the host deleting their waiting room', true, async () => {
  await set(A.r('rooms/WAYT'), room(A.uid));
  await set(A.r('private/WAYT/s0'), 'old');
  await remove(A.r('private/WAYT'));
  await remove(A.r('rooms/WAYT'));
});
await expect('the host deleting a room in play', false, () => remove(A.r(`rooms/${CODE}`)));
await expect('a stranger deleting a fresh room', false, () => remove(D.r(`rooms/${CODE}`)));
// A day-old room, written with the emulator's admin access (clients can't backdate createdAt).
await fetch('http://127.0.0.1:9000/rooms/QLDB.json?ns=demo-reclaude-default-rtdb', {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: JSON.stringify({ ...room(A.uid), status: 'playing', createdAt: Date.now() - 2 * 86400000 }),
});
await expect('a stranger deleting a room over a day old', true, async () => {
  if (!(await get(D.r('rooms/QLDB'))).exists()) throw new Error('the old room was not set up');
  await remove(D.r('rooms/QLDB'));
});

console.log('-- two-player rooms (tic-tac-toe / four in a row)');
await expect('creating a second 2-seat room', true, () => set(A.r('rooms/TTT2'), { ...room(A.uid), seats: 2, min: 2, auto: true, board: '---------' }));
await expect('B starting an auto room that isn\'t full', false, () => update(B.r('rooms/TTT2'), { status: 'playing' }));
await expect('creating an auto-start 2-seat room', true, () => set(A.r('rooms/TTTT'), { ...room(A.uid), seats: 2, min: 2, auto: true, board: '---------' }));
await expect('B joining and starting it in one write', true, () => update(B.r('rooms/TTTT'), { 'players/s1': B.uid, status: 'playing' }));
await expect('C joining a full 2-seat room', false, () => update(C.r('rooms/TTTT'), { 'players/s2': C.uid }));
await expect('a joiner filling the board as they join', false, () => update(C.r('rooms/TTT2'), { 'players/s1': C.uid, status: 'playing', board: 'xxx------' }).catch((e) => { throw e; }));
console.log('-- leaving mid-game (forfeit)');
await expect('B forfeiting in their own favour', false, () => update(B.r('rooms/TTTT'), { status: 'done', winner: 1, left: 1 }));
await expect('B forfeiting on A\'s behalf', false, () => update(B.r('rooms/TTTT'), { status: 'done', winner: 0, left: 0 }));
await expect('B forfeiting to an empty seat', false, () => update(B.r('rooms/TTTT'), { status: 'done', winner: 2, left: 1 }));
await expect('B forfeiting while also changing the board', false, () => update(B.r('rooms/TTTT'), { status: 'done', winner: 0, left: 1, board: 'xxx------' }));
await expect('a stranger forfeiting for B', false, () => update(C.r('rooms/TTTT'), { status: 'done', winner: 0, left: 1 }));
await expect('B (not on turn) forfeiting', true, () => update(B.r('rooms/TTTT'), { status: 'done', winner: 0, left: 1 }));
await expect('changing who left afterwards', false, () => update(A.r('rooms/TTTT'), { left: 0 }));
await expect('a seated player deleting the room mid-game', false, () => remove(A.r('rooms/TTTT')));
await expect('A starting the next round after the forfeit', true, () => update(A.r('rooms/TTTT'), { status: 'playing', round: 1, turn: 1, winner: null, left: null }));
await expect('a left seat outside 0–5', false, () => update(B.r('rooms/TTTT'), { status: 'done', winner: 0, left: 9 }));
// Forfeits in rooms with game state (a transaction rewrites the whole room, state included), teams and 3 players
const whole = async (u, code, patch) => { const cur = (await get(u.r(`rooms/${code}`))).val(); await set(u.r(`rooms/${code}`), { ...cur, ...patch }); };
await expect('creating a 2-team room with state', true, () => set(A.r('rooms/TEAM'), { ...room(A.uid), seats: 4, min: 4, teams: 2, auto: false, state: { deck: 'x' } }));
for (const [u, s] of [[B, 1], [C, 2], [D, 3]]) await update(u.r('rooms/TEAM'), { [`players/s${s}`]: u.uid });
await update(A.r('rooms/TEAM'), { status: 'playing' });
await expect('B forfeiting a team game to their own team', false, () => whole(B, 'TEAM', { status: 'done', winner: 1, left: 1 }));
await expect('B (not on turn) forfeiting a team game to the other team, rewriting the room whole', true, () => whole(B, 'TEAM', { status: 'done', winner: 0, left: 1 }));
await expect('creating a 3-player room with state', true, () => set(A.r('rooms/TRYZ'), { ...room(A.uid), seats: 3, min: 2, auto: false, state: { deck: 'x' } }));
for (const [u, s] of [[B, 1], [C, 2]]) await update(u.r('rooms/TRYZ'), { [`players/s${s}`]: u.uid });
await update(A.r('rooms/TRYZ'), { status: 'playing', turn: 1 });
await expect('C forfeiting a 3-player game in their own favour', false, () => whole(C, 'TRYZ', { status: 'done', winner: 2, left: 2 }));
await expect('C (not on turn) forfeiting a 3-player game as a draw', true, () => whole(C, 'TRYZ', { status: 'done', winner: 'draw', left: 2 }));
await expect('the host closing a waiting room with guests in it', true, async () => {
  await set(A.r('rooms/LQBY'), room(A.uid)); await update(B.r('rooms/LQBY'), { 'players/s1': B.uid }); await remove(A.r('rooms/LQBY'));
});

console.log('-- leaderboard (scores/2048)');
const entry = (name, score) => ({ name, score, at: serverTimestamp() });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await expect('saving your own score', true, () => set(A.r(`scores/2048/${A.uid}`), entry('Jun', 2048)));
await expect("saving into someone else's entry", false, () => set(B.r(`scores/2048/${A.uid}`), entry('Fake', 9000)));
await expect('a second save within 5 seconds', false, () => set(A.r(`scores/2048/${A.uid}`), entry('Jun', 4096)));
await wait(5200);
await expect('a higher score after 5 seconds', true, () => set(A.r(`scores/2048/${A.uid}`), entry('Jun', 4096)));
await wait(5200);
await expect('lowering your score', false, () => set(A.r(`scores/2048/${A.uid}`), entry('Jun', 100)));
await expect('an odd score', false, () => set(B.r(`scores/2048/${B.uid}`), entry('Bo', 1001)));
await expect('a negative score', false, () => set(B.r(`scores/2048/${B.uid}`), entry('Bo', -10)));
await expect('an impossible score (over 3,932,156)', false, () => set(B.r(`scores/2048/${B.uid}`), entry('Bo', 99999998)));
await expect('a score as text', false, () => set(B.r(`scores/2048/${B.uid}`), entry('Bo', '5000')));
await expect('a name with symbols', false, () => set(B.r(`scores/2048/${B.uid}`), entry('<b>hi</b>', 512)));
await expect('a name over 12 characters', false, () => set(B.r(`scores/2048/${B.uid}`), entry('ABCDEFGHIJKLM', 512)));
await expect('an empty name', false, () => set(B.r(`scores/2048/${B.uid}`), entry('', 512)));
await expect('a made-up timestamp', false, () => set(B.r(`scores/2048/${B.uid}`), { name: 'Bo', score: 512, at: 1 }));
await expect('an extra field', false, () => set(B.r(`scores/2048/${B.uid}`), { ...entry('Bo', 512), level: 99 }));
await expect('a valid first score with a space in the name', true, () => set(B.r(`scores/2048/${B.uid}`), entry('Bo B', 512)));
await expect('deleting your own entry', false, () => remove(A.r(`scores/2048/${A.uid}`)).then(() => wait(0)));
const appNoAuth = initializeApp({ apiKey: 'fake', projectId: 'demo-reclaude', databaseURL: 'http://127.0.0.1:9000?ns=demo-reclaude-default-rtdb' }, 'anon');
const dbNoAuth = getDatabase(appNoAuth); connectDatabaseEmulator(dbNoAuth, '127.0.0.1', 9000);
let top = null;
await expect('reading the top 10 without signing in', true, async () => {
  const snap = await get(query(ref(dbNoAuth, 'scores/2048'), orderByChild('score'), limitToLast(10)));
  top = []; snap.forEach((c) => { top.push(c.val().score); });
});
console.log(`     top scores read back: ${JSON.stringify(top)}`);
if (JSON.stringify(top) !== '[512,4096]') { fails++; console.log('FAIL top 10 order/content'); }
await expect('writing a score without signing in', false, () => set(ref(dbNoAuth, 'scores/2048/someone'), entry('Anon', 64)));
await expect('a malformed game name', false, () => get(ref(dbNoAuth, 'scores/Bad Game')));

console.log(`\nFAILS: ${fails}`);
process.exit(fails ? 1 : 0);
