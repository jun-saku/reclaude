# reclaude design standard

Every game looks and reads the same way around its board, so a player who knows one game knows them all. The look is
one shared stylesheet, `shared/base.css`, which every game links; a game's own `<style>` only draws its board and
pieces. Games on the kit (`shared/kit.js` + `kit.css`) also get the screens and wording for free; a game that builds
its own screens uses base.css's classes (`.card`, `.join`, `.name-row`, `.seg`, `.bar`, `.chip`, `.status`, `.hint`,
`.bigcode`, `.seated`) and copies the wording and layout below. `node tests/ui-audit.cjs <name>` checks the parts marked ✓ on every screen, in light and dark mode at 320
and 390 px; it must report 0 problems before a game PR is ready.

## Title

- ✓ One name, written the same in `<title>`, the page's `<h1>` and its card on the games page.
- Short (1–3 words), in Title Case ("Four in a Row", "Word Tiles"), unless the game's usual name is spelled otherwise
  ("Tic-tac-toe", "2048"). The folder name is the title in lowercase-kebab-case.
- The games page card: icon, title, one sentence saying what you do ("Drop discs and line up four before your friend
  does."), player tags. The `<meta name="description">` says the same.

## Words

- Plain, short, friendly: "Your turn", not "It is now your turn to move". Sentence case for everything but the title.
- Talk to the player as "you"; other players by name (`rooms.nameOf`), "your friend" when there's no name.
- A hint ends with a full stop ("Tap a card to play."). A status line doesn't ("Your turn").
- Waiting ends with "…" ("Waiting for Bo…"). A win ends with "! 🎉".
- Never blame the player: "That word isn't in the list." not "Invalid word".

| Moment | Words |
| --- | --- |
| Turn line | `Your turn` · `Bo's turn` · `Bo's turn (away)` |
| Waiting | `Waiting for a friend to join…` · `Waiting for friends…` · `Waiting for the host to start…` · `Waiting for Bo…` |
| Win | `You win! 🎉` · `Bo wins!` · `Your team wins! 🎉` · `Team 2 wins!` |
| Draw | `It's a draw!` |
| Someone left | `Bo left. You win! 🎉` (or `Bo left. Game over` with 3+ players) |
| Leave, mid-game | confirm: `Leave the game? Your friend wins this round.` |

## Home screen (start and create rooms)

- ✓ `‹ All games` link first, back to the games page (hidden once in a room or game: use Leave there).
- `<h1>` title, then the 🏆 Top 10 button on the right if the game has a leaderboard.
- ✓ The name field, if any: label "Your name", placeholder `So friends know it's you`.
- ✓ The sections, each a card with an `<h2>`, always in this order (skip the ones the game doesn't have):
  1. `Play friends online` (`Play a friend online` for 2-player games): room options (players, timer) as segmented
     buttons, then ✓ `Create room`.
  2. `Join a room`: ✓ code field (placeholder `CODE`) and ✓ `Join`.
  3. `Same phone`: player count if it varies, then ✓ `Play here`.
  4. `Solo`: one line on who you play against, then ✓ `Play solo` (`Continue game` when one is saved).
- `How to play` last, folded (`<details>`).

## Lobby (waiting room)

- ✓ The room code big in the middle (`.bigcode`), then ✓ `Share link` (primary) and ✓ `Copy code` (secondary) side by
  side under it.
- ✓ Who's here: a list (`#seated`) of the players, the host marked `(host)`, and ✓ how many of how many
  ("2 of 4 here.") for everyone, host or not.
- The host's ✓ `Start game` / `Start with 3 players` (disabled as `Waiting for friends…` until enough have joined);
  everyone else reads `Waiting for the host to start…`.
- ✓ `Leave` at the bottom (secondary). A host leaving a waiting room closes it.

## Game screen (interface)

Top to bottom:
1. ✓ Player bar (`#players`): a chip per player (colour, name, online dot, score if any); the player on turn has a coloured ring.
   Online, the room code sits at the right.
2. ✓ Status line (`#status`, bold, centred, above the board): the turn line, timer, or result. One line, it never jumps the board around.
3. The board, as wide as the screen allows (max 480 px), square cells.
4. ✓ Hint line (`#hint`, muted, small, under the board): what to do next, in one sentence.
5. The player's own controls (their hand, rack, tool buttons): primary action first.
6. ✓ `Leave` (secondary), last, under the board and controls.

Game over replaces the status line with a card: the result as its heading, the score or reason under it, then
✓ `Play again` (primary; online it shows who's ready: `Play again (Bo is ready)`), then the Top 10 save if any.

## Controls

- ✓ Every button, input and link is at least 44×44 px. Boards and racks whose pieces are smaller (cells, tiles,
  cards) are marked `data-small-ok` and must still be easy to hit: use the whole cell as the target.
- Touch first: tap (and swipe or drag where natural). Every action works without a keyboard; keys are an extra.
- One primary button (accent colour, `var(--on-accent)` text) per card or row; the rest are `secondary` (soft
  background). Destructive actions (`Leave`) are secondary and ask first when it would end a game for others.
- A button that can't be used now is `disabled` (faded), never hidden-then-shown in a way that moves the layout.
- ✓ A button with only an icon or emoji (🏆, 🔍, ☰) has an `aria-label`.
- Segmented options (player count, timer) use `aria-pressed`.

## Look

- Colours from base.css's tokens: `--bg --text --muted --panel --line --soft --accent --on-accent --danger --good`,
  each with a dark-mode value, and player colours `--p0..--p3`. A game adds its own tokens for its board (light and
  dark).
- ✓ Text at least 12 px (body 17 px); contrast at least 4.5:1, or 3:1 for large text (24 px, or 18.7 px bold), in
  both light and dark mode.
- Cards: `--panel` background, 1 px `--line` border, 16 px radius, 16 px padding, 12 px gaps. Buttons: 12 px radius.
- ✓ Fits 320–430 px wide: no sideways scroll, no clipped text; safe-area padding on all sides; content max 480 px.
- ✓ No JavaScript errors on any screen.
