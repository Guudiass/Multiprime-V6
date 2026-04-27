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

    // Funcao utilitaria para exportar sessao sem dialog (uso interno, auto-export silencioso)
    async function autoExportSession(tab) {
        if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return false;
        const viewContents = tab.view.webContents;
        const perfil = tab.perfil;
        if (!perfil?.ftp || !perfil?.senha) return false;

        try {
            const cookies = await viewContents.session.cookies.get({});
            let localStorageData = {};
            let sessionStorageData = {};
            let indexedDBData = {};

            try {
                localStorageData = await viewContents.executeJavaScript(`(function(){var d={};try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);d[k]=localStorage.getItem(k);}}catch(e){}return d;})();`);
            } catch {}
            try {
                sessionStorageData = await viewContents.executeJavaScript(`(function(){var d={};try{for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i);d[k]=sessionStorage.getItem(k);}}catch(e){}return d;})();`);
            } catch {}
            try {
                indexedDBData = await viewContents.executeJavaScript(`
                    (async function() {
                        var allDBs = {};
                        try {
                            var dbs = await indexedDB.databases();
                            for (var i = 0; i < dbs.length; i++) {
                                var dbInfo = dbs[i];
                                if (!dbInfo.name) continue;
                                try {
                                    var dbData = await new Promise(function(resolve) {
                                        var req = indexedDB.open(dbInfo.name, dbInfo.version);
                                        req.onsuccess = function() {
                                            var db = req.result;
                                            var result = { version: db.version, stores: {} };
                                            if (db.objectStoreNames.length === 0) { db.close(); resolve(result); return; }
                                            var tx = db.transaction(Array.from(db.objectStoreNames), 'readonly');
                                            var pending = 0;
                                            for (var j = 0; j < db.objectStoreNames.length; j++) {
                                                (function(storeName) {
                                                    pending++;
                                                    var storeData = { keyPath: null, autoIncrement: false, entries: [] };
                                                    try {
                                                        var store = tx.objectStore(storeName);
                                                        storeData.keyPath = store.keyPath;
                                                        storeData.autoIncrement = store.autoIncrement;
                                                        var cursor = store.openCursor();
                                                        cursor.onsuccess = function(e) {
                                                            var c = e.target.result;
                                                            if (c) { try { storeData.entries.push({ key: c.key, value: c.value }); } catch(ee) {} c.continue(); }
                                                            else { result.stores[storeName] = storeData; pending--; if (pending === 0) { db.close(); resolve(result); } }
                                                        };
                                                        cursor.onerror = function() { result.stores[storeName] = storeData; pending--; if (pending === 0) { db.close(); resolve(result); } };
                                                    } catch(e) { pending--; if (pending === 0) { db.close(); resolve(result); } }
                                                })(db.objectStoreNames[j]);
                                            }
                                            setTimeout(function() { try { db.close(); } catch(e) {} resolve(result); }, 8000);
                                        };
                                        req.onerror = function() { resolve(null); };
                                    });
                                    if (dbData) allDBs[dbInfo.name] = dbData;
                                } catch(e) {}
                            }
                        } catch(e) {}
                        return allDBs;
                    })();
                `);
            } catch {}

            const fullSessionData = {
                exported_at: new Date().toISOString(),
                source_url: viewContents.getURL(),
                cookies,
                localStorage: localStorageData,
                sessionStorage: sessionStorageData,
                indexedDB: indexedDBData
            };
            const jsonContent = JSON.stringify(fullSessionData, null, 4);

            const cookieCount = cookies.length;
            if (cookieCount < 5) {
                console.warn(`[AUTO-EXPORT] ${perfil.ftp}: apenas ${cookieCount} cookies — abortando`);
                return false;
            }

            // Retry com backoff em caso de 409 (conflict do GitHub - race condition)
            const MAX_RETRIES = 3;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    await uploadToGitHub(perfil.ftp, jsonContent, perfil.senha, `Auto-export: ${new Date().toISOString()}`);
                    // Atualizar timestamp de ultimo export (para o throttle)
                    if (!state.lastExportByPerfil) state.lastExportByPerfil = new Map();
                    if (perfil.id) state.lastExportByPerfil.set(perfil.id, Date.now());
                    return true;
                } catch (uploadErr) {
                    const is409 = String(uploadErr.message || '').includes('409');
                    if (is409 && attempt < MAX_RETRIES) {
                        console.warn(`[AUTO-EXPORT] ${perfil.ftp}: 409 conflict, retry em ${attempt}s...`);
                        await new Promise(r => setTimeout(r, attempt * 1000));
                        continue;
                    }
                    throw uploadErr;
                }
            }
            return false;
        } catch (err) {
            console.error(`[AUTO-EXPORT] Falha ${perfil?.ftp}:`, err.message);
            return false;
        }
    }

    // Expor globalmente via state para ser usado pelo closeTab
    state.autoExportSession = autoExportSession;

    ipcMain.on('initiate-full-session-export', async (event, storageData) => {
        if (!state.browserWindow || state.browserWindow.isDestroyed() || !state.activeTabId) return;
        const tab = state.tabs.get(state.activeTabId);
        if (!tab) return;

        const viewContents = tab.view.webContents;
        const perfil = tab.perfil;

        try {
            const cookies = await viewContents.session.cookies.get({});

            // Capturar localStorage e sessionStorage da pagina ativa
            let localStorageData = {};
            let sessionStorageData = {};
            try {
                localStorageData = await viewContents.executeJavaScript(`
                    (function() {
                        var data = {};
                        try {
                            for (var i = 0; i < localStorage.length; i++) {
                                var key = localStorage.key(i);
                                data[key] = localStorage.getItem(key);
                            }
                        } catch (e) {}
                        return data;
                    })();
                `);
            } catch {}
            try {
                sessionStorageData = await viewContents.executeJavaScript(`
                    (function() {
                        var data = {};
                        try {
                            for (var i = 0; i < sessionStorage.length; i++) {
                                var key = sessionStorage.key(i);
                                data[key] = sessionStorage.getItem(key);
                            }
                        } catch (e) {}
                        return data;
                    })();
                `);
            } catch {}

            // Capturar IndexedDB (CRITICO para sites com Supabase/Firebase auth: Higgsfield, etc.)
            let indexedDBData = {};
            try {
                indexedDBData = await viewContents.executeJavaScript(`
                    (async function() {
                        var allDBs = {};
                        try {
                            var dbs = await indexedDB.databases();
                            for (var i = 0; i < dbs.length; i++) {
                                var dbInfo = dbs[i];
                                if (!dbInfo.name) continue;
                                try {
                                    var dbData = await new Promise(function(resolve) {
                                        var req = indexedDB.open(dbInfo.name, dbInfo.version);
                                        req.onsuccess = function() {
                                            var db = req.result;
                                            var result = { version: db.version, stores: {} };
                                            if (db.objectStoreNames.length === 0) {
                                                db.close();
                                                resolve(result);
                                                return;
                                            }
                                            var tx = db.transaction(Array.from(db.objectStoreNames), 'readonly');
                                            var pending = 0;
                                            for (var j = 0; j < db.objectStoreNames.length; j++) {
                                                (function(storeName) {
                                                    pending++;
                                                    var storeData = { keyPath: null, autoIncrement: false, entries: [] };
                                                    try {
                                                        var store = tx.objectStore(storeName);
                                                        storeData.keyPath = store.keyPath;
                                                        storeData.autoIncrement = store.autoIncrement;
                                                        var cursor = store.openCursor();
                                                        cursor.onsuccess = function(e) {
                                                            var c = e.target.result;
                                                            if (c) {
                                                                try {
                                                                    storeData.entries.push({ key: c.key, value: c.value });
                                                                } catch(ee) {}
                                                                c.continue();
                                                            } else {
                                                                result.stores[storeName] = storeData;
                                                                pending--;
                                                                if (pending === 0) { db.close(); resolve(result); }
                                                            }
                                                        };
                                                        cursor.onerror = function() {
                                                            result.stores[storeName] = storeData;
                                                            pending--;
                                                            if (pending === 0) { db.close(); resolve(result); }
                                                        };
                                                    } catch(e) {
                                                        pending--;
                                                        if (pending === 0) { db.close(); resolve(result); }
                                                    }
                                                })(db.objectStoreNames[j]);
                                            }
                                            setTimeout(function() { try { db.close(); } catch(e) {} resolve(result); }, 10000);
                                        };
                                        req.onerror = function() { resolve(null); };
                                    });
                                    if (dbData) allDBs[dbInfo.name] = dbData;
                                } catch(e) {}
                            }
                        } catch(e) {}
                        return allDBs;
                    })();
                `);
            } catch (err) {
                console.warn('[EXPORT] IndexedDB falhou:', err.message);
            }

            const fullSessionData = {
                exported_at: new Date().toISOString(),
                source_url: viewContents.getURL(),
                cookies,
                localStorage: localStorageData,
                sessionStorage: sessionStorageData,
                indexedDB: indexedDBData
            };
            const jsonContent = JSON.stringify(fullSessionData, null, 4);

            const cookieCount = cookies.length;
            const lsCount = Object.keys(localStorageData || {}).length;
            const ssCount = Object.keys(sessionStorageData || {}).length;
            const idbDbs = Object.keys(indexedDBData || {}).length;
            let idbEntries = 0;
            try {
                for (const dbName in (indexedDBData || {})) {
                    const db = indexedDBData[dbName];
                    for (const storeName in (db.stores || {})) {
                        idbEntries += (db.stores[storeName].entries || []).length;
                    }
                }
            } catch {}


            // Aviso se poucos cookies (suspeito de sessao incompleta)
            if (cookieCount < 50) {
                const { response } = await dialog.showMessageBox(state.browserWindow, {
                    type: 'warning',
                    title: 'Poucos cookies detectados',
                    message: `Apenas ${cookieCount} cookies foram capturados.`,
                    detail: 'Isso pode indicar que a sessao ainda nao carregou completamente ou voce nao esta logado.\n\nDeseja exportar mesmo assim?',
                    buttons: ['Cancelar', 'Exportar mesmo assim'],
                    defaultId: 0,
                    cancelId: 0
                });
                if (response !== 1) {
                    return;
                }
            }

            if (perfil?.ftp && perfil?.senha) {
                try {
                    await uploadToGitHub(perfil.ftp, jsonContent, perfil.senha, `Atualizar sessão - ${new Date().toISOString()}`);
                    await dialog.showMessageBox(state.browserWindow, {
                        type: 'info', title: 'Exportação Concluída',
                        message: `Sessão salva com sucesso!`,
                        detail: `Arquivo: ${perfil.ftp}\n\nCookies: ${cookieCount}\nlocalStorage: ${lsCount} chaves\nsessionStorage: ${ssCount} chaves\nIndexedDB: ${idbDbs} DBs (${idbEntries} entradas)`
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
            return;
        }
        state.perfilIdToTab.delete(perfil.id);
    }

    // CLOUD-FIRST: particao SEMPRE limpa, GitHub e a fonte unica de verdade
    // Sem dependencia de cache local — tudo vem da nuvem
    const windowId = perfil?.id ? `profile_${perfil.id}` : `profile_${Date.now()}`;
    const partition = `persist:${windowId}`;
    const isolatedSession = session.fromPartition(partition);
    let shouldRefreshGitHub = false;

    try {
        if (!perfil?.link) throw new Error('Perfil ou link inválido.');

        // SEMPRE limpa storage (cloud-first)
        await isolatedSession.clearStorageData();

        // SEMPRE baixa do GitHub
        let sessionDataEarly = null;
        if (perfil.ftp && perfil.senha) {
            try {
                const fileContent = await downloadFromGitHub(perfil.ftp, perfil.senha);
                if (fileContent) {
                    sessionDataEarly = JSON.parse(fileContent);
                    const githubTs = new Date(sessionDataEarly.exported_at || 0).getTime();
                    const ageMs = Date.now() - githubTs;
                    const FOUR_HOURS_MS = 4 * 3600 * 1000;


                    if (ageMs > FOUR_HOURS_MS) {
                        shouldRefreshGitHub = true;
                    }
                }
            } catch (err) {
            }
        }

        const shouldUseGitHub = true;
        const existingCookies = [];

        if (perfil.userAgent && perfil.userAgent.includes('Mozilla/') && !perfil.userAgent.includes('@')) {
            await isolatedSession.setUserAgent(perfil.userAgent);
        } else {
            const defaultUA = isolatedSession.getUserAgent()
                .replace(/Electron\/[\d.]+ /, '')
                .replace(/multiprime-v6\/[\d.]+ /, '');
            await isolatedSession.setUserAgent(defaultUA);
        }

        // Cookies — so injeta do GitHub se shouldUseGitHub=true
        let sessionData = shouldUseGitHub ? sessionDataEarly : null;
        // Se shouldUseGitHub mas ainda nao temos dados (erro anterior), tentar baixar
        if (shouldUseGitHub && !sessionData && perfil.ftp && perfil.senha) {
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

        // Usar dados do GitHub para storage, mesmo que shouldUseGitHub=false
        // (particoes persistentes as vezes perdem IndexedDB entre aberturas)
        // Isso garante reinjecao de localStorage + IndexedDB em TODA abertura
        const storageForInjection = sessionData || sessionDataEarly;
        const storageData = {
            localStorage: storageForInjection?.localStorage,
            sessionStorage: storageForInjection?.sessionStorage,
            indexedDB: storageForInjection?.indexedDB
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

        // Auto-reload de 403 e tratado em tabs.js (checkAndReload403)
        // Funciona para TODOS os tipos: HTTP 403, body "403", Access Denied, Cloudflare stuck, etc.

        // Load URL
        try {
            await view.webContents.loadURL(perfil.link);
        } catch (err) {
            console.warn(`[NAV] Erro: ${err.code || err.message}`);
        }


        // GATILHO: se GitHub > 4h, este usuario sera o "renovador" — exporta apos 30s
        if (shouldRefreshGitHub) {
            setTimeout(async () => {
                if (view.webContents && !view.webContents.isDestroyed() && state.autoExportSession) {
                    let tabRef = null;
                    for (const [, t] of state.tabs) {
                        if (t.view === view) { tabRef = t; break; }
                    }
                    if (tabRef) {
                        try { await state.autoExportSession(tabRef); } catch {}
                    }
                }
            }, 30000);
        }

        // tokenRotation=true: PRE-AQUECIMENTO EVENT-DRIVEN COM TRUE-IDLE
        // Por que precisa true-idle: did-stop-loading dispara em SPAs entre rajadas de XHRs
        // (HTML carrega → idle → XHRs /user /access /subscriptions disparam → idle de novo).
        // Se ativarmos no 1o idle, perdemos os endpoints que dizem "user e PLUS".
        // Settle de 2s sem novo did-start-loading = todas XHRs terminaram = pagina renderiza correto.
        if (perfil?.tokenRotation === true && cookiesToInject.length > 0) {
            (async () => {
                const t0 = Date.now();
                let tabRef = null;
                for (const [, t] of state.tabs) {
                    if (t.view === view) { tabRef = t; break; }
                }
                if (!tabRef) return;

                // Aguarda 2s consecutivos sem did-start-loading = idle real
                const waitTrueIdle = (settleMs = 2000) => new Promise((resolve) => {
                    if (view.webContents.isDestroyed()) { resolve(); return; }
                    let timer = null;
                    let resolved = false;
                    const finish = () => {
                        if (resolved) return;
                        resolved = true;
                        try { view.webContents.removeListener('did-start-loading', onStart); } catch {}
                        try { view.webContents.removeListener('did-stop-loading', onStop); } catch {}
                        resolve();
                    };
                    const onStart = () => { if (timer) { clearTimeout(timer); timer = null; } };
                    const onStop = () => { if (timer) clearTimeout(timer); timer = setTimeout(finish, settleMs); };
                    view.webContents.on('did-start-loading', onStart);
                    view.webContents.on('did-stop-loading', onStop);
                    if (!view.webContents.isLoading()) timer = setTimeout(finish, settleMs);
                });

                try {
                    await waitTrueIdle();
                    if (!view.webContents || view.webContents.isDestroyed()) return;

                    view.webContents.reload();

                    await waitTrueIdle();
                    if (!view.webContents || view.webContents.isDestroyed()) return;

                    tabRef._warming = false;
                    activateTab(tabRef.tabId);
                } catch (err) {
                    console.error(`[PRE-AQUECIMENTO] Erro:`, err.message);
                    if (tabRef) {
                        tabRef._warming = false;
                        try { activateTab(tabRef.tabId); } catch {}
                    }
                }
            })();
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
