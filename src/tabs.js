/* eslint-disable no-undef */
// src/tabs.js — Sistema de abas (janela, criação, ativação, fechamento)

const { BrowserWindow, BrowserView } = require('electron');
const path = require('path');
const state = require('./state');
const { CONFIG, IS_DEV } = require('./config');
const { updateViewBounds, getViewBounds, injectSiteFixes } = require('./utils');
const { sendToLovable, logEvent, startHeartbeat, stopHeartbeat } = require('./status');
const { solveTurnstile } = require('./capsolver');
const { setupDownloadManager } = require('./downloads');

/**
 * Cria a janela principal com toolbar (chamada apenas 1 vez, na 1a aba).
 */
function createBrowserWindow() {
    const win = new BrowserWindow({
        ...CONFIG.WINDOW_DEFAULTS,
        frame: false,
        show: false,
        backgroundColor: state.currentTema === 'dark' ? '#181818' : '#f5f5f5',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload-toolbar.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: IS_DEV
        }
    });

    win.loadFile(path.join(__dirname, '..', 'toolbar.html'));

    win.webContents.once('did-finish-load', () => {
        win.webContents.send('theme-changed', state.currentTema);
    });

    const onResize = () => {
        if (!win.isDestroyed()) {
            updateViewBounds();
            const tab = state.activeTabId ? state.tabs.get(state.activeTabId) : null;
            if (tab && !tab.view.webContents.isDestroyed()) {
                setTimeout(() => {
                    tab.view.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
                }, 100);
            }
        }
    };
    win.on('resize', onResize);
    win.on('maximize', () => setTimeout(onResize, 50));
    win.on('unmaximize', () => setTimeout(onResize, 50));

    win.webContents.on('before-input-event', (event, input) => {
        handleTabShortcut(event, input);
    });

    let isExportingOnClose = false;
    win.on('close', (e) => {
        const allTabs = Array.from(state.tabs.values());

        // SO exporta tabs com tokenRotation=true (sites como Higgsfield)
        // Outros sites: confiam apenas no gatilho 4h ao abrir
        const tabsToExport = allTabs.filter(t =>
            !t._closing && t.perfil?.ftp && t.perfil?.senha && t.perfil?.tokenRotation === true
        );

        if (!isExportingOnClose && tabsToExport.length > 0 && state.autoExportSession) {
            e.preventDefault();
            isExportingOnClose = true;

            for (const t of allTabs) t._closing = true;

            try { win.hide(); } catch {}

            try {
                for (const t of allTabs) {
                    sendToLovable('mp-tab-closed', { tabId: t.tabId, perfilId: t.perfil?.id });
                }
                sendToLovable('mp-app-closing', { tabCount: allTabs.length, timestamp: Date.now() });
            } catch {}

            (async () => {
                for (const t of tabsToExport) {
                    try {
                        if (t.view && t.view.webContents && !t.view.webContents.isDestroyed()) {
                            await state.autoExportSession({ view: t.view, perfil: t.perfil });
                        }
                    } catch (err) {
                        console.error(`[AUTO-EXPORT] Erro em ${t.perfil?.ftp}:`, err.message);
                    }
                }
            })().finally(() => {
                if (!win.isDestroyed()) {
                    try { win.destroy(); } catch {}
                }
            });

            setTimeout(() => {
                if (!win.isDestroyed()) {
                    try { win.destroy(); } catch {}
                }
            }, 30000);
            return;
        }

        // Sem tabs para exportar (todas dentro do throttle): fecha imediato
        try {
            for (const t of allTabs) {
                sendToLovable('mp-tab-closed', { tabId: t.tabId, perfilId: t.perfil?.id });
            }
            sendToLovable('mp-app-closing', { tabCount: allTabs.length, timestamp: Date.now() });
        } catch {}
    });

    win.on('closed', () => {
        // Cleanup robusto — pode ser chamado mesmo se ja foi limpo
        try {
            for (const [, tab] of state.tabs) {
                try {
                    if (tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
                        const viewId = tab.view.webContents.id;
                        state.proxyCredentials.delete(viewId);
                        state.proxyFallbackState.delete(viewId);
                        for (const [key] of state.proxyAuthAttempts) {
                            if (key.startsWith(`${viewId}-`)) state.proxyAuthAttempts.delete(key);
                        }
                    }
                } catch {}
            }
        } catch {}
        state.tabs.clear();
        state.perfilIdToTab.clear();
        state.activeTabId = null;
        state.browserWindow = null;
        stopHeartbeat();
    });

    win.setMaxListeners(50); // Suportar muitas abas sem warning
    win.once('ready-to-show', () => win.show());

    state.browserWindow = win;
    startHeartbeat();
    return win;
}

