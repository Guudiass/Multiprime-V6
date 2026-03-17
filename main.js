/* eslint-disable no-undef */
// main.js — MultiPrime V6 (Electron Puro)
// Sem Nativefier. Janela principal carrega o Lovable diretamente.

const { app, BrowserWindow, BrowserView, ipcMain, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const fsPromises = require('fs').promises;
const crypto = require('crypto');

// ★ AUTO-UPDATER: Atualiza o .exe/Electron via GitHub Releases
let autoUpdater;
try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
} catch (e) {
    console.warn('[APP-UPDATER] electron-updater não disponível (modo dev):', e.message);
    autoUpdater = null;
}

// ===================================================================
// CONSTANTES E CONFIGURAÇÃO
// ===================================================================
const TOOLBAR_HEIGHT = 44;

// ★ URL DO SEU SITE LOVABLE (alterar para a URL real)
const APP_URL = 'https://multiprime.designerprime.com.br';

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
const windowProfiles = new Map();
// Mapa: mainWindow.id -> { mainWindow, browserView }
const windowViews = new Map();

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
            console.log(`[LIMPEZA] ${deletePromises.length} partição(ões) removida(s).`);
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
function getViewBounds(mainWindow, panelOpen) {
    const [width, height] = mainWindow.getSize();
    const viewWidth = panelOpen ? Math.max(400, width - DOWNLOADS_PANEL_WIDTH) : width;
    return { x: 0, y: TOOLBAR_HEIGHT, width: viewWidth, height: height - TOOLBAR_HEIGHT };
}

/**
 * Atualiza os bounds da view levando em conta o estado do painel de downloads.
 */
function updateViewBounds(mainWindow) {
    const entry = windowViews.get(mainWindow.id);
    if (!entry) return;
    entry.view.setBounds(getViewBounds(mainWindow, entry.downloadsPanelOpen));
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
                console.log(`[CSS FIX] Dialog fix aplicado para ${hostname}`);
            }).catch(() => {});
        }

        // Adicionar mais sites aqui conforme necessário:
        // if (hostname.includes('outro-site.com')) { ... }

    } catch (e) {
        // URL inválida ou webContents destruído — ignorar
    }
}

/**
 * Cria a janela principal com toolbar embutida + BrowserView para o conteúdo web.
 * A toolbar é um HTML local carregado na própria janela.
 * O conteúdo web fica num BrowserView separado, SEM NENHUMA interferência CSS.
 */
