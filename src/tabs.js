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

    win.on('close', () => {
        for (const [tabId, tab] of state.tabs) {
            sendToLovable('mp-tab-closed', { tabId, perfilId: tab.perfil?.id });
        }
        sendToLovable('mp-app-closing', { tabCount: state.tabs.size, timestamp: Date.now() });
    });

    win.on('closed', () => {
        for (const [tabId, tab] of state.tabs) {
            const viewId = tab.view.webContents.id;
            state.proxyCredentials.delete(viewId);
            state.proxyFallbackState.delete(viewId);
            for (const [key] of state.proxyAuthAttempts) {
                if (key.startsWith(`${viewId}-`)) state.proxyAuthAttempts.delete(key);
            }
        }
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
        if (!view.webContents.isDestroyed()) {
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

    // Viewport + site fixes
    const reloaded403Urls = new Set();
    view.webContents.on('did-finish-load', () => {
        setTimeout(forceViewportRecalc, 300);
        setTimeout(forceViewportRecalc, 1000);
        injectSiteFixes(view.webContents);

        // Detectar pagina 200 OK mas com conteudo de erro 403/bloqueio
        // (alguns sites retornam HTML com erro em vez de HTTP status)
        setTimeout(async () => {
            if (view.webContents.isDestroyed()) return;
            try {
                const check = await view.webContents.executeJavaScript(`
                    (function() {
                        var title = (document.title || '').toLowerCase();
                        var body = (document.body && document.body.innerText || '').substring(0, 500).toLowerCase();
                        var url = window.location.href;
                        // Pagina muito curta com "403" visivel
                        var isBlocked = (
                            (title.indexOf('403') !== -1) ||
                            (title.indexOf('access denied') !== -1) ||
                            (body.trim() === '403') ||
                            (body.length < 100 && body.indexOf('403') !== -1)
                        );
                        return { blocked: isBlocked, url: url, title: title, bodyLen: body.length };
                    })();
                `);

                if (check && check.blocked) {
                    const urlKey = check.url.split('?')[0];
                    if (!reloaded403Urls.has(urlKey)) {
                        reloaded403Urls.add(urlKey);
                        console.warn(`[PAGE 403] Detectado via DOM: ${check.url.substring(0, 100)} | title="${check.title}"`);
                        setTimeout(() => {
                            if (!view.webContents.isDestroyed()) view.webContents.reload();
                        }, 1200);
                    }
                }
            } catch {}
        }, 1500);
    });
    view.webContents.on('did-navigate', () => {
        setTimeout(() => injectSiteFixes(view.webContents), 500);
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

    // Session data injection
    view.webContents.ipc.once('request-session-data', (e) => {
        e.sender.send('inject-session-data', storageData);
    });
    view.webContents.ipc.once('get-initial-session-data', (e) => {
        e.returnValue = storageData || null;
    });

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
    sendToToolbar('tab-added', { tabId, title: tabEntry.title, favicon: null, isActive: true });
    sendToLovable('mp-tab-opened', { tabId, perfilId: perfil.id, url: perfil.link, title: tabEntry.title });

    activateTab(tabId);

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
 */
function activateTab(tabId) {
    const tab = state.tabs.get(tabId);
    if (!tab || !state.browserWindow || state.browserWindow.isDestroyed()) return;

    state.activeTabId = tabId;

    state.browserWindow.setBrowserView(tab.view);
    tab.view.setBounds(getViewBounds(state.browserWindow, tab.downloadsPanelOpen));
    tab.view.setAutoResize({ width: !tab.downloadsPanelOpen, height: true, horizontal: false, vertical: false });

    state.browserWindow.webContents.send('tab-activated', { tabId });
    state.browserWindow.webContents.send('url-updated', tab.url || tab.view.webContents.getURL());
    state.browserWindow.webContents.send('page-loading', tab.isLoading);
}

/**
 * Fecha uma aba.
 */
function closeTab(tabId) {
    const tab = state.tabs.get(tabId);
    if (!tab) return;

    if (state.tabs.size === 1) {
        if (state.browserWindow && !state.browserWindow.isDestroyed()) state.browserWindow.close();
        return;
    }

    if (state.activeTabId === tabId) {
        const tabIds = Array.from(state.tabs.keys());
        const idx = tabIds.indexOf(tabId);
        const nextIdx = idx < tabIds.length - 1 ? idx + 1 : idx - 1;
        activateTab(tabIds[nextIdx]);
    }

    const viewId = tab.view.webContents.id;
    if (state.browserWindow && !state.browserWindow.isDestroyed()) {
        state.browserWindow.removeBrowserView(tab.view);
    }
    try { tab.view.webContents.destroy(); } catch {}
    state.proxyCredentials.delete(viewId);
    state.proxyFallbackState.delete(viewId);
    for (const [key] of state.proxyAuthAttempts) {
        if (key.startsWith(`${viewId}-`)) state.proxyAuthAttempts.delete(key);
    }
    if (tab.perfil?.id) state.perfilIdToTab.delete(tab.perfil.id);
    state.tabs.delete(tabId);

    if (state.browserWindow && !state.browserWindow.isDestroyed()) {
        state.browserWindow.webContents.send('tab-removed', tabId);
    }

    sendToLovable('mp-tab-closed', { tabId, perfilId: tab.perfil?.id });
}

module.exports = {
    createBrowserWindow,
    createTab,
    activateTab,
    closeTab,
    handleTabShortcut
};
