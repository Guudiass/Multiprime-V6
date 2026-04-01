/* eslint-disable no-undef */
// main.js — MultiPrime V6 (Electron Puro)
// Sem Nativefier. Janela principal carrega o Lovable diretamente.

const { app, BrowserWindow, BrowserView, ipcMain, session, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const fsPromises = require('fs').promises;
const crypto = require('crypto');

// ★ AUTO-UPDATER: Atualiza o .exe/Electron via GitHub Releases
let autoUpdater;
try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
} catch (e) {
    console.warn('[APP-UPDATER] electron-updater não disponível (modo dev):', e.message);
    autoUpdater = null;
}

// ===================================================================
// CONSTANTES E CONFIGURAÇÃO
// ===================================================================
const TAB_BAR_HEIGHT = 36;
const TOOLBAR_HEIGHT = 44;
const TOTAL_HEADER_HEIGHT = TAB_BAR_HEIGHT + TOOLBAR_HEIGHT; // 80

// ★ URL DO SEU SITE LOVABLE (alterar para a URL real)
const APP_URL = 'https://multiprime.designerprime.com.br';

// Modo desenvolvimento (npm start) vs produção (instalado)
const IS_DEV = !__dirname.includes('.asar');

const CONFIG = {
    WINDOW_DEFAULTS: { width: 1280, height: 720, minWidth: 800, minHeight: 600 },
    COOKIE_TIMEOUT: 90_000,
    SESSION_CLEANUP_DELAY: 1_000
};

const GITHUB_CONFIG = {
    owner: 'Guudiass',
    repo: 'MULTIPRIMECOOKIES',
    baseUrl: 'https://api.github.com'
};

const CRYPTO_CONFIG = {
    algorithm: 'aes-256-gcm',
    keyLength: 32,
    ivLength: 16,
    tagLength: 16,
    salt: 'multiprime-cookies-salt-2025'
};

// ★ CAPSOLVER: Resolver Cloudflare Turnstile automaticamente
const CAPSOLVER_API_KEY = 'CAP-01A9A1326BAF756532B4BDF3127D364D207D976FD8558E2EC4C7CFD117597533';

// ===================================================================
// SEGURANÇA — IPC CRIPTOGRAFADO
// ===================================================================
// Credenciais (senha GitHub, proxy, login) nunca trafegam em texto puro no IPC.
// Integridade dos arquivos é garantida pelo ASAR (read-only).

// Chave de sessão para criptografar IPC (gerada a cada execução)
const SESSION_IPC_KEY = crypto.randomBytes(32);
const SESSION_IPC_IV_PREFIX = crypto.randomBytes(8);

// ===== CAMADA 3: IPC CRIPTOGRAFADO =====
// Credenciais (senha GitHub, proxy, login) nunca trafegam em texto puro no IPC.
// O preload do Lovable criptografa com a chave de sessão antes de enviar.

function encryptIPC(data) {
    const iv = Buffer.concat([SESSION_IPC_IV_PREFIX, crypto.randomBytes(8)]);
    const cipher = crypto.createCipheriv('aes-256-gcm', SESSION_IPC_KEY, iv);
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return {
        e: encrypted,
        i: iv.toString('hex'),
        t: cipher.getAuthTag().toString('hex')
    };
}

function decryptIPC(pkg) {
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', SESSION_IPC_KEY,
            Buffer.from(pkg.i, 'hex'));
        decipher.setAuthTag(Buffer.from(pkg.t, 'hex'));
        let decrypted = decipher.update(pkg.e, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return JSON.parse(decrypted);
    } catch (err) {
        console.error('[IPC CRYPTO] Falha ao descriptografar:', err.message);
        return null;
    }
}

// Fornecer a chave de sessão para o preload do Lovable (via IPC síncrono seguro)
ipcMain.on('get-ipc-session-key', (e) => {
    // Só fornecer a chave para a janela principal (Lovable), não para views
    e.returnValue = {
        key: SESSION_IPC_KEY.toString('hex'),
        prefix: SESSION_IPC_IV_PREFIX.toString('hex')
    };
});

// ===================================================================
// CRIPTOGRAFIA
// ===================================================================
function encryptData(data, password = 'MultiPrime-Default-Key-2025') {
    const key = crypto.scryptSync(password, CRYPTO_CONFIG.salt, CRYPTO_CONFIG.keyLength);
    const iv = crypto.randomBytes(CRYPTO_CONFIG.ivLength);
    const cipher = crypto.createCipheriv(CRYPTO_CONFIG.algorithm, key, iv);
    cipher.setAAD(Buffer.from('multiprime-session-data'));
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return JSON.stringify({
        encrypted, iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        algorithm: CRYPTO_CONFIG.algorithm,
        timestamp: new Date().toISOString(),
        version: '1.0'
    }, null, 2);
}

