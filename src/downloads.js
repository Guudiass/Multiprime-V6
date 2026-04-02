/* eslint-disable no-undef */
// src/downloads.js — Gerenciamento de downloads

const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const state = require('./state');
const { findUniquePath } = require('./utils');
const { logEvent } = require('./status');

// Fila global de dialogos de download (compartilhada entre abas)
const dlTempDir = path.join(app.getPath('temp'), 'multiprime-downloads');
let dlDialogQueue = [];
let dlDialogBusy = false;

function setupDownloadManager(view, isolatedSession) {
    if (!fs.existsSync(dlTempDir)) fs.mkdirSync(dlTempDir, { recursive: true });

    const getPerfilId = () => {
        for (const [, tab] of state.tabs) {
            if (tab.view === view) return tab.perfil?.id;
        }
        return null;
    };

    function sendDl(channel, data) {
        if (state.browserWindow && !state.browserWindow.isDestroyed()) {
            state.browserWindow.webContents.send(channel, data);
        }
    }

    async function processDialogQueue() {
        if (dlDialogBusy || dlDialogQueue.length === 0) return;
        dlDialogBusy = true;

        const { tempPath, filename, downloadId } = dlDialogQueue.shift();
        const parsedName = path.parse(filename);
        const extNoDot = parsedName.ext ? parsedName.ext.replace('.', '') : '*';

        try {
            const win = state.browserWindow && !state.browserWindow.isDestroyed() ? state.browserWindow : null;
            if (!win) { try { fs.unlinkSync(tempPath); } catch {} dlDialogBusy = false; processDialogQueue(); return; }

            const { canceled, filePath } = await dialog.showSaveDialog(win, {
                title: 'Salvar download como...',
                defaultPath: path.join(app.getPath('downloads'), filename),
                filters: [
                    { name: `Arquivo ${extNoDot.toUpperCase()}`, extensions: [extNoDot] },
                    { name: 'Todos os arquivos', extensions: ['*'] }
                ]
            });

            if (canceled || !filePath) {
                try { fs.unlinkSync(tempPath); } catch {}
            } else {
                moveFileToFinal(tempPath, filePath, downloadId);
            }
        } catch {
            try { fs.unlinkSync(tempPath); } catch {}
        }

        dlDialogBusy = false;
        processDialogQueue();
    }

    isolatedSession.on('will-download', (event, item) => {
        if (!state.browserWindow || state.browserWindow.isDestroyed()) return item.cancel();

        const url = item.getURL();
        const isBlob = url.startsWith('blob:');

        let filename = item.getFilename();
        if (!filename) {
            const mimeType = item.getMimeType();
            let ext = '.tmp';
            if (mimeType === 'audio/mpeg') ext = '.mp3';
            else if (mimeType?.includes('wav')) ext = '.wav';
            else if (mimeType === 'audio/aac') ext = '.aac';
            else if (mimeType === 'application/zip') ext = '.zip';
            else if (mimeType === 'application/pdf') ext = '.pdf';
            else if (mimeType?.includes('mp4')) ext = '.mp4';
            else if (mimeType?.includes('webm')) ext = '.webm';
            else if (mimeType?.includes('png')) ext = '.png';
            else if (mimeType?.includes('jpeg') || mimeType?.includes('jpg')) ext = '.jpg';
            else if (mimeType?.includes('gif')) ext = '.gif';
            else if (mimeType?.includes('svg')) ext = '.svg';
            filename = `download-${Date.now()}${ext}`;
        }

        const downloadId = `dl-${crypto.randomUUID()}`;

        if (isBlob) {
            const downloadsPath = findUniquePath(path.join(app.getPath('downloads'), filename));
            item.setSavePath(downloadsPath);
            sendDl('download-started', { id: downloadId, filename });

            item.on('updated', (e, dlState) => {
                const total = item.getTotalBytes();
                if (total <= 0 || dlState !== 'progressing') return;
                sendDl('download-progress', { id: downloadId, progress: Math.round((item.getReceivedBytes() / total) * 100) });
            });

            item.on('done', (e, dlState) => {
                if (dlState !== 'completed') { try { fs.unlinkSync(downloadsPath); } catch {} }
                sendDl('download-complete', {
                    id: downloadId, state: dlState,
                    path: dlState === 'completed' ? downloadsPath : null,
                    progress: dlState === 'completed' ? 100 : 0
                });
                logEvent(dlState === 'completed' ? 'download_complete' : 'download_failed', { perfilId: getPerfilId(), filename });
            });

        } else {
            const tempPath = path.join(dlTempDir, `${crypto.randomUUID()}_${filename}`);
            item.setSavePath(tempPath);
            sendDl('download-started', { id: downloadId, filename });

            let lastProgress = 0, lastUpdate = 0;
            item.on('updated', (e, dlState) => {
                if (dlState !== 'progressing') return;
                const total = item.getTotalBytes();
                if (total <= 0) return;
                const progress = Math.round((item.getReceivedBytes() / total) * 100);
                const now = Date.now();
                if (progress > lastProgress && now - lastUpdate > 250) {
                    sendDl('download-progress', { id: downloadId, progress });
                    lastProgress = progress;
                    lastUpdate = now;
                }
            });

            item.on('done', (e, dlState) => {
                if (dlState !== 'completed') {
                    try { fs.unlinkSync(tempPath); } catch {}
                    sendDl('download-complete', { id: downloadId, state: dlState, path: null, progress: 0 });
                    logEvent('download_failed', { perfilId: getPerfilId(), filename });
                    return;
                }
                logEvent('download_complete', { perfilId: getPerfilId(), filename });
                dlDialogQueue.push({ tempPath, filename, downloadId });
                processDialogQueue();
            });
        }
    });
}

function moveFileToFinal(tempPath, destPath, downloadId) {
    const sendDl = (data) => {
        if (state.browserWindow && !state.browserWindow.isDestroyed()) {
            state.browserWindow.webContents.send('download-complete', data);
        }
    };
    try {
        const finalPath = findUniquePath(destPath);
        try { fs.renameSync(tempPath, finalPath); }
        catch { fs.copyFileSync(tempPath, finalPath); try { fs.unlinkSync(tempPath); } catch {} }
        sendDl({ id: downloadId, state: 'completed', path: finalPath, progress: 100 });
    } catch (err) {
        console.error('[DOWNLOAD] Erro ao mover arquivo:', err);
        sendDl({ id: downloadId, state: 'interrupted', path: tempPath, progress: 100 });
    }
}

module.exports = { setupDownloadManager };
