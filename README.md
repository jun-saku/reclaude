# reclaude

claudeOS for remote and mobile friendly development: a site where every file is a web page.
Ask Claude for a doc or a slide deck, it pushes the HTML here, and Cloudflare Pages publishes it
at `/<name>`, a link you can share. There is no public index; the list of pages lives at
`/admin/<key>`.

- `docs/`: documents
- `slides/`: slide decks (swipe, tap the edges or use arrow keys)
- `pages/`: anything else

See [CLAUDE.md](CLAUDE.md) for how pages are added and published.

## Preview locally

```sh
node scripts/build.mjs
python3 -m http.server -d _site 8000   # pages at /<name>.html; the admin gate needs Cloudflare
```

## Cloudflare Pages setup (once)

1. Workers & Pages → Create → Pages → connect this GitHub repo.
2. Production branch `main`; build command `node scripts/build.mjs`; output directory `_site`.
3. Settings → Variables and Secrets: add `ADMIN_KEY` as a secret (a long random string, letters and digits only).
4. Settings → Builds → Branch control: turn off preview deployments to save builds.

The admin page is then at `https://<project>.pages.dev/admin/<ADMIN_KEY>/`.
