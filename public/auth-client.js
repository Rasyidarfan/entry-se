'use strict';

// Shared auth + API client for all pages. Stores the JWT in localStorage and
// attaches it to every /api request. Redirects to /login.html when missing/expired.

const SE = (() => {
  const TOKEN_KEY = 'se_token';
  const USER_KEY = 'se_user';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  }
  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function isAdmin() { const u = getUser(); return u && u.role === 'admin'; }

  // Redirect to login if not authenticated. Call at the top of protected pages.
  function requireAuth() {
    if (!getToken()) {
      location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
      return false;
    }
    return true;
  }

  // Fetch wrapper: adds Authorization, parses JSON, throws on error, and bounces
  // to login on 401.
  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      clearSession();
      location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
      throw new Error('unauthorized');
    }
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = body && body.error ? body.error.message : `HTTP ${res.status}`;
      const err = new Error(msg);
      err.code = body && body.error ? body.error.code : null;
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ? body.error.message : 'Login gagal');
    setSession(body.token, body.user);
    return body.user;
  }

  function logout() {
    api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearSession();
    location.href = '/login.html';
  }

  return { getToken, getUser, setSession, clearSession, isAdmin, requireAuth, api, login, logout };
})();

window.SE = SE;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
