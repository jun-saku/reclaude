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

`claude/...` → PR → `main`. Merging into `main` publishes the site; PRs only run the build check.

One-time setup:
1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → General → Default branch: `main`. Leave "Allow auto-merge" off.
3. Settings → Rules → Rulesets (or Branches): protect `main`: require a pull request (0 approvals is fine
   when working solo), require the "build" check to pass, block force pushes and deletion, no bypass.
