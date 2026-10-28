// The profile icon (.me-link, shared/base.css) at the top right of the pages: your avatar once you've made a profile
// on this device (where shared/core.js keeps your profile: name and avatar), else 👤. Only reads this device: no
// network, no sign-in. The build runs showMe() on every page; pages that add a .me-link later (the kit) call it again.
export const ME_KEY = "core-me";

export function readMe() {
  try { return JSON.parse(localStorage.getItem(ME_KEY)) || null; } catch { return null; }
}

export function rememberMe(profile) {
  try {
    // (pending: shared/core.js hasn't backed it up to Supabase yet.)
    if (profile) localStorage.setItem(ME_KEY, JSON.stringify({ display_name: profile.display_name, avatar: profile.avatar || null, ...(profile.pending ? { pending: true } : {}) }));
    else localStorage.removeItem(ME_KEY);
  } catch {}
  showMe();
}

// Whether this device is signed in to an account (its username), as shared/core.js last saw it: only for what pages
// show (the home page lists the account-only apps when it's set). The server checks for itself, every time.
export const ACCOUNT_KEY = "core-account";
export function noteAccount(username) {
  try { if (username) localStorage.setItem(ACCOUNT_KEY, username); else localStorage.removeItem(ACCOUNT_KEY); } catch {}
}

export function showMe(root = document) {
  const me = readMe();
  for (const a of root.querySelectorAll(".me-link")) {
    a.textContent = me?.avatar || "👤";
    a.setAttribute("aria-label", me?.display_name ? `Your profile (${me.display_name})` : "Your profile");
  }
}
