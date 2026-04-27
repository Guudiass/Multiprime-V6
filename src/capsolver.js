/* eslint-disable no-undef */
// src/capsolver.js — CapSolver Turnstile resolver (robusto, com retry e logs detalhados)

const https = require('https');
const state = require('./state');
const { logEvent } = require('./status');

const MAX_CREATE_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30; // 60s max

async function solveTurnstile(websiteURL, websiteKey, proxyInfo) {
    if (!state.CAPSOLVER_API_KEY) {
        console.error('[CAPSOLVER] ❌ API key NÃO configurada. Verifique se o Lovable está enviando capsolverKey no perfil.');
        return null;
    }


    // Tipos de task para tentar (Turnstile primeiro, Challenge como fallback)
    // AntiTurnstileTaskProxyLess: widget Turnstile (sem proxy)
    // AntiCloudflareTask: Challenge 5s / Managed Challenge (precisa proxy)
    const taskTypes = [
        {
            type: 'AntiTurnstileTaskProxyLess',
            label: 'Turnstile',
            buildTask: () => ({
                type: 'AntiTurnstileTaskProxyLess',
                websiteURL: websiteURL,
                websiteKey: websiteKey
            })
        }
    ];

    // Se temos proxy, adicionar AntiCloudflareTask como fallback
    if (proxyInfo?.host && proxyInfo?.port) {
        const proxyType = (proxyInfo.tipo || 'http').toLowerCase();
        taskTypes.push({
            type: 'AntiCloudflareTask',
            label: 'Challenge',
            buildTask: () => ({
                type: 'AntiCloudflareTask',
                websiteURL: websiteURL,
                proxy: `${proxyType}://${proxyInfo.username ? proxyInfo.username + ':' + (proxyInfo.password || '') + '@' : ''}${proxyInfo.host}:${proxyInfo.port}`
            })
        });
    } else {
    }

    let createResp = null;

    for (const taskType of taskTypes) {
        let succeeded = false;

        for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
            try {
                createResp = await capsolverRequest('createTask', {
                    clientKey: state.CAPSOLVER_API_KEY,
                    task: taskType.buildTask()
                });

                // Sucesso
                if (createResp && createResp.taskId) {
                    createResp._usedType = taskType.type;
                    succeeded = true;
                    break;
                }

                const errorMsg = createResp?.errorDescription || createResp?.errorCode || 'Resposta vazia';
                const errorId = createResp?.errorId || 'N/A';
                console.error(`[CAPSOLVER] ❌ ${taskType.label} falhou (tentativa ${attempt}/${MAX_CREATE_RETRIES}): errorId=${errorId} | ${errorMsg}`);

                // Sitekey é challenge, não turnstile → pular para o próximo tipo
                if (createResp?.errorDescription?.includes('not turnstile') ||
                    createResp?.errorDescription?.includes('not challenge')) {
                    break;
                }

                // Erros permanentes que não adianta tentar de novo nem trocar tipo
                if (createResp?.errorCode === 'ERROR_KEY_DOES_NOT_EXIST' ||
                    createResp?.errorCode === 'ERROR_ZERO_BALANCE' ||
                    createResp?.errorCode === 'ERROR_IP_NOT_ALLOWED') {
                    console.error(`[CAPSOLVER] ❌ Erro permanente: ${createResp.errorCode}`);
                    logEvent('capsolver_error', { errorCode: createResp.errorCode, errorMsg, websiteURL });
                    return null;
                }

                // Task data invalida → tentar proximo tipo
                if (createResp?.errorCode === 'ERROR_INVALID_TASK_DATA') {
                    break;
                }

                if (attempt < MAX_CREATE_RETRIES) {
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                }

            } catch (err) {
                console.error(`[CAPSOLVER] ❌ Erro de rede (tentativa ${attempt}/${MAX_CREATE_RETRIES}):`, err.message);
                if (attempt < MAX_CREATE_RETRIES) {
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                }
            }
        }

        if (succeeded) break;
    }

    if (!createResp || !createResp.taskId) {
        console.error('[CAPSOLVER] ❌ Todas as tentativas de criar task falharam');
        return null;
    }

    // Identificar qual tipo de task foi criada
    const usedTaskType = taskTypes.find(t => t.type === (createResp._usedType || taskTypes[0].type));
    const isChallenge = usedTaskType?.type === 'AntiCloudflareTask';

    // Polling para resultado
    const taskId = createResp.taskId;
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        try {
            const result = await capsolverRequest('getTaskResult', {
                clientKey: state.CAPSOLVER_API_KEY,
                taskId: taskId
            });

            if (result && result.status === 'ready') {
                const solution = result.solution || {};
                const token = solution.token;
                const cfClearance = solution.cf_clearance;
                const userAgent = solution.userAgent;
                const elapsed = ((i + 1) * POLL_INTERVAL_MS / 1000).toFixed(0);

                // Challenge: priorizar cf_clearance, mas aceitar token tambem
                if (isChallenge) {
                    if (cfClearance) {
                        return { type: 'cf_clearance', cfClearance, userAgent };
                    }
                    if (token) {
                        // Challenge retornou token — tratar como cf_clearance (o token E o clearance em alguns casos)
                        return { type: 'cf_clearance', cfClearance: token, userAgent };
                    }
                }

                // Turnstile: retornar token
                if (token) {
                    return { type: 'token', token };
                }

                console.error('[CAPSOLVER] ❌ Status ready mas sem token/cf_clearance:', JSON.stringify(solution));
                return null;
            }

            if (result && result.status === 'failed') {
                const errorMsg = result.errorDescription || result.errorCode || 'Desconhecido';
                console.error(`[CAPSOLVER] ❌ Task falhou: ${errorMsg}`);
                logEvent('capsolver_task_failed', { taskId, errorMsg, websiteURL });
                return null;
            }

            if (result && result.errorId && result.errorId !== 0) {
                const errorMsg = result.errorDescription || result.errorCode || 'Desconhecido';
                console.error(`[CAPSOLVER] ❌ Erro no polling: errorId=${result.errorId} | ${errorMsg}`);
                return null;
            }

            // Status: processing — continuar polling
        } catch (err) {
            console.warn(`[CAPSOLVER] ⚠️ Erro no polling (tentativa ${i + 1}):`, err.message);
            // Continuar tentando, não abortar por erro de rede no polling
        }
    }

    console.error(`[CAPSOLVER] ❌ Timeout (${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s)`);
    return null;
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
                try {
                    const parsed = JSON.parse(chunks);
                    resolve(parsed);
                } catch {
                    console.error(`[CAPSOLVER] Resposta inválida do endpoint ${endpoint}:`, chunks.substring(0, 200));
                    resolve(null);
                }
            });
        });
        req.on('error', (err) => {
            console.error(`[CAPSOLVER] Erro de rede em ${endpoint}:`, err.message);
            reject(err);
        });
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error(`Timeout ${endpoint} (30s)`));
        });
        req.write(data);
        req.end();
    });
}

module.exports = { solveTurnstile };