/**
 * Atalhos de teclado para abas.
 */
function handleTabShortcut(event, input) {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (!ctrl) return;

    const tabIds = Array.from(state.tabs.keys());
    if (tabIds.length === 0) return;

    if (input.key === 'w' || input.key === 'W') {
        event.preventDefault();
        if (state.activeTabId) closeTab(state.activeTabId);
    } else if (input.key === 'Tab') {
        event.preventDefault();
        const idx = tabIds.indexOf(state.activeTabId);
        const next = input.shift
            ? (idx - 1 + tabIds.length) % tabIds.length
            : (idx + 1) % tabIds.length;
        activateTab(tabIds[next]);
    } else if (input.key >= '1' && input.key <= '9') {
        event.preventDefault();
        const n = parseInt(input.key);
        const target = n === 9 ? tabIds.length - 1 : n - 1;
        if (target < tabIds.length) activateTab(tabIds[target]);
    } else if (input.key === 't' || input.key === 'T' || input.key === 'n' || input.key === 'N') {
        event.preventDefault();
    }
}

/**
 * Cria uma nova aba com BrowserView isolada.
 */
function createTab(perfil, isolatedSession, storageData) {
    const tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const view = new BrowserView({
        webPreferences: {
            session: isolatedSession,
            preload: path.join(__dirname, '..', 'preload-secure.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            devTools: IS_DEV
        }
    });

    const tabEntry = {
        tabId,
        view,
        session: isolatedSession,
        perfil,
        downloadsPanelOpen: false,
        title: perfil.link ? new URL(perfil.link).hostname : 'Nova aba',
        url: perfil.link || '',
        isLoading: true
    };

    state.tabs.set(tabId, tabEntry);
    if (perfil.id) state.perfilIdToTab.set(perfil.id, tabId);

    const forceViewportRecalc = () => {
        if (view.webContents && !view.webContents.isDestroyed()) {
            view.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
        }
    };

    const sendToToolbar = (channel, data) => {
        if (state.browserWindow && !state.browserWindow.isDestroyed()) {
            state.browserWindow.webContents.send(channel, data);
        }
    };

    const updateTabInfo = (url, title) => {
        if (url) tabEntry.url = url;
        if (title) tabEntry.title = title;
        sendToToolbar('tab-updated', { tabId, title: tabEntry.title, favicon: tabEntry.favicon, url: tabEntry.url });
        if (state.activeTabId === tabId) {
            sendToToolbar('url-updated', tabEntry.url);
        }
    };

    view.webContents.on('did-navigate', (e, url) => {
        updateTabInfo(url, null);
        sendToLovable('mp-navigation', { tabId, perfilId: perfil.id, url, title: tabEntry.title, timestamp: Date.now() });
    });
    view.webContents.on('did-navigate-in-page', (e, url) => updateTabInfo(url, null));

    // Titulo + Turnstile
    let turnstileSolving = false;
    const turnstileSolved = new Map();
    const turnstileAttempts = new Map(); // url → count (limitar tentativas)
    const MAX_TURNSTILE_ATTEMPTS = 2;

    view.webContents.on('page-title-updated', (e, title) => {
        if (title.startsWith('MP_TURNSTILE:') && !turnstileSolving) {
            e.preventDefault();
            const sitekey = title.substring('MP_TURNSTILE:'.length);
            if (!sitekey) return;

            const pageUrl = view.webContents.getURL().split('#')[0];
            const lastSolved = turnstileSolved.get(pageUrl);
            if (lastSolved && Date.now() - lastSolved < 30000) return;

            // Limitar tentativas para evitar loop infinito e gasto de creditos
            const attempts = turnstileAttempts.get(pageUrl) || 0;
            if (attempts >= MAX_TURNSTILE_ATTEMPTS) {
                console.warn(`[CAPSOLVER] ⚠️ Máximo de ${MAX_TURNSTILE_ATTEMPTS} tentativas para ${pageUrl}. Parando.`);
                logEvent('turnstile_max_attempts', { tabId, perfilId: perfil.id, url: pageUrl, attempts });
                return;
            }
            turnstileAttempts.set(pageUrl, attempts + 1);

            turnstileSolving = true;
            const solveStart = Date.now();
            logEvent('turnstile_solving', { tabId, perfilId: perfil.id, url: pageUrl, sitekey });

            solveTurnstile(pageUrl, sitekey, perfil.proxy).then(result => {
                turnstileSolving = false;
                if (result && view.webContents && !view.webContents.isDestroyed()) {
                    logEvent('turnstile_solved', { tabId, perfilId: perfil.id, url: pageUrl, tempoMs: Date.now() - solveStart, method: result.type });
                    turnstileSolved.set(pageUrl, Date.now());
                    reloadTracker.clear();

                    if (result.type === 'token') {
                        // Turnstile: injetar token via callback
                        view.webContents.executeJavaScript(`
                            if (window.__mpTurnstileCallback) {
                                window.__mpTurnstileCallback('${result.token.replace(/'/g, "\\'")}');
                            }
                        `).catch(() => {});
                        setTimeout(() => {
                            if (!view.webContents.isDestroyed()) {
                                reloadTracker.clear();
                                view.webContents.reload();
                            }
                        }, 2000);
                    } else if (result.type === 'cf_clearance') {
                        // Challenge: injetar cf_clearance cookie e recarregar
                        const domain = new URL(pageUrl).hostname;
                        isolatedSession.cookies.set({
                            url: pageUrl,
                            name: 'cf_clearance',
                            value: result.cfClearance,
                            domain: '.' + domain,
                            path: '/',
                            secure: true,
                            httpOnly: true,
                            sameSite: 'no_restriction'
                        }).then(() => {
                            // Atualizar UA se o CapSolver retornou um
                            if (result.userAgent) {
                                isolatedSession.setUserAgent(result.userAgent);
                            }
                            if (!view.webContents.isDestroyed()) {
                                reloadTracker.clear();
                                view.webContents.reload();
                            }
                        }).catch(err => {
                            console.error('[CAPSOLVER] Erro ao injetar cf_clearance:', err.message);
                        });
                    }
                } else {
                    logEvent('turnstile_failed', { tabId, perfilId: perfil.id, url: pageUrl, tempoMs: Date.now() - solveStart });
                }
            });
            return;
        }
        updateTabInfo(null, title);
    });

    // Favicon
    view.webContents.on('page-favicon-updated', (e, favicons) => {
        if (favicons && favicons.length > 0) {
            tabEntry.favicon = favicons[0];
            sendToToolbar('tab-updated', { tabId, title: tabEntry.title, favicon: tabEntry.favicon, url: tabEntry.url });
        }
    });

    // Loading
    view.webContents.on('did-start-loading', () => {
        tabEntry.isLoading = true;
        if (state.activeTabId === tabId) sendToToolbar('page-loading', true);
        sendToToolbar('tab-loading', { tabId, isLoading: true });
        sendToLovable('mp-tab-status', { tabId, perfilId: perfil.id, url: tabEntry.url, title: tabEntry.title, isLoading: true });
    });
    view.webContents.on('did-stop-loading', () => {
        tabEntry.isLoading = false;
        if (state.activeTabId === tabId) sendToToolbar('page-loading', false);
        sendToToolbar('tab-loading', { tabId, isLoading: false });
        sendToLovable('mp-tab-status', { tabId, perfilId: perfil.id, url: tabEntry.url, title: tabEntry.title, isLoading: false });
    });
    view.webContents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
        if (isMainFrame && state.activeTabId === tabId) sendToToolbar('page-loading', true);
    });

    // Viewport + site fixes + AUTO-RELOAD 403 UNIFICADO
    // Unica solucao: detectar pagina de erro apos CADA navegacao e recarregar automaticamente.
    // Funciona para TODOS os tipos de 403: HTTP status, HTML body, redirect bloqueado, etc.
    const autoReloadAttempts = new Map(); // urlBase → tentativas
    const MAX_AUTO_RELOAD = 2; // max 2 reloads por URL

    async function checkAndReload403() {
        if (!view.webContents || view.webContents.isDestroyed()) return;
        try {
            const check = await view.webContents.executeJavaScript(`
                (function() {
                    var t = (document.title || '').toLowerCase();
                    var b = (document.body ? document.body.innerText : '').substring(0, 1000);
                    var bl = b.toLowerCase();
                    var url = window.location.href;

                    var blocked = false;
                    var reason = '';

                    // 1. Titulo com erro
                    if (t.indexOf('403') !== -1 || t === 'forbidden' || t.indexOf('access denied') !== -1 || t.indexOf('error') !== -1 && t.indexOf('403') !== -1) {
                        blocked = true; reason = 'title:' + t;
                    }

                    // 2. Body so tem "403" (ChatGPT retorna pagina com so "403" no body)
                    if (!blocked && b.trim() === '403') {
                        blocked = true; reason = 'body-only-403';
                    }

                    // 3. Body curto (< 200 chars) com indicadores de bloqueio
                    if (!blocked && b.length < 200) {
                        if (bl.indexOf('403') !== -1 || bl.indexOf('forbidden') !== -1 || bl.indexOf('access denied') !== -1 || bl.indexOf('blocked') !== -1) {
                            blocked = true; reason = 'short-body-blocked';
                        }
                    }

                    // 4. Pagina do Freepik com "ERROR" e "Access denied"
                    if (!blocked && bl.indexOf('access denied') !== -1 && bl.indexOf('you don') !== -1 && bl.indexOf('permission') !== -1) {
                        blocked = true; reason = 'access-denied-page';
                    }

                    // 5. URL com bm-verify (bot management redirect do Freepik)
                    if (!blocked && url.indexOf('bm-verify=') !== -1 && bl.indexOf('403') !== -1) {
                        blocked = true; reason = 'bm-verify-403';
                    }

                    // 6. Pagina Cloudflare Challenge que ficou presa
                    if (!blocked && (bl.indexOf('just a moment') !== -1 || bl.indexOf('verificação de segurança') !== -1 || bl.indexOf('checking') !== -1 && bl.indexOf('browser') !== -1) && b.length < 500) {
                        blocked = true; reason = 'cloudflare-stuck';
                    }

                    return { blocked: blocked, reason: reason, url: url, title: t.substring(0, 50), bodyLen: b.length };
                })();
            `);

            if (check && check.blocked) {
                const urlKey = check.url.split('?')[0].split('#')[0];
                const attempts = autoReloadAttempts.get(urlKey) || 0;

                if (attempts < MAX_AUTO_RELOAD) {
                    autoReloadAttempts.set(urlKey, attempts + 1);
                    console.warn('[AUTO-RELOAD] ' + (attempts + 1) + '/' + MAX_AUTO_RELOAD + ' | ' + check.reason + ' | ' + check.url.substring(0, 80));
                    setTimeout(() => {
                        if (!view.webContents.isDestroyed()) view.webContents.reload();
                    }, 1000 + (attempts * 500));
                } else {
                    console.warn('[AUTO-RELOAD] Max tentativas atingido para: ' + urlKey.substring(0, 60));
                }
            } else if (check) {
                // Pagina carregou OK — resetar tentativas para esta URL
                const urlKey = check.url.split('?')[0].split('#')[0];
                autoReloadAttempts.delete(urlKey);
            }
        } catch {}
    }

    view.webContents.on('did-finish-load', () => {
        setTimeout(forceViewportRecalc, 300);
        setTimeout(forceViewportRecalc, 1000);
        injectSiteFixes(view.webContents);
        // Checar 403 apos 1s (tempo pro DOM renderizar)
        setTimeout(checkAndReload403, 1000);
    });

    view.webContents.on('did-navigate', () => {
        setTimeout(() => injectSiteFixes(view.webContents), 500);
        // Tambem checar apos navegacao SPA
        setTimeout(checkAndReload403, 1500);
    });

    view.webContents.on('did-navigate-in-page', () => {
        // Checar mesmo em navegacao in-page (SPA routing)
        setTimeout(checkAndReload403, 1500);
    });

    view.webContents.on('did-fail-load', (event, errorCode, desc, url, isMainFrame) => {
        if (errorCode === -3) return;
        if (isMainFrame && state.activeTabId === tabId) sendToToolbar('page-loading', false);
    });

    // Auto-retry em 403/503 e headers sec-fetch sao tratados em ipc-handlers.js
    // via isolatedSession.webRequest.onBeforeSendHeaders + onHeadersReceived

    // Crash recovery
    view.webContents.on('render-process-gone', () => {
        logEvent('tab_crashed', { tabId, perfilId: perfil.id, url: tabEntry.url });
        setTimeout(() => {
            if (!view.webContents.isDestroyed()) view.webContents.reload();
        }, 1000);
    });

    // Anti-reload-loop
    const reloadTracker = new Map();
    view.webContents.on('will-navigate', (event, url) => {
        if (view.webContents.isDestroyed()) return;
        const cleanCurrent = view.webContents.getURL().split('#')[0];
        const cleanNew = url.split('#')[0];
        if (cleanCurrent === cleanNew) {
            const now = Date.now();
            const tracker = reloadTracker.get(cleanNew) || { count: 0, firstTime: now };
            if (now - tracker.firstTime > 15000) { tracker.count = 0; tracker.firstTime = now; }
            tracker.count++;
            reloadTracker.set(cleanNew, tracker);
            if (tracker.count > 2) { event.preventDefault(); return; }
        } else {
            reloadTracker.clear();
        }
    });

    view.webContents.on('unresponsive', () => {});
    view.webContents.on('responsive', () => {});

    // Popups
    view.webContents.setWindowOpenHandler(({ url }) => {
        if (!url || url === 'about:blank' || url.startsWith('blob:') || url.startsWith('javascript:')) {
            return { action: 'deny' };
        }
        try {
            const currentHost = new URL(view.webContents.getURL()).hostname;
            const popupHost = new URL(url).hostname;
            if (currentHost === popupHost || popupHost.endsWith('.' + currentHost) || currentHost.endsWith('.' + popupHost)) {
                view.webContents.loadURL(url);
                return { action: 'deny' };
            }
        } catch {}

        const { screen } = require('electron');
        const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
        const popW = Math.min(1200, Math.round(screenW * 0.8));
        const popH = Math.min(850, Math.round(screenH * 0.85));
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                x: Math.round((screenW - popW) / 2), y: Math.round((screenH - popH) / 2),
                width: popW, height: popH, minWidth: 500, minHeight: 400,
                modal: false, show: true, autoHideMenuBar: true, frame: true,
                webPreferences: { session: isolatedSession, contextIsolation: true, nodeIntegration: false, devTools: IS_DEV }
            }
        };
    });

    view.webContents.on('did-create-window', (popupWindow) => {
        const onWillDownload = () => {
            setTimeout(() => { if (!popupWindow.isDestroyed()) popupWindow.close(); }, 2000);
        };
        isolatedSession.on('will-download', onWillDownload);
        popupWindow.on('closed', () => isolatedSession.removeListener('will-download', onWillDownload));
        popupWindow.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
            if (popupUrl && popupUrl !== 'about:blank' && !popupUrl.startsWith('javascript:')) {
                popupWindow.webContents.loadURL(popupUrl);
            }
            return { action: 'deny' };
        });
        setTimeout(() => {
            if (!popupWindow.isDestroyed()) {
                const u = popupWindow.webContents.getURL();
                if (u === 'about:blank' || u === '') {
                    popupWindow.webContents.executeJavaScript('document.body?.innerHTML?.length || 0')
                        .then(len => { if (len < 10 && !popupWindow.isDestroyed()) popupWindow.close(); })
                        .catch(() => {});
                }
            }
        }, 5000);
    });

    // Auto-login
    if (perfil.usuariodaferramenta && perfil.senhadaferramenta) {
        const sendCredentials = () => {
            if (!view.webContents.isDestroyed()) {
                view.webContents.send('set-auto-login-credentials', {
                    usuariodaferramenta: perfil.usuariodaferramenta,
                    senhadaferramenta: perfil.senhadaferramenta
                });
            }
        };
        view.webContents.once('did-finish-load', sendCredentials);
        view.webContents.on('did-navigate', sendCredentials);
    }

    // Session data injection (apos primeiro request do preload)
    view.webContents.ipc.once('request-session-data', (e) => {
        e.sender.send('inject-session-data', storageData);
    });
    view.webContents.ipc.once('get-initial-session-data', (e) => {
        e.returnValue = storageData || null;
    });

    // FORCA injecao de localStorage/sessionStorage/IndexedDB via executeJavaScript
    let storageInjected = false;
    const injectStorageForced = async () => {
        if (storageInjected) return; // so injeta uma vez por aba
        if (!storageData || !view.webContents || view.webContents.isDestroyed()) return;
        if (!storageData.localStorage && !storageData.sessionStorage && !storageData.indexedDB) return;

        try {
            const ls = JSON.stringify(storageData.localStorage || {});
            const ss = JSON.stringify(storageData.sessionStorage || {});
            const idb = JSON.stringify(storageData.indexedDB || {});

            await view.webContents.executeJavaScript(`
                (async function() {
                    try {
                        var ls = ${ls};
                        var ss = ${ss};
                        var idb = ${idb};

                        // localStorage (sempre sobrescreve — garante dados frescos)
                        for (var k in ls) {
                            try { localStorage.setItem(k, ls[k]); } catch(e) {}
                        }
                        // sessionStorage
                        for (var k in ss) {
                            try { sessionStorage.setItem(k, ss[k]); } catch(e) {}
                        }

                        // IndexedDB — restaurar DBs e object stores
                        for (var dbName in idb) {
                            try {
                                var dbData = idb[dbName];
                                var dbVersion = dbData.version || 1;
                                await new Promise(function(resolve) {
                                    var req = indexedDB.open(dbName, dbVersion);
                                    req.onupgradeneeded = function(e) {
                                        var db = e.target.result;
                                        for (var storeName in dbData.stores) {
                                            if (!db.objectStoreNames.contains(storeName)) {
                                                var storeOpts = dbData.stores[storeName];
                                                try {
                                                    db.createObjectStore(storeName, {
                                                        keyPath: storeOpts.keyPath,
                                                        autoIncrement: storeOpts.autoIncrement || false
                                                    });
                                                } catch(e) {}
                                            }
                                        }
                                    };
                                    req.onsuccess = function() {
                                        var db = req.result;
                                        try {
                                            var storeNames = Array.from(db.objectStoreNames);
                                            if (storeNames.length === 0) { db.close(); resolve(); return; }
                                            var tx = db.transaction(storeNames, 'readwrite');
                                            var pending = 0;
                                            for (var i = 0; i < storeNames.length; i++) {
                                                (function(storeName) {
                                                    var storeData = dbData.stores[storeName];
                                                    if (!storeData || !storeData.entries) return;
                                                    try {
                                                        var store = tx.objectStore(storeName);
                                                        for (var j = 0; j < storeData.entries.length; j++) {
                                                            pending++;
                                                            var entry = storeData.entries[j];
                                                            var putReq = store.put(entry.value, entry.key);
                                                            putReq.onsuccess = putReq.onerror = function() {
                                                                pending--;
                                                            };
                                                        }
                                                    } catch(e) {}
                                                })(storeNames[i]);
                                            }
                                            tx.oncomplete = function() { db.close(); resolve(); };
                                            tx.onerror = function() { db.close(); resolve(); };
                                            setTimeout(function() { try { db.close(); } catch(e) {} resolve(); }, 5000);
                                        } catch(e) {
                                            try { db.close(); } catch(ee) {}
                                            resolve();
                                        }
                                    };
                                    req.onerror = function() { resolve(); };
                                    setTimeout(resolve, 5000);
                                });
                            } catch(e) {}
                        }
                    } catch(e) {}
                })();
            `);
            storageInjected = true;
        } catch {}
    };

    view.webContents.on('dom-ready', injectStorageForced);
    view.webContents.on('did-finish-load', injectStorageForced);

    // Downloads
    setupDownloadManager(view, isolatedSession);

    // Atalhos na view
    view.webContents.on('before-input-event', (event, input) => {
        handleTabShortcut(event, input);
        if (IS_DEV && input.key === 'F12' && input.type === 'keyDown') {
            event.preventDefault();
            if (!view.webContents.isDestroyed()) view.webContents.openDevTools({ mode: 'detach' });
        }
    });

    // Notificar toolbar e Lovable
    const isWarming = perfil?.tokenRotation === true;
    tabEntry._warming = isWarming;

    sendToToolbar('tab-added', {
        tabId,
        title: isWarming ? 'Preparando sessao...' : tabEntry.title,
        favicon: null,
        isActive: true,
        userGroup: perfil.userGroup || null
    });
    sendToLovable('mp-tab-opened', { tabId, perfilId: perfil.id, url: perfil.link, title: tabEntry.title });

    if (!isWarming) {
        activateTab(tabId);
    } else {
        // Cria view de SPLASH visivel enquanto a view real faz pre-aquecimento oculto
        const splashView = new BrowserView({
            webPreferences: { contextIsolation: true, nodeIntegration: false }
        });
        const isDark = state.currentTema === 'dark';
        const bgColor = isDark ? '#181818' : '#f5f5f5';
        const textColor = isDark ? '#ecf0f1' : '#1a1a1a';
        const accentColor = '#3b82f6';
        const splashHtml = `
            <html>
            <head>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    html, body {
                        width: 100%; height: 100%;
                        background: ${bgColor}; color: ${textColor};
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                        display: flex; align-items: center; justify-content: center;
                        flex-direction: column; gap: 20px;
                        overflow: hidden;
                    }
                    .spinner {
                        width: 48px; height: 48px;
                        border: 3px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
                        border-top-color: ${accentColor};
                        border-radius: 50%;
                        animation: spin 0.8s linear infinite;
                    }
                    .title { font-size: 16px; font-weight: 500; opacity: 0.9; }
                    .subtitle { font-size: 13px; opacity: 0.5; }
                    @keyframes spin { to { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="spinner"></div>
                <div class="title">Preparando sessao</div>
                <div class="subtitle">${(perfil.link ? new URL(perfil.link).hostname : 'Carregando')}</div>
            </body>
            </html>
        `;
        splashView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml));
        tabEntry._splashView = splashView;

        // Mostrar a splash no lugar da view real
        if (state.browserWindow && !state.browserWindow.isDestroyed()) {
            state.activeTabId = tabId;
            state.browserWindow.setBrowserView(splashView);
            const { getViewBounds } = require('./utils');
            splashView.setBounds(getViewBounds(state.browserWindow, false));
            splashView.setAutoResize({ width: true, height: true });
            // Notificar toolbar que a aba esta ativa visualmente
            state.browserWindow.webContents.send('tab-activated', { tabId });
            state.browserWindow.webContents.send('url-updated', perfil.link || '');
            state.browserWindow.webContents.send('page-loading', true);
        }

        // View real fica oculta
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }

    // Restaurar e focar a janela para o usuario ver que a ferramenta abriu
    if (state.browserWindow && !state.browserWindow.isDestroyed()) {
        if (state.browserWindow.isMinimized()) state.browserWindow.restore();
        state.browserWindow.show();
        state.browserWindow.focus();
    }

    return tabEntry;
}

