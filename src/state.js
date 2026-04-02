// src/state.js — Estado compartilhado entre módulos

module.exports = {
    browserWindow: null,
    lovableView: null,
    activeTabId: null,
    currentTema: 'dark',
    CAPSOLVER_API_KEY: null,
    tabs: new Map(),
    perfilIdToTab: new Map(),
    proxyCredentials: new Map(),
    proxyFallbackState: new Map(),
    proxyAuthAttempts: new Map(),
    heartbeatInterval: null
};
