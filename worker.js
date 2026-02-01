/**
 * NEBULA - Universal Cloudflare Worker Dashboard (Template)
 *
 * - First login default: admin / admin123456 (forced change password)
 * - Data stored in KV (LINKS): categories & links
 * - UI:
 *   - Google search bar
 *   - Mouse wheel to switch categories
 *   - Category manager: drag-sort + rename
 *   - Links: drag-sort + cross-category move
 *   - Add/Edit/Delete links (auto favicon)
 *   - Light/Dark toggle (localStorage), default follow system
 *
 * Required KV bindings:
 *   - LINKS
 *   - AUTH
 * Required secret:
 *   - SESSION_SECRET
 */

const COOKIE_NAME = "nebula_session";
const COOKIE_MAX_AGE = 86400;

const LINKS_KEY = "nebula_links_v1";
const AUTH_KEY = "nebula_auth_v1";

const DEFAULT_USER = "admin";
const DEFAULT_PASS = "admin123456";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // logout
    if (url.pathname === "/logout") {
      return new Response("已退出", {
        status: 302,
        headers: { Location: "/", "Set-Cookie": buildCookie("", 0) },
      });
    }

    // login
    if (request.method === "POST" && url.pathname === "/login") {
      const formData = await request.formData();
      const user = String(formData.get("user") || "");
      const pass = String(formData.get("pass") || "");

      const auth = await loadAuth(env);
      const userOk = user === auth.user;

      let passOk = false;
      if (auth.passHash) passOk = (await sha256Hex(pass)) === auth.passHash;
      else passOk = pass === DEFAULT_PASS;

      if (userOk && passOk) {
        const mustChange = !!auth.forceChange || !auth.passHash;
        const token = await signSession(env, user, mustChange);
        return new Response(null, {
          status: 302,
          headers: { Location: "/", "Set-Cookie": buildCookie(token, COOKIE_MAX_AGE) },
        });
      }
      return new Response("账号或密码错误", { status: 403 });
    }

    // session
    const cookieHeader = request.headers.get("Cookie") || "";
    const session = readCookie(cookieHeader, COOKIE_NAME);
    const authed = session ? await verifySession(env, session) : { ok: false };

    // APIs
    if (url.pathname.startsWith("/api/")) {
      if (!authed.ok) return json({ error: "Unauthorized" }, 401);

      // change password
      if (url.pathname === "/api/change-password" && request.method === "POST") {
        const body = await safeJson(request);
        const oldPass = String(body?.oldPass || "");
        const newPass = String(body?.newPass || "");
        if (newPass.length < 8) return json({ error: "新密码至少 8 位" }, 400);

        const auth = await loadAuth(env);
        let oldOk = false;
        if (auth.passHash) oldOk = (await sha256Hex(oldPass)) === auth.passHash;
        else oldOk = oldPass === DEFAULT_PASS;

        if (!oldOk) return json({ error: "旧密码不正确" }, 403);

        auth.passHash = await sha256Hex(newPass);
        auth.forceChange = false;
        await env.AUTH.put(AUTH_KEY, JSON.stringify(auth, null, 2));

        const newToken = await signSession(env, authed.user, false);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json;charset=UTF-8",
            "Set-Cookie": buildCookie(newToken, COOKIE_MAX_AGE),
          },
        });
      }

      // get links
      if (url.pathname === "/api/links" && request.method === "GET") {
        const data = await loadLinks(env);
        return json(data, 200);
      }

      // add link (supports creating new category)
      if (url.pathname === "/api/links" && request.method === "POST") {
        const body = await safeJson(request);
        const categoryId = String(body?.categoryId || "");
        const categoryName = String(body?.categoryName || "").trim();
        const title = String(body?.title || "").trim();
        const linkUrl = String(body?.url || "").trim();
        const icon = String(body?.icon || "").trim();

        if (!title || !linkUrl) return json({ error: "title/url required" }, 400);
        if (!isValidHttpUrl(linkUrl)) return json({ error: "invalid url" }, 400);

        const data = await loadLinks(env);

        let cat = null;
        if (categoryName) {
          cat = data.categories.find((c) => c.name === categoryName);
          if (!cat) {
            cat = { id: uid(), name: categoryName, links: [] };
            data.categories.push(cat);
          }
        } else if (categoryId) {
          cat = data.categories.find((c) => c.id === categoryId);
        }
        if (!cat) cat = data.categories[0];

        cat.links.push({
          id: uid(),
          title,
          url: linkUrl,
          icon: icon || faviconFromUrl(linkUrl),
        });

        await env.LINKS.put(LINKS_KEY, JSON.stringify(data, null, 2));
        return json({ ok: true, data }, 200);
      }

      // edit link
      if (url.pathname === "/api/links" && request.method === "PUT") {
        const body = await safeJson(request);
        const linkId = String(body?.linkId || "");
        const title = String(body?.title || "").trim();
        const linkUrl = String(body?.url || "").trim();
        const icon = String(body?.icon || "").trim();
        const moveToCategoryId = String(body?.moveToCategoryId || "");

        if (!linkId) return json({ error: "linkId required" }, 400);
        if (!title || !linkUrl) return json({ error: "title/url required" }, 400);
        if (!isValidHttpUrl(linkUrl)) return json({ error: "invalid url" }, 400);

        const data = await loadLinks(env);
        const found = findLink(data, linkId);
        if (!found) return json({ error: "not found" }, 404);

        found.link.title = title;
        found.link.url = linkUrl;
        found.link.icon = icon || faviconFromUrl(linkUrl);

        if (moveToCategoryId && moveToCategoryId !== found.category.id) {
          const target = data.categories.find((c) => c.id === moveToCategoryId);
          if (target) {
            found.category.links = found.category.links.filter((l) => l.id !== linkId);
            target.links.push(found.link);
          }
        }

        await env.LINKS.put(LINKS_KEY, JSON.stringify(data, null, 2));
        return json({ ok: true, data }, 200);
      }

      // delete link
      if (url.pathname === "/api/links" && request.method === "DELETE") {
        const body = await safeJson(request);
        const linkId = String(body?.linkId || "");
        if (!linkId) return json({ error: "linkId required" }, 400);

        const data = await loadLinks(env);
        let deleted = false;
        for (const c of data.categories) {
          const before = c.links.length;
          c.links = c.links.filter((l) => l.id !== linkId);
          if (c.links.length !== before) deleted = true;
        }
        if (!deleted) return json({ error: "not found" }, 404);

        await env.LINKS.put(LINKS_KEY, JSON.stringify(data, null, 2));
        return json({ ok: true, data }, 200);
      }

      // reorder categories / links
      if (url.pathname === "/api/reorder" && request.method === "POST") {
        const body = await safeJson(request);
        const patch = body?.data;
        if (!patch?.categories || !Array.isArray(patch.categories)) return json({ error: "data.categories required" }, 400);

        const stored = await loadLinks(env);
        const next = applyReorder(stored, patch);

        await env.LINKS.put(LINKS_KEY, JSON.stringify(next, null, 2));
        return json({ ok: true, data: next }, 200);
      }

      // rename category
      if (url.pathname === "/api/categories/rename" && request.method === "POST") {
        const body = await safeJson(request);
        const categoryId = String(body?.categoryId || "");
        const newName = String(body?.newName || "").trim();
        if (!categoryId || !newName) return json({ error: "categoryId/newName required" }, 400);

        const data = await loadLinks(env);
        const cat = data.categories.find((c) => c.id === categoryId);
        if (!cat) return json({ error: "not found" }, 404);

        cat.name = newName;
        await env.LINKS.put(LINKS_KEY, JSON.stringify(data, null, 2));
        return json({ ok: true, data }, 200);
      }

      return json({ error: "Not found" }, 404);
    }

    // pages
    if (!authed.ok) return html(renderLoginPage(), 200);
    if (authed.mustChange) return html(renderChangePasswordPage(), 200);

    const data = await loadLinks(env);
    return html(renderDashboardPage(data), 200);
  },
};

