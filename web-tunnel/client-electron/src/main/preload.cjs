const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wt', {
  getCaps: () => ipcRenderer.invoke('caps:get'),
  openLog: () => ipcRenderer.invoke('log:open'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  sendPhoneCode: (phone) => ipcRenderer.invoke('auth:send-code', phone),
  resendCode: () => ipcRenderer.invoke('auth:resend-code'),
  verifyCode: (code) => ipcRenderer.invoke('auth:verify-code', code),
  verifyPassword: (pw) => ipcRenderer.invoke('auth:verify-password', pw),
  backToPhone: () => ipcRenderer.invoke('auth:back-to-phone'),
  backToCode: () => ipcRenderer.invoke('auth:back-to-code'),
  signOut: () => ipcRenderer.invoke('auth:sign-out'),
  importClientConfig: (config) => ipcRenderer.invoke('config:import', config),
  listChats: () => ipcRenderer.invoke('chats:list'),
  startTunnel: (opts) => ipcRenderer.invoke('tunnel:start', opts),
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),
  sendLogs: () => ipcRenderer.invoke('logs:send'),
  resetPinnedKey: (keyId) => ipcRenderer.invoke('keys:reset-pin', keyId),
  speedTest: () => ipcRenderer.invoke('tunnel:speedtest'),
  systemTunnel: {
    status: () => ipcRenderer.invoke('system-tunnel:status'),
    start: () => ipcRenderer.invoke('system-tunnel:start'),
    stop: () => ipcRenderer.invoke('system-tunnel:stop'),
    onStatus: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('system-tunnel:status', handler);
      return () => ipcRenderer.removeListener('system-tunnel:status', handler);
    },
  },
  lanShare: {
    status: () => ipcRenderer.invoke('lan-share:status'),
    start: () => ipcRenderer.invoke('lan-share:start'),
    stop: () => ipcRenderer.invoke('lan-share:stop'),
    qr: (text) => ipcRenderer.invoke('lan-share:qr', text),
    onStatus: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('lan-share:status', handler);
      return () => ipcRenderer.removeListener('lan-share:status', handler);
    },
  },
  onStatusChange: (cb) => {
    const handler = (_event, status) => cb(status);
    ipcRenderer.on('status:change', handler);
    return () => ipcRenderer.removeListener('status:change', handler);
  },
});
