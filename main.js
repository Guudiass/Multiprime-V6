/* eslint-disable no-undef */
// main.js — MultiPrime V6 (Electron Puro)
// Ponto de entrada. Módulos em src/.

const { app, BrowserWindow, BrowserView, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const state = require('./src/state');
const { APP_URL, IS_DEV } = require('./src/config');
const { limparParticoesAntigas } = require('./src/utils');
const { nossoManipuladorDeLogin } = require('./src/proxy');
const { sendToLovable } = require('./src/status');
const { registerIpcHandlers } = require('./src/ipc-handlers');
const { setupAutoUpdater } = require('./src/updater');

// Registrar IPC handlers (crypto, navegação, abas, tema, etc.)
require('./src/crypto'); // registra get-ipc-session-key
registerIpcHandlers();

// ===================================================================
// INICIALIZAÇÃO
// ===================================================================
function startApp() {
    // Anti-bot
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
    // Estabilidade GPU
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('disable-software-rasterizer');

    app.whenReady().then(async () => {
        await limparParticoesAntigas();

        // Proxy auth handler
        for (const listener of app.listeners('login')) app.removeListener('login', listener);
        app.on('login', nossoManipuladorDeLogin);

        // ★ JANELA PRINCIPAL — titlebar + Lovable em BrowserView
        const MAIN_BAR_HEIGHT = 36;

        const mainWindow = new BrowserWindow({
            width: 1280, height: 720,
            minWidth: 800, minHeight: 600,
            icon: path.join(__dirname, 'icon.ico'),
            title: 'MultiPrime',
            frame: false, show: false,
            backgroundColor: '#111111',
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                devTools: IS_DEV
            }
        });

        Menu.setApplicationMenu(null);

        // Titlebar inline
        let iconBase64 = '';
        try {
            const iconBuffer = fs.readFileSync(path.join(__dirname, 'icon.ico'));
            iconBase64 = 'data:image/x-icon;base64,' + iconBuffer.toString('base64');
        } catch (e) {
            console.warn('[SISTEMA] icon.ico não encontrado');
        }

        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --tb-bg: linear-gradient(180deg, #f0f0f0 0%, #e5e5e5 100%);
  --tb-border: rgba(0,0,0,0.08);
  --tb-title: rgba(0,0,0,0.65);
  --tb-btn: rgba(0,0,0,0.45);
  --tb-btn-hover-bg: rgba(0,0,0,0.06);
  --tb-btn-hover: rgba(0,0,0,0.8);
}
:root.dark {
  --tb-bg: linear-gradient(180deg, #1a1a1a 0%, #111111 100%);
  --tb-border: rgba(255,255,255,0.06);
  --tb-title: rgba(255,255,255,0.7);
  --tb-btn: rgba(255,255,255,0.55);
  --tb-btn-hover-bg: rgba(255,255,255,0.08);
  --tb-btn-hover: rgba(255,255,255,0.9);
}
body {
  height: ${MAIN_BAR_HEIGHT}px;
  background: var(--tb-bg);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 12px;
  -webkit-app-region: drag;
  user-select: none;
  font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  border-bottom: 1px solid var(--tb-border);
  overflow: hidden;
  transition: background 0.2s;
}
.title { display: flex; align-items: center; color: var(--tb-title); }
.title img { width: 18px; height: 18px; margin-right: 8px; }
.title span { font-weight: 500; letter-spacing: 0.3px; }
.controls { display: flex; gap: 4px; -webkit-app-region: no-drag; }
.btn {
  width: 28px; height: 28px;
  background: transparent; border: none; border-radius: 6px;
  color: var(--tb-btn); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.btn:hover { background: var(--tb-btn-hover-bg); color: var(--tb-btn-hover); }
.close:hover { background: #e81123; color: white; }
</style></head><body>
<div class="title">
  <img src="${iconBase64}" alt="">
  <span>MultiPrime</span>
</div>
<div class="controls">
  <button class="btn" onclick="require('electron').ipcRenderer.send('main-minimize')">
    <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
  </button>
  <button class="btn" onclick="require('electron').ipcRenderer.send('main-maximize')">
    <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
  </button>
  <button class="btn close" onclick="require('electron').ipcRenderer.send('main-close')">
    <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
  </button>
</div>
<script>
  require('electron').ipcRenderer.on('theme-changed', (e, tema) => {
    document.documentElement.classList.toggle('dark', tema === 'dark');
  });
</script>
</body></html>`));

        // Lovable BrowserView
        state.lovableView = new BrowserView({
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
                devTools: IS_DEV
            }
        });

        mainWindow.setBrowserView(state.lovableView);

        const updateLovableBounds = () => {
            if (mainWindow.isDestroyed()) return;
            const { width, height } = mainWindow.getContentBounds();
            state.lovableView.setBounds({ x: 0, y: MAIN_BAR_HEIGHT, width: width, height: height - MAIN_BAR_HEIGHT });
        };

        updateLovableBounds();
        state.lovableView.setAutoResize({ width: true, height: true });

        mainWindow.on('resize', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('maximize', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('unmaximize', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('restore', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('enter-full-screen', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('leave-full-screen', () => setTimeout(updateLovableBounds, 50));

        // Carregar Lovable
        const loadLovable = () => {
            state.lovableView.webContents.loadURL(APP_URL);

            const lovableHost = new URL(APP_URL).hostname;

            state.lovableView.webContents.setWindowOpenHandler(({ url }) => {
                try {
                    const host = new URL(url).hostname;
                    if (host !== lovableHost) {
                        shell.openExternal(url);
                        return { action: 'deny' };
                    }
                } catch {}
                return { action: 'deny' };
            });

            state.lovableView.webContents.on('will-navigate', (e, url) => {
                try {
                    const host = new URL(url).hostname;
                    if (host !== lovableHost) {
                        e.preventDefault();
                        shell.openExternal(url);
                    }
                } catch {}
            });

            state.lovableView.webContents.once('did-finish-load', () => {
                if (!mainWindow.isVisible()) {
                    mainWindow.maximize();
                    mainWindow.show();
                }
            });
        };

        // Auto-updater
        setupAutoUpdater(state.lovableView, mainWindow, loadLovable);
    });

    // Cleanup
    app.on('before-quit', () => {
        for (const [tabId, tab] of state.tabs) {
            sendToLovable('mp-tab-closed', { tabId, perfilId: tab.perfil?.id });
        }
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    process.on('uncaughtException', err => console.error('--- ERRO NÃO CAPTURADO ---', err));
    process.on('unhandledRejection', reason => console.error('--- PROMISE REJEITADA ---', reason));
}

// ===================================================================
// PONTO DE ENTRADA
// ===================================================================
startApp();
