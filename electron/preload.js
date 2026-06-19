const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  onTogglePlay: (callback) => ipcRenderer.on('toggle-play', (_event, ...args) => callback(...args)),
  togglePlay: () => ipcRenderer.send('toggle-play'),
});
