// Cloudflare Pages Function: the admin page is only reachable at /admin/<ADMIN_KEY>.
// ADMIN_KEY is an environment variable set in the Cloudflare dashboard
// (Settings → Variables and Secrets), never in the repo. Every other /admin/...
// address, including /admin/ itself, answers 404 as if nothing were there.

const encoder = new TextEncoder();

// Compares via SHA-256 digests so the check takes the same time however many characters match.
async function sameSecret(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function notFound(env, url) {
  const page = await env.ASSETS.fetch(new URL("/404", url));
  return new Response(page.body, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  // /admin/<key>/<rest>
  const [, , key = "", ...rest] = url.pathname.split("/");

  if (!env.ADMIN_KEY || !key || !(await sameSecret(key, env.ADMIN_KEY))) {
    return notFound(env, url);
  }

  // /admin/<key> needs a trailing slash so the page's relative files.json fetch resolves under the key.
  if (rest.length === 0) {
    return Response.redirect(`${url.origin}/admin/${key}/`, 308);
  }

  const file = rest.join("/");
  const asset = await env.ASSETS.fetch(new URL(file === "" ? "/admin/" : `/admin/${file}`, url));
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(asset.body, { status: asset.status, headers });
}
