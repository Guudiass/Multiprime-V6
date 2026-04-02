/* eslint-disable no-undef */
// src/crypto.js — Criptografia IPC e dados

const crypto = require('crypto');
const { ipcMain } = require('electron');
const { CRYPTO_CONFIG } = require('./config');

// Chave de sessão para criptografar IPC (gerada a cada execução)
const SESSION_IPC_KEY = crypto.randomBytes(32);
const SESSION_IPC_IV_PREFIX = crypto.randomBytes(8);

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

// Registrar IPC handler para fornecer chave de sessão
ipcMain.on('get-ipc-session-key', (e) => {
    e.returnValue = {
        key: SESSION_IPC_KEY.toString('hex'),
        prefix: SESSION_IPC_IV_PREFIX.toString('hex')
    };
});

module.exports = {
    encryptIPC,
    decryptIPC,
    encryptData,
    decryptData,
    isEncryptedData
};