function createSecureWindow(perfil, isolatedSession, storageData) {
    const mainWindow = new BrowserWindow({
        ...CONFIG.WINDOW_DEFAULTS,
        frame: false,
        show: false,
        backgroundColor: '#181818',
        webPreferences: {
            preload: path.join(__dirname, 'preload-toolbar.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true
        }
    });

    // Carregar a toolbar HTML local na janela principal
    mainWindow.loadFile(path.join(__dirname, 'toolbar.html'));

    // Criar o BrowserView para o conteúdo web
    const view = new BrowserView({
        webPreferences: {
            session: isolatedSession,
            preload: path.join(__dirname, 'preload-secure.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            devTools: true
        }
    });

    mainWindow.setBrowserView(view);
    view.setBounds(getViewBounds(mainWindow, false));
    view.setAutoResize({ width: true, height: true, horizontal: false, vertical: false });

    // Recalcular bounds ao redimensionar + forçar recálculo de viewport
    const forceViewportRecalc = () => {
        if (!view.webContents.isDestroyed()) {
            view.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
        }
    };

    mainWindow.on('resize', () => {
        if (!mainWindow.isDestroyed()) {
            updateViewBounds(mainWindow);
            setTimeout(forceViewportRecalc, 100);
        }
    });

    mainWindow.on('maximize', () => {
        setTimeout(() => {
            if (!mainWindow.isDestroyed()) {
                updateViewBounds(mainWindow);
                setTimeout(forceViewportRecalc, 100);
            }
        }, 50);
    });
    mainWindow.on('unmaximize', () => {
        setTimeout(() => {
            if (!mainWindow.isDestroyed()) {
                updateViewBounds(mainWindow);
                setTimeout(forceViewportRecalc, 100);
            }
        }, 50);
    });

    // Salvar referências
    const viewId = view.webContents.id;
    windowViews.set(mainWindow.id, { mainWindow, view, downloadsPanelOpen: false });
    windowProfiles.set(viewId, perfil);

    // Enviar URL para a toolbar quando a view navegar
    view.webContents.on('did-navigate', (e, url) => {
        withAlive(mainWindow, (w) => w.webContents.send('url-updated', url));
    });
    view.webContents.on('did-navigate-in-page', (e, url) => {
        withAlive(mainWindow, (w) => w.webContents.send('url-updated', url));
    });

    // ★ BARRA DE CARREGAMENTO: enviar eventos de loading para a toolbar
    view.webContents.on('did-start-loading', () => {
        withAlive(mainWindow, (w) => w.webContents.send('page-loading', true));
    });
    view.webContents.on('did-stop-loading', () => {
        withAlive(mainWindow, (w) => w.webContents.send('page-loading', false));
    });

    // ★ FIX VIEWPORT: Forçar recálculo de layout após carregar
    view.webContents.on('did-finish-load', () => {
        setTimeout(forceViewportRecalc, 300);
        setTimeout(forceViewportRecalc, 1000);
        // Injetar CSS fixes específicos por site
        injectSiteFixes(view.webContents);
    });

    // Também injetar após navegação (SPA routing)
    view.webContents.on('did-navigate', () => {
        setTimeout(() => injectSiteFixes(view.webContents), 500);
    });
    view.webContents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
        if (isMainFrame) {
            withAlive(mainWindow, (w) => w.webContents.send('page-loading', true));
        }
    });

    // Falha de navegação
    view.webContents.on('did-fail-load', (event, errorCode, desc, url, isMainFrame) => {
        // ERR_ABORTED (-3) é normal (navegação interrompida por outra), ignorar silenciosamente
        if (errorCode === -3) return;
        
        console.warn(`[NAV] Falha: ${desc} (${errorCode}) → ${url}`);
        
        // Parar loading bar
        if (isMainFrame) {
            withAlive(mainWindow, (w) => w.webContents.send('page-loading', false));
        }
    });

    // ★ POPUPS: Roteamento inteligente
    // - Mesmo domínio (ChatGPT, etc.) → navega na própria view (sem popup)
    // - about:blank / blob: / javascript: → negar (modais internos do site)
    // - Domínio externo → janela nova (para downloads, OAuth, etc.)
    view.webContents.setWindowOpenHandler(({ url, disposition }) => {
        console.log(`[POPUP] ${disposition}: ${url}`);

        // about:blank, blob:, javascript: → negar (modais internos, o site cuida)
        if (!url || url === 'about:blank' || url.startsWith('blob:') || url.startsWith('javascript:')) {
            console.log('[POPUP] Negado (modal interno)');
            return { action: 'deny' };
        }

        // Verificar se é mesmo domínio
        try {
            const currentUrl = view.webContents.getURL();
            const currentHost = new URL(currentUrl).hostname;
            const popupHost = new URL(url).hostname;

            // Mesmo domínio ou subdomínio → navegar na própria view
            if (currentHost === popupHost || popupHost.endsWith('.' + currentHost) || currentHost.endsWith('.' + popupHost)) {
                console.log(`[POPUP] Mesmo domínio — navegando na view: ${url}`);
                view.webContents.loadURL(url);
                return { action: 'deny' };
            }
        } catch (e) {
            // URL inválida, deixar abrir como popup
        }

        // Domínio diferente → janela nova centralizada (Vecteezy download, OAuth, etc.)
        console.log(`[POPUP] Domínio externo — abrindo janela: ${url}`);
        const { screen } = require('electron');
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;
        const popW = Math.min(1200, Math.round(screenW * 0.8));
        const popH = Math.min(850, Math.round(screenH * 0.85));

        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                x: Math.round((screenW - popW) / 2),
                y: Math.round((screenH - popH) / 2),
                width: popW,
                height: popH,
                minWidth: 500,
                minHeight: 400,
                modal: false,
                show: true,
                autoHideMenuBar: true,
                frame: true,
                webPreferences: {
                    session: isolatedSession,
                    contextIsolation: true,
                    nodeIntegration: false
                }
            }
        };
    });

    // Quando um popup é criado, configurar auto-close pós-download e popups aninhados
    view.webContents.on('did-create-window', (popupWindow) => {
        console.log('[POPUP] Janela popup criada');

        // Se o popup dispara um download (ex: Vecteezy), fechar depois
        let downloadTriggered = false;
        const onWillDownload = () => {
            downloadTriggered = true;
            setTimeout(() => {
                if (!popupWindow.isDestroyed()) {
                    console.log('[POPUP] Fechando popup pós-download');
                    popupWindow.close();
                }
            }, 2000);
        };
        isolatedSession.on('will-download', onWillDownload);

        // Limpar listener quando popup fecha
        popupWindow.on('closed', () => {
            isolatedSession.removeListener('will-download', onWillDownload);
        });

        // Popups dentro de popups → abrir na mesma popup
        popupWindow.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
            if (popupUrl && popupUrl !== 'about:blank' && !popupUrl.startsWith('javascript:')) {
                popupWindow.webContents.loadURL(popupUrl);
            }
            return { action: 'deny' };
        });

        // Se o popup é about:blank e fica vazio por muito tempo, fechar
        setTimeout(() => {
            if (!popupWindow.isDestroyed()) {
                const currentUrl = popupWindow.webContents.getURL();
                if (currentUrl === 'about:blank' || currentUrl === '') {
                    // Verificar se tem conteúdo real
                    popupWindow.webContents.executeJavaScript('document.body?.innerHTML?.length || 0')
                        .then(len => {
                            if (len < 10 && !popupWindow.isDestroyed()) {
                                console.log('[POPUP] Popup vazio detectado, fechando');
                                popupWindow.close();
                            }
                        })
                        .catch(() => {});
                }
            }
        }, 5000);
    });

    // Auto-login: enviar credenciais para o preload-secure da view
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

    // Injetar sessão data na view
    ipcMain.once('request-session-data', (e) => {
        if (!view.webContents.isDestroyed() && e.sender === view.webContents) {
            e.sender.send('inject-session-data', storageData);
        }
    });
    ipcMain.once('get-initial-session-data', (e) => {
        if (!view.webContents.isDestroyed() && e.sender === view.webContents) {
            e.returnValue = storageData || null;
        } else {
            e.returnValue = null;
        }
    });

    // Downloads
    setupDownloadManager(mainWindow, view, isolatedSession);

    // Limpeza ao fechar
    mainWindow.on('closed', () => {
        proxyCredentials.delete(viewId);
        windowProfiles.delete(viewId);
        windowViews.delete(mainWindow.id);
    });

    // ★ F12: Abrir DevTools da BrowserView em janela DESTACADA
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            event.preventDefault();
            if (!view.webContents.isDestroyed()) {
                view.webContents.openDevTools({ mode: 'detach' });
            }
        }
    });

    // Mostrar quando pronto
    mainWindow.once('ready-to-show', () => mainWindow.show());

    return { mainWindow, view };
}

