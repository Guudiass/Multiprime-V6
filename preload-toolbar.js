/* eslint-disable no-undef */
// preload-toolbar.js
// Preload para a janela principal (toolbar).
// Expõe uma API segura via contextBridge para o toolbar.html controlar a navegação.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toolbarAPI', {
    // Navegação
    navigateBack:    () => ipcRenderer.send('navigate-back'),
    navigateForward: () => ipcRenderer.send('navigate-forward'),
    navigateReload:  () => ipcRenderer.send('navigate-reload'),
    navigateToUrl:   (url) => ipcRenderer.send('navigate-to-url', url),

    // Janela
    minimize: () => ipcRenderer.send('minimize-secure-window'),
    maximize: () => ipcRenderer.send('maximize-secure-window'),
    close:    () => ipcRenderer.send('close-secure-window'),

    // Downloads
    openDownload: (filePath) => ipcRenderer.send('open-download', filePath),
    showInFolder: (filePath) => ipcRenderer.send('show-download-in-folder', filePath),
    toggleDownloadsPanel: (isOpen) => ipcRenderer.send('downloads-panel-toggle', isOpen),

    // Solicitar URL inicial
    requestInitialUrl: () => ipcRenderer.send('request-initial-url'),

    // Listeners
    onUrlUpdated: (callback) => {
        ipcRenderer.on('url-updated', (event, url) => callback(url));
    },
    onPageLoading: (callback) => {
        ipcRenderer.on('page-loading', (event, isLoading) => callback(isLoading));
    },
    onDownloadStarted: (callback) => {
        ipcRenderer.on('download-started', (event, data) => callback(data));
    },
    onDownloadProgress: (callback) => {
        ipcRenderer.on('download-progress', (event, data) => callback(data));
    },
    onDownloadComplete: (callback) => {
        ipcRenderer.on('download-complete', (event, data) => callback(data));
    },

    // Exportação de sessão
    exportSession: (storageData) => ipcRenderer.send('initiate-full-session-export', storageData)
});

console.log('[PRELOAD-TOOLBAR] API da toolbar carregada.');