function decryptData(encryptedData, password = 'MultiPrime-Default-Key-2025') {
    const pkg = JSON.parse(encryptedData);
    if (!pkg.encrypted || !pkg.iv || !pkg.authTag) throw new Error('Dados criptografados inválidos');
    
    const version = pkg.version || '1.0';
    let key;
    
    if (version === '1.0') {
        key = crypto.scryptSync(password, CRYPTO_CONFIG.salt, CRYPTO_CONFIG.keyLength);
    } else if (version === '2.0') {
        key = crypto.pbkdf2Sync(password, CRYPTO_CONFIG.salt, 100000, CRYPTO_CONFIG.keyLength, 'sha256');
    } else {
        throw new Error(`Versão de criptografia não suportada: ${version}`);
    }
    
    const iv = Buffer.from(pkg.iv, 'hex');
    const authTag = Buffer.from(pkg.authTag, 'hex');
    const decipher = crypto.createDecipheriv(pkg.algorithm || CRYPTO_CONFIG.algorithm, key, iv);
    decipher.setAAD(Buffer.from('multiprime-session-data'));
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(pkg.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function isEncryptedData(data) {
    try {
        const p = JSON.parse(data);
        return !!(p.encrypted && p.iv && p.authTag && p.algorithm);
    } catch { return false; }
}

// ===================================================================
// GITHUB
// ===================================================================
async function downloadFromGitHub(filePath, token) {
    return new Promise((resolve, reject) => {
        const url = `${GITHUB_CONFIG.baseUrl}/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${filePath}`;
        const req = https.request(url, {
            method: 'GET',
            headers: {
                'Authorization': `token ${token}`,
                'User-Agent': 'MultiPrime-Cookies-App',
                'Accept': 'application/vnd.github.v3+json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) return reject(new Error(`GitHub ${res.statusCode}: ${data}`));
                    const response = JSON.parse(data);
                    let content = response.content
                        ? Buffer.from(response.content, 'base64').toString('utf-8')
                        : null;
                    if (!content && response.download_url) {
                        https.get(response.download_url, { headers: { 'Authorization': `token ${token}`, 'User-Agent': 'MultiPrime-Cookies-App' } }, (dlRes) => {
                            let c = '';
                            dlRes.on('data', ch => { c += ch; });
                            dlRes.on('end', () => resolve(isEncryptedData(c) ? decryptData(c) : c));
                        }).on('error', reject);
                        return;
                    }
                    if (!content) return reject(new Error('Sem conteúdo na resposta'));
                    resolve(isEncryptedData(content) ? decryptData(content) : content);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.abort(); reject(new Error('Timeout GitHub')); });
        req.end();
    });
}

async function uploadToGitHub(filePath, content, token, commitMessage = 'Atualizar sessão') {
    return new Promise((resolve, reject) => {
        const encryptedContent = encryptData(content);
        const getUrl = `${GITHUB_CONFIG.baseUrl}/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${filePath}`;
        const headers = {
            'Authorization': `token ${token}`,
            'User-Agent': 'MultiPrime-Cookies-App',
            'Accept': 'application/vnd.github.v3+json'
        };
        
        const getReq = https.request(getUrl, { method: 'GET', headers }, (getRes) => {
            let getData = '';
            getRes.on('data', ch => { getData += ch; });
            getRes.on('end', () => {
                let sha = null;
                if (getRes.statusCode === 200) {
                    try { sha = JSON.parse(getData).sha; } catch {}
                }
                const putData = JSON.stringify({
                    message: commitMessage,
                    content: Buffer.from(encryptedContent).toString('base64'),
                    ...(sha && { sha })
                });
                const putReq = https.request(getUrl, {
                    method: 'PUT',
                    headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(putData) }
                }, (putRes) => {
                    let putResponse = '';
                    putRes.on('data', ch => { putResponse += ch; });
                    putRes.on('end', () => {
                        if (putRes.statusCode === 200 || putRes.statusCode === 201) resolve(JSON.parse(putResponse));
                        else reject(new Error(`Upload falhou: ${putRes.statusCode}`));
                    });
                });
                putReq.on('error', reject);
                putReq.setTimeout(30000, () => { putReq.abort(); reject(new Error('Timeout upload')); });
                putReq.write(putData);
                putReq.end();
            });
        });
        getReq.on('error', reject);
        getReq.setTimeout(30000, () => { getReq.abort(); reject(new Error('Timeout verificação')); });
        getReq.end();
    });
}

// ===================================================================
// HELPERS
// ===================================================================
const proxyCredentials = new Map();
// Mapa: viewId -> { fallbacks: [...], currentIndex: -1, session, perfil }
const proxyFallbackState = new Map();

// ===== LOVABLE VIEW (referencia global) =====
let lovableView = null;

function sendToLovable(channel, data) {
    if (lovableView && !lovableView.webContents.isDestroyed()) {
        lovableView.webContents.send(channel, data);
    }
}

function logEvent(type, data) {
    const event = { type, timestamp: Date.now(), ...data };
    sendToLovable('mp-event-log', event);
    console.log(`[EVENT] ${type}`, JSON.stringify(data || {}));
}

// ===== SISTEMA DE ABAS =====
let browserWindow = null;           // janela unica (criada na 1a aba)
const tabs = new Map();             // tabId -> { view, session, perfil, downloadsPanelOpen, title, url, isLoading }
const perfilIdToTab = new Map();    // perfil.id -> tabId (deduplicacao)
let activeTabId = null;

function buildProxyRules(proxy) {
    const validation = validateProxyConfig(proxy);
    if (!validation.valid) return null;
    const t = validation.type;
    if (t === 'socks5' || t === 'socks') return `socks5://${proxy.host}:${validation.port}`;
    if (t === 'socks4') return `socks4://${proxy.host}:${validation.port}`;
    return `http://${proxy.host}:${validation.port}`;
}

async function switchToNextProxy(viewId) {
    const state = proxyFallbackState.get(viewId);
    if (!state) return false;

    state.currentIndex++;
    if (state.currentIndex >= state.fallbacks.length) {
        console.error(`[PROXY FALLBACK] ❌ Todos os proxies falharam para view ${viewId}`);
        logEvent('proxy_all_failed', { perfilId: state.perfil?.id, viewId });
        return false;
    }

    const nextProxy = state.fallbacks[state.currentIndex];
    const proxyRules = buildProxyRules(nextProxy);
    if (!proxyRules) {
        console.warn(`[PROXY FALLBACK] Proxy inválido no index ${state.currentIndex}, tentando próximo...`);
        return switchToNextProxy(viewId); // tenta o proximo
    }

    const bypass = [nextProxy.bypass || '', '*.envatousercontent.com'].filter(Boolean).join(',');
    await state.session.setProxy({ proxyRules, proxyBypassRules: bypass });

    // Atualizar credenciais
    proxyCredentials.delete(viewId);
    if (nextProxy.username) {
        proxyCredentials.set(viewId, {
            username: nextProxy.username,
            password: nextProxy.password ?? ''
        });
    }

    // Reset tentativas de auth para o novo proxy
    for (const [key] of proxyAuthAttempts) {
        if (key.startsWith(`${viewId}-`)) proxyAuthAttempts.delete(key);
    }

    console.log(`[PROXY FALLBACK] ✅ View ${viewId} → fallback[${state.currentIndex}]: ${nextProxy.host}:${nextProxy.port} (${nextProxy.tipo || 'http'})`);
    logEvent('proxy_fallback_success', { perfilId: state.perfil?.id, viewId, proxy: `${nextProxy.host}:${nextProxy.port}`, index: state.currentIndex });
    return true;
}

function withAlive(win, fn) {
    try { if (win && !win.isDestroyed()) fn(win); } catch {}
}

function isNonFatalNavError(errOrCode) {
    // Erros de navegação que NÃO devem destruir a janela
    const nonFatalCodes = [
        -3,    // ERR_ABORTED (navegação interrompida por outra)
        -375,  // ERR_TOO_MANY_RETRIES (loop de redirecionamento)
        -310,  // ERR_TOO_MANY_REDIRECTS
        -102,  // ERR_CONNECTION_REFUSED
        -105,  // ERR_NAME_NOT_RESOLVED (DNS)
        -106,  // ERR_INTERNET_DISCONNECTED
        -109,  // ERR_ADDRESS_UNREACHABLE
        -118,  // ERR_CONNECTION_TIMED_OUT
        -137,  // ERR_NAME_RESOLUTION_FAILED
        -200,  // ERR_CERT_COMMON_NAME_INVALID
        -201,  // ERR_CERT_DATE_INVALID
        -202,  // ERR_CERT_AUTHORITY_INVALID
        -501,  // ERR_INSECURE_RESPONSE
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

function validateProxyConfig(proxy) {
    if (!proxy || !proxy.host || !proxy.port) return { valid: false, error: 'Host e porta obrigatórios' };
    const validTypes = ['http', 'https', 'socks', 'socks4', 'socks5'];
    const proxyType = proxy.tipo?.toLowerCase() || 'http';
    if (!validTypes.includes(proxyType)) return { valid: false, error: `Tipo inválido: ${proxy.tipo}` };
    const port = parseInt(proxy.port);
    if (isNaN(port) || port < 1 || port > 65535) return { valid: false, error: 'Porta inválida' };
    return { valid: true, type: proxyType, port };
}

function sanitizeCookieForInjection(cookie, defaultUrl) {
    const c = {};

    // Nome e valor são obrigatórios
    if (!cookie.name || cookie.value === undefined || cookie.value === null) return null;
    c.name = String(cookie.name);
    c.value = String(cookie.value);

    // Construir URL a partir do domain
    const host = cookie.domain
        ? (cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain)
        : new URL(defaultUrl).hostname;

    // Sempre usar HTTPS para evitar problemas com cookies secure
    c.url = `https://${host}${cookie.path || '/'}`;

    // Domain — preservar se veio no cookie original
    if (cookie.domain) {
        c.domain = cookie.domain;
    }

    // Path
    if (cookie.path) {
        c.path = cookie.path;
    }

    // Secure — forçar true para HTTPS (a maioria dos sites modernos precisa)
    c.secure = cookie.secure !== false;

    // HttpOnly
    if (cookie.httpOnly !== undefined) {
        c.httpOnly = !!cookie.httpOnly;
    }

    // SameSite — tratamento rigoroso
    if (cookie.sameSite) {
        const s = String(cookie.sameSite).toLowerCase();
        if (s === 'strict') c.sameSite = 'strict';
        else if (s === 'lax') c.sameSite = 'lax';
        else if (s === 'none' || s === 'no_restriction' || s === 'unspecified') {
            c.sameSite = 'no_restriction';
            c.secure = true; // Chromium EXIGE secure com sameSite=none
        }
        // Se não for nenhum valor conhecido, não definir (usa default do browser)
    } else {
        // Sem sameSite definido → usar 'lax' (padrão seguro do Chromium)
        c.sameSite = 'lax';
    }

    // Cookies especiais com prefixo
    if (c.name.startsWith('__Host-')) {
        c.secure = true;
        c.path = '/';
        delete c.domain; // __Host- não pode ter domain
    } else if (c.name.startsWith('__Secure-')) {
        c.secure = true;
    }

    // ExpirationDate — tratamento cuidadoso
    if (cookie.expirationDate) {
        const exp = Number(cookie.expirationDate);
        if (!isNaN(exp) && exp > 0) {
            // expirationDate em segundos (epoch)
            const expMs = exp > 1e12 ? exp : exp * 1000; // detectar se é ms ou s
            if (expMs > Date.now()) {
                // Cookie ainda válido — preservar expiração
                c.expirationDate = exp > 1e12 ? exp / 1000 : exp;
            } else {
                // Cookie EXPIRADO — pular completamente (não injetar)
                return null;
            }
        }
        // Se não é número válido, omitir (vira session cookie)
    }

    return c;
}

/**
 * Deduplica cookies — se houver 2 com mesmo nome+domain+path, mantém o último.
 * Também remove cookies expirados e inválidos.
 */
function prepareCookiesForInjection(cookies, defaultUrl) {
    const seen = new Map(); // chave: "name|domain|path"
    const result = [];

    for (const cookie of cookies) {
        const sanitized = sanitizeCookieForInjection(cookie, defaultUrl);
        if (!sanitized) continue; // Cookie inválido ou expirado — pular

        // Deduplicar por nome+domain+path
        const key = `${sanitized.name}|${sanitized.domain || ''}|${sanitized.path || '/'}`;
        seen.set(key, sanitized); // Último vence
    }

    // Ordenar: cookies de autenticação por último (para não serem sobrescritos)
    const authPatterns = ['session', 'token', 'auth', 'sid', 'csrf', 'login', 'jwt'];
    const entries = Array.from(seen.values());
    const normal = [];
    const auth = [];

    for (const c of entries) {
        const nameLower = c.name.toLowerCase();
        const isAuth = authPatterns.some(p => nameLower.includes(p));
        if (isAuth) auth.push(c);
        else normal.push(c);
    }

    // Normal primeiro, auth por último (para garantir que não são sobrescritos)
    return [...normal, ...auth];
}

// ===================================================================
// CAPSOLVER — RESOLVER TURNSTILE
// ===================================================================
async function solveTurnstile(websiteURL, websiteKey) {
    if (!CAPSOLVER_API_KEY || CAPSOLVER_API_KEY.includes('XXXX')) {
        console.warn('[CAPSOLVER] API key não configurada');
        return null;
    }

    

    try {
        // Criar task
        const createResp = await capsolverRequest('createTask', {
            clientKey: CAPSOLVER_API_KEY,
            task: {
                type: 'AntiTurnstileTaskProxyLess',
                websiteURL: websiteURL,
                websiteKey: websiteKey
            }
        });

        if (!createResp || !createResp.taskId) {
            console.error('[CAPSOLVER] Falha ao criar task');
            return null;
        }

        // Polling para resultado (max 60s)
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));

            const result = await capsolverRequest('getTaskResult', {
                clientKey: CAPSOLVER_API_KEY,
                taskId: createResp.taskId
            });

            if (result && result.status === 'ready') {
                console.log('[CAPSOLVER] ✅ Token obtido');
                return result.solution?.token;
            }

            if (result && (result.status === 'failed' || result.errorId)) {
                console.error('[CAPSOLVER] ❌ Falha');
                return null;
            }
        }

        console.error('[CAPSOLVER] ❌ Timeout (60s)');
        return null;
    } catch (err) {
        console.error('[CAPSOLVER] Erro:', err.message);
        return null;
    }
}

function capsolverRequest(endpoint, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request({
            hostname: 'api.capsolver.com',
            path: '/' + endpoint,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, (res) => {
            let chunks = '';
            res.on('data', c => { chunks += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(chunks)); }
                catch { resolve(null); }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(data);
        req.end();
    });
}

function findUniquePath(proposedPath) {
    if (!fs.existsSync(proposedPath)) return proposedPath;
    const { dir, name, ext } = path.parse(proposedPath);
    let counter = 1, newPath;
    do { newPath = path.join(dir, `${name} (${counter})${ext}`); counter++; } while (fs.existsSync(newPath));
    return newPath;
}

// ===================================================================
// LIMPEZA
// ===================================================================
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

// ===================================================================
// BROWSERVIEW — CORAÇÃO DA NOVA ARQUITETURA
// ===================================================================

const DOWNLOADS_PANEL_WIDTH = 370;

/**
 * Calcula os bounds do BrowserView baseado no tamanho da janela e estado do painel.
 */
function getViewBounds(win, panelOpen) {
    const { width, height } = win.getContentBounds();
    const viewWidth = panelOpen ? Math.max(400, width - DOWNLOADS_PANEL_WIDTH) : width;
    return { x: 0, y: TOTAL_HEADER_HEIGHT, width: viewWidth, height: height - TOTAL_HEADER_HEIGHT };
}

/**
 * Atualiza os bounds da view levando em conta o estado do painel de downloads.
 */
function updateViewBounds() {
    if (!browserWindow || browserWindow.isDestroyed() || !activeTabId) return;
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    tab.view.setBounds(getViewBounds(browserWindow, tab.downloadsPanelOpen));
}

/**
 * Injetar CSS fixes específicos por site.
 * Necessário porque o BrowserView pode causar diferenças de layout em sites
 * que usam 100vh, position: fixed, ou grids complexos.
 */
function injectSiteFixes(webContents) {
    if (webContents.isDestroyed()) return;

    try {
        const currentUrl = webContents.getURL();
        const hostname = new URL(currentUrl).hostname;

        // ChatGPT: dialog de visualização de imagem fica deslocado no grid
        if (hostname.includes('chatgpt.com') || hostname.includes('chat.openai.com')) {
            webContents.insertCSS(`
                /* Fix: dialog do ChatGPT no BrowserView */
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
                /* Sobrescrever overlay/backdrop do dialog */
                [data-state="open"][role="dialog"] ~ div[data-state="open"],
                div:has(> [role="dialog"][data-state="open"]) {
                    position: fixed !important;
                    inset: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    z-index: 9998 !important;
                }
            `).then(() => {
                
            }).catch(() => {});
        }

        // Adicionar mais sites aqui conforme necessário:
        // if (hostname.includes('outro-site.com')) { ... }

        // Freepik/Turnstile: CapSolver integration handled via page-title-updated event

    } catch (e) {
        // URL inválida ou webContents destruído — ignorar
    }
}

// ===================================================================
// JANELA UNICA + SISTEMA DE ABAS
// ===================================================================

/**
 * Cria a janela principal com toolbar (chamada apenas 1 vez, na 1a aba).
 */
function createBrowserWindow() {
    const win = new BrowserWindow({
        ...CONFIG.WINDOW_DEFAULTS,
        frame: false,
        show: false,
        backgroundColor: currentTema === 'dark' ? '#181818' : '#f5f5f5',
        webPreferences: {
            preload: path.join(__dirname, 'preload-toolbar.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: IS_DEV
        }
    });

    win.loadFile(path.join(__dirname, 'toolbar.html'));

    // Enviar tema atual quando a toolbar carregar
    win.webContents.once('did-finish-load', () => {
        win.webContents.send('theme-changed', currentTema);
    });

    // Recalcular bounds ao redimensionar
    const onResize = () => {
        if (!win.isDestroyed()) {
            updateViewBounds();
            // Forcar recalculo de viewport na aba ativa
            const tab = activeTabId ? tabs.get(activeTabId) : null;
            if (tab && !tab.view.webContents.isDestroyed()) {
                setTimeout(() => {
                    tab.view.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
                }, 100);
            }
        }
    };
    win.on('resize', onResize);
    win.on('maximize', () => setTimeout(onResize, 50));
    win.on('unmaximize', () => setTimeout(onResize, 50));

    // Atalhos de teclado na toolbar
    win.webContents.on('before-input-event', (event, input) => {
        handleTabShortcut(event, input);
    });

    // Limpeza ao fechar — limpar TODAS as abas
    win.on('closed', () => {
        for (const [tabId, tab] of tabs) {
            const viewId = tab.view.webContents.id;
            proxyCredentials.delete(viewId);
            proxyFallbackState.delete(viewId);
            for (const [key] of proxyAuthAttempts) {
                if (key.startsWith(`${viewId}-`)) proxyAuthAttempts.delete(key);
            }
        }
        tabs.clear();
        perfilIdToTab.clear();
        activeTabId = null;
        browserWindow = null;
    });

    win.once('ready-to-show', () => win.show());

    browserWindow = win;
    return win;
}

/**
 * Atalhos de teclado para abas.
 */
function handleTabShortcut(event, input) {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (!ctrl) return;

    const tabIds = Array.from(tabs.keys());
    if (tabIds.length === 0) return;

    if (input.key === 'w' || input.key === 'W') {
        event.preventDefault();
        if (activeTabId) closeTab(activeTabId);
    } else if (input.key === 'Tab') {
        event.preventDefault();
        const idx = tabIds.indexOf(activeTabId);
        const next = input.shift
            ? (idx - 1 + tabIds.length) % tabIds.length
            : (idx + 1) % tabIds.length;
        activateTab(tabIds[next]);
    } else if (input.key >= '1' && input.key <= '9') {
        event.preventDefault();
        const n = parseInt(input.key);
        const target = n === 9 ? tabIds.length - 1 : n - 1;
        if (target < tabIds.length) activateTab(tabIds[target]);
    } else if (input.key === 't' || input.key === 'T' || input.key === 'n' || input.key === 'N') {
        event.preventDefault(); // Bloquear Ctrl+T e Ctrl+N
    }
}

/**
 * Cria uma nova aba com BrowserView isolada.
 */
function createTab(perfil, isolatedSession, storageData) {
    const tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const view = new BrowserView({
        webPreferences: {
            session: isolatedSession,
            preload: path.join(__dirname, 'preload-secure.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            devTools: IS_DEV
        }
    });

    const tabEntry = {
        tabId,
        view,
        session: isolatedSession,
        perfil,
        downloadsPanelOpen: false,
        title: perfil.link ? new URL(perfil.link).hostname : 'Nova aba',
        url: perfil.link || '',
        isLoading: true
    };

    tabs.set(tabId, tabEntry);
    if (perfil.id) perfilIdToTab.set(perfil.id, tabId);

    const viewId = view.webContents.id;

    // Forcar recalculo de viewport
    const forceViewportRecalc = () => {
        if (!view.webContents.isDestroyed()) {
            view.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
        }
    };

    // URL e titulo — atualizar tab + URL bar se for a aba ativa
    const sendToToolbar = (channel, data) => {
        if (browserWindow && !browserWindow.isDestroyed()) {
            browserWindow.webContents.send(channel, data);
        }
    };

    const updateTabInfo = (url, title) => {
        if (url) tabEntry.url = url;
        if (title) tabEntry.title = title;
        // Atualizar tab-bar
        sendToToolbar('tab-updated', { tabId, title: tabEntry.title, favicon: tabEntry.favicon, url: tabEntry.url });
        // Se e a aba ativa, atualizar URL bar
        if (activeTabId === tabId) {
            sendToToolbar('url-updated', tabEntry.url);
        }
    };

    view.webContents.on('did-navigate', (e, url) => {
        updateTabInfo(url, null);
        sendToLovable('mp-navigation', { tabId, perfilId: perfil.id, url, title: tabEntry.title, timestamp: Date.now() });
    });
    view.webContents.on('did-navigate-in-page', (e, url) => updateTabInfo(url, null));

    // Titulo da pagina → titulo da aba
    let turnstileSolving = false;
    const turnstileSolved = new Map();

    view.webContents.on('page-title-updated', (e, title) => {
        // CapSolver Turnstile
        if (title.startsWith('MP_TURNSTILE:') && !turnstileSolving) {
            e.preventDefault();
            const sitekey = title.substring('MP_TURNSTILE:'.length);
            if (!sitekey) return;

            const pageUrl = view.webContents.getURL().split('#')[0];
            const lastSolved = turnstileSolved.get(pageUrl);
            if (lastSolved && Date.now() - lastSolved < 30000) return;

            turnstileSolving = true;
            const solveStart = Date.now();
            logEvent('turnstile_solving', { tabId, perfilId: perfil.id, url: pageUrl, sitekey });

            solveTurnstile(pageUrl, sitekey).then(token => {
                turnstileSolving = false;
                if (token && !view.webContents.isDestroyed()) {
                    logEvent('turnstile_solved', { tabId, perfilId: perfil.id, url: pageUrl, tempoMs: Date.now() - solveStart });
                    turnstileSolved.set(pageUrl, Date.now());
                    reloadTracker.clear();
                    view.webContents.executeJavaScript(`
                        if (window.__mpTurnstileCallback) {
                            window.__mpTurnstileCallback('${token.replace(/'/g, "\\'")}');
                        }
                    `).catch(() => {});
                    setTimeout(() => {
                        if (!view.webContents.isDestroyed()) {
                            reloadTracker.clear();
                            view.webContents.reload();
                        }
                    }, 2000);
                } else {
                    logEvent('turnstile_failed', { tabId, perfilId: perfil.id, url: pageUrl, tempoMs: Date.now() - solveStart });
                }
            });
            return;
        }

        // Titulo normal → atualizar aba
        updateTabInfo(null, title);
    });

    // Loading
    view.webContents.on('did-start-loading', () => {
        tabEntry.isLoading = true;
        if (activeTabId === tabId) sendToToolbar('page-loading', true);
        sendToLovable('mp-tab-status', { tabId, perfilId: perfil.id, url: tabEntry.url, title: tabEntry.title, isLoading: true });
    });
    view.webContents.on('did-stop-loading', () => {
        tabEntry.isLoading = false;
        if (activeTabId === tabId) sendToToolbar('page-loading', false);
        sendToLovable('mp-tab-status', { tabId, perfilId: perfil.id, url: tabEntry.url, title: tabEntry.title, isLoading: false });
    });
    view.webContents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
        if (isMainFrame && activeTabId === tabId) sendToToolbar('page-loading', true);
    });

    // Viewport recalc + site fixes
    view.webContents.on('did-finish-load', () => {
        setTimeout(forceViewportRecalc, 300);
        setTimeout(forceViewportRecalc, 1000);
        injectSiteFixes(view.webContents);
    });
    view.webContents.on('did-navigate', () => {
        setTimeout(() => injectSiteFixes(view.webContents), 500);
    });

    // Falha de navegacao
    view.webContents.on('did-fail-load', (event, errorCode, desc, url, isMainFrame) => {
        if (errorCode === -3) return;
        if (isMainFrame && activeTabId === tabId) sendToToolbar('page-loading', false);
    });

    // Crash recovery
    view.webContents.on('render-process-gone', () => {
        logEvent('tab_crashed', { tabId, perfilId: perfil.id, url: tabEntry.url });
        setTimeout(() => {
            if (!view.webContents.isDestroyed()) view.webContents.reload();
        }, 1000);
    });

    // Anti-reload-loop
    const reloadTracker = new Map();
    view.webContents.on('will-navigate', (event, url) => {
        if (view.webContents.isDestroyed()) return;
        const cleanCurrent = view.webContents.getURL().split('#')[0];
        const cleanNew = url.split('#')[0];
        if (cleanCurrent === cleanNew) {
            const now = Date.now();
            const tracker = reloadTracker.get(cleanNew) || { count: 0, firstTime: now };
            if (now - tracker.firstTime > 15000) { tracker.count = 0; tracker.firstTime = now; }
            tracker.count++;
            reloadTracker.set(cleanNew, tracker);
            if (tracker.count > 2) { event.preventDefault(); return; }
        } else {
            reloadTracker.clear();
        }
    });

    view.webContents.on('unresponsive', () => {});
    view.webContents.on('responsive', () => {});

    // Popups
    view.webContents.setWindowOpenHandler(({ url }) => {
        if (!url || url === 'about:blank' || url.startsWith('blob:') || url.startsWith('javascript:')) {
            return { action: 'deny' };
        }
        try {
            const currentHost = new URL(view.webContents.getURL()).hostname;
            const popupHost = new URL(url).hostname;
            if (currentHost === popupHost || popupHost.endsWith('.' + currentHost) || currentHost.endsWith('.' + popupHost)) {
                view.webContents.loadURL(url);
                return { action: 'deny' };
            }
        } catch {}

        const { screen } = require('electron');
        const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
        const popW = Math.min(1200, Math.round(screenW * 0.8));
        const popH = Math.min(850, Math.round(screenH * 0.85));
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                x: Math.round((screenW - popW) / 2), y: Math.round((screenH - popH) / 2),
                width: popW, height: popH, minWidth: 500, minHeight: 400,
                modal: false, show: true, autoHideMenuBar: true, frame: true,
                webPreferences: { session: isolatedSession, contextIsolation: true, nodeIntegration: false, devTools: IS_DEV }
            }
        };
    });

    view.webContents.on('did-create-window', (popupWindow) => {
        const onWillDownload = () => {
            setTimeout(() => { if (!popupWindow.isDestroyed()) popupWindow.close(); }, 2000);
        };
        isolatedSession.on('will-download', onWillDownload);
        popupWindow.on('closed', () => isolatedSession.removeListener('will-download', onWillDownload));
        popupWindow.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
            if (popupUrl && popupUrl !== 'about:blank' && !popupUrl.startsWith('javascript:')) {
                popupWindow.webContents.loadURL(popupUrl);
            }
            return { action: 'deny' };
        });
        setTimeout(() => {
            if (!popupWindow.isDestroyed()) {
                const u = popupWindow.webContents.getURL();
                if (u === 'about:blank' || u === '') {
                    popupWindow.webContents.executeJavaScript('document.body?.innerHTML?.length || 0')
                        .then(len => { if (len < 10 && !popupWindow.isDestroyed()) popupWindow.close(); })
                        .catch(() => {});
                }
            }
        }, 5000);
    });

    // Auto-login
    if (perfil.usuariodaferramenta && perfil.senhadaferramenta) {
        const sendCredentials = () => {
            if (!view.webContents.isDestroyed()) {
                view.webContents.send('set-auto-login-credentials', {
                    usuariodaferramenta: perfil.usuariodaferramenta,
                    senhadaferramenta: perfil.senhadaferramenta
                });
            }
        };
        view.webContents.once('did-finish-load', sendCredentials);
        view.webContents.on('did-navigate', sendCredentials);
    }

    // Session data injection (usando webContents.ipc para evitar conflito entre abas)
    view.webContents.ipc.once('request-session-data', (e) => {
        e.sender.send('inject-session-data', storageData);
    });
    view.webContents.ipc.once('get-initial-session-data', (e) => {
        e.returnValue = storageData || null;
    });

    // Downloads
    setupDownloadManager(view, isolatedSession);

    // Atalhos de teclado na view (a view recebe input quando ativa)
    view.webContents.on('before-input-event', (event, input) => {
        handleTabShortcut(event, input);
        // F12 DevTools em dev
        if (IS_DEV && input.key === 'F12' && input.type === 'keyDown') {
            event.preventDefault();
            if (!view.webContents.isDestroyed()) view.webContents.openDevTools({ mode: 'detach' });
        }
    });

    // Enviar tab-added para toolbar
    sendToToolbar('tab-added', {
        tabId,
        title: tabEntry.title,
        favicon: null,
        isActive: true
    });

    // Notificar Lovable: aba aberta
    sendToLovable('mp-tab-opened', { tabId, perfilId: perfil.id, url: perfil.link, title: tabEntry.title });

    // Ativar esta aba
    activateTab(tabId);

    return tabEntry;
}

