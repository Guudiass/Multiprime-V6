/* eslint-disable no-undef */
// preload-secure.js — VERSÃO LIMPA
// Este arquivo roda APENAS no BrowserView (conteúdo web).
// NÃO injeta toolbar, NÃO manipula CSS, NÃO mexe no DOM do site.
// Responsabilidades: polyfills, anti-detecção, auto-login, injeção de sessão.

const { ipcRenderer, webFrame } = require('electron');

// ===== POLYFILL SET METHODS =====
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
                } catch (e) {
                    console.error('[SET POLYFILL] Erro:', e);
                }
            })();
        `, true);
    } catch (e) {
        console.error('[SET POLYFILL] Erro fatal:', e);
    }
})();

// ===== ANTI-DETECÇÃO (injetado no MAIN WORLD via webFrame) =====
// Com contextIsolation: true, Object.defineProperty no preload NÃO afeta o site.
// Precisa injetar no main world para o site enxergar as mudanças.
(() => {
    try {
        webFrame.executeJavaScript(`
            (function() {
                try {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });

                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [
                            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
                        ],
                    });

                    var origQuery = navigator.permissions.query.bind(navigator.permissions);
                    navigator.permissions.query = function(params) {
                        if (params.name === 'notifications') {
                            return Promise.resolve({ state: Notification.permission });
                        }
                        return origQuery(params);
                    };

                    console.log('[ANTI-DETECT] Camuflagem aplicada no main world');
                } catch (e) {
                    console.error('[ANTI-DETECT] Erro:', e);
                }
            })();
        `, true);
    } catch (e) {
        console.error('[ANTI-DETECT] Erro fatal:', e);
    }
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

console.log('[PRELOAD-SECURE] Carregado.');