/* ---------------- KV: LINKS ---------------- */

async function loadLinks(env) {
  const raw = await env.LINKS.get(LINKS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.categories)) return normalizeLinks(parsed);
    } catch {}
  }

  // ✅ Empty template: only one empty category, no links
  const seed = {
    categories: [
      {
        id: uid(),
        name: "✨ 开始使用（可重命名）",
        links: [],
      },
    ],
  };

  await env.LINKS.put(LINKS_KEY, JSON.stringify(seed, null, 2));
  return seed;
}

function normalizeLinks(data) {
  const out = { categories: [] };
  for (const c of data.categories || []) {
    const id = String(c?.id || "") || uid();
    const name = String(c?.name || "").trim();
    if (!name) continue;
    const links = Array.isArray(c.links) ? c.links : [];
    out.categories.push({
      id,
      name,
      links: links
        .map((l) => ({
          id: String(l?.id || "") || uid(),
          title: String(l?.title || "").trim(),
          url: String(l?.url || "").trim(),
          icon: String(l?.icon || "").trim() || faviconFromUrl(String(l?.url || "")),
        }))
        .filter((l) => l.title && isValidHttpUrl(l.url)),
    });
  }
  if (!out.categories.length) out.categories = [{ id: uid(), name: "✨ 开始使用（可重命名）", links: [] }];
  return out;
}

function findLink(data, linkId) {
  for (const c of data.categories) {
    const link = c.links.find((l) => l.id === linkId);
    if (link) return { category: c, link };
  }
  return null;
}

function applyReorder(stored, patch) {
  const linkMap = new Map();
  for (const c of stored.categories) for (const l of c.links) linkMap.set(l.id, l);

  const byCatId = new Map(stored.categories.map((c) => [c.id, c]));
  const nextCats = [];

  for (const pc of patch.categories) {
    const cid = String(pc?.id || "");
    const sc = byCatId.get(cid);
    if (!sc) continue;

    const nextLinks = [];
    for (const pl of (pc.links || [])) {
      const lid = String(pl?.id || pl || "");
      const l = linkMap.get(lid);
      if (l) nextLinks.push(l);
      linkMap.delete(lid);
    }
    nextCats.push({ id: sc.id, name: sc.name, links: nextLinks });
  }

  if (linkMap.size) {
    const origCatByLink = new Map();
    for (const c of stored.categories) for (const l of c.links) origCatByLink.set(l.id, c.id);
    for (const [lid, l] of linkMap.entries()) {
      const cid = origCatByLink.get(lid);
      const target = nextCats.find((c) => c.id === cid) || nextCats[0];
      target.links.push(l);
    }
  }

  const existing = new Set(nextCats.map((c) => c.id));
  for (const c of stored.categories) if (!existing.has(c.id)) nextCats.push(c);
  return { categories: nextCats };
}

function faviconFromUrl(u) {
  try {
    const url = new URL(u);
    return `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(url.origin)}`;
  } catch {
    return `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(u)}`;
  }
}

function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------- KV: AUTH ---------------- */

