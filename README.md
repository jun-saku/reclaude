# reclaude

claudeOS for remote and mobile friendly development: small web projects (calculators, games,
toys) built by Claude from a phone, each published at its own link.

- `projects/<name>/` → `https://jun-saku.github.io/reclaude/<name>/`
- There's no index page; share each project's link directly.

## Projects

- [Calculator](https://jun-saku.github.io/reclaude/calculator/): a pocket calculator with a live result preview

See [CLAUDE.md](CLAUDE.md) for how projects are added, tested and deployed.

## Preview locally

```sh
node scripts/build.mjs
mkdir -p /tmp/serve && ln -sfn "$PWD/_site" /tmp/serve/reclaude
python3 -m http.server 8000 -d /tmp/serve   # open http://localhost:8000/reclaude/<name>/
```

## Deploying

`claude/...` → PR → `main`. Merging into `main` publishes the site; PRs only run the build check.

Repo settings (done):
- Settings → Pages → Source: **GitHub Actions**.
- Settings → General: default branch `main`; squash merging only; auto-merge off.
- Settings → Rules → Rulesets → `protect-main` (default branch): require a pull request (0 approvals),
  require the `build` check, block force pushes, restrict deletions, empty bypass list.
