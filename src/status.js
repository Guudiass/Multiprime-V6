/* eslint-disable no-undef */
// src/status.js — Status panel e log de eventos (Lovable integration)

const state = require('./state');

function sendToLovable(channel, data) {
    if (state.lovableView && !state.lovableView.webContents.isDestroyed()) {
        state.lovableView.webContents.send(channel, data);
    }
}

function logEvent(type, data) {
    const event = { type, timestamp: Date.now(), ...data };
    sendToLovable('mp-event-log', event);
    console.log(`[EVENT] ${type}`, JSON.stringify(data || {}));
}

function startHeartbeat() {
    if (state.heartbeatInterval) return;
    state.heartbeatInterval = setInterval(() => {
        const openTabs = [];
        for (const [tabId, tab] of state.tabs) {
            openTabs.push({ tabId, perfilId: tab.perfil?.id, url: tab.url, title: tab.title });
        }
        sendToLovable('mp-heartbeat', { timestamp: Date.now(), openTabs });
    }, 600000); // a cada 10 minutos
}

function stopHeartbeat() {
    if (state.heartbeatInterval) {
        clearInterval(state.heartbeatInterval);
        state.heartbeatInterval = null;
    }
}

module.exports = { sendToLovable, logEvent, startHeartbeat, stopHeartbeat };
