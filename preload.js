'use strict';

const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('desktopUpdater', {
    getStatus: () => ipcRenderer.invoke('updater:get-status'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: callback => {
        const handler = (_event, status) => callback(status);
        ipcRenderer.on('updater:status', handler);
        return () => ipcRenderer.removeListener('updater:status', handler);
    }
});
