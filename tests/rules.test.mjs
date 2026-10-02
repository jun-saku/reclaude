// Checks firebase/database.rules.json against the Firebase emulator, as several anonymous users.
// Run: cd tests && npm install && npm run rules   (needs Java; CI runs it on every push and PR)

import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInAnonymously } from "firebase/auth";
import { getDatabase, connectDatabaseEmulator, ref, set, get, update, remove } from "firebase/database";

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

console.log('-- playing');
await expect('the host starting the game', true, () => update(A.r(`rooms/${CODE}`), { status: 'playing', teams: 0, state: { deck: 'QH,2S' } }));
await expect('D joining after the game started', false, () => update(D.r(`rooms/${CODE}`), { 'players/s2': D.uid }));
await expect('a seated player making a move', true, () => update(B.r(`rooms/${CODE}`), { board: '-x-', turn: 2, last: 1 }));
await expect('a non-player making a move', false, () => update(D.r(`rooms/${CODE}`), { turn: 0 }));
await expect('a turn outside 0–5', false, () => update(B.r(`rooms/${CODE}`), { turn: 9 }));
await expect('a seated player setting their online flag', true, () => set(C.r(`rooms/${CODE}/online/s2`), true));
await expect('a bad online seat key', false, () => set(C.r(`rooms/${CODE}/online/s9`), true));
await expect('a winner of "draw"', true, () => update(A.r(`rooms/${CODE}`), { status: 'done', winner: 'draw', line: '1,2,3' }));
await expect('a winner like "everyone"', false, () => update(A.r(`rooms/${CODE}`), { winner: 'everyone' }));
await expect('a seated player reading the room', true, () => get(C.r(`rooms/${CODE}`)));
await expect('anyone signed in reading a room by its code', true, () => get(D.r(`rooms/${CODE}`)));
await expect('listing all rooms', false, () => get(D.r('rooms')));

console.log('-- private hands');
await expect('B writing their own hand', true, () => set(B.r(`private/${CODE}/s1`), 'QH,2S,7D'));
await expect('B reading their own hand', true, () => get(B.r(`private/${CODE}/s1`)));
await expect("A reading B's hand", false, () => get(A.r(`private/${CODE}/s1`)));
await expect("D (not in the room) reading B's hand", false, () => get(D.r(`private/${CODE}/s1`)));
await expect("A overwriting B's hand", false, () => set(A.r(`private/${CODE}/s1`), 'AS'));
await expect('reading all hands in a room', false, () => get(A.r(`private/${CODE}`)));
await expect('a hand that is not a string', false, () => set(B.r(`private/${CODE}/s1`), { cards: 1 }));

console.log('-- two-player rooms (tic-tac-toe / four in a row)');
await expect('creating an auto-start 2-seat room', true, () => set(A.r('rooms/TTTT'), { ...room(A.uid), seats: 2, min: 2, auto: true, board: '---------' }));
await expect('B joining and starting it in one write', true, () => update(B.r('rooms/TTTT'), { 'players/s1': B.uid, status: 'playing' }));
await expect('C joining a full 2-seat room', false, () => update(C.r('rooms/TTTT'), { 'players/s2': C.uid }));
await expect('a seated player deleting the room', true, () => remove(A.r('rooms/TTTT')));

console.log(`\nFAILS: ${fails}`);
process.exit(fails ? 1 : 0);
