# reclaude

claudeOS for remote and mobile friendly development: small web projects (calculators, games,
toys) built by Claude from a phone, each published at its own link.

- `projects/<name>/` → `https://reclaude.junsaku.dev/<name>/`
- There's no index page; share each project's link directly.

## Projects

- [Murder Weapon](https://reclaude.junsaku.dev/murder-weapon/): a hidden-killer house game for 4–8 players online (draft rules)
- [Four in a Row](https://reclaude.junsaku.dev/four-in-a-row/): drop discs and line up four, online with a room code or on one phone
- [Five Line](https://reclaude.junsaku.dev/five-line/): place chips on a 10×10 board of coloured numbers and line up five, 2–4 players online with a room code
- [Tic-tac-toe](https://reclaude.junsaku.dev/tic-tac-toe/): play a friend online with a room code, or on one phone
- [2048](https://reclaude.junsaku.dev/2048/): slide and merge tiles, with swipe controls, undo, saved progress and a shared Top 10
- [Calculator](https://reclaude.junsaku.dev/calculator/): a pocket calculator with a live result preview

See [CLAUDE.md](CLAUDE.md) for how projects are added, tested and deployed.

## Preview locally

```sh
node scripts/build.mjs
mkdir -p /tmp/serve && ln -sfn "$PWD/_site" /tmp/serve/reclaude
python3 -m http.server 8000 -d /tmp/serve   # open http://localhost:8000/reclaude/<name>/
```

## Firebase

Online games use Firebase (Realtime Database + anonymous sign-in, free Spark plan). The database access
rules are in [`firebase/database.rules.json`](firebase/database.rules.json) and are **published automatically**
when a change reaches `main`: GitHub Actions signs in to Google with Workload Identity Federation (no stored
key; Google trusts only this repo's `main` branch) as the `rules-deployer` service account.

One-time setup (done) in Cloud Shell for project `reclaude-67a01`: a `rules-deployer` service account with
*Firebase Realtime Database Admin* and *Firebase Viewer*, a workload identity pool `github` with provider
`reclaude` limited to `jun-saku/reclaude` on `refs/heads/main`, and *Workload Identity User* for that repo on the
service account. To revoke, delete the service account or the pool in Google Cloud console.

## Tests

Dev-only, in `tests/` (needs Java): `npm install`, then `npm run rules` to check the database rules on the Firebase
emulator (also run by CI), or `npm run e2e` to play the online games on the real Firebase SDK and emulator.

## Deploying

`claude/...` → PR → `main`. Each PR gets a Cloudflare preview link (posted as a comment); merging into
`main` publishes to **Cloudflare Pages** (`reclaude.junsaku.dev`, also `reclaude.pages.dev`) and to GitHub Pages
(`jun-saku.github.io/reclaude`, kept for old links).

Cloudflare setup (once):
1. Cloudflare → My Profile → **API Tokens** → Create Token → **Create Custom Token**: permission
   *Account · Cloudflare Pages · Edit*, for your account. Copy the token.
2. Copy your **Account ID** (Workers & Pages overview sidebar, or the long ID in the dashboard URL).
3. GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**:
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. The next deploy creates the `reclaude` Pages project (done). Custom domain `reclaude.junsaku.dev` is attached
   under Workers & Pages → reclaude → **Custom domains** (done).

Repo settings (done):
- Settings → Pages → Source: **GitHub Actions**.
- Settings → General: default branch `main`; squash merging only; auto-merge off.
- Settings → Rules → Rulesets → `protect-main` (default branch): require a pull request (0 approvals),
  require the `build` check, block force pushes, restrict deletions, empty bypass list.
