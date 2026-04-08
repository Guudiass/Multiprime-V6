/* eslint-disable no-undef */
// src/ipc-handlers.js — Todos os IPC handlers

const { BrowserWindow, ipcMain, shell, dialog, session } = require('electron');
const path = require('path');
const fsPromises = require('fs').promises;
const state = require('./state');
const { IS_DEV } = require('./config');
const { updateViewBounds } = require('./utils');
const { sendToLovable } = require('./status');
const { decryptIPC } = require('./crypto');
const { downloadFromGitHub, uploadToGitHub } = require('./github');
const { prepareCookiesForInjection } = require('./cookies');
const { validateProxyConfig, switchToNextProxy } = require('./proxy');
const { createBrowserWindow, createTab, activateTab, closeTab } = require('./tabs');
const { logEvent } = require('./status');

function getViewForSender() {
    if (!state.browserWindow || state.browserWindow.isDestroyed() || !state.activeTabId) return null;
    const tab = state.tabs.get(state.activeTabId);
    return tab ? { mainWindow: state.browserWindow, view: tab.view, downloadsPanelOpen: tab.downloadsPanelOpen } : null;
}

function registerIpcHandlers() {
    // ===== NAVEGACAO =====
    ipcMain.on('navigate-back', (e) => {
        const entry = getViewForSender();
        if (entry?.view.webContents.canGoBack()) entry.view.webContents.goBack();
    });

    ipcMain.on('navigate-forward', (e) => {
        const entry = getViewForSender();
        if (entry?.view.webContents.canGoForward()) entry.view.webContents.goForward();
    });

    ipcMain.on('navigate-reload', (e) => {
        const entry = getViewForSender();
        entry?.view.webContents.reload();
    });

    ipcMain.on('navigate-to-url', (e, url) => {
        const entry = getViewForSender();
        if (entry && url) entry.view.webContents.loadURL(url);
    });

    ipcMain.on('request-initial-url', (e) => {
        const entry = getViewForSender();
        if (entry) e.sender.send('url-updated', entry.view.webContents.getURL());
    });

    // ===== WINDOW CONTROLS (browser) =====
    ipcMain.on('minimize-secure-window', (e) => {
        BrowserWindow.fromWebContents(e.sender)?.minimize();
    });

    ipcMain.on('maximize-secure-window', (e) => {
        const w = BrowserWindow.fromWebContents(e.sender);
        if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
    });

    ipcMain.on('close-secure-window', (e) => {
        BrowserWindow.fromWebContents(e.sender)?.close();
    });

    // ===== WINDOW CONTROLS (titlebar principal) =====
    ipcMain.on('main-minimize', (e) => {
        BrowserWindow.fromWebContents(e.sender)?.minimize();
    });
    ipcMain.on('main-maximize', (e) => {
        const w = BrowserWindow.fromWebContents(e.sender);
        if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
    });
    ipcMain.on('main-close', (e) => {
        BrowserWindow.fromWebContents(e.sender)?.close();
    });
    ipcMain.on('main-is-maximized', (e) => {
        const w = BrowserWindow.fromWebContents(e.sender);
        e.returnValue = w ? w.isMaximized() : false;
    });

    // ===== FILE OPERATIONS =====
    ipcMain.on('open-download', (e, p) => { if (p) shell.openPath(p).catch(() => {}); });
    ipcMain.on('show-download-in-folder', (e, p) => { if (p) shell.showItemInFolder(path.resolve(p)); });
    ipcMain.on('open-external', (e, url) => {
        if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
            shell.openExternal(url);
        }
    });

    // ===== DOWNLOADS PANEL =====
    ipcMain.on('downloads-panel-toggle', (e, isOpen) => {
        if (!state.activeTabId) return;
        const tab = state.tabs.get(state.activeTabId);
        if (!tab) return;

        tab.downloadsPanelOpen = isOpen;
        updateViewBounds();

        tab.view.setAutoResize({
            width: !isOpen,
            height: true,
            horizontal: false,
            vertical: false
        });
    });

    // ===== SESSION EXPORT =====
    ipcMain.on('initiate-full-session-export', async (event, storageData) => {
        if (!state.browserWindow || state.browserWindow.isDestroyed() || !state.activeTabId) return;
        const tab = state.tabs.get(state.activeTabId);
        if (!tab) return;

        const viewContents = tab.view.webContents;
        const perfil = tab.perfil;

        try {
            const cookies = await viewContents.session.cookies.get({});
            const fullSessionData = {
                exported_at: new Date().toISOString(),
                source_url: viewContents.getURL(),
                cookies,
                localStorage: storageData?.localStorageData,
                sessionStorage: storageData?.sessionStorageData,
                indexedDB: storageData?.indexedDBData
            };
            const jsonContent = JSON.stringify(fullSessionData, null, 4);

            if (perfil?.ftp && perfil?.senha) {
                try {
                    await uploadToGitHub(perfil.ftp, jsonContent, perfil.senha, `Atualizar sessão - ${new Date().toISOString()}`);
                    await dialog.showMessageBox(state.browserWindow, {
                        type: 'info', title: 'Exportação Concluída',
                        message: 'Sessão salva com sucesso no GitHub (criptografada)!',
                        detail: `Arquivo: ${perfil.ftp}`
                    });
                } catch (err) {
                    console.error('[EXPORT] Falha GitHub:', err);
                    const { response } = await dialog.showMessageBox(state.browserWindow, {
                        type: 'warning', title: 'Erro GitHub',
                        message: 'Falha no GitHub. Salvar localmente?',
                        buttons: ['Salvar Localmente', 'Cancelar']
                    });
                    if (response === 0) await saveSessionLocally(state.browserWindow, jsonContent);
                }
            } else {
                await saveSessionLocally(state.browserWindow, jsonContent);
            }
        } catch (err) {
            console.error('[EXPORT] Erro:', err);
            await dialog.showMessageBox(state.browserWindow, {
                type: 'error', title: 'Erro', message: 'Erro ao exportar sessão.', detail: err.message
            });
        }
    });

    // ===== ABRIR NAVEGADOR =====
    ipcMain.on('abrir-navegador', (event, perfil) => handleAbrirNavegador(event, perfil));
    ipcMain.on('abrir-navegador-secure', (event, encryptedPerfil) => handleAbrirNavegador(event, encryptedPerfil));

    // ===== ABAS =====
    ipcMain.on('switch-tab', (e, tabId) => {
        if (state.tabs.has(tabId)) activateTab(tabId);
    });
    ipcMain.on('close-tab', (e, tabId) => {
        if (state.tabs.has(tabId)) closeTab(tabId);
    });

    // ===== TEMA =====
    ipcMain.on('set-tema', (event, tema) => {
        state.currentTema = tema;
        if (state.browserWindow && !state.browserWindow.isDestroyed()) {
            state.browserWindow.webContents.send('theme-changed', tema);
        }
        const allWindows = BrowserWindow.getAllWindows();
        for (const win of allWindows) {
            try {
                if (!win.isDestroyed() && win !== state.browserWindow) {
                    win.webContents.send('theme-changed', tema);
                }
            } catch {}
        }
    });
}

