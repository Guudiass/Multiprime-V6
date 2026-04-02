/* eslint-disable no-undef */
// src/utils.js — Funções utilitárias

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const state = require('./state');
const { TOTAL_HEADER_HEIGHT, DOWNLOADS_PANEL_WIDTH } = require('./config');

function withAlive(win, fn) {
    try { if (win && !win.isDestroyed()) fn(win); } catch {}
}

function isNonFatalNavError(errOrCode) {
    const nonFatalCodes = [
        -3, -375, -310, -102, -105, -106, -109, -118, -137, -200, -201, -202, -501
    ];

    if (typeof errOrCode === 'number') return nonFatalCodes.includes(errOrCode);
    if (!errOrCode) return false;

    const errno = errOrCode.errno || errOrCode.errorCode;
    if (errno && nonFatalCodes.includes(errno)) return true;

    const code = errOrCode.code || '';
    return code === 'ERR_ABORTED' || code.startsWith('ERR_TOO_MANY') ||
           code.startsWith('ERR_CONNECTION') || code.startsWith('ERR_CERT') ||
           code.startsWith('ERR_NAME') || code === 'ERR_INTERNET_DISCONNECTED' ||
           code === 'ERR_INSECURE_RESPONSE' || code === 'ERR_ADDRESS_UNREACHABLE';
}

function findUniquePath(proposedPath) {
    if (!fs.existsSync(proposedPath)) return proposedPath;
    const { dir, name, ext } = path.parse(proposedPath);
    let counter = 1, newPath;
    do { newPath = path.join(dir, `${name} (${counter})${ext}`); counter++; } while (fs.existsSync(newPath));
    return newPath;
}

function getViewBounds(win, panelOpen) {
    const { width, height } = win.getContentBounds();
    const viewWidth = panelOpen ? Math.max(400, width - DOWNLOADS_PANEL_WIDTH) : width;
    return { x: 0, y: TOTAL_HEADER_HEIGHT, width: viewWidth, height: height - TOTAL_HEADER_HEIGHT };
}

function updateViewBounds() {
    if (!state.browserWindow || state.browserWindow.isDestroyed() || !state.activeTabId) return;
    const tab = state.tabs.get(state.activeTabId);
    if (!tab) return;
    tab.view.setBounds(getViewBounds(state.browserWindow, tab.downloadsPanelOpen));
}

function injectSiteFixes(webContents) {
    if (webContents.isDestroyed()) return;

    try {
        const currentUrl = webContents.getURL();
        const hostname = new URL(currentUrl).hostname;

        if (hostname.includes('chatgpt.com') || hostname.includes('chat.openai.com')) {
            webContents.insertCSS(`
                [role="dialog"][data-state="open"] {
                    position: fixed !important;
                    inset: 0 !important;
                    top: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    max-width: none !important;
                    max-height: none !important;
                    transform: none !important;
                    translate: none !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    z-index: 9999 !important;
                    grid-column: 1 / -1 !important;
                    grid-row: 1 / -1 !important;
                    inset-inline-start: 0 !important;
                }
                [data-state="open"][role="dialog"] ~ div[data-state="open"],
                div:has(> [role="dialog"][data-state="open"]) {
                    position: fixed !important;
                    inset: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    z-index: 9998 !important;
                }
            `).then(() => {}).catch(() => {});
        }
    } catch (e) {}
}

async function limparParticoesAntigas() {
    const partitionsPath = path.join(app.getPath('userData'), 'Partitions');
    try {
        if (!fs.existsSync(partitionsPath)) return;
        const items = await fsPromises.readdir(partitionsPath);
        const deletePromises = items
            .filter(item => item.startsWith('profile_'))
            .map(item => fsPromises.rm(path.join(partitionsPath, item), { recursive: true, force: true }));
        if (deletePromises.length > 0) {
            await Promise.allSettled(deletePromises);
        }
    } catch (err) { console.error('[LIMPEZA] Erro:', err); }
}

module.exports = {
    withAlive,
    isNonFatalNavError,
    findUniquePath,
    getViewBounds,
    updateViewBounds,
    injectSiteFixes,
    limparParticoesAntigas
};
