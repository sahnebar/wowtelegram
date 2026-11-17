const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (action, payload) => {
  const result = await ipcRenderer.invoke('relay:invoke', { action, payload });
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('relay', Object.freeze({
  bootstrap: () => invoke('bootstrap'),
  settings: patch => invoke('settings', patch),
  login: data => invoke('login', data),
  answer: value => invoke('answer', value),
  cancelLogin: () => invoke('cancel-login'),
  demo: value => invoke('demo', value),
  simulate: () => invoke('simulate'),
  chats: more => invoke('chats', more === true),
  messages: (id, before) => invoke('messages', { id, before }),
  send: data => invoke('send', data),
  read: (id, maxId) => invoke('read', { id, maxId }),
  typing: id => invoke('typing', id),
  hide: () => invoke('hide'),
  passive: () => invoke('passive'),
  open: target => invoke('open', target),
  logout: () => invoke('logout'),
  resetLocal: () => invoke('reset-local'),
  quit: () => invoke('quit'),
  on: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('relay:event', listener);
    return () => ipcRenderer.removeListener('relay:event', listener);
  },
}));