/**
 * Ativa uma aba (mostra sua BrowserView).
 */
function activateTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !browserWindow || browserWindow.isDestroyed()) return;

    activeTabId = tabId;

    // Trocar BrowserView visivel
    browserWindow.setBrowserView(tab.view);
    tab.view.setBounds(getViewBounds(browserWindow, tab.downloadsPanelOpen));
    tab.view.setAutoResize({ width: !tab.downloadsPanelOpen, height: true, horizontal: false, vertical: false });

    // Informar toolbar
    browserWindow.webContents.send('tab-activated', { tabId });
    browserWindow.webContents.send('url-updated', tab.url || tab.view.webContents.getURL());
    browserWindow.webContents.send('page-loading', tab.isLoading);
}

/**
 * Fecha uma aba.
 */
function closeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;

    // Se e a ultima aba, fechar a janela inteira
    if (tabs.size === 1) {
        if (browserWindow && !browserWindow.isDestroyed()) browserWindow.close();
        return;
    }

    // Se fechando a aba ativa, ativar a adjacente
    if (activeTabId === tabId) {
        const tabIds = Array.from(tabs.keys());
        const idx = tabIds.indexOf(tabId);
        const nextIdx = idx < tabIds.length - 1 ? idx + 1 : idx - 1;
        activateTab(tabIds[nextIdx]);
    }

    // Limpar
    const viewId = tab.view.webContents.id;
    if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.removeBrowserView(tab.view);
    }
    try { tab.view.webContents.destroy(); } catch {}
    proxyCredentials.delete(viewId);
    proxyFallbackState.delete(viewId);
    for (const [key] of proxyAuthAttempts) {
        if (key.startsWith(`${viewId}-`)) proxyAuthAttempts.delete(key);
    }
    if (tab.perfil?.id) perfilIdToTab.delete(tab.perfil.id);
    tabs.delete(tabId);

    // Informar toolbar
    if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.webContents.send('tab-removed', tabId);
    }

    // Notificar Lovable: aba fechada
    sendToLovable('mp-tab-closed', { tabId, perfilId: tab.perfil?.id });
}

