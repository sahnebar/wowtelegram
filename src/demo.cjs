const { EventEmitter } = require('node:events');
const { outgoing, chatId } = require('./model.cjs');

class DemoTelegram extends EventEmitter {
  constructor() {
    super();
    this.mode = 'demo'; this.status = 'ready'; this.user = { name: 'Thorsten', initials: 'TS' };
    this.sent = new Map(); this.nextId = 80;
    const now = Math.floor(Date.now() / 1000);
    this.chats = [
      { id: '101', title: 'Mara', initials: 'MA', kind: 'private', unread: 2, color: 'rose', preview: 'Bist du nachher noch online?', date: now - 80 },
      { id: '-102', title: 'Die Abendrunde', initials: 'AR', kind: 'group', unread: 3, color: 'gold', preview: 'Jonas: Noch ein Run?', date: now - 300 },
      { id: '103', title: 'Felix', initials: 'FE', kind: 'private', unread: 0, color: 'blue', preview: 'Perfekt, bis später! 🙌', date: now - 1800 },
      { id: '104', title: 'Gespeichertes', initials: 'DU', kind: 'saved', unread: 0, color: 'green', preview: 'Gedanken für nach dem Raid.', date: now - 7200 },
    ];
    this.history = new Map([
      ['101', [
        { id: 1, text: 'Hey! Wie läuft’s in Azeroth? 🌙', outgoing: false, sender: 'Mara', date: now - 3600 },
        { id: 2, text: 'Sehr gut. Noch eine Runde mit der Gilde, dann bin ich da.', outgoing: true, sender: 'Du', date: now - 3500 },
        { id: 3, text: 'Klingt gut! Ich kümmere mich schon mal ums Essen.', outgoing: false, sender: 'Mara', date: now - 140 },
        { id: 4, text: 'Bist du nachher noch online?', outgoing: false, sender: 'Mara', date: now - 80 },
      ]],
      ['-102', [
        { id: 5, text: 'Treffpunkt um 20 Uhr. Wer ist dabei?', outgoing: false, sender: 'Lea', date: now - 1800 },
        { id: 6, text: 'Bin dabei! Tränke sind eingepackt.', outgoing: true, sender: 'Du', date: now - 1600 },
        { id: 7, text: 'Noch ein Run?', outgoing: false, sender: 'Jonas', date: now - 300 },
      ]],
      ['103', [{ id: 8, text: 'Perfekt, bis später! 🙌', outgoing: false, sender: 'Felix', date: now - 1800 }]],
      ['104', [{ id: 9, text: 'Gedanken für nach dem Raid.', outgoing: true, sender: 'Du', date: now - 7200 }]],
    ]);
  }
  snapshot() { return { mode: this.mode, status: this.status, user: this.user, chats: this.chats, hasMoreChats: false, auth: null, error: null }; }
  async initialize() { this.emit('state', this.snapshot()); }
  async loadChats() { return this.snapshot(); }
  async messages(id, before) {
    chatId(id);
    return { messages: (this.history.get(id) || []).filter(m => !before || m.id < before), hasMore: false };
  }
  async send(input) {
    const data = outgoing(input);
    if (this.sent.has(data.requestId)) return this.sent.get(data.requestId);
    if (!this.chats.some(c => c.id === data.chatId)) throw new Error('Unbekannter Chat.');
    const message = { id: this.nextId++, text: data.text, outgoing: true, sender: 'Du', date: Math.floor(Date.now() / 1000), replyTo: data.replyTo };
    this.history.get(data.chatId).push(message);
    this.sent.set(data.requestId, message);
    const chat = this.chats.find(c => c.id === data.chatId);
    Object.assign(chat, { preview: data.text, date: message.date });
    this.emit('message', { chatId: data.chatId, message }); this.emit('state', this.snapshot());
    return message;
  }
  async markRead(id) { const chat = this.chats.find(c => c.id === chatId(id)); if (chat) chat.unread = 0; this.emit('state', this.snapshot()); }
  simulate() {
    const id = '101';
    const message = { id: this.nextId++, text: 'Kleine Pause? Dein Essen ist gleich fertig. ✨', outgoing: false, sender: 'Mara', date: Math.floor(Date.now() / 1000) };
    this.history.get(id).push(message);
    Object.assign(this.chats[0], { unread: this.chats[0].unread + 1, preview: message.text, date: message.date });
    this.emit('message', { chatId: id, message }); this.emit('state', this.snapshot());
  }
  async close() {}
}
module.exports = { DemoTelegram };