/**
 * Ativa uma aba (mostra sua BrowserView).
 * Se a aba tinha splash de pre-aquecimento, destroi a splash e mostra a view real.
 */
function activateTab(tabId) {
    const tab = state.tabs.get(tabId);
    if (!tab || !state.browserWindow || state.browserWindow.isDestroyed()) return;

    state.activeTabId = tabId;

    // Limpar splash de pre-aquecimento se existir (transicao warming → ready)
    if (tab._splashView) {
        try {
            state.browserWindow.removeBrowserView(tab._splashView);
        } catch {}
        try {
            if (tab._splashView.webContents && !tab._splashView.webContents.isDestroyed()) {
                tab._splashView.webContents.destroy();
            }
        } catch {}
        tab._splashView = null;
        tab._warming = false;

        // Atualizar titulo na toolbar (estava "Preparando sessao...")
        try {
            const realTitle = tab.title || (tab.url ? new URL(tab.url).hostname : 'Aba');
            state.browserWindow.webContents.send('tab-updated', {
                tabId, title: realTitle, favicon: tab.favicon, url: tab.url
            });
        } catch {}
    }

    state.browserWindow.setBrowserView(tab.view);
    tab.view.setBounds(getViewBounds(state.browserWindow, tab.downloadsPanelOpen));
    tab.view.setAutoResize({ width: !tab.downloadsPanelOpen, height: true, horizontal: false, vertical: false });

    state.browserWindow.webContents.send('tab-activated', { tabId });
    state.browserWindow.webContents.send('url-updated', tab.url || tab.view.webContents.getURL());
    state.browserWindow.webContents.send('page-loading', tab.isLoading);
}

