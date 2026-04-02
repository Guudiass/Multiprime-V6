/* eslint-disable no-undef */
// src/config.js — Constantes e configuração

const TAB_BAR_HEIGHT = 36;
const TOOLBAR_HEIGHT = 44;
const TOTAL_HEADER_HEIGHT = TAB_BAR_HEIGHT + TOOLBAR_HEIGHT; // 80
const DOWNLOADS_PANEL_WIDTH = 370;

const APP_URL = 'https://multiprime.designerprime.com.br';
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

module.exports = {
    TAB_BAR_HEIGHT,
    TOOLBAR_HEIGHT,
    TOTAL_HEADER_HEIGHT,
    DOWNLOADS_PANEL_WIDTH,
    APP_URL,
    IS_DEV,
    CONFIG,
    GITHUB_CONFIG,
    CRYPTO_CONFIG
};
