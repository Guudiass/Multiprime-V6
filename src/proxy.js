/* eslint-disable no-undef */
// src/proxy.js — Validação, fallback e autenticação de proxy

const state = require('./state');
const { logEvent } = require('./status');

function validateProxyConfig(proxy) {
    if (!proxy || !proxy.host || !proxy.port) return { valid: false, error: 'Host e porta obrigatórios' };
    const validTypes = ['http', 'https', 'socks', 'socks4', 'socks5'];
    const proxyType = proxy.tipo?.toLowerCase() || 'http';
    if (!validTypes.includes(proxyType)) return { valid: false, error: `Tipo inválido: ${proxy.tipo}` };
    const port = parseInt(proxy.port);
    if (isNaN(port) || port < 1 || port > 65535) return { valid: false, error: 'Porta inválida' };
    return { valid: true, type: proxyType, port };
}

function buildProxyRules(proxy) {
    const validation = validateProxyConfig(proxy);
    if (!validation.valid) return null;
    const t = validation.type;
    if (t === 'socks5' || t === 'socks') return `socks5://${proxy.host}:${validation.port}`;
    if (t === 'socks4') return `socks4://${proxy.host}:${validation.port}`;
    return `http://${proxy.host}:${validation.port}`;
}

async function switchToNextProxy(viewId) {
    const proxyState = state.proxyFallbackState.get(viewId);
    if (!proxyState) return false;

    proxyState.currentIndex++;
    if (proxyState.currentIndex >= proxyState.fallbacks.length) {
        console.error(`[PROXY FALLBACK] ❌ Todos os proxies falharam para view ${viewId}`);
        logEvent('proxy_all_failed', { perfilId: proxyState.perfil?.id, viewId });
        return false;
    }

    const nextProxy = proxyState.fallbacks[proxyState.currentIndex];
    const proxyRules = buildProxyRules(nextProxy);
    if (!proxyRules) {
        console.warn(`[PROXY FALLBACK] Proxy inválido no index ${proxyState.currentIndex}, tentando próximo...`);
        return switchToNextProxy(viewId);
    }

    const bypass = [nextProxy.bypass || '', '*.envatousercontent.com'].filter(Boolean).join(',');
    await proxyState.session.setProxy({ proxyRules, proxyBypassRules: bypass });

    state.proxyCredentials.delete(viewId);
    if (nextProxy.username) {
        state.proxyCredentials.set(viewId, {
            username: nextProxy.username,
            password: nextProxy.password ?? ''
        });
    }

    for (const [key] of state.proxyAuthAttempts) {
        if (key.startsWith(`${viewId}-`)) state.proxyAuthAttempts.delete(key);
    }

    logEvent('proxy_fallback_success', { perfilId: proxyState.perfil?.id, viewId, proxy: `${nextProxy.host}:${nextProxy.port}`, index: proxyState.currentIndex });
    return true;
}

const nossoManipuladorDeLogin = (event, webContents, request, authInfo, callback) => {
    if (!authInfo.isProxy) return callback();
    event.preventDefault();

    const wcId = webContents?.id ?? 'N/A';
    const host = `${authInfo.host}:${authInfo.port}`;

    const key = `${wcId}-${host}`;
    const attempts = (state.proxyAuthAttempts.get(key) || 0) + 1;
    state.proxyAuthAttempts.set(key, attempts);

    if (attempts > 3) {
        console.error(`[PROXY AUTH] ❌ Máximo de tentativas atingido para ${host} (wcId: ${wcId}). Tentando fallback...`);
        logEvent('proxy_auth_failed', { viewId: wcId, host });
        state.proxyAuthAttempts.delete(key);

        switchToNextProxy(wcId).then(switched => {
            if (switched) {
                try { if (!webContents.isDestroyed()) webContents.reload(); } catch {}
            } else {
                console.error(`[PROXY AUTH] ❌ Sem fallbacks restantes para view ${wcId}`);
            }
        });

        callback();
        return;
    }

    const credentials = state.proxyCredentials.get(wcId);

    if (credentials) {
        callback(credentials.username, credentials.password);
    } else {
        console.error(`[PROXY AUTH] ❌ NENHUMA credencial para wcId ${wcId} (host: ${host})`);
        callback();
    }
};

module.exports = {
    validateProxyConfig,
    buildProxyRules,
    switchToNextProxy,
    nossoManipuladorDeLogin
};
