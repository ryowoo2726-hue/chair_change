const assert = require('node:assert/strict');
const {test} = require('node:test');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture({packaged = true, answer = 1, version = '1.4.9'} = {}) {
    const handlers = new Map();
    const statuses = [];
    const prompts = [];
    let readyToShow;
    let checks = 0, downloads = 0, installs = 0;
    const updater = Object.assign(new EventEmitter(), {
        checkForUpdates: async () => {
            checks++;
            updater.emit('checking-for-update');
            updater.emit(version ? 'update-available' : 'update-not-available', {version});
        },
        downloadUpdate: async () => { downloads++; },
        quitAndInstall: (silent, restart) => { assert.equal(silent, true); assert.equal(restart, true); installs++; }
    });
    class Window {
        constructor() {
            this.webContents = {
                send: (_channel, status) => statuses.push(status),
                setWindowOpenHandler() {}, on() {}
            };
        }
        removeMenu() {} loadFile() {} once(_event, callback) { readyToShow = callback; } show() {} isDestroyed() { return false; }
    }
    const electron = {
        app: {isPackaged:packaged, whenReady: () => Promise.resolve(), on() {}, quit() {}},
        BrowserWindow: Window,
        ipcMain: {handle: (name, callback) => handlers.set(name, callback)},
        shell: {},
        dialog: {showMessageBox: async (_window, options) => { prompts.push(options); return {response:answer}; }}
    };
    const context = vm.createContext({
        __dirname:path.join(__dirname, '..'), process:{env:{}, platform:'win32'}, setImmediate,
        require(name) {
            if (name === 'electron') return electron;
            if (name === 'electron-updater') return {autoUpdater:updater};
            return require(name);
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
    await flush();
    return {handlers, statuses, prompts, updater,
        show: async () => { readyToShow(); await flush(); },
        counts: () => ({checks, downloads, installs}),
        call: (name, ...args) => handlers.get(name)(null, ...args)};
}

test('checks share one public feed request', async () => {
    const f = await fixture();
    const results = await Promise.all([f.call('updater:check'), f.call('updater:check')]);
    assert.ok(results.every(result => result.ok));
    assert.equal(f.counts().checks, 1);
    assert.equal(f.updater.autoDownload, false);
    assert.equal((await f.call('updater:get-status')).type, 'available');
});

test('startup asks once and an accepted update downloads and installs without a second prompt', async () => {
    const f = await fixture({answer:0});
    await f.show();
    assert.equal(f.counts().checks, 1);
    assert.equal(f.counts().downloads, 1);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0].detail, /재시작/);
    assert.equal(f.counts().installs, 0);
    f.updater.emit('update-downloaded', {version:'1.4.9'});
    await flush();
    assert.equal(f.counts().installs, 1);
    assert.equal(f.prompts.length, 1);
    assert.equal((await f.call('updater:get-status')).type, 'downloaded');
});

test('declining keeps the app open and manual update still works', async () => {
    const f = await fixture();
    assert.equal((await f.call('updater:install')).ok, false);
    assert.equal((await f.call('updater:download')).ok, false);
    await f.show();
    assert.equal(f.counts().downloads, 0);
    assert.equal(f.counts().installs, 0);
    await Promise.all([f.call('updater:download'), f.call('updater:download')]);
    assert.equal(f.counts().downloads, 1);
});

test('development skips update checks and failed downloads return actionable errors', async () => {
    const dev = await fixture({packaged:false});
    await dev.show();
    assert.equal((await dev.call('updater:check')).ok, false);
    assert.equal(dev.counts().checks, 0);
    assert.equal(dev.prompts.length, 0);
    const current = await fixture({version:null});
    await current.show();
    assert.equal(current.prompts.length, 0);
    const f = await fixture();
    await f.show();
    f.updater.downloadUpdate = async () => { throw new Error('Cannot find latest.yml'); };
    const result = await f.call('updater:download');
    assert.equal(result.ok, false);
    assert.match(result.message, /빌드 완료/);
    assert.equal(f.statuses.at(-1).type, 'error');
});

test('renderer uses startup status without rechecking and retains progress when reopened', async () => {
    const nodes = new Map();
    let checks = 0, statusCallback;
    const document = {
        addEventListener() {}, querySelectorAll: () => [],
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, {
                value:'', style:{}, listeners:[], classList:{add() {}, remove() {}},
                addEventListener(type, callback) { this.listeners.push({type, callback}); }
            });
            return nodes.get(id);
        }
    };
    const context = vm.createContext({document, window: {
        addEventListener() {},
        desktopUpdater: {
            onStatus: callback => { statusCallback = callback; },
            check: async () => { checks++; return {ok:true}; },
            getStatus: async () => ({type:'downloaded', version:'1.4.9'})
        }
    }});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8') +
        '\nglobalThis.app = Object.create(SeatingApp.prototype);', context);
    const app = context.app;
    app.initDesks = () => { app.students = [{id:'1'}]; };
    app.loadLocalData = app.renderGrid = () => {};
    app.init();
    assert.equal(checks, 0);
    for (const id of ['btnDownloadUpdate', 'btnInstallUpdate', 'btnRefreshUpdates']) {
        assert.equal(document.getElementById(id).listeners.length, 1);
    }
    statusCallback({type:'downloading', percent:55});
    assert.equal(document.getElementById('updateProgressFill').style.width, '55%');
    statusCallback({type:'downloaded', version:'1.4.9'});
    await app.openUpdateModal();
    assert.equal(checks, 0);
    assert.equal(document.getElementById('btnInstallUpdate').hidden, true);
    assert.equal(document.getElementById('btnDownloadUpdate').hidden, true);
    statusCallback({type:'install-error', message:'설치 실패'});
    assert.equal(document.getElementById('btnInstallUpdate').hidden, false);
});
