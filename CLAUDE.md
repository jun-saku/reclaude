# reclaude

A static site on Cloudflare Pages where every file is a web page: docs, slide decks and
other pages, written by Claude and shared by link. The user usually works from their
phone, so keep replies short and always end with the link to what changed.

## Addresses

- `/<name>`: one page, named after its file (`docs/trip-plan.html` → `/trip-plan`).
- `/admin/<ADMIN_KEY>/`: list of every page with copy-link buttons. `ADMIN_KEY` is a Cloudflare
  environment variable; it is not in the repo and Claude does not know it. Every other `/admin/...`
  address returns 404.
- Anything else, including `/`: a blank 404. There is no public index, and pages must not link to
  each other or to a home page, so one link reveals only one page.

## Layout

- `docs/`, `slides/`, `pages/`: page sources. Templates are `docs/_template.html` and `slides/_template.html`.
- `assets/`: shared `theme.css`, `slides.css`, `slides.js`, referenced as `/assets/...`. Changes affect every page.
- `admin/index.html`: the admin list; it loads `files.json`, which the build generates.
- `site/`: files copied to the site root (`_headers`, `404.html`).
- `functions/admin/_middleware.js`: Cloudflare Pages Function that gates `/admin/*` on `ADMIN_KEY`.
- `scripts/build.mjs`: builds `_site/` (the Cloudflare output directory). Fails on duplicate,
  reserved or non-kebab-case names.
- `scripts/new-page.mjs`: creates a page from a template.

## Adding a page

1. `node scripts/new-page.mjs <docs|slides|pages> <name> "Title" "Description"`. The name is the URL,
   so make it short, lowercase-kebab-case and unique across all folders.
2. Fill in the content. For decks, one `<section class="slide">` per slide (`slide title` for a title slide).
3. Keep pages self-contained: inline any extra CSS/JS, no build step. External scripts only from
   cdn.jsdelivr.net or cdnjs.cloudflare.com. Keep `<meta name="robots" content="noindex">`.
4. Pages must work at phone width (no horizontal scroll) and in light and dark mode
   (use the `var(--…)` colors from `theme.css`).
5. Check it: `node scripts/build.mjs && python3 -m http.server -d _site 8000`, then open
   `http://localhost:8000/<name>.html` (Cloudflare drops the `.html`; the local server doesn't).
   Screenshot it with Playwright at 390px wide in light and dark and look at the result.
6. Commit and push. Pages are live after the change reaches `main`.

Names starting with `_` are templates or drafts and are never published.

## Rules

- Everything published is reachable by anyone who has or guesses the link. Never add secrets,
  credentials, personal data about other people, or work-confidential material.
- Renaming a file changes its URL and breaks links already shared. Don't rename or delete an
  existing page unless asked; update its content in place.
