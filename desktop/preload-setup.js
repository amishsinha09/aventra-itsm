// Exposes exactly one function to the setup page: connect(serverAddress).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aventra', {
  connect: (address) => ipcRenderer.invoke('setup:connect', address),
});
