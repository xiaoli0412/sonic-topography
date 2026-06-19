const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  onTogglePlay: (callback) => ipcRenderer.on('toggle-play', (_event, ...args) => callback(...args)),
  togglePlay: () => ipcRenderer.send('toggle-play'),
  onExternalMediaInfo: (callback) => {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on('external-media-info', handler);
    return () => ipcRenderer.removeListener('external-media-info', handler);
  },
  onExternalMediaStatus: (callback) => {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on('external-media-status', handler);
    return () => ipcRenderer.removeListener('external-media-status', handler);
  },
  sendStartListeningExternalMedia: () => ipcRenderer.send('start-listening-external-media'),
  sendStopListeningExternalMedia: () => ipcRenderer.send('stop-listening-external-media'),
  getSystemAudioSource: () => ipcRenderer.invoke('get-system-audio-source'),
});
