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

export const NAV_ICONS = {
  dashboard: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>`,
  problems: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  solutions: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  teams: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  blogs: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  leaderboard: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`,
  mentors: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  portfolio: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  messages: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  notifications: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  admin: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  postProblem: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
  logout: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`
};

export function isDashboardPage(path = location.pathname) {
  if (path === '/' || path === '/index.html' || path === '/how-it-works') return false;
  if (path.startsWith('/login') || path === '/join' || path === '/forgot-password' || path === '/setup-admin') return false;
  if (path.startsWith('/admin')) return false; // Admin has its dedicated control plane sidebar
  return true;
}

export function getActiveRoute(path = location.pathname) {
  if (path === '/problems' || path.startsWith('/problems/')) return '/problems';
  if (path === '/solutions' || path.startsWith('/solutions/')) return '/solutions';
  if (path === '/teams' || path.startsWith('/teams/')) return '/teams';
  if (path === '/blogs' || path.startsWith('/blogs/')) return '/blogs';
  if (path === '/leaderboard' || path.startsWith('/leaderboard/')) return '/leaderboard';
  if (path === '/mentors' || path.startsWith('/mentor/connect') || path.startsWith('/mentor/profile')) return '/mentors';
  if (path === '/profile' || path.startsWith('/profile/')) return '/profile';
  if (path === '/messages' || path.startsWith('/messages/')) return '/messages';
  if (path === '/notifications' || path.startsWith('/notifications/')) return '/notifications';
  if (path === '/poster/post-problem') return '/poster/post-problem';
  if (path.startsWith('/poster')) return '/poster/dashboard';
  if (path.startsWith('/mentor')) return '/mentor/dashboard';
  if (path === '/dashboard' || path.startsWith('/dashboard/')) return '/dashboard';
  return '/dashboard';
}

export function getPageTitle(path = location.pathname) {
  if (path.startsWith('/problems')) return 'Problems';
  if (path.startsWith('/solutions')) return 'Solutions';
  if (path.startsWith('/teams')) return 'Teams & Workspaces';
  if (path.startsWith('/blogs')) return 'Community Blogs';
  if (path.startsWith('/leaderboard')) return 'Leaderboard';
  if (path.startsWith('/mentors') || path.startsWith('/mentor/connect')) return 'Mentors';
  if (path.startsWith('/profile')) return 'My Portfolio';
  if (path.startsWith('/messages')) return 'Messages';
  if (path.startsWith('/notifications')) return 'Notifications';
  if (path.startsWith('/poster/post-problem')) return 'Post a Problem';
  if (path.startsWith('/poster')) return 'Poster Workspace';
  if (path.startsWith('/mentor')) return 'Mentor Workspace';
  return 'Dashboard';
}

export function applyDashboardLayout(user) {
  const path = location.pathname;
  if (!isDashboardPage(path)) return;

  const existingSidebar = document.getElementById('dash-sidebar');
  if (existingSidebar) {
    renderSidebar({ targetId: 'dash-sidebar', user, active: getActiveRoute(path) });
    return;
  }

  const snNav = document.getElementById('sn-nav');
  if (!snNav) return;

  const parent = snNav.parentNode;

  // Collect all sibling elements after #sn-nav that should be inside the main content
  const nodesToWrap = [];
  let el = snNav.nextSibling;
  while (el) {
    const next = el.nextSibling;
    if (el.nodeName !== 'SCRIPT' && el.nodeName !== 'TEMPLATE' && el.nodeName !== 'LINK' && el.nodeName !== 'STYLE') {
      nodesToWrap.push(el);
    }
    el = next;
  }

  const layout = document.createElement('div');
  layout.className = 'dash-layout';

  const backdrop = document.createElement('div');
  backdrop.className = 'dash-sidebar-backdrop';
  backdrop.id = 'dash-sidebar-backdrop';

  const sidebar = document.createElement('aside');
  sidebar.className = 'dash-sidebar';
  sidebar.id = 'dash-sidebar';

  const main = document.createElement('main');
  main.className = 'dash-main';

  const mobileBar = document.createElement('div');
  mobileBar.className = 'dash-mobile-bar';
  mobileBar.innerHTML = `
    <button type="button" class="dash-mobile-toggle" id="dash-sidebar-toggle">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      <span>Menu</span>
    </button>
    <div style="font-family:'Sora',sans-serif;font-weight:600;font-size:14px;color:var(--ink)">${esc(getPageTitle(path))}</div>
  `;

  const contentInner = document.createElement('div');
  contentInner.className = 'dash-content-inner';

  nodesToWrap.forEach(node => contentInner.appendChild(node));

  main.appendChild(mobileBar);
  main.appendChild(contentInner);

  layout.appendChild(backdrop);
  layout.appendChild(sidebar);
  layout.appendChild(main);

  if (snNav.nextSibling) {
    parent.insertBefore(layout, snNav.nextSibling);
  } else {
    parent.appendChild(layout);
  }

  const toggleBtn = mobileBar.querySelector('#dash-sidebar-toggle');
  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    backdrop.classList.toggle('open');
  });
  backdrop.addEventListener('click', () => {
    sidebar.classList.remove('open');
    backdrop.classList.remove('open');
  });

  renderSidebar({ targetId: 'dash-sidebar', user, active: getActiveRoute(path) });
}

export async function renderNav() {
  const el = document.getElementById('sn-nav');
  if (!el) return;
  const path = location.pathname;
  const isActive = (p) => (p === '/' ? path === '/' : path.startsWith(p));

  // Instantly apply dashboard layout wrapper to avoid layout shift
  applyDashboardLayout(null);

  let user = null;
  try {
    const { data } = await sb().auth.getSession();
    if (data.session) {
      const me = await api('/api/auth/profile');
      user = me.profile || null;
    }
  } catch { user = null; }

  const isPoster = user?.role === 'poster';
  const isMentor = user?.role === 'mentor';
  const dashboardHref = isPoster ? '/poster/dashboard' : isMentor ? '/mentor/dashboard' : '/dashboard';

  el.innerHTML = `
    <a class="brand" href="/">${LOGO_SVG}<span>SproutNet</span></a>
    <nav class="sn-nav-links">
      ${user ? `
        <a class="sn-pill amber ${isActive(dashboardHref) ? 'on' : ''}" style="padding:8px 20px;border-radius:6px;font-weight:600;display:inline-flex;align-items:center;gap:6px" href="${dashboardHref}">Dashboard</a>
      ` : `
        <a class="navlink${isActive('/login') ? ' on' : ''}" href="/login">Sign In</a>
        <a class="sn-pill amber" style="padding:8px 20px;border-radius:6px;font-weight:600" href="/join">Join →</a>
      `}
    </nav>`;

  if (isDashboardPage(path)) {
    renderSidebar({ targetId: 'dash-sidebar', user, active: getActiveRoute(path) });
  }
}

export async function renderSidebar({ targetId = 'dash-sidebar', user = null, active = '/dashboard' } = {}) {
  const el = document.getElementById(targetId);
  if (!el) return;

  if (!user) {
    try {
      const { data } = await sb().auth.getSession();
      if (data.session) {
        const me = await api('/api/auth/profile');
        user = me.profile || null;
      }
    } catch { user = null; }
  }

  const isPoster = user?.role === 'poster';
  const isMentor = user?.role === 'mentor';
  const isAdmin = user?.role === 'admin' || user?.is_master;
  const dashboardHref = isPoster ? '/poster/dashboard' : isMentor ? '/mentor/dashboard' : '/dashboard';
  const roleLabel = user?.is_master ? 'Master Admin' : (user?.role || 'STUDENT');
  const profileHref = user ? `/profile/${user.profile_slug || user.id}` : '/profile';
  const name = user?.name || 'User';

  el.innerHTML = `
    <div class="dash-sidebar-header-mobile">
      <span style="font-family:'Sora',sans-serif;font-weight:700;font-size:15px;color:var(--ink)">Dashboard Menu</span>
      <button type="button" class="dash-sidebar-close" id="dash-sidebar-close" aria-label="Close menu">✕</button>
    </div>

    ${user ? `
    <a href="${profileHref}" class="dash-user-card" title="View Builder Portfolio">
      <span class="dash-user-avatar" style="background:${avatarColor(name)}">${esc(initials(name))}</span>
      <div class="dash-user-info">
        <div class="dash-user-name">${esc(name)}</div>
        <div class="dash-user-role-wrap"><span class="sn-role">${esc(roleLabel)}</span></div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9CA3A0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
    </a>
    ` : `
    <a href="/login" class="dash-user-card" title="Sign In to SproutNet">
      <span class="dash-user-avatar" style="background:#2D6A4F"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FAF8F4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg></span>
      <div class="dash-user-info">
        <div class="dash-user-name">Sign In / Join</div>
        <div class="dash-user-role-wrap"><span class="sn-role">Guest</span></div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9CA3A0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
    </a>
    `}

    <div class="dash-nav-section">
      <div class="dash-nav-title">MAIN MENU</div>
      <a class="dash-nav-link ${active === '/dashboard' || active === dashboardHref ? 'active' : ''}" href="${dashboardHref}">
        <span class="dash-nav-icon">${NAV_ICONS.dashboard}</span>
        <span class="dash-nav-text">Dashboard</span>
      </a>
      <a class="dash-nav-link ${active === '/problems' ? 'active' : ''}" href="/problems">
        <span class="dash-nav-icon">${NAV_ICONS.problems}</span>
        <span class="dash-nav-text">Problems</span>
      </a>
      <a class="dash-nav-link ${active === '/solutions' ? 'active' : ''}" href="/solutions">
        <span class="dash-nav-icon">${NAV_ICONS.solutions}</span>
        <span class="dash-nav-text">Solutions</span>
      </a>
      <a class="dash-nav-link ${active === '/teams' ? 'active' : ''}" href="/teams">
        <span class="dash-nav-icon">${NAV_ICONS.teams}</span>
        <span class="dash-nav-text">Teams</span>
      </a>
      <a class="dash-nav-link ${active === '/blogs' ? 'active' : ''}" href="/blogs">
        <span class="dash-nav-icon">${NAV_ICONS.blogs}</span>
        <span class="dash-nav-text">Blogs</span>
      </a>
      <a class="dash-nav-link ${active === '/leaderboard' ? 'active' : ''}" href="/leaderboard">
        <span class="dash-nav-icon">${NAV_ICONS.leaderboard}</span>
        <span class="dash-nav-text">Leaderboard</span>
      </a>
      <a class="dash-nav-link ${active === '/mentors' ? 'active' : ''}" href="/mentors">
        <span class="dash-nav-icon">${NAV_ICONS.mentors}</span>
        <span class="dash-nav-text">Mentors</span>
      </a>
      <a class="dash-nav-link ${active === '/profile' ? 'active' : ''}" href="${profileHref}">
        <span class="dash-nav-icon">${NAV_ICONS.portfolio}</span>
        <span class="dash-nav-text">My Portfolio</span>
      </a>
    </div>

    <div class="dash-nav-section">
      <div class="dash-nav-title">COMMUNICATION</div>
      <a class="dash-nav-link ${active === '/messages' ? 'active' : ''}" href="/messages">
        <span class="dash-nav-icon">${NAV_ICONS.messages}</span>
        <span class="dash-nav-text">Messages</span>
        <span class="dash-nav-pill amber">Chat</span>
      </a>
      <a class="dash-nav-link ${active === '/notifications' ? 'active' : ''}" href="/notifications">
        <span class="dash-nav-icon">${NAV_ICONS.notifications}</span>
        <span class="dash-nav-text">Notifications</span>
      </a>
    </div>

    ${isAdmin || isPoster ? `
    <div class="dash-nav-section">
      <div class="dash-nav-title">WORKSPACE TOOLS</div>
      ${isAdmin ? `
        <a class="dash-nav-link ${active === '/admin' ? 'active' : ''}" href="/admin">
          <span class="dash-nav-icon">${NAV_ICONS.admin}</span>
          <span class="dash-nav-text">Admin Panel</span>
        </a>` : ''}
      ${isPoster ? `
        <a class="dash-nav-link ${active === '/poster/post-problem' ? 'active' : ''}" href="/poster/post-problem">
          <span class="dash-nav-icon">${NAV_ICONS.postProblem}</span>
          <span class="dash-nav-text">Post a Problem</span>
        </a>` : ''}
    </div>` : ''}

    <div class="dash-sidebar-bottom">
      ${user ? `
      <button type="button" class="dash-signout-btn" id="dash-sidebar-logout">
        <span class="dash-nav-icon">${NAV_ICONS.logout}</span>
        <span>Sign out</span>
      </button>` : `
      <a href="/login" class="dash-signout-btn" style="text-decoration:none">
        <span class="dash-nav-icon">${NAV_ICONS.logout}</span>
        <span>Sign In</span>
      </a>`}
    </div>
  `;

  document.getElementById('dash-sidebar-logout')?.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });

  document.getElementById('dash-sidebar-close')?.addEventListener('click', () => {
    document.getElementById('dash-sidebar')?.classList.remove('open');
    document.getElementById('dash-sidebar-backdrop')?.classList.remove('open');
  });
}

export function alertBox(msg, ok = false) {
  return `<div class="alert ${ok ? 'ok' : 'err'}">${esc(msg)}</div>`;
}

// Image loading: above-the-fold images stay eager, everything else lazy-loads.
// Templates hardcode loading/decoding/fetchpriority attributes directly; this
// safety net upgrades any <img> injected without them (cards, lists, dashboards,
// blog bodies) so below-fold images never block the initial page load.
function markImage(img) {
  if (!(img instanceof HTMLImageElement)) return;
  if (!img.hasAttribute('loading')) {
    const eager = img.hasAttribute('data-eager') || img.getAttribute('fetchpriority') === 'high';
    img.setAttribute('loading', eager ? 'eager' : 'lazy');
  }
  if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
}

function sweepImages(root = document) {
  try {
    root.querySelectorAll('img:not([loading])').forEach(markImage);
    if (root instanceof HTMLImageElement) markImage(root);
  } catch { /* ignore */ }
}

if (typeof window !== 'undefined' && typeof MutationObserver !== 'undefined') {
  sweepImages();
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLImageElement) markImage(node);
        else if (node instanceof Element) sweepImages(node);
      }
      if (m.type === 'attributes' && m.target instanceof HTMLImageElement && m.attributeName === 'src') {
        markImage(m.target);
      }
    }
  });
  const startObserving = () => {
    try {
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    } catch { /* ignore */ }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { sweepImages(); startObserving(); }, { once: true });
  else startObserving();
}
