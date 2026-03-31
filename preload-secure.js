/* eslint-disable no-undef */
// preload-secure.js — VERSÃO ANTI-DETECÇÃO AVANÇADA v2
// Responsabilidades: polyfills, anti-detecção completa, auto-login, injeção de sessão.

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
                } catch (e) {}
            })();
        `, true);
    } catch (e) {}
})();

// ===== ANTI-DETECÇÃO AVANÇADA (MAIN WORLD) =====
(() => {
    try {
        webFrame.executeJavaScript(`
            (function() {
                try {
                    // 1. webdriver = false
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });

                    // 2. Plugins Chrome-like
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => {
                            var p = [
                                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
                                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
                                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
                            ];
                            p.namedItem = function(name) { return this.find(function(x) { return x.name === name; }) || null; };
                            p.item = function(i) { return this[i] || null; };
                            p.refresh = function() {};
                            return p;
                        },
                    });

                    // 3. Permissions query
                    var origQuery = navigator.permissions.query.bind(navigator.permissions);
                    navigator.permissions.query = function(params) {
                        if (params.name === 'notifications') {
                            return Promise.resolve({ state: Notification.permission });
                        }
                        return origQuery(params);
                    };

                    // 4. chrome.runtime / csi / loadTimes / app
                    if (!window.chrome) window.chrome = {};
                    if (!window.chrome.runtime) {
                        window.chrome.runtime = {
                            connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, onDisconnect: { addListener: function() {} } }; },
                            sendMessage: function(msg, cb) { if (cb) cb(); },
                            id: undefined,
                            getManifest: function() { return {}; },
                            getURL: function() { return ''; },
                            onConnect: { addListener: function() {} },
                            onMessage: { addListener: function() {} }
                        };
                    }
                    if (!window.chrome.csi) window.chrome.csi = function() {
                        return { startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 1000, tran: 15 };
                    };
                    if (!window.chrome.loadTimes) window.chrome.loadTimes = function() {
                        return {
                            commitLoadTime: Date.now() / 1000, connectionInfo: 'h2',
                            finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000,
                            firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000,
                            navigationType: 'Other', npnNegotiatedProtocol: 'h2',
                            requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000,
                            wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true
                        };
                    };
                    if (!window.chrome.app) {
                        window.chrome.app = {
                            isInstalled: false,
                            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
                            getDetails: function() { return null; }, getIsInstalled: function() { return false; }
                        };
                    }

                    // 5. navigator.userAgentData
                    var uaVersion = (navigator.userAgent.match(/Chrome\\/([\\d]+)/) || ['', '146'])[1];
                    Object.defineProperty(navigator, 'userAgentData', {
                        get: function() {
                            return {
                                brands: [
                                    { brand: 'Google Chrome', version: uaVersion },
                                    { brand: 'Chromium', version: uaVersion },
                                    { brand: 'Not_A Brand', version: '24' }
                                ],
                                mobile: false,
                                platform: navigator.platform.includes('Mac') ? 'macOS' : 'Windows',
                                getHighEntropyValues: function() {
                                    return Promise.resolve({
                                        brands: this.brands, mobile: false, bitness: '64',
                                        platform: this.platform, platformVersion: '15.0.0',
                                        architecture: 'x86', model: '',
                                        uaFullVersion: uaVersion + '.0.0.0',
                                        fullVersionList: [
                                            { brand: 'Google Chrome', version: uaVersion + '.0.0.0' },
                                            { brand: 'Chromium', version: uaVersion + '.0.0.0' },
                                            { brand: 'Not_A Brand', version: '24.0.0.0' }
                                        ]
                                    });
                                },
                                toJSON: function() { return { brands: this.brands, mobile: false, platform: this.platform }; }
                            };
                        }, configurable: true
                    });

                    // 6. Limpar User Agent
                    var cleanUA = navigator.userAgent.replace(/Electron\\/[\\d.]+ /, '').replace(/multiprime-v6\\/[\\d.]+ /, '');
                    Object.defineProperty(navigator, 'userAgent', { get: function() { return cleanUA; } });
                    Object.defineProperty(navigator, 'appVersion', { get: function() { return cleanUA.replace('Mozilla/', ''); } });

                    // 7. Languages
                    Object.defineProperty(navigator, 'languages', { get: function() { return ['pt-BR', 'pt', 'en-US', 'en']; }, configurable: true });

                    // 8. Connection
                    if (!navigator.connection) {
                        Object.defineProperty(navigator, 'connection', {
                            get: function() { return { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false, onchange: null, addEventListener: function(){}, removeEventListener: function(){} }; }
                        });
                    }

                    // 9. Remover sinais de automação
                    ['__nightmare','_phantom','callPhantom','__selenium_unwrapped','__webdriver_evaluate',
                     '__driver_evaluate','__webdriver_unwrapped','__fxdriver_evaluate','__fxdriver_unwrapped',
                     'domAutomation','domAutomationController','_Selenium_IDE_Recorder'
                    ].forEach(function(p) { try { delete window[p]; } catch(e){} try { delete document[p]; } catch(e){} });

                    // 10. Canvas fingerprint noise
                    (function() {
                        var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
                        var origToBlob = HTMLCanvasElement.prototype.toBlob;
                        var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
                        function addNoise(imgData) {
                            var d = imgData.data;
                            for (var i = 0; i < d.length; i += 4) {
                                if (Math.random() < 0.1) d[i] = d[i] ^ 1;
                            }
                            return imgData;
                        }
                        HTMLCanvasElement.prototype.toDataURL = function() {
                            try {
                                var ctx = this.getContext('2d');
                                if (ctx && this.width > 16 && this.height > 16) {
                                    var img = origGetImageData.call(ctx, 0, 0, this.width, this.height);
                                    addNoise(img); ctx.putImageData(img, 0, 0);
                                }
                            } catch(e) {}
                            return origToDataURL.apply(this, arguments);
                        };
                        HTMLCanvasElement.prototype.toBlob = function() {
                            try {
                                var ctx = this.getContext('2d');
                                if (ctx && this.width > 16 && this.height > 16) {
                                    var img = origGetImageData.call(ctx, 0, 0, this.width, this.height);
                                    addNoise(img); ctx.putImageData(img, 0, 0);
                                }
                            } catch(e) {}
                            return origToBlob.apply(this, arguments);
                        };
                    })();

                    // 11. WebGL Vendor/Renderer spoofing
                    (function() {
                        var origGetParam = WebGLRenderingContext.prototype.getParameter;
                        var VENDOR = 0x9245, RENDERER = 0x9246;
                        function spoof(orig) {
                            return function(p) {
                                if (p === VENDOR) return 'Google Inc. (NVIDIA)';
                                if (p === RENDERER) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                                return orig.call(this, p);
                            };
                        }
                        WebGLRenderingContext.prototype.getParameter = spoof(origGetParam);
                        try { WebGL2RenderingContext.prototype.getParameter = spoof(WebGL2RenderingContext.prototype.getParameter); } catch(e) {}
                    })();

                    // 12. Notification
                    if (!window.Notification) {
                        window.Notification = function() {};
                        window.Notification.permission = 'default';
                        window.Notification.requestPermission = function() { return Promise.resolve('default'); };
                    }

                    // 13. Screen consistency
                    if (screen.availWidth === 0) {
                        Object.defineProperty(screen, 'availWidth', { get: function() { return screen.width; } });
                        Object.defineProperty(screen, 'availHeight', { get: function() { return screen.height - 40; } });
                    }

                    // 14. Turnstile mock → CapSolver
                    // Captura sitekey e callback, sinaliza main process via título,
                    // main process resolve via CapSolver e injeta o token
                    window.__mpTurnstileCallback = null;
                    var tsMock = {
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
                                // Sinalizar main process
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
                    Object.defineProperty(window, 'turnstile', {
                        get: function() { return tsMock; },
                        set: function() {},
                        configurable: false
                    });

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