async function handleAbrirNavegador(event, rawPerfil) {
    let perfil;
    if (rawPerfil && rawPerfil.__encrypted && rawPerfil.payload) {
        perfil = decryptIPC(rawPerfil.payload);
        if (!perfil) {
            console.error('[IPC CRYPTO] ❌ Falha ao descriptografar perfil.');
            dialog.showErrorBox('Erro de Segurança', 'Não foi possível processar os dados de forma segura.');
            return;
        }
    } else {
        perfil = rawPerfil;
    }

    // CapSolver key
    if (perfil?.capsolverKey && perfil.capsolverKey.startsWith('CAP-')) {
        state.CAPSOLVER_API_KEY = perfil.capsolverKey;
    }

    // Deduplicacao
    if (perfil?.id && state.perfilIdToTab.has(perfil.id)) {
        const existingTabId = state.perfilIdToTab.get(perfil.id);
        if (state.tabs.has(existingTabId)) {
            activateTab(existingTabId);
            if (state.browserWindow && !state.browserWindow.isDestroyed()) {
                if (state.browserWindow.isMinimized()) state.browserWindow.restore();
                state.browserWindow.focus();
            }
            console.log(`[ABAS] Perfil ${perfil.id} já aberto → focando aba existente`);
            return;
        }
        state.perfilIdToTab.delete(perfil.id);
    }

    const windowId = `profile_${Date.now()}`;
    const partition = `persist:${windowId}`;
    const isolatedSession = session.fromPartition(partition);

    try {
        if (!perfil?.link) throw new Error('Perfil ou link inválido.');

        await isolatedSession.clearStorageData();

        if (perfil.userAgent && perfil.userAgent.includes('Mozilla/') && !perfil.userAgent.includes('@')) {
            await isolatedSession.setUserAgent(perfil.userAgent);
        } else {
            const defaultUA = isolatedSession.getUserAgent()
                .replace(/Electron\/[\d.]+ /, '')
                .replace(/multiprime-v6\/[\d.]+ /, '');
            await isolatedSession.setUserAgent(defaultUA);
        }

        // Cookies
        let sessionData = null;
        if (perfil.ftp && perfil.senha) {
            try {
                const fileContent = await downloadFromGitHub(perfil.ftp, perfil.senha);
                if (fileContent) sessionData = JSON.parse(fileContent);
            } catch (err) {
                console.error(`[SESSÃO ${windowId}] Falha GitHub:`, err.message);
                logEvent('session_failed', { perfilId: perfil.id, erro: err.message, ftp: perfil.ftp });
            }
        }

        let cookiesToInject = [];
        if (sessionData) {
            if (Array.isArray(sessionData)) cookiesToInject = sessionData;
            else if (Array.isArray(sessionData.cookies)) cookiesToInject = sessionData.cookies;
        }

        if (cookiesToInject.length > 0) {
            const prepared = prepareCookiesForInjection(cookiesToInject, perfil.link);
            let ok = 0, fail = 0;
            const failedNames = [];
            for (const cookie of prepared) {
                try { await isolatedSession.cookies.set(cookie); ok++; }
                catch (err) { fail++; if (fail <= 5) failedNames.push(`${cookie.name}: ${err.message}`); }
            }
            if (failedNames.length > 0) console.warn(`[SESSÃO ${windowId}] Falhas:`, failedNames.join(' | '));
            await isolatedSession.cookies.flushStore();
            logEvent('session_loaded', { perfilId: perfil.id, cookieCount: ok, cookieFailed: fail, ftp: perfil.ftp });
        }

        const storageData = {
            localStorage: sessionData?.localStorage,
            sessionStorage: sessionData?.sessionStorage,
            indexedDB: sessionData?.indexedDB
        };

        // Proxy
        if (perfil.proxy?.host && perfil.proxy?.port) {
            const validation = validateProxyConfig(perfil.proxy);
            if (validation.valid) {
                const t = validation.type;
                let proxyRules;
                if (t === 'socks5' || t === 'socks') proxyRules = `socks5://${perfil.proxy.host}:${validation.port}`;
                else if (t === 'socks4') proxyRules = `socks4://${perfil.proxy.host}:${validation.port}`;
                else proxyRules = `http://${perfil.proxy.host}:${validation.port}`;
                const bypass = [perfil.proxy.bypass || '', '*.envatousercontent.com'].filter(Boolean).join(',');
                await isolatedSession.setProxy({ proxyRules, proxyBypassRules: bypass });
            } else {
                console.warn(`[PROXY] Inválido: ${validation.error}. Usando direto.`);
                await isolatedSession.setProxy({ proxyRules: 'direct://' });
            }
        } else {
            await isolatedSession.setProxy({ proxyRules: 'direct://' });
        }

        // Permissoes
        isolatedSession.setPermissionRequestHandler((wc, permission, callback) => callback(true));
        isolatedSession.setPermissionCheckHandler(() => true);


        // Criar janela e aba
        if (!state.browserWindow || state.browserWindow.isDestroyed()) {
            createBrowserWindow();
        }

        const tabEntry = createTab(perfil, isolatedSession, storageData);
        const view = tabEntry.view;
        const viewId = view.webContents.id;

        // Proxy credentials
        if (perfil.proxy?.username) {
            state.proxyCredentials.set(viewId, {
                username: perfil.proxy.username,
                password: perfil.proxy.password ?? ''
            });
        }

        // Fallbacks
        if (perfil.proxy?.host && Array.isArray(perfil.proxyFallbacks) && perfil.proxyFallbacks.length > 0) {
            state.proxyFallbackState.set(viewId, {
                fallbacks: perfil.proxyFallbacks.slice(0, 2),
                currentIndex: -1,
                session: isolatedSession,
                perfil
            });
        }

        // Proxy error detection
        view.webContents.on('did-fail-load', async (event, errorCode, errorDescription) => {
            const proxyErrors = [-102, -105, -106, -109, -118, -130, -137, -138];
            if (proxyErrors.includes(errorCode) && state.proxyFallbackState.has(view.webContents.id)) {
                const switched = await switchToNextProxy(view.webContents.id);
                if (switched) {
                    try { if (!view.webContents.isDestroyed()) view.webContents.reload(); } catch {}
                }
            }
        });

        // Auto-reload em 403/503 no main frame (max 1 retry por URL)
        // (sites como ChatGPT, Freepik etc rejeitam a primeira requisicao e refresh resolve)
        const reloadedUrls = new Set();
        isolatedSession.webRequest.onHeadersReceived((details, callback) => {
            if (details.resourceType === 'mainFrame') {
                const statusCode = details.statusCode;
                // URL base sem params de verificacao (para agrupar retries)
                const urlKey = details.url.split('?')[0];

                if ((statusCode === 403 || statusCode === 503) && !reloadedUrls.has(urlKey)) {
                    reloadedUrls.add(urlKey);
                    console.warn(`[HTTP ${statusCode}] Auto-reload em: ${details.url.substring(0, 100)}`);
                    setTimeout(() => {
                        try {
                            for (const [, tab] of state.tabs) {
                                if (tab.view.webContents.session === isolatedSession) {
                                    if (!tab.view.webContents.isDestroyed()) {
                                        tab.view.webContents.reload();
                                    }
                                    break;
                                }
                            }
                        } catch {}
                    }, 1200);
                } else if (statusCode >= 200 && statusCode < 400) {
                    // Sucesso — remover da lista de URLs com retry feito
                    // (assim se o usuario voltar para a mesma URL e der 403 de novo, faz retry)
                    reloadedUrls.delete(urlKey);
                }
            }
            callback({ responseHeaders: details.responseHeaders });
        });

        // Load URL
        try {
            await view.webContents.loadURL(perfil.link);
        } catch (err) {
            console.warn(`[NAV] Erro: ${err.code || err.message}`);
        }

    } catch (err) {
        console.error('--- [ERRO FATAL] ---', err);
    }
}

async function saveSessionLocally(window, jsonContent) {
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
        title: 'Salvar Sessão',
        defaultPath: `session-${Date.now()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (!canceled && filePath) {
        await fsPromises.writeFile(filePath, jsonContent);
        await dialog.showMessageBox(window, {
            type: 'info', title: 'Salvo', message: `Sessão salva em: ${filePath}`
        });
    }
}

module.exports = { registerIpcHandlers };
