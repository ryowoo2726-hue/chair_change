'use strict';

const {app, BrowserWindow, ipcMain, shell, dialog} = require('electron');
const {autoUpdater} = require('electron-updater');
const path = require('path');

let mainWindow;
let updateReady = false;
let updateStatus = null;
let checkPromise = null;
let downloadPromise = null;

function sendUpdate(type, data = {}) {
    updateStatus = {type, ...data};
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', {type, ...data});
}

function friendlyUpdateError(error) {
    const message = String(error?.message || error || '');
    if (/403|429|rate limit/i.test(message)) return 'GitHub 요청 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.';
    if (/latest\.yml|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_ASSET_NOT_FOUND/.test(message)) {
        return '릴리스의 업데이트 파일이 아직 준비되지 않았습니다. 빌드 완료 후 다시 확인해 주세요.';
    }
    if (/releases\/latest|Unable to find latest version|404/.test(message)) {
        return 'GitHub 릴리스를 열 수 없습니다. 릴리스가 게시된 뒤 다시 확인해 주세요.';
    }
    if (/ENOTFOUND|ERR_(?:NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION|TIMED_OUT)|network|fetch failed/i.test(message)) return '인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
    return '업데이트를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

async function checkUpdates() {
    if (!app.isPackaged) return {ok:false, message:'개발 실행에서는 자동 업데이트를 사용할 수 없습니다. 설치된 EXE에서 확인해 주세요.'};
    if (checkPromise) return checkPromise;
    if (updateReady || downloadPromise) return {ok:true};
    checkPromise = (async () => {
        try {
            await autoUpdater.checkForUpdates();
            return {ok:true};
        } catch (error) {
            const message = friendlyUpdateError(error);
            sendUpdate('error', {message});
            return {ok:false, message};
        }
    })();
    try { return await checkPromise; } finally { checkPromise = null; }
}

async function downloadUpdate() {
    if (updateReady) return {ok:true};
    if (downloadPromise) return downloadPromise;
    if (updateStatus?.type !== 'available') return {ok:false, message:'먼저 설치할 수 있는 새 버전을 확인해 주세요.'};
    downloadPromise = (async () => {
        try {
            sendUpdate('downloading', {percent:0});
            await autoUpdater.downloadUpdate();
            return {ok:true};
        } catch (error) {
            const message = friendlyUpdateError(error);
            sendUpdate('error', {message});
            return {ok:false, message};
        }
    })();
    try { return await downloadPromise; } finally { downloadPromise = null; }
}

async function checkForStartupUpdate() {
    const result = await checkUpdates();
    if (!result.ok || updateStatus?.type !== 'available' || mainWindow.isDestroyed()) return;
    const choice = await dialog.showMessageBox(mainWindow, {
        type:'question', title:'새 업데이트',
        message:'새 버전 v' + updateStatus.version + '이 있습니다. 지금 업데이트할까요?',
        detail:'다운로드가 끝나면 앱이 재시작됩니다.',
        buttons:['업데이트', '나중에'], defaultId:0, cancelId:1
    });
    if (choice.response === 0) await downloadUpdate();
}

function installUpdate() {
    if (!updateReady) return {ok:false, message:'업데이트 다운로드가 완료된 뒤 설치해 주세요.'};
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return {ok:true};
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 1050,
        minHeight: 720,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    mainWindow.removeMenu();
    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        if (app.isPackaged) void checkForStartupUpdate().catch(error => sendUpdate('error', {message:friendlyUpdateError(error)}));
    });
    mainWindow.webContents.setWindowOpenHandler(({url}) => {
        if (url.startsWith('https://github.com/')) shell.openExternal(url);
        return {action:'deny'};
    });
    mainWindow.webContents.on('will-navigate', event => event.preventDefault());
}

autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
autoUpdater.on('update-available', info => sendUpdate('available', {version:info.version}));
autoUpdater.on('update-not-available', info => sendUpdate('not-available', {version:info.version}));
autoUpdater.on('download-progress', progress => sendUpdate('downloading', {percent:progress.percent}));
autoUpdater.on('update-downloaded', info => {
    updateReady = true;
    sendUpdate('downloaded', {version:info.version});
    installUpdate();
});
autoUpdater.on('error', error => {
    if (updateReady) {
        sendUpdate('install-error', {message:'새 버전을 설치하지 못했습니다. 재시작하여 설치를 다시 눌러 주세요.'});
    } else {
        sendUpdate('error', {message:friendlyUpdateError(error)});
    }
});

app.whenReady().then(() => {
    createWindow();

    ipcMain.handle('updater:get-status', () => updateStatus);
    ipcMain.handle('updater:check', () => checkUpdates());
    ipcMain.handle('updater:download', () => downloadUpdate());
    ipcMain.handle('updater:install', () => installUpdate());
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
