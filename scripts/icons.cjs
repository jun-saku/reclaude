// Draws the app icons in site/icons/ (home screen, app switcher, browser tab): a white "r" for reclaude on the
// accent orange (#b04d14), as a path (no fonts); and apps/pickleball/icons/ (installed on its own): a yellow ball
// with holes on court green. Run: node scripts/icons.cjs   (needs Playwright; commit the PNGs)
const { chromium } = (() => {
  for (const m of ['playwright', 'playwright-core']) { try { return require(m); } catch {} }
  return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
})();
const path = require('path');
const OUT = path.join(__dirname, '..', 'site', 'icons');
const PICKLEBALL = path.join(__dirname, '..', 'apps', 'pickleball', 'icons');
const R = (s) => `<path d="M206 366 V244 C206 200 238 172 292 172 H318" fill="none" stroke="#fff" stroke-width="66" stroke-linecap="round" stroke-linejoin="round" transform="translate(256 270) scale(${s}) translate(-256 -270) translate(8 4)"/>`;
const svg = ({ rounded, scale }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="#b04d14"/>${R(scale)}</svg>`;
// A pickleball: a yellow ball with a ring of holes, on court green.
const HOLES = [[0, 0], ...[0, 60, 120, 180, 240, 300].map((a) => [Math.cos(a * Math.PI / 180) * 92, Math.sin(a * Math.PI / 180) * 92])];
const BALL = (s) => `<g transform="translate(256 256) scale(${s})"><circle r="170" fill="#e6f04a"/>${HOLES.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="26" fill="#2d6a45"/>`).join('')}</g>`;
const ball = ({ rounded, scale }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="#2d6a45"/>${BALL(scale)}</svg>`;
const ICONS = [
  ["icon-512.png", 512, { rounded: true, scale: 1.08 }],
  ["icon-192.png", 192, { rounded: true, scale: 1.08 }],
  ['icon-maskable-512.png', 512, { rounded: false, scale: 0.84 }], // the glyph inside the maskable safe zone
  ['apple-touch-icon.png', 180, { rounded: false, scale: 0.98 }],   // iOS rounds the corners itself
  ['favicon-32.png', 32, { rounded: true, scale: 1.3 }],
];
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  require('fs').mkdirSync(PICKLEBALL, { recursive: true });
  for (const [dir, draw, scaleBy] of [[OUT, svg, 1], [PICKLEBALL, ball, 0.95]]) {
    for (const [name, size, opt] of ICONS) {
      const p = await (await b.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })).newPage();
      await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${draw({ ...opt, scale: opt.scale * scaleBy })}`);
      await p.screenshot({ path: `${dir}/${name}`, omitBackground: !name.startsWith('apple') });
    }
  }
  await b.close();
})();