async function loadAuth(env) {
  const raw = await env.AUTH.get(AUTH_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.user === "string") return parsed;
    } catch {}
  }
  const seed = { user: DEFAULT_USER, passHash: "", forceChange: true };
  await env.AUTH.put(AUTH_KEY, JSON.stringify(seed, null, 2));
  return seed;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------- Session ---------------- */

function buildCookie(value, maxAge) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    "Secure",
  ].join("; ");
}

function readCookie(cookieHeader, name) {
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escapeRegExp(name)}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
}
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function signSession(env, user, mustChange) {
  const payload = JSON.stringify({
    u: user,
    mc: !!mustChange,
    exp: Date.now() + COOKIE_MAX_AGE * 1000,
    n: uid(),
  });
  const payloadB64 = b64(payload);
  const sig = await hmacSha256(env.SESSION_SECRET, payloadB64);
  return `${payloadB64}.${b64(sig)}`;
}

async function verifySession(env, token) {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return { ok: false };

    const expected = await hmacSha256(env.SESSION_SECRET, payloadB64);
    const got = unb64(sigB64);
    if (!timingSafeEqual(expected, got)) return { ok: false };

    const payload = JSON.parse(unb64(payloadB64));
    if (!payload?.exp || Date.now() > payload.exp) return { ok: false };

    return { ok: true, user: payload.u, mustChange: !!payload.mc };
  } catch {
    return { ok: false };
  }
}

function b64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function unb64(b64s) {
  return decodeURIComponent(escape(atob(b64s)));
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return String.fromCharCode(...new Uint8Array(sig));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/* ---------------- HTTP helpers ---------------- */

function html(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html;charset=UTF-8" } });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" },
  });
}
async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/* ---------------- Pages ---------------- */

function renderLoginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>NEBULA</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;
      background:
        radial-gradient(1100px 900px at 20% 10%, rgba(79,70,229,.30), transparent 60%),
        radial-gradient(1100px 900px at 90% 80%, rgba(124,58,237,.26), transparent 55%),
        linear-gradient(135deg,#070A14,#0B1230);
    }
    .card{
      width:100%;max-width:400px;margin:18px;
      background:rgba(18,26,59,.62);
      backdrop-filter:blur(18px);
      border:1px solid rgba(234,240,255,.12);
      border-radius:22px;
      padding:34px 28px;
      box-shadow:0 20px 70px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.08);
    }
    .logo{text-align:center;margin-bottom:22px}
    .icon{
      width:64px;height:64px;border-radius:16px;display:inline-flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#7C3AED,#4F46E5);
      font-size:32px;box-shadow:0 12px 30px rgba(124,58,237,.35);margin-bottom:12px;
    }
    h1{
      font-size:1.55rem;font-weight:950;letter-spacing:.08em;
      background:linear-gradient(135deg,#EAF0FF,#C7D2FE);
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
      user-select:none;
    }
    .g{margin-top:16px;display:flex;flex-direction:column;gap:12px}
    input{
      width:100%;padding:14px 16px;border-radius:12px;
      border:1px solid rgba(234,240,255,.12);
      background:rgba(10,16,40,.55);
      color:#fff;font-size:1rem;outline:none;transition:.2s;
    }
    input:focus{border-color:rgba(124,58,237,.55);box-shadow:0 0 0 3px rgba(124,58,237,.14);background:rgba(10,16,40,.72)}
    button{
      padding:14px;border:none;border-radius:12px;cursor:pointer;font-weight:950;font-size:1rem;color:#fff;
      background:linear-gradient(135deg,#7C3AED,#4F46E5);
      box-shadow:0 10px 30px rgba(124,58,237,.22);
      transition:.2s;
    }
    button:hover{transform:translateY(-1px);box-shadow:0 14px 40px rgba(124,58,237,.28)}
    .hint{margin-top:14px;color:rgba(234,240,255,.65);font-weight:700;font-size:.86rem;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="icon">🪐</div>
      <h1>NEBULA</h1>
    </div>
    <form action="/login" method="POST" class="g">
      <input name="user" placeholder="用户名" autocomplete="username" required>
      <input name="pass" type="password" placeholder="密码" autocomplete="current-password" required>
      <button type="submit">登 录</button>
    </form>
    <div class="hint">首次登录默认：admin / admin123456（登录后强制改密码）</div>
  </div>
</body>
</html>`;
}

function renderChangePasswordPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>NEBULA</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;
      background:
        radial-gradient(1100px 900px at 20% 10%, rgba(79,70,229,.30), transparent 60%),
        radial-gradient(1100px 900px at 90% 80%, rgba(124,58,237,.26), transparent 55%),
        linear-gradient(135deg,#070A14,#0B1230);
    }
    .card{
      width:100%;max-width:460px;margin:18px;
      background:rgba(18,26,59,.62);
      backdrop-filter:blur(18px);
      border:1px solid rgba(234,240,255,.12);
      border-radius:22px;
      padding:28px;
      box-shadow:0 22px 80px rgba(0,0,0,.55);
    }
    h1{font-size:1.2rem;font-weight:950;color:#EAF0FF;margin-bottom:14px;text-align:center}
    .g{display:flex;flex-direction:column;gap:12px}
    input{
      width:100%;padding:14px 16px;border-radius:12px;border:1px solid rgba(234,240,255,.12);
      background:rgba(10,16,40,.55);color:#fff;font-size:1rem;outline:none;transition:.2s;
    }
    input:focus{border-color:rgba(124,58,237,.55);box-shadow:0 0 0 3px rgba(124,58,237,.14);background:rgba(10,16,40,.72)}
    button{
      padding:14px;border:none;border-radius:12px;cursor:pointer;font-weight:950;font-size:1rem;color:#fff;
      background:linear-gradient(135deg,#7C3AED,#4F46E5);box-shadow:0 10px 30px rgba(124,58,237,.22);transition:.2s;
    }
    button:hover{transform:translateY(-1px);box-shadow:0 14px 40px rgba(124,58,237,.28)}
    .msg{margin-top:12px;color:#fca5a5;font-weight:900;display:none;text-align:center}
    .ok{color:#86efac}
  </style>
</head>
<body>
  <div class="card">
    <h1>修改密码</h1>
    <div class="g">
      <input id="oldPass" type="password" placeholder="旧密码" autocomplete="current-password">
      <input id="newPass" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password">
      <button id="save">保存</button>
    </div>
    <div class="msg" id="msg"></div>
  </div>

  <script>
    const msg = document.getElementById('msg');
    const show = (t, ok=false)=>{ msg.textContent=t; msg.style.display='block'; msg.className = 'msg' + (ok?' ok':''); };

    document.getElementById('save').onclick = async ()=>{
      const oldPass = document.getElementById('oldPass').value;
      const newPass = document.getElementById('newPass').value;
      try{
        const res = await fetch('/api/change-password',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({oldPass,newPass})
        });
        const out = await res.json().catch(()=>({}));
        if(!res.ok) return show(out.error || '保存失败');
        show('已保存 ✅', true);
        setTimeout(()=>location.href='/', 450);
      }catch(e){
        show('网络错误');
      }
    };
  </script>
</body>
</html>`;
}

function renderDashboardPage(data) {
  const safeData = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>NEBULA</title>
  <style>
    :root{
      --topbar-h: 140px;
      --gap: 20px;

      --bg0: #070A14;
      --bg1: #0B1230;
      --bg2: #121A3B;

      --panel: rgba(18, 26, 59, .62);
      --panel2: rgba(10, 16, 40, .55);
      --border: rgba(234, 240, 255, .12);

      --text: #EAF0FF;
      --muted: rgba(234, 240, 255, .62);

      --primary: #7C3AED;
      --primary2:#4F46E5;

      --shadow: 0 18px 60px rgba(0,0,0,.45);
      --glow: 0 0 0 3px rgba(124, 58, 237, .14);
    }
    :root[data-theme="light"]{
      --bg0: #F6F7FF;
      --bg1: #EEF1FF;
      --bg2: #E9ECFF;

      --panel: rgba(255,255,255,.72);
      --panel2: rgba(255,255,255,.58);
      --border: rgba(15,23,42,.12);

      --text: #0B1226;
      --muted: rgba(11, 18, 38, .58);

      --primary:#6D28D9;
      --primary2:#2563EB;

      --shadow: 0 18px 60px rgba(15,23,42,.10);
      --glow: 0 0 0 3px rgba(109, 40, 217, .12);
    }

    *{margin:0;padding:0;box-sizing:border-box}
    body{
      height:100vh;overflow:hidden;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      color: var(--text);
      background:
        radial-gradient(1200px 800px at 20% 10%, var(--bg2), transparent 60%),
        radial-gradient(1100px 900px at 90% 80%, rgba(124,58,237,.22), transparent 55%),
        linear-gradient(135deg, var(--bg0), var(--bg1));
    }
    body::before{
      content:"";
      position:fixed;inset:0;
      pointer-events:none;
      background:
        radial-gradient(circle at 18% 40%, rgba(79,70,229,.18), transparent 55%),
        radial-gradient(circle at 82% 78%, rgba(124,58,237,.16), transparent 58%);
    }

    .topbar{
      position:fixed;left:0;right:0;top:0;z-index:20;
      padding:18px 18px 14px;
      backdrop-filter: blur(16px);
      background: linear-gradient(180deg, var(--panel), rgba(0,0,0,0));
      border-bottom: 1px solid var(--border);
    }
    .container{max-width:1200px;margin:0 auto}

    .header{
      display:grid;
      grid-template-columns: 1fr auto 1fr;
      align-items:center;
      gap:12px;
      margin-bottom:12px;
    }
    .brand{grid-column:2;text-align:center}
    .brand h1{
      font-size:1.8rem;font-weight:950;letter-spacing:.08em;line-height:1;
      background:linear-gradient(135deg, var(--text), rgba(199,210,254,.9));
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
      user-select:none;
    }
    :root[data-theme="light"] .brand h1{
      background:linear-gradient(135deg, #111827, rgba(109,40,217,.95));
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
    }

    .actions{
      grid-column:3;justify-self:end;
      display:flex;align-items:center;gap:10px;flex-wrap:wrap;
    }
    .pill{
      border:1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      padding:10px 12px;border-radius:999px;text-decoration:none;font-size:.9rem;font-weight:950;
      transition:.18s;display:inline-flex;align-items:center;gap:8px;cursor:pointer;
      box-shadow: 0 10px 30px rgba(0,0,0,.10);
    }
    .pill:hover{transform:translateY(-1px);border-color:rgba(124,58,237,.35)}
    .pill.danger:hover{border-color:rgba(248,113,113,.55);color:#ef4444}

    .searchbar{
      display:flex;gap:10px;align-items:center;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius:16px;padding:12px;
      box-shadow: var(--shadow);
    }
    .searchbar input{
      flex:1;padding:12px 14px;border-radius:12px;
      border:1px solid var(--border);
      background: var(--panel2);
      color: var(--text);
      font-size:1rem;outline:none;
    }
    .searchbar input:focus{box-shadow: var(--glow); border-color: rgba(124,58,237,.55);}
    .searchbar button{
      padding:12px 14px;border:none;border-radius:12px;cursor:pointer;font-weight:950;color:#fff;
      background: linear-gradient(135deg, var(--primary), var(--primary2));
      box-shadow: 0 10px 30px rgba(124,58,237,.22);
      transition:.18s;white-space:nowrap;
    }

    .viewport{
      position:absolute;left:0;right:0;
      top: calc(var(--topbar-h) + var(--gap));
      bottom:0;
      padding: 0 18px 22px;
      overflow:hidden;
    }
    .sections{height:100%;transition:transform 520ms cubic-bezier(.2,.8,.2,1);will-change:transform}
    .section{
      height: calc(100vh - var(--topbar-h) - var(--gap));
      max-width:1200px;margin:0 auto;
      padding: 10px 0 40px;
    }
    .section-title{
      font-size:1.14rem;color: var(--text);font-weight:950;
      margin:10px 0 14px;padding-left:1rem;border-left:4px solid var(--primary);
      display:flex;align-items:center;justify-content:space-between;
    }

    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.1rem}
    .card{
      position:relative;
      background: var(--panel);
      backdrop-filter:blur(12px);
      border:1px solid var(--border);
      border-radius:16px;
      padding:1.2rem 1.1rem;
      text-decoration:none;color: var(--text);
      transition:.22s cubic-bezier(.4,0,.2,1);
      display:flex;align-items:center;gap:12px;
      min-height:76px;
      box-shadow: 0 10px 30px rgba(0,0,0,.10);
    }
    .card:hover{
      transform:translateY(-6px);
      border-color: rgba(124,58,237,.35);
      box-shadow: 0 18px 60px rgba(124,58,237,.12);
    }
    .favicon{
      width:40px;height:40px;border-radius:12px;
      background: var(--panel2);
      border:1px solid var(--border);
      display:flex;align-items:center;justify-content:center;overflow:hidden;flex:0 0 auto;
    }
    .favicon img{width:22px;height:22px;display:block}

    .meta{display:flex;flex-direction:column;gap:3px;min-width:0}
    .title{font-weight:950;color:var(--text);font-size:1.02rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .url{color:var(--muted);font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    .tools{
      position:absolute;right:10px;top:10px;display:flex;gap:6px;opacity:0;transform:translateY(-2px);
      transition:.15s;
    }
    .card:hover .tools{opacity:1;transform:translateY(0)}
    .mini{
      width:30px;height:30px;border-radius:10px;
      border:1px solid var(--border);
      background: var(--panel2);
      color: var(--text);
      cursor:pointer;font-weight:950;
      display:flex;align-items:center;justify-content:center;
    }
    .mini.d:hover{border-color:rgba(248,113,113,.55);color:#ef4444}

    .dragging{opacity:.55;transform:scale(.98)}
    .dots{
      position:fixed;right:14px;top:50%;transform:translateY(-50%);
      display:flex;flex-direction:column;gap:10px;z-index:25;user-select:none
    }
    .dot{
      width:10px;height:10px;border-radius:999px;border:1px solid var(--border);
      background: rgba(255,255,255,.08);
      cursor:pointer;
    }
    .dot.active{background:rgba(124,58,237,.85);border-color:rgba(124,58,237,.9);transform:scale(1.25)}

    .fab{position:fixed;right:16px;bottom:16px;z-index:30}
    .fab button{
      border:none;border-radius:999px;padding:12px 14px;cursor:pointer;font-weight:950;color:#fff;
      background:linear-gradient(135deg,var(--primary),var(--primary2));
      box-shadow:0 14px 40px rgba(124,58,237,.22);
      display:flex;align-items:center;gap:8px;
    }

    .mask{position:fixed;inset:0;background:rgba(0,0,0,.42);display:none;align-items:center;justify-content:center;z-index:40;padding:18px}
    .modal{
      width:100%;max-width:560px;background: var(--panel);
      border:1px solid var(--border);border-radius:18px;box-shadow: var(--shadow);
      backdrop-filter:blur(18px);overflow:hidden;
    }
    .modal header{display:flex;align-items:center;justify-content:space-between;padding:14px;border-bottom:1px solid var(--border)}
    .modal header h3{font-size:1.03rem;color:var(--text);font-weight:950}
    .close{border:1px solid var(--border);background: var(--panel2);color:var(--text);border-radius:10px;padding:8px 10px;cursor:pointer;font-weight:950}
    .modal .body{padding:14px}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .field{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
    label{color:var(--muted);font-size:.88rem;font-weight:950}
    select,input{
      padding:12px;border-radius:12px;border:1px solid var(--border);
      background: var(--panel2);color:var(--text);font-size:.96rem;outline:none;
    }
    .modal footer{display:flex;justify-content:flex-end;gap:10px;padding:12px 14px;border-top:1px solid var(--border)}
    .btn{border:none;border-radius:12px;padding:11px 14px;cursor:pointer;font-weight:950}
    .btn.secondary{background: var(--panel2);border:1px solid var(--border);color:var(--text)}
    .btn.primary{background:linear-gradient(135deg,var(--primary),var(--primary2));color:#fff}

    .toast{
      position:fixed;left:50%;bottom:18px;transform:translateX(-50%);
      background: var(--panel);
      border:1px solid var(--border);
      color: var(--text);
      padding:10px 12px;border-radius:12px;display:none;z-index:60;
      box-shadow: 0 14px 40px rgba(0,0,0,.18);font-weight:950;
    }
    @media (max-width:768px){ .row{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <div class="topbar" id="topbar">
    <div class="container">
      <div class="header">
        <div></div>
        <div class="brand"><h1>NEBULA</h1></div>
        <div class="actions">
          <button class="pill" id="btnTheme" title="切换亮/暗">🌙</button>
          <button class="pill" id="btnManage">🧩 管理分类</button>
          <a class="pill danger" href="/logout">🚪 退出</a>
        </div>
      </div>

      <form class="searchbar" action="https://www.google.com/search" method="GET" target="_blank">
        <input name="q" placeholder="Google 搜索…" autocomplete="off">
        <button type="submit">🔎 搜索</button>
      </form>
    </div>
  </div>

  <div class="viewport">
    <div class="sections" id="sections"></div>
  </div>

  <div class="dots" id="dots"></div>

  <div class="fab"><button id="btnAdd">➕ 添加链接</button></div>

  <!-- Add/Edit -->
  <div class="mask" id="maskLink">
    <div class="modal">
      <header>
        <h3 id="linkModalTitle">添加链接</h3>
        <button class="close" id="closeLink">关闭</button>
      </header>
      <div class="body">
        <div class="row">
          <div class="field">
            <label>分类</label>
            <select id="linkCategory"></select>
          </div>
          <div class="field">
            <label>新建分类（可选）</label>
            <input id="newCategory" placeholder="例如：💼 工作 / 🎬 娱乐">
          </div>
        </div>
        <div class="field"><label>标题</label><input id="linkTitle" placeholder="例如：Notion / Gmail"></div>
        <div class="field"><label>URL</label><input id="linkUrl" placeholder="https://example.com"></div>
        <div class="field"><label>图标（可选）</label><input id="linkIcon" placeholder="留空自动同步 favicon"></div>
      </div>
      <footer>
        <button class="btn secondary" id="cancelLink">取消</button>
        <button class="btn primary" id="saveLink">保存</button>
      </footer>
    </div>
  </div>

  <!-- Category Manager (simple: reorder + rename) -->
  <div class="mask" id="maskCats">
    <div class="modal">
      <header>
        <h3>管理分类（拖拽排序 / 重命名）</h3>
        <button class="close" id="closeCats">关闭</button>
      </header>
      <div class="body">
        <div id="catlist"></div>
      </div>
      <footer>
        <button class="btn secondary" id="cancelCats">取消</button>
        <button class="btn primary" id="saveCats">保存排序</button>
      </footer>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    // Theme
    (function(){
      const saved = localStorage.getItem("nebula_theme");
      const systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      const theme = saved || (systemDark ? "dark" : "light");
      document.documentElement.dataset.theme = theme;
      function sync(){
        const cur = document.documentElement.dataset.theme || "dark";
        const btn = document.getElementById("btnTheme");
        if(btn) btn.textContent = cur === "dark" ? "🌙" : "☀️";
      }
      window.__toggleTheme = function(){
        const cur = document.documentElement.dataset.theme || "dark";
        const next = cur === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        localStorage.setItem("nebula_theme", next);
        sync();
      };
      sync();
    })();

    const state = { data: ${safeData}, index: 0, lock:false, lockMs:650, editing:null, catOrder:null };

    const elSections = document.getElementById("sections");
    const elDots = document.getElementById("dots");
    const toastEl = document.getElementById("toast");

    const maskLink = document.getElementById("maskLink");
    const maskCats = document.getElementById("maskCats");

    const linkModalTitle = document.getElementById("linkModalTitle");
    const linkCategory = document.getElementById("linkCategory");
    const newCategory = document.getElementById("newCategory");
    const linkTitle = document.getElementById("linkTitle");
    const linkUrl = document.getElementById("linkUrl");
    const linkIcon = document.getElementById("linkIcon");

    document.getElementById("btnTheme").onclick = ()=> window.__toggleTheme && window.__toggleTheme();

    function toast(msg){
      toastEl.textContent = msg;
      toastEl.style.display = "block";
      clearTimeout(window.__t);
      window.__t = setTimeout(()=> toastEl.style.display="none", 1800);
    }
    function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function escapeAttr(s){ return String(s).replace(/"/g, "&quot;"); }
    function originFromUrl(u){ try { return new URL(u).origin } catch { return u } }

    function applyTopbarVar(){
      const tb = document.getElementById("topbar");
      const h = tb ? tb.offsetHeight : 140;
      document.documentElement.style.setProperty("--topbar-h", h + "px");
    }
    function applyTransform(){
      const sectionEl = document.querySelector(".section");
      const vh = sectionEl ? sectionEl.offsetHeight : (window.innerHeight - 160);
      elSections.style.transform = "translateY(" + (-state.index * vh) + "px)";
      document.querySelectorAll(".dot").forEach((d,i)=>d.classList.toggle("active", i===state.index));
    }
    function goTo(i){
      const max = (state.data.categories?.length || 1) - 1;
      state.index = Math.max(0, Math.min(max, i));
      applyTransform();
    }
    function wheelHandler(e){
      e.preventDefault();
      if(state.lock) return;
      state.lock = true;
      setTimeout(()=>state.lock=false, state.lockMs);
      const dir = e.deltaY > 0 ? 1 : -1;
      goTo(state.index + dir);
    }
    window.addEventListener("resize", ()=>{ applyTopbarVar(); applyTransform(); });
    document.addEventListener("wheel", wheelHandler, { passive:false });

    function render(){
      const cats = state.data.categories || [];
      elDots.innerHTML = cats.map((_, i)=>\`<div class="dot \${i===state.index?"active":""}" data-i="\${i}"></div>\`).join("");
      elDots.querySelectorAll(".dot").forEach(d=> d.onclick = ()=> goTo(Number(d.dataset.i)));

      linkCategory.innerHTML = cats.map(c=>\`<option value="\${escapeAttr(c.id)}">\${escapeHtml(c.name)}</option>\`).join("");

      elSections.innerHTML = cats.map((c) => {
        const links = (c.links || []).map(l => {
          const icon = l.icon || "";
          return \`
            <a class="card" href="\${escapeAttr(l.url)}" target="_blank" rel="noopener"
               draggable="true" data-link-id="\${escapeAttr(l.id)}" data-cat-id="\${escapeAttr(c.id)}">
              <div class="tools">
                <div class="mini" data-action="edit" data-link-id="\${escapeAttr(l.id)}">✎</div>
                <div class="mini d" data-action="del" data-link-id="\${escapeAttr(l.id)}">🗑</div>
              </div>
              <div class="favicon"><img src="\${escapeAttr(icon)}" alt=""></div>
              <div class="meta">
                <div class="title">\${escapeHtml(l.title)}</div>
                <div class="url">\${escapeHtml(originFromUrl(l.url))}</div>
              </div>
            </a>\`;
        }).join("");

        const emptyHint = (c.links||[]).length ? "" : \`
          <div style="margin:10px 0 0;color:var(--muted);font-weight:900;">
            这个分类还没有链接，点右下角 ➕ 添加
          </div>\`;

        return \`
          <section class="section" data-section-cat="\${escapeAttr(c.id)}">
            <div class="section-title"><span>\${escapeHtml(c.name)}</span></div>
            <div class="grid" data-grid-cat="\${escapeAttr(c.id)}">\${links}</div>
            \${emptyHint}
          </section>\`;
      }).join("");

      document.querySelectorAll(".mini").forEach(btn=>{
        btn.addEventListener("click", async (e)=>{
          e.preventDefault(); e.stopPropagation();
          const action = btn.dataset.action;
          const linkId = btn.dataset.linkId;
          if(action==="edit") openEdit(linkId);
          if(action==="del"){
            if(!confirm("确定删除？")) return;
            await deleteLink(linkId);
          }
        });
      });

      wireDragDropLinks();
      applyTopbarVar();
      applyTransform();
    }

    function getCategoryById(catId){ return (state.data.categories||[]).find(c=>c.id===catId); }
    function findLink(linkId){
      for(const c of (state.data.categories||[])){
        const l = (c.links||[]).find(x=>x.id===linkId);
        if(l) return {cat:c, link:l};
      }
      return null;
    }

    // Add/Edit modal
    function openAdd(){
      state.editing = null;
      linkModalTitle.textContent = "添加链接";
      newCategory.value = "";
      linkTitle.value = "";
      linkUrl.value = "";
      linkIcon.value = "";
      linkCategory.value = (state.data.categories?.[0]?.id) || "";
      maskLink.style.display = "flex";
    }
    function openEdit(linkId){
      const found = findLink(linkId);
      if(!found) return toast("未找到");
      state.editing = { linkId, catId: found.cat.id };
      linkModalTitle.textContent = "编辑链接";
      newCategory.value = "";
      linkTitle.value = found.link.title || "";
      linkUrl.value = found.link.url || "";
      linkIcon.value = found.link.icon || "";
      linkCategory.value = found.cat.id;
      maskLink.style.display = "flex";
    }
    function closeLinkModal(){ maskLink.style.display="none"; }

    document.getElementById("btnAdd").onclick = openAdd;
    document.getElementById("closeLink").onclick = closeLinkModal;
    document.getElementById("cancelLink").onclick = closeLinkModal;
    maskLink.addEventListener("click",(e)=>{ if(e.target===maskLink) closeLinkModal(); });

    document.getElementById("saveLink").onclick = async ()=>{
      const catId = linkCategory.value;
      const catName = newCategory.value.trim();
      const title = linkTitle.value.trim();
      const url = linkUrl.value.trim();
      const icon = linkIcon.value.trim();
      if(!title || !url) return toast("标题/URL 不能为空");

      try{
        if(!state.editing){
          const res = await fetch("/api/links",{method:"POST",headers:{"content-type":"application/json"},
            body: JSON.stringify({ categoryId: catId, categoryName: catName, title, url, icon })
          });
          const out = await res.json();
          if(!res.ok) return toast(out?.error || "失败");
          state.data = out.data;
          render();
          closeLinkModal();
          toast("已添加");
        }else{
          const res = await fetch("/api/links",{method:"PUT",headers:{"content-type":"application/json"},
            body: JSON.stringify({ linkId: state.editing.linkId, title, url, icon, moveToCategoryId: catId })
          });
          const out = await res.json();
          if(!res.ok) return toast(out?.error || "失败");
          state.data = out.data;
          render();
          closeLinkModal();
          toast("已更新");
        }
      }catch(e){ toast("网络错误"); }
    };

    async function deleteLink(linkId){
      try{
        const res = await fetch("/api/links",{method:"DELETE",headers:{"content-type":"application/json"},
          body: JSON.stringify({ linkId })
        });
        const out = await res.json();
        if(!res.ok) return toast(out?.error || "失败");
        state.data = out.data;
        render();
        toast("已删除");
      }catch(e){ toast("网络错误"); }
    }

    // Drag/drop links
    function wireDragDropLinks(){
      const cards = document.querySelectorAll(".card[draggable='true']");
      const grids = document.querySelectorAll(".grid");
      let drag = null;

      cards.forEach(card=>{
        card.addEventListener("dragstart", (e)=>{
          drag = { linkId: card.dataset.linkId, fromCatId: card.dataset.catId };
          card.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
        });
        card.addEventListener("dragend", ()=>{
          card.classList.remove("dragging");
          drag = null;
        });

        card.addEventListener("dragover", (e)=>{ if(!drag) return; e.preventDefault(); });
        card.addEventListener("drop", async (e)=>{
          if(!drag) return;
          e.preventDefault();
          const toCatId = card.dataset.catId;
          const targetLinkId = card.dataset.linkId;
          reorderByDrop(drag.linkId, drag.fromCatId, toCatId, targetLinkId);
          render();
          await persistReorder();
          toast("已保存");
        });
      });

      grids.forEach(grid=>{
        grid.addEventListener("dragover",(e)=>{ if(!drag) return; e.preventDefault(); });
        grid.addEventListener("drop", async (e)=>{
          if(!drag) return;
          e.preventDefault();
          const toCatId = grid.dataset.gridCat;
          reorderByDrop(drag.linkId, drag.fromCatId, toCatId, null);
          render();
          await persistReorder();
          toast("已保存");
        });
      });
    }

    function reorderByDrop(linkId, fromCatId, toCatId, beforeLinkId){
      const from = getCategoryById(fromCatId);
      const to = getCategoryById(toCatId);
      if(!from || !to) return;
      const idx = from.links.findIndex(l=>l.id===linkId);
      if(idx<0) return;
      const [item] = from.links.splice(idx,1);
      if(beforeLinkId){
        const bi = to.links.findIndex(l=>l.id===beforeLinkId);
        if(bi>=0){ to.links.splice(bi,0,item); return; }
      }
      to.links.push(item);
    }

    async function persistReorder(){
      const payload = {
        data:{ categories:(state.data.categories||[]).map(c=>({id:c.id, links:(c.links||[]).map(l=>({id:l.id}))})) }
      };
      try{
        const res = await fetch("/api/reorder",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
        const out = await res.json();
        if(!res.ok) return toast(out?.error || "保存失败");
        state.data = out.data;
      }catch(e){ toast("网络错误"); }
    }

    // Category manager (simple)
    const catlist = document.getElementById("catlist");

    document.getElementById("btnManage").onclick = ()=>{
      state.catOrder = (state.data.categories||[]).map(c=>c.id);
      renderCats();
      maskCats.style.display="flex";
    };
    function closeCats(){ maskCats.style.display="none"; state.catOrder=null; }
    document.getElementById("closeCats").onclick = closeCats;
    document.getElementById("cancelCats").onclick = closeCats;
    maskCats.addEventListener("click",(e)=>{ if(e.target===maskCats) closeCats(); });

    function renderCats(){
      const cats = state.data.categories || [];
      const order = state.catOrder || cats.map(c=>c.id);
      const orderedCats = order.map(id=>cats.find(c=>c.id===id)).filter(Boolean);

      catlist.innerHTML = orderedCats.map(c=>\`
        <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;
                    padding:12px;border:1px solid var(--border);border-radius:14px;
                    background:var(--panel2);margin-bottom:10px;cursor:grab;"
             draggable="true" data-cid="\${escapeAttr(c.id)}">
          <div style="font-weight:950;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${escapeHtml(c.name)}</div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="mini" title="重命名" data-rename="\${escapeAttr(c.id)}">✎</button>
            <span style="color:var(--muted);font-weight:950;font-size:.82rem">拖动</span>
          </div>
        </div>
      \`).join("");

      // rename
      catlist.querySelectorAll("[data-rename]").forEach(btn=>{
        btn.onclick = async (e)=>{
          e.preventDefault(); e.stopPropagation();
          const cid = btn.dataset.rename;
          const cat = (state.data.categories||[]).find(x=>x.id===cid);
          if(!cat) return;
          const name = prompt("新的分类名称：", cat.name);
          if(!name) return;
          const res = await fetch("/api/categories/rename",{method:"POST",headers:{"content-type":"application/json"},
            body: JSON.stringify({ categoryId: cid, newName: name.trim() })
          });
          const out = await res.json();
          if(!res.ok) return toast(out?.error || "失败");
          state.data = out.data;
          renderCats(); render();
          toast("已重命名");
        };
      });

      // drag order
      const items = catlist.querySelectorAll("[draggable='true']");
      let draggingId = null;
      items.forEach(it=>{
        it.addEventListener("dragstart", ()=> draggingId = it.dataset.cid );
        it.addEventListener("dragover",(e)=>{ if(!draggingId) return; e.preventDefault(); });
        it.addEventListener("drop",(e)=>{
          if(!draggingId) return;
          e.preventDefault();
          const targetId = it.dataset.cid;
          const arr = state.catOrder;
          const from = arr.indexOf(draggingId);
          arr.splice(from,1);
          const to = arr.indexOf(targetId);
          arr.splice(to,0,draggingId);
          renderCats();
        });
      });
    }

    document.getElementById("saveCats").onclick = async ()=>{
      const cats = state.data.categories || [];
      const order = state.catOrder || cats.map(c=>c.id);
      const byId = new Map(cats.map(c=>[c.id,c]));
      const nextCats = order.map(id=>byId.get(id)).filter(Boolean);
      for(const c of cats) if(!nextCats.some(x=>x.id===c.id)) nextCats.push(c);
      state.data.categories = nextCats;
      closeCats();
      render();
      await persistReorder();
      toast("已保存");
    };

    // init
    applyTopbarVar();
    render();
  </script>
</body>
</html>`;
}
