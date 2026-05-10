const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wt', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  openLog: () => ipcRenderer.invoke('log:open'),
  getLogPath: () => ipcRenderer.invoke('log:path'),
  sendPhoneCode: (phone, account) => ipcRenderer.invoke('auth:send-code', phone, account),
  resendCode: (account) => ipcRenderer.invoke('auth:resend-code', account),
  verifyCode: (code, account) => ipcRenderer.invoke('auth:verify-code', code, account),
  verifyPassword: (pw, account) => ipcRenderer.invoke('auth:verify-password', pw, account),
  backToPhone: (account) => ipcRenderer.invoke('auth:back-to-phone', account),
  backToCode: (account) => ipcRenderer.invoke('auth:back-to-code', account),
  signOut: (account) => ipcRenderer.invoke('auth:sign-out', account),
  startServer: (password) => ipcRenderer.invoke('server:start', password),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  createClient: (name) => ipcRenderer.invoke('client:create', name),
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
