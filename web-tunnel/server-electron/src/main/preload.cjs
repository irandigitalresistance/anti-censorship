const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wt', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  openLog: () => ipcRenderer.invoke('log:open'),
  getLogPath: () => ipcRenderer.invoke('log:path'),
  sendPhoneCode: (phone) => ipcRenderer.invoke('auth:send-code', phone),
  resendCode: () => ipcRenderer.invoke('auth:resend-code'),
  verifyCode: (code) => ipcRenderer.invoke('auth:verify-code', code),
  verifyPassword: (pw) => ipcRenderer.invoke('auth:verify-password', pw),
  backToPhone: () => ipcRenderer.invoke('auth:back-to-phone'),
  backToCode: () => ipcRenderer.invoke('auth:back-to-code'),
  signOut: () => ipcRenderer.invoke('auth:sign-out'),
  startServer: (password) => ipcRenderer.invoke('server:start', password),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  terminateConnection: (id, reason) => ipcRenderer.invoke('connection:terminate', id, reason),
  resetUser: (peerKey) => ipcRenderer.invoke('user:reset', peerKey),
  listLogs: () => ipcRenderer.invoke('logs:list'),
  getLog: (id) => ipcRenderer.invoke('logs:get', id),
  onStatusChange: (cb) => {
    const handler = (_event, status) => cb(status);
    ipcRenderer.on('status:change', handler);
    return () => ipcRenderer.removeListener('status:change', handler);
  },
});
