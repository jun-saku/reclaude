# reclaude

claudeOS for remote and mobile friendly development: small web projects (calculators, games,
toys) built by Claude from a phone, each published at its own link.

- `projects/<name>/` → `https://jun-saku.github.io/reclaude/<name>/`
- There's no index page; share each project's link directly.

See [CLAUDE.md](CLAUDE.md) for how projects are added, tested and deployed.

## Preview locally

```sh
node scripts/build.mjs
mkdir -p /tmp/serve && ln -sfn "$PWD/_site" /tmp/serve/reclaude
python3 -m http.server 8000 -d /tmp/serve   # open http://localhost:8000/reclaude/<name>/
```

## Deploying

`claude/...` → PR → `main` → PR → `deploy`. Only `deploy` is published.

One-time setup:
1. Make the repo public (Settings → General → Danger Zone → Change visibility).
2. Settings → Pages → Source: **GitHub Actions**.
3. Settings → Environments → `github-pages` → Deployment branches: allow `deploy`.
4. Settings → Branches (or Rules): protect `deploy`: require a pull request, block force pushes and deletion,
   and don't allow bypassing. Settings → General: leave "Allow auto-merge" off.