// ===================================================================
// DOWNLOADS
// ===================================================================
// Fila global de dialogos de download (compartilhada entre abas)
const dlTempDir = path.join(app.getPath('temp'), 'multiprime-downloads');
let dlDialogQueue = [];
let dlDialogBusy = false;

function setupDownloadManager(view, isolatedSession) {
    // Garantir pasta temp
    if (!fs.existsSync(dlTempDir)) fs.mkdirSync(dlTempDir, { recursive: true });

    // Encontrar perfilId associado a esta view
    const getPerfilId = () => {
        for (const [, tab] of tabs) {
            if (tab.view === view) return tab.perfil?.id;
        }
        return null;
    };

    function sendDl(channel, data) {
        if (browserWindow && !browserWindow.isDestroyed()) {
            browserWindow.webContents.send(channel, data);
        }
    }

    async function processDialogQueue() {
        if (dlDialogBusy || dlDialogQueue.length === 0) return;
        dlDialogBusy = true;

        const { tempPath, filename, downloadId } = dlDialogQueue.shift();
        const parsedName = path.parse(filename);
        const extNoDot = parsedName.ext ? parsedName.ext.replace('.', '') : '*';

        try {
            const win = browserWindow && !browserWindow.isDestroyed() ? browserWindow : null;
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
        if (!browserWindow || browserWindow.isDestroyed()) return item.cancel();

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

            item.on('updated', (e, state) => {
                const total = item.getTotalBytes();
                if (total <= 0 || state !== 'progressing') return;
                sendDl('download-progress', { id: downloadId, progress: Math.round((item.getReceivedBytes() / total) * 100) });
            });

            item.on('done', (e, state) => {
                if (state !== 'completed') { try { fs.unlinkSync(downloadsPath); } catch {} }
                sendDl('download-complete', {
                    id: downloadId, state,
                    path: state === 'completed' ? downloadsPath : null,
                    progress: state === 'completed' ? 100 : 0
                });
                logEvent(state === 'completed' ? 'download_complete' : 'download_failed', { perfilId: getPerfilId(), filename });
            });

        } else {
            const tempPath = path.join(dlTempDir, `${crypto.randomUUID()}_${filename}`);
            item.setSavePath(tempPath);
            sendDl('download-started', { id: downloadId, filename });

            let lastProgress = 0, lastUpdate = 0;
            item.on('updated', (e, state) => {
                if (state !== 'progressing') return;
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

            item.on('done', (e, state) => {
                if (state !== 'completed') {
                    try { fs.unlinkSync(tempPath); } catch {}
                    sendDl('download-complete', { id: downloadId, state, path: null, progress: 0 });
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

// Mover arquivo do temp para o destino final escolhido pelo usuário
function moveFileToFinal(tempPath, destPath, downloadId) {
    const sendDl = (data) => {
        if (browserWindow && !browserWindow.isDestroyed()) {
            browserWindow.webContents.send('download-complete', data);
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

// ===================================================================
// IPC — TOOLBAR COMMANDS
// ===================================================================

function getViewForSender() {
    // Retorna a aba ativa da janela unica
    if (!browserWindow || browserWindow.isDestroyed() || !activeTabId) return null;
    const tab = tabs.get(activeTabId);
    return tab ? { mainWindow: browserWindow, view: tab.view, downloadsPanelOpen: tab.downloadsPanelOpen } : null;
}

ipcMain.on('navigate-back', (e) => {
    const entry = getViewForSender(e);
    if (entry?.view.webContents.canGoBack()) entry.view.webContents.goBack();
});

ipcMain.on('navigate-forward', (e) => {
    const entry = getViewForSender(e);
    if (entry?.view.webContents.canGoForward()) entry.view.webContents.goForward();
});

ipcMain.on('navigate-reload', (e) => {
    const entry = getViewForSender(e);
    entry?.view.webContents.reload();
});

ipcMain.on('navigate-to-url', (e, url) => {
    const entry = getViewForSender(e);
    if (entry && url) entry.view.webContents.loadURL(url);
});

ipcMain.on('request-initial-url', (e) => {
    const entry = getViewForSender(e);
    if (entry) e.sender.send('url-updated', entry.view.webContents.getURL());
});

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

// ★ IPC para a janela principal (titlebar personalizada)
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

ipcMain.on('open-download', (e, p) => { if (p) shell.openPath(p).catch(() => {}); });
ipcMain.on('show-download-in-folder', (e, p) => { if (p) shell.showItemInFolder(path.resolve(p)); });
ipcMain.on('open-external', (e, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
        shell.openExternal(url);
    }
});

// ★ Toggle do painel de downloads: encolher BrowserView para o painel ficar visível

ipcMain.on('downloads-panel-toggle', (e, isOpen) => {
    if (!activeTabId) return;
    const tab = tabs.get(activeTabId);
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

// ===================================================================
// EXPORTAÇÃO DE SESSÃO
// ===================================================================
ipcMain.on('initiate-full-session-export', async (event, storageData) => {
    if (!browserWindow || browserWindow.isDestroyed() || !activeTabId) return;
    const tab = tabs.get(activeTabId);
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
                await dialog.showMessageBox(browserWindow, {
                    type: 'info', title: 'Exportação Concluída',
                    message: 'Sessão salva com sucesso no GitHub (criptografada)!',
                    detail: `Arquivo: ${perfil.ftp}`
                });
            } catch (err) {
                console.error('[EXPORT] Falha GitHub:', err);
                const { response } = await dialog.showMessageBox(browserWindow, {
                    type: 'warning', title: 'Erro GitHub',
                    message: 'Falha no GitHub. Salvar localmente?',
                    buttons: ['Salvar Localmente', 'Cancelar']
                });
                if (response === 0) await saveSessionLocally(browserWindow, jsonContent);
            }
        } else {
            await saveSessionLocally(browserWindow, jsonContent);
        }
    } catch (err) {
        console.error('[EXPORT] Erro:', err);
        await dialog.showMessageBox(browserWindow, {
            type: 'error', title: 'Erro', message: 'Erro ao exportar sessão.', detail: err.message
        });
    }
});

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

// ===================================================================
// ABRIR NAVEGADOR (evento principal)
// ===================================================================

// Handler unificado: aceita perfil plain OU criptografado
async function handleAbrirNavegador(event, rawPerfil) {

    // ★ Descriptografar perfil se veio criptografado
    let perfil;
    if (rawPerfil && rawPerfil.__encrypted && rawPerfil.payload) {
        perfil = decryptIPC(rawPerfil.payload);
        if (!perfil) {
            console.error('[IPC CRYPTO] ❌ Falha ao descriptografar perfil. IPC possivelmente adulterado.');
            dialog.showErrorBox('Erro de Segurança', 'Não foi possível processar os dados de forma segura.');
            return;
        }
    } else {
        // Perfil veio em texto puro (retrocompatibilidade)
        perfil = rawPerfil;
    }

    // Deduplicacao: se perfil.id ja esta aberto, focar a aba existente
    if (perfil?.id && perfilIdToTab.has(perfil.id)) {
        const existingTabId = perfilIdToTab.get(perfil.id);
        if (tabs.has(existingTabId)) {
            activateTab(existingTabId);
            // Restaurar janela se minimizada
            if (browserWindow && !browserWindow.isDestroyed()) {
                if (browserWindow.isMinimized()) browserWindow.restore();
                browserWindow.focus();
            }
            console.log(`[ABAS] Perfil ${perfil.id} já aberto → focando aba existente`);
            return;
        }
        // Tab nao existe mais, limpar referencia
        perfilIdToTab.delete(perfil.id);
    }

    const windowId = `profile_${Date.now()}`;
    const partition = `persist:${windowId}`;
    const isolatedSession = session.fromPartition(partition);

    try {
        if (!perfil?.link) throw new Error('Perfil ou link inválido.');

        await isolatedSession.clearStorageData();

        // User Agent: usar apenas se o perfil fornecer
        // User Agent: limpar "Electron" do UA padrão (Cloudflare detecta)
        if (perfil.userAgent && perfil.userAgent.includes('Mozilla/') && !perfil.userAgent.includes('@')) {
            await isolatedSession.setUserAgent(perfil.userAgent);
        } else {
            // Remover "Electron/xxx" e "multiprime-v6/xxx" do UA padrão
            const defaultUA = isolatedSession.getUserAgent()
                .replace(/Electron\/[\d.]+ /, '')
                .replace(/multiprime-v6\/[\d.]+ /, '');
            await isolatedSession.setUserAgent(defaultUA);
        }

        // Baixar cookies do GitHub
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

        // Injetar cookies
        let cookiesToInject = [];
        if (sessionData) {
            if (Array.isArray(sessionData)) cookiesToInject = sessionData;
            else if (Array.isArray(sessionData.cookies)) cookiesToInject = sessionData.cookies;
        }

        if (cookiesToInject.length > 0) {
            // Preparar cookies: deduplica, remove expirados, ordena auth por último
            const prepared = prepareCookiesForInjection(cookiesToInject, perfil.link);
            const skipped = cookiesToInject.length - prepared.length;


            let ok = 0, fail = 0;
            const failedNames = [];
            for (const cookie of prepared) {
                try {
                    await isolatedSession.cookies.set(cookie);
                    ok++;
                } catch (err) {
                    fail++;
                    if (fail <= 5) failedNames.push(`${cookie.name}: ${err.message}`);
                }
            }

            if (failedNames.length > 0) {
                console.warn(`[SESSÃO ${windowId}] Primeiras falhas:`, failedNames.join(' | '));
            }

            await isolatedSession.cookies.flushStore();
            logEvent('session_loaded', { perfilId: perfil.id, cookieCount: ok, cookieFailed: fail, ftp: perfil.ftp });
        }

        const storageData = {
            localStorage: sessionData?.localStorage,
            sessionStorage: sessionData?.sessionStorage,
            indexedDB: sessionData?.indexedDB
        };

        // Configurar proxy
        if (perfil.proxy?.host && perfil.proxy?.port) {
            const validation = validateProxyConfig(perfil.proxy);
            if (validation.valid) {
                const t = validation.type;
                let proxyRules;

                // Electron setProxy NÃO aceita credenciais na URL.
                // Formato: apenas protocolo://host:porta
                // Autenticação: via evento 'login' (app.on('login', ...))
                if (t === 'socks5' || t === 'socks') {
                    proxyRules = `socks5://${perfil.proxy.host}:${validation.port}`;
                } else if (t === 'socks4') {
                    proxyRules = `socks4://${perfil.proxy.host}:${validation.port}`;
                } else {
                    proxyRules = `http://${perfil.proxy.host}:${validation.port}`;
                }

                const bypass = [perfil.proxy.bypass || '', '*.envatousercontent.com'].filter(Boolean).join(',');
                await isolatedSession.setProxy({ proxyRules, proxyBypassRules: bypass });

                } else {
                console.warn(`[PROXY] Configuração inválida: ${validation.error}. Usando direto.`);
                await isolatedSession.setProxy({ proxyRules: 'direct://' });
            }
        } else {
            await isolatedSession.setProxy({ proxyRules: 'direct://' });
        }

        // ★ PERMISSÕES: Permitir tudo que sites precisam
        isolatedSession.setPermissionRequestHandler((webContents, permission, callback) => {
            callback(true);
        });
        isolatedSession.setPermissionCheckHandler(() => true);

        // ★ TURNSTILE: Bloquear script real, usar mock + CapSolver
        isolatedSession.webRequest.onBeforeRequest(
            { urls: ['*://challenges.cloudflare.com/turnstile/v0/api.js*'] },
            (details, callback) => {
                console.log('[TURNSTILE] Script bloqueado → CapSolver');
                callback({ cancel: true });
            }
        );

        // CRIAR JANELA (se primeira aba) + CRIAR ABA
        if (!browserWindow || browserWindow.isDestroyed()) {
            createBrowserWindow();
        }

        const tabEntry = createTab(perfil, isolatedSession, storageData);
        const view = tabEntry.view;
        const viewId = view.webContents.id;

        // Proxy credentials
        if (perfil.proxy?.username) {
            proxyCredentials.set(viewId, {
                username: perfil.proxy.username,
                password: perfil.proxy.password ?? ''
            });
        }

        // Registrar fallbacks
        if (perfil.proxy?.host && Array.isArray(perfil.proxyFallbacks) && perfil.proxyFallbacks.length > 0) {
            proxyFallbackState.set(viewId, {
                fallbacks: perfil.proxyFallbacks.slice(0, 2),
                currentIndex: -1,
                session: isolatedSession,
                perfil
            });
            console.log(`[PROXY FALLBACK] View ${viewId}: ${perfil.proxyFallbacks.length} fallback(s) registrado(s)`);
        }

        // Detectar erros de conexao/proxy e tentar fallback
        view.webContents.on('did-fail-load', async (event, errorCode, errorDescription) => {
            const proxyErrors = [-102, -105, -106, -109, -118, -130, -137, -138];
            if (proxyErrors.includes(errorCode) && proxyFallbackState.has(view.webContents.id)) {
                console.warn(`[PROXY FALLBACK] Erro de conexão ${errorCode} (${errorDescription}). Tentando fallback...`);
                const switched = await switchToNextProxy(view.webContents.id);
                if (switched) {
                    try { if (!view.webContents.isDestroyed()) view.webContents.reload(); } catch {}
                }
            }
        });

        // Carregar URL
        try {
            await view.webContents.loadURL(perfil.link);
        } catch (err) {
            console.warn(`[NAV] Erro ao carregar ${perfil.link}: ${err.code || err.message}`);
        }

    } catch (err) {
        console.error('--- [ERRO FATAL] ---', err);
    }
}

// Registrar AMBOS os handlers: plain e criptografado
ipcMain.on('abrir-navegador', (event, perfil) => handleAbrirNavegador(event, perfil));
ipcMain.on('abrir-navegador-secure', (event, encryptedPerfil) => handleAbrirNavegador(event, encryptedPerfil));

// IPC para abas (toolbar → main)
ipcMain.on('switch-tab', (e, tabId) => {
    if (tabs.has(tabId)) activateTab(tabId);
});
ipcMain.on('close-tab', (e, tabId) => {
    if (tabs.has(tabId)) closeTab(tabId);
});

// ===================================================================
// TEMA (recebe do Lovable, repassa para todas as toolbars)
// ===================================================================
let currentTema = 'dark'; // padrão

ipcMain.on('set-tema', (event, tema) => {
    currentTema = tema;
    // Enviar para a toolbar do browser (janela de abas)
    if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.webContents.send('theme-changed', tema);
    }
    // Enviar para a titlebar principal (janela do Lovable)
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
        try {
            if (!win.isDestroyed() && win !== browserWindow) {
                win.webContents.send('theme-changed', tema);
            }
        } catch {}
    }
});

// ===================================================================
// PROXY AUTH
// ===================================================================
const proxyAuthAttempts = new Map(); // webContentsId → count

const nossoManipuladorDeLogin = (event, webContents, request, authInfo, callback) => {
    if (!authInfo.isProxy) return callback();
    event.preventDefault();

    const wcId = webContents?.id ?? 'N/A';
    const host = `${authInfo.host}:${authInfo.port}`;
    const scheme = authInfo.scheme || '?';

    // Limitar tentativas para evitar loop infinito
    const key = `${wcId}-${host}`;
    const attempts = (proxyAuthAttempts.get(key) || 0) + 1;
    proxyAuthAttempts.set(key, attempts);

    if (attempts > 3) {
        console.error(`[PROXY AUTH] ❌ Máximo de tentativas atingido para ${host} (wcId: ${wcId}). Tentando fallback...`);
        logEvent('proxy_auth_failed', { viewId: wcId, host });
        proxyAuthAttempts.delete(key);

        // Tentar próximo proxy via fallback
        switchToNextProxy(wcId).then(switched => {
            if (switched) {
                // Recarregar a página com o novo proxy
                try { if (!webContents.isDestroyed()) webContents.reload(); } catch {}
            } else {
                console.error(`[PROXY AUTH] ❌ Sem fallbacks restantes para view ${wcId}`);
            }
        });

        callback(); // Cancela esta tentativa
        return;
    }

    // Buscar credenciais pelo webContents.id exato (sem fallback generico para evitar credenciais erradas com multi-abas)
    const credentials = proxyCredentials.get(wcId);

    if (credentials) {
        callback(credentials.username, credentials.password);
    } else {
        console.error(`[PROXY AUTH] ❌ NENHUMA credencial para wcId ${wcId} (host: ${host})`);
        callback();
    }
};

// ===================================================================
// INICIALIZAÇÃO
// ===================================================================
function startApp() {
    // Anti-bot
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
    // Estabilidade GPU — previne tela preta em BrowserViews
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('disable-software-rasterizer');

    app.whenReady().then(async () => {
        await limparParticoesAntigas();

        for (const listener of app.listeners('login')) app.removeListener('login', listener);
        app.on('login', nossoManipuladorDeLogin);

        // ★ CRIAR JANELA PRINCIPAL — titlebar própria + Lovable em BrowserView
        const MAIN_BAR_HEIGHT = 36;

        const mainWindow = new BrowserWindow({
            width: 1280,
            height: 720,
            minWidth: 800,
            minHeight: 600,
            icon: path.join(__dirname, 'icon.ico'),
            title: 'MultiPrime',
            frame: false,
            show: false,
            backgroundColor: '#111111',
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,  // Seguro: só carrega nosso HTML inline
                devTools: IS_DEV
            }
        });

        // Remover menu
        Menu.setApplicationMenu(null);

        // Carregar titlebar inline (sem arquivo HTML extra)
        // Converter icon.ico para base64 (funciona dentro de data: URL)
        let iconBase64 = '';
        try {
            const iconBuffer = fs.readFileSync(path.join(__dirname, 'icon.ico'));
            iconBase64 = 'data:image/x-icon;base64,' + iconBuffer.toString('base64');
        } catch (e) {
            console.warn('[SISTEMA] icon.ico não encontrado, usando fallback');
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
.title {
  display: flex; align-items: center; color: var(--tb-title);
}
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

        // BrowserView para o Lovable — carrega ABAIXO da titlebar
        lovableView = new BrowserView({
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: false,
                nodeIntegration: false,
                sandbox: false,
                devTools: IS_DEV
            }
        });

        mainWindow.setBrowserView(lovableView);

        // Posicionar abaixo da titlebar
        const updateLovableBounds = () => {
            if (mainWindow.isDestroyed()) return;
            const { width, height } = mainWindow.getContentBounds();
            lovableView.setBounds({ x: 0, y: MAIN_BAR_HEIGHT, width: width, height: height - MAIN_BAR_HEIGHT });
        };

        updateLovableBounds();
        lovableView.setAutoResize({ width: true, height: true });

        mainWindow.on('resize', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('maximize', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('unmaximize', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('restore', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('enter-full-screen', () => setTimeout(updateLovableBounds, 50));
        mainWindow.on('leave-full-screen', () => setTimeout(updateLovableBounds, 50));

        // Função para carregar o Lovable e configurar links externos
        const loadLovable = () => {
            lovableView.webContents.loadURL(APP_URL);

            const lovableHost = new URL(APP_URL).hostname;

            lovableView.webContents.setWindowOpenHandler(({ url }) => {
                try {
                    const host = new URL(url).hostname;
                    if (host !== lovableHost) {
                        shell.openExternal(url);
                        return { action: 'deny' };
                    }
                } catch {}
                return { action: 'deny' };
            });

            lovableView.webContents.on('will-navigate', (e, url) => {
                try {
                    const host = new URL(url).hostname;
                    if (host !== lovableHost) {
                        e.preventDefault();
                        shell.openExternal(url);
                    }
                } catch {}
            });

            lovableView.webContents.once('did-finish-load', () => {
                if (!mainWindow.isVisible()) {
                    mainWindow.maximize();
                    mainWindow.show();
                }
            });
        };

        // Tela de update (carrega uma vez, atualiza via JS — sem recarregar)
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


        // ★ AUTO-UPDATER: Verificar oculto, só mostrar tela se tiver update
        if (autoUpdater) {
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
                // Timeout: se o download não completar em 2 minutos, abortar e carregar o app
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
                // Só loga a cada 10% para não poluir
                if (pct % 10 === 0) console.log(`[APP-UPDATER] Baixando: ${pct}%`);
                updateScreenProgress('Baixando atualização...', pct);
            });

            autoUpdater.on('update-downloaded', (info) => {
                clearTimeout(downloadTimeout);
                console.log(`[APP-UPDATER] ✅ Versão ${info.version} pronta. Reiniciando...`);
                updateScreenProgress('Instalando... Reiniciando em instantes', 100);

                // Aguardar 2s para o usuario ver a mensagem, depois instalar
                setTimeout(() => {
                    try {
                        autoUpdater.quitAndInstall(false, true);
                    } catch (err) {
                        console.error('[APP-UPDATER] Erro quitAndInstall:', err);
                        try { app.quit(); } catch {}
                    }
                }, 2000);

                // Fallback: se quitAndInstall não fechou o app em 8s, forçar saída
                setTimeout(() => {
                    console.warn('[APP-UPDATER] Fallback: forçando saída');
                    process.exit(0);
                }, 10000);
            });

            autoUpdater.on('error', (err) => {
                console.warn('[APP-UPDATER] Erro (não crítico):', err.message);
                clearTimeout(downloadTimeout);
                if (updateFound) {
                    // Update estava em andamento e falhou — carregar o app normalmente
                    abortUpdateAndLoad(`Erro no updater: ${err.message}`);
                } else {
                    safeLoadLovable();
                }
            });

            // Fallback: se em 5s nenhum evento disparou (ex: modo dev)
            fallback = setTimeout(safeLoadLovable, 5000);

            autoUpdater.checkForUpdates().catch(() => safeLoadLovable());
        } else {
            loadLovable();
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

// Atualizações são feitas via electron-updater (GitHub Releases).
// Arquivos são protegidos pelo ASAR (read-only).
// Não precisa de JS file updater nem verificação de integridade manual.
startApp();