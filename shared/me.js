// The profile icon (.me-link, shared/base.css) at the top right of the pages: your avatar once you've made a profile
// on this device (shared/core.js keeps a copy of your name and avatar here), else 👤. Only reads this device: no
// network, no sign-in. The build runs showMe() on every page; pages that add a .me-link later (the kit) call it again.
export const ME_KEY = "core-me";

export function readMe() {
  try { return JSON.parse(localStorage.getItem(ME_KEY)) || null; } catch { return null; }
}

export function rememberMe(profile) {
  try {
    if (profile) localStorage.setItem(ME_KEY, JSON.stringify({ display_name: profile.display_name, avatar: profile.avatar || null }));
    else localStorage.removeItem(ME_KEY);
  } catch {}
  showMe();
}

export function showMe(root = document) {
  const me = readMe();
  for (const a of root.querySelectorAll(".me-link")) {
    a.textContent = me?.avatar || "👤";
    a.setAttribute("aria-label", me?.display_name ? `Your profile (${me.display_name})` : "Your profile");
  }
}
