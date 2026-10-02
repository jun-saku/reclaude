// Shared Top 10 sheet for a game's public leaderboard: a bottom sheet on phones (a centred card on wider
// screens) with Reload and close, the player's own entry highlighted. Nothing connects until it's opened.
// Saving is up to the game (it knows what a valid score is): call rooms.saveScore(game, name, score, { order }),
// then sheet.stale() so the next open fetches fresh standings.
//
//   import { topTen } from "../shared/leaderboard.js";
//   const sheet = topTen({ game: "2048", rooms: () => import("../shared/rooms.js"), button: trophyEl });
//
// Pass the room module through `rooms` (as above) rather than importing it here: the build version-stamps
// "../shared/…" links in project files, and the page and this sheet must share one copy of rooms.js.
// Colours come from the page's CSS variables when it has them (--panel, --text, --muted, --soft or --board,
// --accent), with neutral fallbacks, so the sheet fits each game in light and dark mode.
//
// Options: game (leaderboard id), rooms (returns the rooms.js module), button (opens the sheet when tapped),
//   title ("Top 10"), size (10), order ("high" or "low" is better), format(score) → text,
//   empty ("No scores yet. Be the first!").
// Returns { open(), close(), reload(), stale(), isOpen(), state() → { top, uid, loading } }.

const STYLE = `
  .leaders {
    --lb-panel: var(--panel, Canvas); --lb-text: var(--text, CanvasText); --lb-muted: var(--muted, GrayText);
    --lb-soft: var(--soft, var(--board, rgba(127, 127, 127, 0.18)));
    width: min(100% - 16px, 448px); max-height: min(80vh, 640px);
    margin: auto auto max(8px, env(safe-area-inset-bottom)); border: 0; border-radius: 16px;
    padding: 16px 16px max(16px, env(safe-area-inset-bottom));
    background: var(--lb-panel); color: var(--lb-text); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25); overflow-y: auto;
    font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .leaders[open] { display: flex; flex-direction: column; gap: 10px; animation: lb-rise 200ms ease-out; }
  .leaders::backdrop { background: rgba(0, 0, 0, 0.35); }
  @media (min-width: 600px) { .leaders { margin: auto; } }
  @keyframes lb-rise { from { transform: translateY(24px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .leaders[open] { animation: none; } }
  .leaders-head { display: flex; align-items: center; gap: 8px; }
  .leaders h2 { margin: 0; font-size: 1.05rem; }
  .leaders button {
    font: inherit; font-weight: 650; border: 0; cursor: pointer; touch-action: manipulation;
    background: var(--lb-soft); color: var(--lb-text);
  }
  .leaders button:disabled { opacity: 0.5; cursor: default; }
  .leaders-head .reload { margin-left: auto; padding: 7px 12px; font-size: 0.85rem; border-radius: 10px; }
  .leaders .close { width: 34px; height: 34px; padding: 0; border-radius: 50%; font-size: 0.95rem; }
  .leaders .note { margin: 0; color: var(--lb-muted); font-size: 0.85rem; }
  .leaders .note:empty { display: none; }
  .leaders ol { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
  .leaders li {
    display: grid; grid-template-columns: 2em 1fr auto; gap: 8px; align-items: baseline;
    padding: 5px 8px; border-radius: 8px; font-variant-numeric: tabular-nums;
  }
  .leaders li .rank { color: var(--lb-muted); font-size: 0.85rem; }
  .leaders li .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .leaders li .pts { font-weight: 700; }
  .leaders li.me { background: var(--lb-soft); }
`;

// A short, specific reason for a failed load.
function reason(err) {
  const msg = String(err?.code || err?.message || err || "");
  if (/permission/i.test(msg)) return "the database refused it (check the rules are published)";
  if (/network|offline|fetch|timeout|unavailable/i.test(msg) || !navigator.onLine) return "no connection";
  return msg.slice(0, 80) || "unknown error";
}

export function topTen({
  game, rooms, button = null, title = "Top 10", size = 10, order = "high",
  format = (n) => Number(n).toLocaleString("en-US"), empty = "No scores yet. Be the first!",
}) {
  if (!document.getElementById("reclaude-leaders-style")) {
    const style = document.createElement("style");
    style.id = "reclaude-leaders-style";
    style.textContent = STYLE;
    document.head.append(style);
  }
  const dialog = document.createElement("dialog");
  dialog.className = "leaders";
  dialog.id = "leaders";
  dialog.setAttribute("aria-labelledby", "leaders-title");
  dialog.innerHTML = `
    <div class="leaders-head">
      <h2 id="leaders-title"></h2>
      <button class="reload" id="leaders-reload">Reload</button>
      <button class="close" id="leaders-close" aria-label="Close">✕</button>
    </div>
    <p class="note" id="leaders-status" role="status"></p>
    <ol id="leader-list"></ol>`;
  dialog.querySelector("h2").textContent = title;
  document.body.append(dialog);
  const reloadBtn = dialog.querySelector("#leaders-reload");
  const statusEl = dialog.querySelector("#leaders-status");
  const listEl = dialog.querySelector("#leader-list");
  const lb = { top: null, uid: null, loading: false };

  async function reload() {
    if (lb.loading) return;
    lb.loading = true;
    reloadBtn.disabled = true;
    statusEl.textContent = "Loading…";
    try {
      const api = await rooms();
      const [top, uid] = await Promise.all([api.topScores(game, size, order), api.myUid()]);
      Object.assign(lb, { top, uid });
      statusEl.textContent = top.length ? "" : empty;
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Couldn't load the ${title}: ${reason(err)}.`;
    } finally {
      lb.loading = false;
      reloadBtn.disabled = false;
      draw();
    }
  }

  function draw() {
    listEl.replaceChildren();
    (lb.top || []).forEach((entry, i) => {
      const li = document.createElement("li");
      if (entry.uid === lb.uid) li.className = "me";
      for (const [cls, text] of [["rank", `${i + 1}.`], ["name", entry.name], ["pts", format(entry.score)]]) {
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = text;
        li.append(span);
      }
      listEl.append(li);
    });
  }

  function open() {
    dialog.showModal();
    dialog.querySelector("#leaders-close").focus();
    if (lb.top === null) reload();
  }
  const close = () => dialog.close();

  if (button) button.addEventListener("click", open);
  reloadBtn.addEventListener("click", reload);
  dialog.querySelector("#leaders-close").addEventListener("click", close);
  // Tapping the dimmed area outside the sheet closes it.
  dialog.addEventListener("click", (e) => {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });

  return {
    open, close, reload,
    stale() { lb.top = null; },
    isOpen: () => dialog.open,
    state: () => ({ ...lb }),
  };
}
