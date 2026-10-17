# reclaude

claudeOS for remote and mobile friendly development: small web projects (calculators, games,
toys) built by Claude from a phone, each published at its own link.

- `projects/<name>/` → `https://reclaude.junsaku.dev/<name>/`
- `https://reclaude.junsaku.dev/games/` lists the games (`site/games/index.html`); each game's own link can be shared too.

## Projects

- [Tanks](https://reclaude.junsaku.dev/tanks/): Battle City-style co-op, defending the eagle from waves of enemy tanks, solo or 2–4 players online with a room code, with a Top 10 for waves cleared
- [Word Tiles](https://reclaude.junsaku.dev/word-tiles/): build crossing words on a 15×15 board with letter tiles, premium squares and a 172k-word list, 2–4 players online with a room code or on one phone
- [Word Grid](https://reclaude.junsaku.dev/word-grid/): swipe across touching letters to find words in 3 minutes, with a daily board for everyone, a random board any time, Top 10s for both, and online rooms for 2–6 players on the same board
- [Chain Reaction](https://reclaude.junsaku.dev/chain-reaction/): add orbs to your cells until they burst into their neighbours and take them over, 2–6 players online with a room code or on one phone
- [Wall Race](https://reclaude.junsaku.dev/wall-race/): race your pawn to the far side or drop walls to block the others (Quoridor-style), 2–4 players online with a room code or 2 on one phone
- [Bridge](https://reclaude.junsaku.dev/bridge/): contract bridge, 2–4 friends online with a room code (computers fill empty seats), or you and a computer partner against two computer opponents
- [Four in a Row](https://reclaude.junsaku.dev/four-in-a-row/): drop discs and line up four, online with a room code or on one phone
- [Tile Rummy](https://reclaude.junsaku.dev/tile-rummy/): make runs and groups of numbered tiles, rearrange the table, and empty your rack first, 2–4 players online with a room code
- [Five Line](https://reclaude.junsaku.dev/five-line/): place chips on a 10×10 board of coloured numbers and line up five, 2–4 players online with a room code
- [Tic-tac-toe](https://reclaude.junsaku.dev/tic-tac-toe/): play a friend online with a room code, or on one phone
- [2048](https://reclaude.junsaku.dev/2048/): slide and merge tiles, with swipe controls, undo, saved progress and a shared Top 10
- [Calculator](https://reclaude.junsaku.dev/calculator/): a pocket calculator with a live result preview

See [CLAUDE.md](CLAUDE.md) for how projects are added, tested and deployed.

## Preview locally

```sh
node scripts/build.mjs
python3 -m http.server 8000 -d _site   # open http://localhost:8000/<name>/
```

## Firebase

Online games use Firebase (Realtime Database + anonymous sign-in, free Spark plan). The database access
rules are in [`firebase/database.rules.json`](firebase/database.rules.json) and are **published automatically**
when a change reaches `main`: GitHub Actions signs in to Google with Workload Identity Federation (no stored
key; Google trusts only this repo's `main` branch) as the `rules-deployer` service account.

App Check (Google Cloud Fraud Defense, formerly reCAPTCHA Enterprise) proves requests come from this site: the site
key is in `shared/rooms.js` and is registered in Firebase console → App Check with the Fraud Defense provider.
Enforcement is on for the Realtime Database and Authentication; switching it off there is the quick fix if online
play ever breaks.

One-time setup (done) in Cloud Shell for project `reclaude-67a01`: a `rules-deployer` service account with
*Firebase Realtime Database Admin* and *Firebase Viewer*, a workload identity pool `github` with provider
`reclaude` limited to `jun-saku/reclaude` on `refs/heads/main`, and *Workload Identity User* for that repo on the
service account. To revoke, delete the service account or the pool in Google Cloud console.

## Tests

Dev-only, in `tests/` (needs Java): `npm install`, then `npm run rules` to check the database rules on the Firebase
emulator (also run by CI), or `npm run e2e` to play the online games on the real Firebase SDK and emulator (one file per game in
`tests/e2e/`; `E2E=wall-race npm run e2e` runs only that one). PRs run the tests of the games they change.

## Deploying

`claude/...` → PR → `main`. Each PR gets a Cloudflare preview link (posted as a comment); merging into
`main` publishes to **Cloudflare Pages** (`reclaude.junsaku.dev`, also `reclaude.pages.dev`). GitHub Pages
(`jun-saku.github.io/reclaude`) has been retired.

Cloudflare setup (once):
1. Cloudflare → My Profile → **API Tokens** → Create Token → **Create Custom Token**: permission
   *Account · Cloudflare Pages · Edit*, for your account. Copy the token.
2. Copy your **Account ID** (Workers & Pages overview sidebar, or the long ID in the dashboard URL).
3. GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**:
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. The next deploy creates the `reclaude` Pages project (done). Custom domain `reclaude.junsaku.dev` is attached
   under Workers & Pages → reclaude → **Custom domains** (done).

Repo settings (done):
- Settings → Pages: unpublished (the site is only on Cloudflare).
- Settings → General: default branch `main`; squash merging only; auto-merge off.
- Settings → Rules → Rulesets → `protect-main` (default branch): require a pull request (0 approvals),
  require the `build` check, block force pushes, restrict deletions, empty bypass list.
