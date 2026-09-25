# reclaude

claudeOS for remote and mobile friendly development: a site where every file is a web page.
Ask Claude for a doc or a slide deck, it pushes the HTML here, and GitHub Pages publishes it
with a link you can share.

- `docs/`: documents
- `slides/`: slide decks (swipe, tap the edges or use arrow keys)
- `pages/`: anything else

See [CLAUDE.md](CLAUDE.md) for how files are added and published.

## Preview locally

```sh
node scripts/build-manifest.mjs
python3 -m http.server 8000
```

## Publishing

Settings → Pages → Source: **GitHub Actions**. After that, every push to `main` deploys.
Anything published can be opened by anyone with the link.