// ===================================================================
// DOWNLOADS
// ===================================================================
function setupDownloadManager(mainWindow, view, isolatedSession) {
    // Pasta temporária para downloads em andamento
    const tempDownloadDir = path.join(app.getPath('temp'), 'multiprime-downloads');
    if (!fs.existsSync(tempDownloadDir)) fs.mkdirSync(tempDownloadDir, { recursive: true });

    isolatedSession.on('will-download', (event, item) => {
        if (mainWindow.isDestroyed()) return item.cancel();

        // Detectar nome e extensão do arquivo
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

        // ★ PASSO 1: Definir caminho TEMPORÁRIO de forma SÍNCRONA
        // Isso impede o Electron de salvar na pasta Downloads padrão
        const tempPath = path.join(tempDownloadDir, `${crypto.randomUUID()}_${filename}`);
        item.setSavePath(tempPath);

        const parsedName = path.parse(filename);
        const extNoDot = parsedName.ext ? parsedName.ext.replace('.', '') : '*';

        // ★ PASSO 2: Abrir diálogo "Salvar como" (assíncrono)
        let userChosenPath = null;
        let dialogDone = false;
        let downloadDone = false;
        let downloadState = null;

        const downloadId = `dl-${crypto.randomUUID()}`;

        dialog.showSaveDialog(mainWindow, {
            title: 'Salvar download como...',
            defaultPath: path.join(app.getPath('downloads'), filename),
            filters: [
                { name: `Arquivo ${extNoDot.toUpperCase()}`, extensions: [extNoDot] },
                { name: 'Todos os arquivos', extensions: ['*'] }
            ]
        }).then(({ canceled, filePath }) => {
            dialogDone = true;

            if (canceled || !filePath) {
                // Usuário cancelou → cancelar download e limpar temp
                item.cancel();
                try { fs.unlinkSync(tempPath); } catch {}
                return;
            }

            userChosenPath = filePath;

            // Notificar toolbar
            mainWindow.webContents.send('download-started', { id: downloadId, filename: path.basename(filePath) });

            // Se o download já terminou enquanto o diálogo estava aberto, mover agora
            if (downloadDone && downloadState === 'completed') {
                moveFileToFinal(tempPath, userChosenPath, downloadId, mainWindow);
            }
        }).catch(() => {
            dialogDone = true;
            item.cancel();
            try { fs.unlinkSync(tempPath); } catch {}
        });

        // ★ PASSO 3: Progresso do download
        let lastProgress = 0, lastUpdate = 0;
        item.on('updated', (e, state) => {
            if (mainWindow.isDestroyed() || state !== 'progressing' || item.getTotalBytes() <= 0) return;
            if (!userChosenPath) return; // Não notificar enquanto diálogo está aberto
            const progress = Math.round((item.getReceivedBytes() / item.getTotalBytes()) * 100);
            const now = Date.now();
            if (progress > lastProgress && now - lastUpdate > 250) {
                mainWindow.webContents.send('download-progress', { id: downloadId, progress });
                lastProgress = progress;
                lastUpdate = now;
            }
        });

        // ★ PASSO 4: Download terminou → mover do temp para destino final
        item.on('done', (e, state) => {
            downloadDone = true;
            downloadState = state;

            if (state !== 'completed') {
                // Download falhou ou foi cancelado → limpar temp
                try { fs.unlinkSync(tempPath); } catch {}
                if (userChosenPath && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('download-complete', {
                        id: downloadId, state, path: null, progress: 0
                    });
                }
                return;
            }

            // Se o usuário já escolheu o destino, mover agora
            if (userChosenPath) {
                moveFileToFinal(tempPath, userChosenPath, downloadId, mainWindow);
            }
            // Se o diálogo ainda está aberto, o .then() acima vai mover quando fechar
        });
    });
}

