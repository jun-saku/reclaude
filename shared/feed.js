// Feeds: a real-time game's growing list (a drawing's strokes, a chat), sent a piece at a time instead of whole.
// A game's feed(state) returns { id, items }: items only ever get added to, and a new id starts a new list (the next
// drawing). The game server sends each connection only the items it hasn't had yet, and everything when it connects
// (shared/kit.js on the page, worker/src/kit.js on the server; both use these two functions).

// Server: what to send a connection that has `had` ({ id, n } or null), and what it has after that.
// Returns [part or null, had]; part is { id, from, items }.
export function feedPart(feed, had) {
  if (!feed) return [null, had];
  const n = feed.items.length;
  if (had && had.id === feed.id && had.n <= n) {
    return [had.n === n ? null : { id: feed.id, from: had.n, items: feed.items.slice(had.n) }, { id: feed.id, n }];
  }
  return [{ id: feed.id, from: 0, items: feed.items.slice() }, { id: feed.id, n }];
}

// Page: the list after a part arrives. A part that doesn't follow on from what's here (can't happen on one connection,
// which keeps order) is ignored; the next connection starts again from the whole list.
export function feedJoin(list, part) {
  if (!part) return list;
  if (part.from === 0) return { id: part.id, items: part.items.slice() };
  if (list && list.id === part.id && list.items.length === part.from) { list.items.push(...part.items); return list; }
  return list;
}
