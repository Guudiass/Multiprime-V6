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

// ===== TITLEBAR PERSONALIZADA =====
(function() {
  var ipc = _mp_ipc;
  var BAR_HEIGHT = 36;

  function injectTitlebar() {
    if (document.getElementById('mp-titlebar')) return;

    // CSS
    var style = document.createElement('style');
    style.id = 'mp-titlebar-css';
    style.textContent = [
      '#mp-titlebar {',
      '  position: fixed; top: 0; left: 0; width: 100%;',
      '  height: ' + BAR_HEIGHT + 'px;',
      '  background: linear-gradient(180deg, #1a1a1a 0%, #111111 100%);',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  padding: 0 12px; box-sizing: border-box;',
      '  -webkit-app-region: drag;',
      '  user-select: none;',
      '  border-bottom: 1px solid rgba(255,255,255,0.06);',
      '  z-index: 2147483647;',
      '  font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      '}',
      '#mp-title-area {',
      '  display: flex; align-items: center;',
      '  color: rgba(255,255,255,0.7);',
      '  -webkit-app-region: drag;',
      '}',
      '#mp-title-area span { font-weight: 500; letter-spacing: 0.3px; }',
      '#mp-controls {',
      '  display: flex; align-items: center; gap: 4px;',
      '  -webkit-app-region: no-drag;',
      '}',
      '.mp-btn {',
      '  width: 28px; height: 28px;',
      '  background: transparent; border: none; border-radius: 6px;',
      '  color: rgba(255,255,255,0.55); cursor: pointer;',
      '  display: flex; align-items: center; justify-content: center;',
      '  transition: all 0.15s ease;',
      '  -webkit-app-region: no-drag;',
      '  padding: 0; margin: 0;',
      '}',
      '.mp-btn:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); }',
      '.mp-close:hover { background: #e81123; color: white; }',
      '',
      '/* Empurrar o conteúdo para baixo */',
      'html { margin-top: ' + BAR_HEIGHT + 'px !important; }',
      'body { min-height: calc(100vh - ' + BAR_HEIGHT + 'px) !important; }'
    ].join('\n');

    // Titlebar HTML
    var bar = document.createElement('div');
    bar.id = 'mp-titlebar';
    bar.innerHTML = [
      '<div id="mp-title-area">',
      '  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="margin-right:8px;">',
      '    <circle cx="8" cy="8" r="7" fill="#3b82f6"/>',
      '    <path d="M5 8l2 2 4-4" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
      '  </svg>',
      '  <span>MultiPrime</span>',
      '</div>',
      '<div id="mp-controls">',
      '  <button class="mp-btn" id="mp-min">',
      '    <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      '  </button>',
      '  <button class="mp-btn" id="mp-max">',
      '    <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
      '  </button>',
      '  <button class="mp-btn mp-close" id="mp-close">',
      '    <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      '  </button>',
      '</div>'
    ].join('');

    // Inserir no DOM
    (document.head || document.documentElement).appendChild(style);
    (document.body || document.documentElement).appendChild(bar);

    // Eventos
    document.getElementById('mp-min').addEventListener('click', function(e) {
      e.stopPropagation(); ipc.send('main-minimize');
    });
    document.getElementById('mp-max').addEventListener('click', function(e) {
      e.stopPropagation(); ipc.send('main-maximize');
    });
    document.getElementById('mp-close').addEventListener('click', function(e) {
      e.stopPropagation(); ipc.send('main-close');
    });
    bar.addEventListener('dblclick', function() { ipc.send('main-maximize'); });

    // Monitorar remoção (SPAs podem limpar o DOM)
    var observer = new MutationObserver(function() {
      if (!document.getElementById('mp-titlebar')) {
        injectTitlebar();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    console.log('[MULTIPRIME] Titlebar personalizada injetada.');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(injectTitlebar, 0);
  } else {
    document.addEventListener('DOMContentLoaded', injectTitlebar);
  }
  window.addEventListener('load', function() { setTimeout(injectTitlebar, 100); });
})();
