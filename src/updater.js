/* eslint-disable no-undef */
// src/updater.js — Sistema de auto-update

const { BrowserWindow } = require('electron');

let autoUpdater;
try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
} catch (e) {
    console.warn('[APP-UPDATER] electron-updater não disponível (modo dev):', e.message);
    autoUpdater = null;
}

function setupAutoUpdater(lovableView, mainWindow, loadLovable) {
    if (!autoUpdater) {
        loadLovable();
        return;
    }

    let updateScreenLoaded = false;

    const loadUpdateScreen = () => {
        if (lovableView.webContents.isDestroyed()) return;
        if (!mainWindow.isVisible()) { mainWindow.maximize(); mainWindow.show(); }
        if (updateScreenLoaded) return;
        updateScreenLoaded = true;
        lovableView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
    background: #0f0f0f; color: white;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100vh; text-align: center;
}
.logo { margin-bottom: 24px; opacity: 0.7; }
h1 { font-size: 18px; font-weight: 500; margin-bottom: 10px; color: rgba(255,255,255,0.85); }
p { font-size: 13px; color: rgba(255,255,255,0.4); margin-bottom: 20px; }
.bar-bg { width: 280px; height: 4px; background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden; }
.bar-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #60a5fa); border-radius: 2px; width: 0%; transition: width 0.4s ease; }
.pct { font-size: 12px; color: rgba(255,255,255,0.3); margin-top: 6px; }
</style></head><body>
<div class="logo"><svg width="40" height="40" viewBox="0 0 24 24"><path d="M5 20h14v2H5v-2zm1-2h12l1-4h-3V8h1V4h-2V2H10v2H8v4h1v6H6l1 4zm3-6V8h6v4h-6z" fill="rgba(255,255,255,0.6)"/></svg></div>
<h1 id="msg">Atualizando MultiPrime...</h1>
<p id="sub">O aplicativo será reiniciado automaticamente</p>
<div class="bar-bg"><div class="bar-fill" id="bar"></div></div>
<div class="pct" id="pct">0%</div>
</body></html>`));
    };

    const updateScreenProgress = (message, percent) => {
        if (lovableView.webContents.isDestroyed()) return;
        lovableView.webContents.executeJavaScript(`
            try {
                document.getElementById('msg').textContent = '${message.replace(/'/g, "\\'")}';
                document.getElementById('bar').style.width = '${Math.round(percent)}%';
                document.getElementById('pct').textContent = '${Math.round(percent)}%';
            } catch(e) {}
        `).catch(() => {});
    };

    let updateFound = false;
    let lovableLoaded = false;
    let fallback = null;
    let downloadTimeout = null;

    const safeLoadLovable = () => {
        if (lovableLoaded || updateFound) return;
        lovableLoaded = true;
        clearTimeout(fallback);
        loadLovable();
    };

    const abortUpdateAndLoad = (reason) => {
        console.warn(`[APP-UPDATER] Abortando update: ${reason}`);
        clearTimeout(downloadTimeout);
        updateFound = false;
        updateScreenLoaded = false;
        safeLoadLovable();
    };

    autoUpdater.on('update-available', (info) => {
        updateFound = true;
        clearTimeout(fallback);
        console.log(`[APP-UPDATER] ✅ Nova versão: ${info.version}. Baixando...`);
        loadUpdateScreen();
        autoUpdater.downloadUpdate().catch(err => {
            abortUpdateAndLoad(`Falha ao iniciar download: ${err.message}`);
        });
        downloadTimeout = setTimeout(() => {
            abortUpdateAndLoad('Download timeout (2 min)');
        }, 120000);
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[APP-UPDATER] Versão mais recente.');
        safeLoadLovable();
    });

    autoUpdater.on('download-progress', (progress) => {
        const pct = Math.round(progress.percent);
        if (pct % 10 === 0) console.log(`[APP-UPDATER] Baixando: ${pct}%`);
        updateScreenProgress('Baixando atualização...', pct);
    });

    autoUpdater.on('update-downloaded', (info) => {
        clearTimeout(downloadTimeout);
        console.log(`[APP-UPDATER] ✅ Versão ${info.version} pronta. Reiniciando...`);
        updateScreenProgress('Instalando... Reiniciando em instantes', 100);

        setTimeout(() => {
            try {
                autoUpdater.quitAndInstall(false, true);
            } catch (err) {
                console.error('[APP-UPDATER] Erro quitAndInstall:', err);
                try { require('electron').app.quit(); } catch {}
            }
        }, 2000);

        setTimeout(() => {
            console.warn('[APP-UPDATER] Fallback: forçando saída');
            process.exit(0);
        }, 10000);
    });

    autoUpdater.on('error', (err) => {
        console.warn('[APP-UPDATER] Erro (não crítico):', err.message);
        clearTimeout(downloadTimeout);
        if (updateFound) {
            abortUpdateAndLoad(`Erro no updater: ${err.message}`);
        } else {
            safeLoadLovable();
        }
    });

    fallback = setTimeout(safeLoadLovable, 5000);

    autoUpdater.checkForUpdates().catch(() => safeLoadLovable());
}

module.exports = { setupAutoUpdater };
