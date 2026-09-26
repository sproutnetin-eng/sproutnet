import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let _sb = null;
export function sb() {
  if (!_sb) _sb = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  return _sb;
}

export async function token() {
  const { data } = await sb().auth.getSession();
  return data.session?.access_token || null;
}

// JSON/form API helper. Attaches the Supabase JWT as a Bearer token.
export async function api(path, { method = 'GET', body, form } = {}) {
  const t = await token();
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (t) headers['Authorization'] = `Bearer ${t}`;
  const res = await fetch(path, {
    method,
    headers,
    body: form ? form : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function requireAuth() {
  const { data } = await sb().auth.getSession();
  if (!data.session) {
    location.href = '/login';
    return null;
  }
  return data.session;
}

// Redirects away unless the logged-in user has one of the given roles.
export async function requireRole(...roles) {
  const s = await requireAuth();
  if (!s) return null;
  try {
    const me = await api('/api/auth/profile');
    const role = me.profile?.role;
    const isAdmin = role === 'admin' || me.profile?.is_master;
    if (!roles.includes(role) && !(isAdmin && roles.includes('admin'))) {
      location.href = '/dashboard';
      return null;
    }
    return me;
  } catch {
    location.href = '/login';
    return null;
  }
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function logout() {
  await sb().auth.signOut();
  try { await api('/api/auth/signout', { method: 'POST' }); } catch { /* ignore */ }
  location.href = '/login';
}

// Renders the shared top nav into <div id="sn-nav"> (matches original navbar.tsx).
// Call with no args; active link is derived from location.pathname.
const AVATAR_COLORS = ['#2D6A4F', '#1E40AF', '#9C6344', '#6B4C2A', '#3D8A65', '#4A3F38', '#7C3AED', '#BE123C'];
function avatarColor(name) {
  return AVATAR_COLORS[(name || '?').charCodeAt(0) % AVATAR_COLORS.length];
}
function initials(name) {
  return String(name || '?').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
}
const LOGO_SVG = `<svg width="34" height="34" viewBox="0 0 34 34" fill="none"><rect width="34" height="34" rx="8" fill="#2D6A4F"/><line x1="17" y1="27" x2="17" y2="15" stroke="#FAF8F4" stroke-width="1.7" stroke-linecap="round"/><path d="M17 21 C16 19 13 18 11 14.5 C11 14.5 15.5 13 17 17.5" fill="#F4A723"/><path d="M17 18 C18 15.5 21.5 14 24 10.5 C24 10.5 19.5 10 17 14.5" fill="rgba(250,248,244,0.88)"/></svg>`;

export async function renderNav() {
  const el = document.getElementById('sn-nav');
  if (!el) return;
  const path = location.pathname;
  const isActive = (p) => (p === '/' ? path === '/' : path.startsWith(p));
  const link = (href, label) =>
    `<a class="navlink${isActive(href) ? ' on' : ''}" href="${href}">${label}</a>`;

  let user = null;
  try {
    const { data } = await sb().auth.getSession();
    if (data.session) {
      const me = await api('/api/auth/profile');
      user = me.profile || null;
    }
  } catch { user = null; }

  const isPoster = user?.role === 'poster';
  const dashboardHref = isPoster ? '/poster/dashboard' : '/dashboard';
  const roleLabel = user?.is_master ? 'Master Admin' : user?.role;
  const profileHref = user ? `/profile/${user.profile_slug || user.id}` : '/login';

  el.innerHTML = `
    <a class="brand" href="/">${LOGO_SVG}<span>SproutNet</span></a>
    <nav class="sn-nav-links">
      ${link('/problems', 'Problems')}
      ${link('/solutions', 'Solutions')}
      ${link('/blogs', 'Blogs')}
      ${link('/leaderboard', 'Leaderboard')}
      ${link('/mentors', 'Mentors')}
      ${user?.name && user?.role ? link('/profile', 'My Portfolio') : ''}
      ${user ? `
        ${user.role === 'admin' ? `<a class="sn-pill" href="/admin">Admin Panel</a>` : ''}
        ${isPoster ? `<a class="sn-pill" href="/poster/post-problem">Post a Problem</a>` : ''}
        ${user.name && user.role ? `<span class="sn-role">${esc(roleLabel)}</span>` : ''}
        ${user.name ? `<a class="navlink" style="display:flex;align-items:center;gap:8px" href="${profileHref}">
          <span class="sn-avatar" style="background:${avatarColor(user.name)}">${esc(initials(user.name))}</span>
          <span>${esc(user.name)}</span></a>` : ''}
        <a class="sn-pill amber" href="/messages">Messages</a>
        <a class="sn-pill" href="/notifications">Notifications</a>
        <a class="sn-pill amber" style="padding:8px 20px;border-radius:6px" href="${dashboardHref}">Dashboard →</a>
        <button class="sn-signout" id="sn-logout">Sign out</button>
      ` : `
        <a class="navlink${isActive('/login') ? ' on' : ''}" href="/login">Sign In</a>
        <a class="sn-pill amber" style="padding:8px 20px;border-radius:6px" href="/join">Join →</a>
      `}
    </nav>
    <details class="sn-mobile-menu">
      <summary aria-label="Open navigation menu"><span class="sn-menu-icon" aria-hidden="true"></span><span>Menu</span></summary>
      <div class="sn-mobile-panel">
        <a href="/problems">Problems</a>
        <a href="/solutions">Solutions</a>
        <a href="/blogs">Blogs</a>
        <a href="/leaderboard">Leaderboard</a>
        <a href="/mentors">Mentors</a>
        ${user ? `<a href="${dashboardHref}">Dashboard</a><a href="#" id="sn-logout-m">Sign out</a>`
               : `<a href="/login">Sign In</a><a href="/join">Join</a>`}
      </div>
    </details>`;
  const doLogout = (e) => { e.preventDefault(); logout(); };
  document.getElementById('sn-logout')?.addEventListener('click', doLogout);
  document.getElementById('sn-logout-m')?.addEventListener('click', doLogout);
}

export function alertBox(msg, ok = false) {
  return `<div class="alert ${ok ? 'ok' : 'err'}">${esc(msg)}</div>`;
}
