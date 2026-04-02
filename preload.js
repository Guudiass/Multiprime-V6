"use strict";
// preload.js — MultiPrime V6 (Electron Puro)
// Roda na janela principal (Lovable).
// Usa contextBridge para exposição segura via window.multiprime

var _mp_crypto = require('crypto');
var _mp_electron = require('electron');
var _mp_ipc = _mp_electron.ipcRenderer;
var _mp_contextBridge = _mp_electron.contextBridge;
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

// ===== VERIFICAÇÃO DE INTEGRIDADE (boot-locked) =====
var _mp_protectedFiles = ['main.js', 'preload.js', 'preload-secure.js', 'preload-toolbar.js', 'toolbar.html'];
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

_mp_ipc.on('_mp_recapture_boot', function() {
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

// ===== STATUS PANEL — callbacks armazenados no preload =====
var _mp_statusCallbacks = {
  onTabOpened: null,
  onTabClosed: null,
  onTabStatus: null,
  onEventLog: null,
  onNavigation: null,
  onHeartbeat: null,
  onAppClosing: null
};

_mp_ipc.on('mp-tab-opened', function(e, data) { if (_mp_statusCallbacks.onTabOpened) _mp_statusCallbacks.onTabOpened(data); });
_mp_ipc.on('mp-tab-closed', function(e, data) { if (_mp_statusCallbacks.onTabClosed) _mp_statusCallbacks.onTabClosed(data); });
_mp_ipc.on('mp-tab-status', function(e, data) { if (_mp_statusCallbacks.onTabStatus) _mp_statusCallbacks.onTabStatus(data); });
_mp_ipc.on('mp-event-log', function(e, data) { if (_mp_statusCallbacks.onEventLog) _mp_statusCallbacks.onEventLog(data); });
_mp_ipc.on('mp-navigation', function(e, data) { if (_mp_statusCallbacks.onNavigation) _mp_statusCallbacks.onNavigation(data); });
_mp_ipc.on('mp-heartbeat', function(e, data) { if (_mp_statusCallbacks.onHeartbeat) _mp_statusCallbacks.onHeartbeat(data); });
_mp_ipc.on('mp-app-closing', function(e, data) { if (_mp_statusCallbacks.onAppClosing) _mp_statusCallbacks.onAppClosing(data); });

// ===== EXPOR API SEGURA VIA CONTEXTBRIDGE =====
_mp_contextBridge.exposeInMainWorld('multiprime', {
  // Abrir navegador
  abrirNavegador: function(perfil) {
    var cleanPerfil = JSON.parse(JSON.stringify(perfil));
    var encrypted = _mp_encryptPerfil(cleanPerfil);
    if (encrypted) {
      _mp_ipc.send('abrir-navegador-secure', {
        __encrypted: true,
        payload: encrypted
      });
    } else {
      _mp_ipc.send('abrir-navegador', cleanPerfil);
    }
  },

  // Abrir link externo
  openExternal: function(url) {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      _mp_ipc.send('open-external', url);
    }
  },

  // Tema
  setTema: function(tema) {
    if (tema === 'dark' || tema === 'light') {
      _mp_ipc.send('set-tema', tema);
    }
  },

  // Verificação de integridade
  getIntegrity: function(nonce) {
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
  },

  // Status panel callbacks (setter functions para o Lovable registrar callbacks)
  mpStatus: {
    setOnTabOpened: function(cb) { _mp_statusCallbacks.onTabOpened = cb; },
    setOnTabClosed: function(cb) { _mp_statusCallbacks.onTabClosed = cb; },
    setOnTabStatus: function(cb) { _mp_statusCallbacks.onTabStatus = cb; },
    setOnEventLog: function(cb) { _mp_statusCallbacks.onEventLog = cb; },
    setOnNavigation: function(cb) { _mp_statusCallbacks.onNavigation = cb; },
    setOnHeartbeat: function(cb) { _mp_statusCallbacks.onHeartbeat = cb; },
    setOnAppClosing: function(cb) { _mp_statusCallbacks.onAppClosing = cb; }
  }
});

console.log('[MULTIPRIME] window.multiprime configurado via contextBridge (seguro).');
