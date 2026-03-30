// afterSign.js — Notarização automática com a Apple
// Este script roda após o electron-builder assinar o app.
// Envia o .app para a Apple verificar (2-5 minutos) e recebe o "selo" digital.

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;

    // Só notarizar no macOS
    if (electronPlatformName !== 'darwin') {
        return;
    }

    // Pular se não tiver credenciais (build local sem certificado)
    if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
        console.log('[NOTARIZE] Pulando notarização (sem credenciais Apple)');
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = `${appOutDir}/${appName}.app`;

    console.log(`[NOTARIZE] Notarizando ${appPath}...`);

    await notarize({
        appBundleId: 'com.designerprime.multiprime',
        appPath: appPath,
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID
    });

    console.log('[NOTARIZE] ✅ Notarização concluída com sucesso!');
};
