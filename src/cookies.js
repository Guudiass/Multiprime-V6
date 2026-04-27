/* eslint-disable no-undef */
// src/cookies.js — Sanitização e preparação de cookies para injeção

function sanitizeCookieForInjection(cookie, defaultUrl) {
    const c = {};

    if (!cookie.name || cookie.value === undefined || cookie.value === null) return null;
    c.name = String(cookie.name);
    c.value = String(cookie.value);

    const host = cookie.domain
        ? (cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain)
        : new URL(defaultUrl).hostname;

    c.url = `https://${host}${cookie.path || '/'}`;

    if (cookie.domain) c.domain = cookie.domain;
    if (cookie.path) c.path = cookie.path;

    c.secure = cookie.secure !== false;

    if (cookie.httpOnly !== undefined) c.httpOnly = !!cookie.httpOnly;

    if (cookie.sameSite) {
        const s = String(cookie.sameSite).toLowerCase();
        if (s === 'strict') c.sameSite = 'strict';
        else if (s === 'lax') c.sameSite = 'lax';
        else if (s === 'none' || s === 'no_restriction' || s === 'unspecified') {
            c.sameSite = 'no_restriction';
            c.secure = true;
        }
    } else {
        c.sameSite = 'lax';
    }

    if (c.name.startsWith('__Host-')) {
        c.secure = true;
        c.path = '/';
        delete c.domain;
    } else if (c.name.startsWith('__Secure-')) {
        c.secure = true;
    }

    if (cookie.expirationDate) {
        const exp = Number(cookie.expirationDate);
        if (!isNaN(exp) && exp > 0) {
            const expMs = exp > 1e12 ? exp : exp * 1000;
            if (expMs > Date.now()) {
                c.expirationDate = exp > 1e12 ? exp / 1000 : exp;
            } else {
                return null;
            }
        }
    } else {
        // Session cookie (sem expirationDate): converter para persistent (30 dias)
        // Senao, sao apagados quando o browser fecha — perdemos auth de SPAs como Higgsfield
        c.expirationDate = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
    }

    return c;
}

function prepareCookiesForInjection(cookies, defaultUrl) {
    const seen = new Map();

    for (const cookie of cookies) {
        const sanitized = sanitizeCookieForInjection(cookie, defaultUrl);
        if (!sanitized) continue;
        const key = `${sanitized.name}|${sanitized.domain || ''}|${sanitized.path || '/'}`;
        seen.set(key, sanitized);
    }

    const authPatterns = ['session', 'token', 'auth', 'sid', 'csrf', 'login', 'jwt'];
    const entries = Array.from(seen.values());
    const normal = [];
    const auth = [];

    for (const c of entries) {
        const nameLower = c.name.toLowerCase();
        const isAuth = authPatterns.some(p => nameLower.includes(p));
        if (isAuth) auth.push(c);
        else normal.push(c);
    }

    return [...normal, ...auth];
}

module.exports = { sanitizeCookieForInjection, prepareCookiesForInjection };
