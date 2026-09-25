# reclaude

A static site on GitHub Pages where every file is a web page: docs, slide decks and
other pages, written by Claude and shared by link. The user usually works from their
phone, so keep replies short and always end with the live link to what changed.

## Layout

- `index.html`: home page. Lists everything in `files.json`, with search and type filters.
- `docs/`: documents. Start from `docs/_template.html`.
- `slides/`: slide decks. Start from `slides/_template.html`. One `<section class="slide">` per slide;
  add `class="slide title"` for a title slide.
- `pages/`: anything else (tools, dashboards, one-offs). Link `../assets/theme.css` for the shared look.
- `assets/`: shared `theme.css`, `slides.css`, `slides.js`. Changes here affect every page.
- `scripts/build-manifest.mjs`: builds `files.json` from each page's `<title>` and
  `<meta name="description">`. Generated in CI; `files.json` is gitignored.
- `.github/workflows/pages.yml`: on push to `main`, builds the manifest and deploys to Pages.

## Adding a file

1. Copy the matching `_template.html` to a new kebab-case name, e.g. `docs/trip-plan.html`.
2. Set `<title>` and `<meta name="description">`; the home page card uses both.
3. Keep `<meta name="robots" content="noindex">` and the link back home.
4. Keep pages self-contained: inline any extra CSS/JS, no build step. External scripts only from
   cdn.jsdelivr.net or cdnjs.cloudflare.com.
5. Pages must work at phone width (no horizontal scroll) and in light and dark mode
   (use the `var(--…)` colors from `theme.css`).
6. Check it: `node scripts/build-manifest.mjs && python3 -m http.server 8000`, then open the page
   (a Playwright screenshot at 390px wide is a good phone check).
7. Commit and push. The live URL is `https://jun-saku.github.io/reclaude/<path>` once Pages is enabled.

Names starting with `_` are templates or drafts: they stay out of the home page and the deployed site.

## Rules

- Everything published is public to anyone with the link. Never add secrets, credentials,
  personal data about other people, or work-confidential material.
- Don't delete or rewrite an existing page unless asked; update its content in place so its link keeps working.