// Mover arquivo do temp para o destino final escolhido pelo usuário
function moveFileToFinal(tempPath, destPath, downloadId, mainWindow) {
    try {
        // Se já existe, gerar nome único
        const finalPath = findUniquePath(destPath);

        // Tentar rename (rápido, mesmo disco)
        try {
            fs.renameSync(tempPath, finalPath);
        } catch {
            // Se rename falhar (disco diferente), copiar e deletar
            fs.copyFileSync(tempPath, finalPath);
            try { fs.unlinkSync(tempPath); } catch {}
        }

        console.log(`[DOWNLOAD] ✅ Salvo em: ${finalPath}`);

        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-complete', {
                id: downloadId, state: 'completed',
                path: finalPath, progress: 100
            });
        }
    } catch (err) {
        console.error('[DOWNLOAD] Erro ao mover arquivo:', err);
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-complete', {
                id: downloadId, state: 'interrupted',
                path: tempPath, progress: 100
            });
        }
    }
}

// ===================================================================
// IPC — TOOLBAR COMMANDS
// ===================================================================

function getViewForSender(event) {
    // A toolbar envia comandos. Precisamos encontrar o BrowserView associado.
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const entry = windowViews.get(mainWindow.id);
    return entry || null;
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

ipcMain.on('open-download', (e, p) => { if (p) shell.openPath(p).catch(() => {}); });
ipcMain.on('show-download-in-folder', (e, p) => { if (p) shell.showItemInFolder(path.resolve(p)); });

// ★ Toggle do painel de downloads: encolher BrowserView para o painel ficar visível

ipcMain.on('downloads-panel-toggle', (e, isOpen) => {
    const mainWindow = BrowserWindow.fromWebContents(e.sender);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const entry = windowViews.get(mainWindow.id);
    if (!entry) return;

    entry.downloadsPanelOpen = isOpen;
    updateViewBounds(mainWindow);

    // Ajustar auto-resize: quando painel está aberto, não auto-resize largura
    entry.view.setAutoResize({
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
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const entry = windowViews.get(mainWindow.id);
    if (!entry) return;

    const viewContents = entry.view.webContents;
    const perfil = windowProfiles.get(viewContents.id);

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
                await dialog.showMessageBox(mainWindow, {
                    type: 'info', title: 'Exportação Concluída',
                    message: 'Sessão salva com sucesso no GitHub (criptografada)!',
                    detail: `Arquivo: ${perfil.ftp}`
                });
            } catch (err) {
                console.error('[EXPORT] Falha GitHub:', err);
                const { response } = await dialog.showMessageBox(mainWindow, {
                    type: 'warning', title: 'Erro GitHub',
                    message: 'Falha no GitHub. Salvar localmente?',
                    buttons: ['Salvar Localmente', 'Cancelar']
                });
                if (response === 0) await saveSessionLocally(mainWindow, jsonContent);
            }
        } else {
            await saveSessionLocally(mainWindow, jsonContent);
        }
    } catch (err) {
        console.error('[EXPORT] Erro:', err);
        await dialog.showMessageBox(mainWindow, {
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
        console.log('[IPC CRYPTO] Perfil recebido criptografado. Descriptografando...');
        perfil = decryptIPC(rawPerfil.payload);
        if (!perfil) {
            console.error('[IPC CRYPTO] ❌ Falha ao descriptografar perfil. IPC possivelmente adulterado.');
            dialog.showErrorBox('Erro de Segurança', 'Não foi possível processar os dados de forma segura.');
            return;
        }
        console.log('[IPC CRYPTO] ✅ Perfil descriptografado com sucesso.');
    } else {
        // Perfil veio em texto puro (retrocompatibilidade)
        perfil = rawPerfil;
        console.log('[IPC] Perfil recebido (sem criptografia).');
    }

    const windowId = `profile_${Date.now()}`;
    const partition = `persist:${windowId}`;
    const isolatedSession = session.fromPartition(partition);
    let mainWindow = null;

    try {
        if (!perfil?.link) throw new Error('Perfil ou link inválido.');

        await isolatedSession.clearStorageData();

        // User Agent: usar apenas se o perfil fornecer
        // User Agent: validar antes de setar (perfil pode conter email ou lixo no campo)
        if (perfil.userAgent && perfil.userAgent.includes('Mozilla/') && !perfil.userAgent.includes('@')) {
            await isolatedSession.setUserAgent(perfil.userAgent);
        }

        // Baixar cookies do GitHub
        let sessionData = null;
        if (perfil.ftp && perfil.senha) {
            try {
                const fileContent = await downloadFromGitHub(perfil.ftp, perfil.senha);
                if (fileContent) sessionData = JSON.parse(fileContent);
            } catch (err) {
                console.error(`[SESSÃO ${windowId}] Falha GitHub:`, err.message);
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

            console.log(`[SESSÃO ${windowId}] Cookies: ${cookiesToInject.length} total, ${prepared.length} válidos, ${skipped} removidos (expirados/duplicados)`);

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

            console.log(`[SESSÃO ${windowId}] Injeção: ${ok} OK, ${fail} falhas`);
            if (failedNames.length > 0) {
                console.warn(`[SESSÃO ${windowId}] Primeiras falhas:`, failedNames.join(' | '));
            }

            await isolatedSession.cookies.flushStore();
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

                console.log(`[PROXY] Tipo: ${t} | Host: ${perfil.proxy.host}:${validation.port} | Auth: ${perfil.proxy.username ? 'SIM' : 'NÃO'}`);
            } else {
                console.warn(`[PROXY] Configuração inválida: ${validation.error}. Usando direto.`);
                await isolatedSession.setProxy({ proxyRules: 'direct://' });
            }
        } else {
            console.log('[PROXY] Nenhum proxy configurado. Conexão direta.');
            await isolatedSession.setProxy({ proxyRules: 'direct://' });
        }

        // CRIAR JANELA COM BROWSERVIEW
        const { mainWindow: mw, view } = createSecureWindow(perfil, isolatedSession, storageData);
        mainWindow = mw;

        // Proxy credentials
        if (perfil.proxy?.username) {
            proxyCredentials.set(view.webContents.id, {
                username: perfil.proxy.username,
                password: perfil.proxy.password ?? ''
            });
            console.log(`[PROXY] Credenciais armazenadas para wcId ${view.webContents.id}: user=${perfil.proxy.username}`);
        }

        // Carregar URL no BrowserView
        try {
            await view.webContents.loadURL(perfil.link);
        } catch (err) {
            // NUNCA destruir a janela por erro de navegação.
            // O navegador deve ficar aberto mesmo que o site falhe.
            console.warn(`[NAV] Erro ao carregar ${perfil.link}: ${err.code || err.message}`);
        }

    } catch (err) {
        console.error('--- [ERRO FATAL] ---', err);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    }
}

// Registrar AMBOS os handlers: plain e criptografado
ipcMain.on('abrir-navegador', (event, perfil) => handleAbrirNavegador(event, perfil));
ipcMain.on('abrir-navegador-secure', (event, encryptedPerfil) => handleAbrirNavegador(event, encryptedPerfil));

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
        console.error(`[PROXY AUTH] ❌ Máximo de tentativas atingido para ${host} (wcId: ${wcId}). Cancelando.`);
        callback(); // Sem credenciais → cancela
        // Reset após 30s para permitir nova tentativa
        setTimeout(() => proxyAuthAttempts.delete(key), 30000);
        return;
    }

    // Buscar credenciais — tentar pelo webContents.id do view
    let credentials = proxyCredentials.get(wcId);

    // Se não encontrou, buscar por qualquer entrada (pode ser sub-frame ou service worker)
    if (!credentials) {
        for (const [id, creds] of proxyCredentials) {
            credentials = creds;
            console.warn(`[PROXY AUTH] Credenciais não encontradas para wcId ${wcId}, usando do wcId ${id}`);
            break;
        }
    }

    if (credentials) {
        console.log(`[PROXY AUTH] ✅ Autenticando ${scheme} ${host} (tentativa ${attempts}/3, wcId: ${wcId})`);
        callback(credentials.username, credentials.password);
    } else {
        console.error(`[PROXY AUTH] ❌ NENHUMA credencial disponível para ${host} (wcId: ${wcId})`);
        console.error(`[PROXY AUTH] Credenciais armazenadas: ${[...proxyCredentials.keys()].join(', ') || 'nenhuma'}`);
        callback();
    }
};

// ===================================================================
// INICIALIZAÇÃO
// ===================================================================
function startApp() {
    // Anti-bot
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

    app.whenReady().then(async () => {
        await limparParticoesAntigas();

        for (const listener of app.listeners('login')) app.removeListener('login', listener);
        app.on('login', nossoManipuladorDeLogin);

        // ★ CRIAR JANELA PRINCIPAL — carrega o Lovable
        // (substitui o que o Nativefier fazia automaticamente)
        const mainWindow = new BrowserWindow({
            width: 1280,
            height: 720,
            minWidth: 800,
            minHeight: 600,
            icon: path.join(__dirname, 'icon.ico'),
            title: 'MultiPrime V6',
            autoHideMenuBar: true,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: false,  // Necessário para window.abrirNavegador
                nodeIntegration: false,
                sandbox: false,           // Necessário para require('crypto') no preload
                devTools: true
            }
        });

        mainWindow.loadURL(APP_URL);
        mainWindow.maximize();

        console.log(`[SISTEMA] Janela principal criada. Carregando: ${APP_URL}`);
        console.log('[SISTEMA] Aplicação pronta. Arquitetura BrowserView ativa.');

        // ★ AUTO-UPDATER DO ELECTRON: verifica se tem versão nova no GitHub Releases
        // Baixa e instala automaticamente ao fechar o app
        if (autoUpdater) {
            autoUpdater.on('checking-for-update', () => {
                console.log('[APP-UPDATER] Verificando atualizações do app...');
            });
            autoUpdater.on('update-available', (info) => {
                console.log(`[APP-UPDATER] ✅ Nova versão disponível: ${info.version}`);
            });
            autoUpdater.on('update-not-available', () => {
                console.log('[APP-UPDATER] App está na versão mais recente.');
            });
            autoUpdater.on('download-progress', (progress) => {
                console.log(`[APP-UPDATER] Baixando: ${Math.round(progress.percent)}%`);
            });
            autoUpdater.on('update-downloaded', (info) => {
                console.log(`[APP-UPDATER] ✅ Versão ${info.version} baixada. Será instalada ao fechar o app.`);
            });
            autoUpdater.on('error', (err) => {
                console.warn('[APP-UPDATER] Erro (não crítico):', err.message);
            });

            // Verificar após 15s (não atrasar a inicialização)
            setTimeout(() => {
                autoUpdater.checkForUpdatesAndNotify().catch(() => {});
            }, 15000);
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
