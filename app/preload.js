// 起始畫面(start.html)能用的功能:只開放這幾個,網頁碰不到 Node
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sim', {
  recents: () => ipcRenderer.invoke('recents'),
  removeRecent: dir => ipcRenderer.invoke('remove-recent', dir),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openProject: dir => ipcRenderer.invoke('open-project', dir),
  openHelp: () => ipcRenderer.invoke('open-help'),
  openLab: () => ipcRenderer.invoke('open-lab'),
});
