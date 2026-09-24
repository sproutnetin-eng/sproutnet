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

// Renders the shared top nav into <div id="sn-nav">. Call with an active key.
export async function renderNav(active = '') {
  const el = document.getElementById('sn-nav');
  if (!el) return;
  const { data } = await sb().auth.getSession();
  const authed = !!data.session;
  const links = [
    ['problems', '/problems', 'Problems'],
    ['blogs', '/blogs', 'Blogs'],
    ['mentors', '/mentors', 'Mentors'],
    ['leaderboard', '/leaderboard', 'Leaderboard'],
    ['how', '/how-it-works', 'How it works'],
  ];
  el.innerHTML = `
    <a class="brand" href="/">SproutNet</a>
    <nav>${links.map(([k, h, t]) =>
      `<a href="${h}" class="${active === k ? 'on' : ''}">${t}</a>`).join('')}
      ${authed ? `<a href="/dashboard" class="${active === 'dash' ? 'on' : ''}">Dashboard</a>
      <a href="#" id="sn-logout">Logout</a>` :
      `<a href="/login" class="${active === 'login' ? 'on' : ''}">Login</a>
       <a href="/join" class="cta">Join</a>`}
    </nav>`;
  document.getElementById('sn-logout')?.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });
}

export function alertBox(msg, ok = false) {
  return `<div class="alert ${ok ? 'ok' : 'err'}">${esc(msg)}</div>`;
}