/**
 * Fecha uma aba — UI imediata, export+cleanup em background.
 * Idempotente (chamado 2x para mesmo tabId nao quebra).
 */
function closeTab(tabId) {
    const tab = state.tabs.get(tabId);
    if (!tab) return;

    // Marca como "fechando" — evita race condition (botao clicado 2x, etc.)
    if (tab._closing) return;
    tab._closing = true;

    // Se for a ultima aba, fechar a janela inteira (window close cuida do export)
    if (state.tabs.size === 1) {
        if (state.browserWindow && !state.browserWindow.isDestroyed()) {
            try { state.browserWindow.close(); } catch {}
        }
        return;
    }

    // Capturar refs antes de mexer no state (evita undefined depois)
    const view = tab.view;
    const perfil = tab.perfil;
    const viewId = (view && view.webContents && !view.webContents.isDestroyed()) ? view.webContents.id : null;
    const isActive = state.activeTabId === tabId;

    // 1. UI: ativar aba adjacente se estava ativa (instantaneo)
    if (isActive) {
        const otherTabIds = Array.from(state.tabs.keys()).filter(id => id !== tabId);
        if (otherTabIds.length > 0) {
            try { activateTab(otherTabIds[0]); } catch {}
        }
    }

    // 2. UI: remove BrowserView e notifica toolbar (instantaneo)
    if (state.browserWindow && !state.browserWindow.isDestroyed() && view) {
        try { state.browserWindow.removeBrowserView(view); } catch {}
        // Tambem limpar splash se a aba ainda estava em warming
        if (tab._splashView) {
            try { state.browserWindow.removeBrowserView(tab._splashView); } catch {}
            try {
                if (tab._splashView.webContents && !tab._splashView.webContents.isDestroyed()) {
                    tab._splashView.webContents.destroy();
                }
            } catch {}
            tab._splashView = null;
        }
        try { state.browserWindow.webContents.send('tab-removed', tabId); } catch {}
    }
    try { sendToLovable('mp-tab-closed', { tabId, perfilId: perfil?.id }); } catch {}

    // 3. Remove do state imediatamente (evita reabrir/clicar acidental)
    if (perfil?.id) state.perfilIdToTab.delete(perfil.id);
    state.tabs.delete(tabId);
    if (state.activeTabId === tabId) state.activeTabId = null;

    // 4. Background: auto-export + cleanup
    (async () => {
        try {
            // SO exporta ao fechar se tokenRotation=true (sites como Higgsfield)
            // Sites normais usam apenas o gatilho 4h ao abrir
            if (state.autoExportSession && perfil?.tokenRotation === true &&
                perfil?.ftp && perfil?.senha &&
                view && view.webContents && !view.webContents.isDestroyed()) {
                await state.autoExportSession({ view, perfil });
            }
        } catch (err) {
            console.error('[CLOSE-TAB] Auto-export erro:', err.message);
        } finally {
            if (viewId !== null) {
                state.proxyCredentials.delete(viewId);
                state.proxyFallbackState.delete(viewId);
                for (const [key] of state.proxyAuthAttempts) {
                    if (key.startsWith(`${viewId}-`)) state.proxyAuthAttempts.delete(key);
                }
            }
            try {
                if (view && view.webContents && !view.webContents.isDestroyed()) {
                    view.webContents.destroy();
                }
            } catch {}
        }
    })();
}

module.exports = {
    createBrowserWindow,
    createTab,
    activateTab,
    closeTab,
    handleTabShortcut
};
