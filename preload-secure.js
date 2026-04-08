/* eslint-disable no-undef */
// preload-secure.js — VERSÃO SIMPLIFICADA
// O Electron é Chromium real. Quanto menos a gente mocka, menos chance de detecção.
// Responsabilidades: polyfill Set, webdriver=false, Turnstile mock, auto-login, session injection.

const { ipcRenderer, webFrame } = require('electron');

// ===== POLYFILL SET METHODS (Node < 22 compat) =====
(() => {
    try {
        webFrame.executeJavaScript(`
            (function () {
                try {
                    const define = (name, fn) => {
                        if (!Set.prototype[name]) {
                            Object.defineProperty(Set.prototype, name, {
                                value: fn, configurable: true, writable: true
                            });
                        }
                    };
                    define('difference', function (other) {
                        const r = new Set(this);
                        if (other && other[Symbol.iterator]) for (const v of other) r.delete(v);
                        return r;
                    });
                    define('intersection', function (other) {
                        const r = new Set();
                        if (other && other[Symbol.iterator]) for (const v of other) { if (this.has(v)) r.add(v); }
                        return r;
                    });
                    define('union', function (other) {
                        const r = new Set(this);
                        if (other && other[Symbol.iterator]) for (const v of other) r.add(v);
                        return r;
                    });
                } catch (e) {}
            })();
        `, true);
    } catch (e) {}
})();

// ===== MÍNIMO NECESSÁRIO (MAIN WORLD) =====
// Apenas navigator.webdriver = false e Turnstile mock para CapSolver.
// Tudo o resto fica como o Chromium nativo do Electron.
(() => {
    try {
        webFrame.executeJavaScript(`
            (function() {
                try {
                    // 1. webdriver = false (única marca real de automação que o Chrome expõe)
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });

                    // 2. Turnstile mock → CapSolver
                    // Intercepta turnstile.render() para capturar sitekey e notificar o main process.
                    // Atribuição simples (sem defineProperty) — se o script real do Cloudflare
                    // carregar depois (em Challenge pages), ele sobrescreve o mock naturalmente.
                    window.__mpTurnstileCallback = null;
                    window.__mpTurnstileMock = true;
                    window.turnstile = {
                        render: function(el, opts) {
                            var sitekey = '';
                            if (opts) {
                                sitekey = opts.sitekey || opts.siteKey || opts['site-key'] || '';
                                if (typeof opts.callback === 'function') {
                                    window.__mpTurnstileCallback = opts.callback;
                                }
                            }
                            if (!sitekey && typeof el === 'string') {
                                try {
                                    var elem = document.querySelector(el);
                                    if (elem) sitekey = elem.getAttribute('data-sitekey') || '';
                                } catch(e) {}
                            }
                            if (sitekey) {
                                setTimeout(function() {
                                    document.title = 'MP_TURNSTILE:' + sitekey;
                                }, 500);
                            }
                            return 'capsolver-widget';
                        },
                        reset: function() {},
                        remove: function() {},
                        getResponse: function() { return ''; },
                        isExpired: function() { return false; },
                        execute: function(container, opts) {
                            if (opts && typeof opts.callback === 'function') {
                                window.__mpTurnstileCallback = opts.callback;
                            }
                        }
                    };
                } catch (e) {}
            })();
        `, true);
    } catch (e) {}
})();

// ===== AUTO-LOGIN =====
let autoLoginCredentials = null;
let loginAttempted = false;

function fillField(field, value) {
    if (!field || !value) return false;
    try {
        field.focus();
        field.value = '';
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } catch { return false; }
}

function performAutoLogin() {
    if (!autoLoginCredentials || loginAttempted) return;
    const { usuariodaferramenta, senhadaferramenta } = autoLoginCredentials;
    const emailField =
        document.querySelector('input[id="amember-login"]') ||
        document.querySelector('input[name="amember_login"]') ||
        document.querySelector('input[type="email"]') ||
        document.querySelector('input[placeholder*="Username" i]');
    const passwordField =
        document.querySelector('input[id="amember-pass"]') ||
        document.querySelector('input[name="amember_pass"]') ||
        document.querySelector('input[type="password"]');
    if (emailField && passwordField) {
        const emailOk = fillField(emailField, usuariodaferramenta);
        const passOk = fillField(passwordField, senhadaferramenta);
        if (emailOk && passOk) {
            loginAttempted = true;
            setTimeout(() => {
                const submit = document.querySelector('input[type="submit"]') || document.querySelector('button[type="submit"]');
                if (submit) submit.click();
            }, 300);
        }
    }
}

ipcRenderer.on('set-auto-login-credentials', (event, credentials) => {
    autoLoginCredentials = credentials;
    loginAttempted = false;
    setTimeout(performAutoLogin, 1500);
});

window.addEventListener('load', () => setTimeout(performAutoLogin, 2000));
document.addEventListener('DOMContentLoaded', () => setTimeout(performAutoLogin, 1000));

// ===== INJEÇÃO DE SESSÃO =====
ipcRenderer.on('inject-session-data', (event, sessionData) => {
    try {
        if (sessionData && typeof sessionData === 'object') {
            if (sessionData.localStorage) {
                for (const [key, value] of Object.entries(sessionData.localStorage)) {
                    window.localStorage.setItem(key, value);
                }
            }
            if (sessionData.sessionStorage) {
                for (const [key, value] of Object.entries(sessionData.sessionStorage)) {
                    window.sessionStorage.setItem(key, value);
                }
            }
        }
    } catch (err) {
        console.error('[PRELOAD] Erro ao injetar sessão:', err);
    }
});

ipcRenderer.send('request-session-data');
