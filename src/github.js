/* eslint-disable no-undef */
// src/github.js — Operações com GitHub (download/upload cookies)

const https = require('https');
const { GITHUB_CONFIG } = require('./config');
const { encryptData, decryptData, isEncryptedData } = require('./crypto');

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

module.exports = { downloadFromGitHub, uploadToGitHub };
