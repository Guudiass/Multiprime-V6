"use strict";
// preload.js — MultiPrime V5 (Electron Puro)
// Roda na janela principal (Lovable).
// Responsabilidades: window.abrirNavegador + window.getIntegrity + IPC criptografado

var _mp_crypto = require('crypto');
var _mp_ipc = require('electron').ipcRenderer;
var _mp_fs = require('fs');
var _mp_path = require('path');

// ===== IPC CRIPTOGRAFADO =====
var _mp_sessionKey = null;
var _mp_ivPrefix = null;

function _mp_getSessionKey() {
  if (_mp_sessionKey) return true;
  try {
    var result = _mp_ipc.sendSync('get-ipc-session-key');
    if (result && result.key) {
      _mp_sessionKey = Buffer.from(result.key, 'hex');
      _mp_ivPrefix = Buffer.from(result.prefix, 'hex');
      return true;
    }
  } catch (err) {
    console.warn('[MULTIPRIME] Chave de sessao nao disponivel:', err.message);
  }
  return false;
}

function _mp_encryptPerfil(data) {
  if (!_mp_getSessionKey()) return null;
  try {
    var iv = Buffer.concat([_mp_ivPrefix, _mp_crypto.randomBytes(8)]);
    var cipher = _mp_crypto.createCipheriv('aes-256-gcm', _mp_sessionKey, iv);
    var encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return {
      e: encrypted,
      i: iv.toString('hex'),
      t: cipher.getAuthTag().toString('hex')
    };
  } catch (err) {
    console.error('[MULTIPRIME] Erro ao criptografar:', err.message);
    return null;
  }
}

// ===== ABRIR NAVEGADOR (chamado pelo Lovable) =====
window.abrirNavegador = function(perfil) {
  var encrypted = _mp_encryptPerfil(perfil);
  if (encrypted) {
    _mp_ipc.send('abrir-navegador-secure', {
      __encrypted: true,
      payload: encrypted
    });
  } else {
    _mp_ipc.send('abrir-navegador', perfil);
  }
};

// ===== VERIFICAÇÃO DE INTEGRIDADE =====
var _mp_protectedFiles = ['main.js', 'preload.js', 'preload-secure.js', 'preload-toolbar.js', 'toolbar.html'];

// Captura no BOOT: ler conteúdo dos arquivos AGORA (momento da inicialização)
var _mp_bootContents = {};
var _mp_bootTime = Date.now();

(function captureBootState() {
  for (var i = 0; i < _mp_protectedFiles.length; i++) {
    var filename = _mp_protectedFiles[i];
    var filePath = _mp_path.join(__dirname, filename);
    try {
      _mp_bootContents[filename] = _mp_fs.readFileSync(filePath);
    } catch (e) {
      _mp_bootContents[filename] = null;
    }
  }
  console.log('[MULTIPRIME] Boot state capturado para ' + _mp_protectedFiles.length + ' arquivos.');
})();

// Re-captura pós auto-update (apenas o main.js pode disparar)
_mp_ipc.on('_mp_recapture_boot', function() {
  console.log('[MULTIPRIME] Re-captura solicitada pelo auto-updater...');
  for (var i = 0; i < _mp_protectedFiles.length; i++) {
    var filename = _mp_protectedFiles[i];
    var filePath = _mp_path.join(__dirname, filename);
    try {
      _mp_bootContents[filename] = _mp_fs.readFileSync(filePath);
    } catch (e) {
      _mp_bootContents[filename] = null;
    }
  }
  _mp_bootTime = Date.now();
  console.log('[MULTIPRIME] Boot state RE-capturado (pos auto-update).');
});

// getIntegrity usa conteúdo do BOOT, não do disco atual
window.getIntegrity = function(nonce) {
  if (!nonce || typeof nonce !== 'string') return null;
  try {
    var result = {};
    result.__bootTime = _mp_bootTime;
    for (var i = 0; i < _mp_protectedFiles.length; i++) {
      var filename = _mp_protectedFiles[i];
      var content = _mp_bootContents[filename];
      if (content) {
        var hash = _mp_crypto.createHash('sha256')
          .update(content)
          .update(nonce)
          .digest('hex');
        result[filename] = hash;
      } else {
        result[filename] = 'FILE_MISSING';
      }
    }
    return result;
  } catch (err) {
    console.error('[MULTIPRIME] Erro na verificacao de integridade:', err.message);
    return null;
  }
};

console.log('[MULTIPRIME] window.abrirNavegador + window.getIntegrity configurados (boot-locked).');
