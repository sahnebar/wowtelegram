/* The renderer has no Node access. All privileged operations use the narrow preload bridge. */
const $ = selector => document.querySelector(selector);
const api = window.relay;
let state, selectedId = null, filter = 'all', method = 'qr', reply = null;
let selectionGeneration = 0, historyMore = false, noticeTimer, lastTyping = 0;
let challengeKind = null, lastMode = null;
const histories = new Map(), drafts = new Map(), sending = new Set(), uncertain = new Set();
const time = date => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(date * 1000));
const dateLabel = date => {
  const day = new Date(date * 1000), today = new Date();
  return day.toDateString() === today.toDateString() ? 'Heute' : new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long' }).format(day);
};
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg; }
function showError(target, error) { const node = $(target); node.textContent = error?.message || String(error || ''); node.hidden = !error; }
function notice(text) { $('#notice').textContent = text; $('#notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 4500); }
function prettyHotkey(value) { return value.replace('CommandOrControl', state?.app.platform === 'darwin' ? '⌘' : 'Strg').replace('Control', 'Strg').replace('Shift', '⇧').replace('Alt', '⌥').replace(/\+/g, ' '); }
function currentChat() { return state?.telegram.chats.find(c => c.id === selectedId); }
function isReading() { return document.hasFocus() && !state?.app.passive && !$('#settings-dialog').open && !$('#confirm-dialog').open && !document.hidden; }
function atBottom() { const node = $('#message-list'); return node.scrollHeight - node.scrollTop - node.clientHeight < 95; }
function mergeMessages(id, messages) {
  const map = new Map((histories.get(id) || []).map(m => [m.id, m]));
  for (const message of messages) map.set(message.id, message);
  histories.set(id, [...map.values()].sort((a, b) => a.id - b.id));
}
function setReply(message) { reply = message; $('#reply-preview').hidden = !reply; $('#reply-text').textContent = reply?.text || ''; if (reply) $('#message-input').focus(); }

function renderChats() {
  const chats = state.telegram.chats;
  const search = $('#search').value.toLocaleLowerCase('de');
  const shown = chats.filter(c => (filter !== 'favorites' || state.settings.favorites.includes(c.id)) && c.title.toLocaleLowerCase('de').includes(search));
  const list = $('#chat-list'); list.replaceChildren();
  for (const chat of shown) {
    const button = el('button', `chat-item${chat.id === selectedId ? ' selected' : ''}`);
    button.type = 'button'; button.dataset.chatId = chat.id;
    button.setAttribute('aria-label', `${chat.title}${chat.unread ? `, ${chat.unread} ungelesen` : ''}`);
    if (chat.id === selectedId) button.setAttribute('aria-current', 'true');
    button.append(el('span', `avatar ${chat.color}`, chat.initials));
    const info = el('div', 'chat-info'); info.append(el('strong', null, chat.title), el('p', null, chat.preview || 'Noch keine Nachrichten'));
    const meta = el('div', 'chat-meta'); meta.append(el('span', null, chat.date ? time(chat.date) : ''));
    if (chat.unread) meta.append(el('span', 'unread-badge', chat.unread > 99 ? '99+' : chat.unread));
    else if (state.settings.favorites.includes(chat.id)) { const star = icon('star'); star.style.width = '11px'; star.style.height = '11px'; meta.append(star); }
    button.append(info, meta); button.addEventListener('click', () => selectChat(chat.id)); list.append(button);
  }
  if (!shown.length) list.append(el('p', 'list-empty', search ? 'Kein passender Chat.' : filter === 'favorites' ? 'Markiere einen Chat mit dem Stern als Favorit.' : 'Deine Chats werden hier angezeigt.'));
  $('#total-unread').textContent = String(chats.reduce((n, c) => n + c.unread, 0));
  $('#more-chats').hidden = !state.telegram.hasMoreChats;
}
function renderHeader() {
  const chat = currentChat();
  $('#empty-conversation').hidden = !!chat; $('#active-conversation').hidden = !chat;
  if (!chat) return;
  $('#chat-title').textContent = chat.title;
  $('#chat-avatar').textContent = chat.initials; $('#chat-avatar').className = `avatar ${chat.color}`;
  $('#chat-subtitle').textContent = chat.kind === 'group' ? 'Gruppenchat · Telegram' : chat.kind === 'saved' ? 'Deine gespeicherten Nachrichten' : 'Persönlicher Chat · Telegram';
  const favorite = state.settings.favorites.includes(chat.id);
  $('#favorite-button').classList.toggle('active', favorite);
  $('#favorite-button').setAttribute('aria-label', favorite ? 'Favorit entfernen' : 'Als Favorit markieren');
  $('#favorite-button').setAttribute('aria-pressed', favorite);
  $('#demo-banner').hidden = state.telegram.mode !== 'demo';
}
function renderMessages(scroll = false) {
  const container = $('#messages'); const messages = histories.get(selectedId) || [];
  container.replaceChildren();
  let lastDay = '';
  for (const message of messages) {
    const day = new Date(message.date * 1000).toDateString();
    if (day !== lastDay) { container.append(el('div', 'day-divider', dateLabel(message.date))); lastDay = day; }
    const row = el('div', `message-row${message.outgoing ? ' outgoing' : ''}`); row.dataset.messageId = String(message.id);
    const bubble = el('div', 'message-bubble');
    if (currentChat()?.kind === 'group' && !message.outgoing) bubble.append(el('strong', 'message-sender', message.sender));
    if (message.replyTo) {
      const original = messages.find(m => m.id === message.replyTo);
      bubble.append(el('div', 'quote-block', original?.text || 'Antwort auf eine frühere Nachricht'));
    }
    bubble.append(el('p', 'message-text', message.text));
    const stamp = el('div', 'message-time', time(message.date));
    if (message.outgoing) { const check = icon('check'); check.setAttribute('aria-label', 'Gesendet'); stamp.append(check); }
    bubble.append(stamp);
    const replyButton = el('button', 'icon-button reply-action'); replyButton.append(icon('reply')); replyButton.title = 'Auf Nachricht antworten'; replyButton.setAttribute('aria-label', 'Auf Nachricht antworten'); replyButton.addEventListener('click', () => setReply(message));
    row.append(bubble, replyButton); container.append(row);
  }
  if (!messages.length) container.append(el('p', 'list-empty', 'Hier beginnt eure Unterhaltung.'));
  $('#older-messages').hidden = !historyMore;
  if (scroll) requestAnimationFrame(() => { $('#message-list').scrollTop = $('#message-list').scrollHeight; markRead(); });
}
async function markRead() {
  if (!selectedId || !isReading() || !atBottom()) return;
  const messages = histories.get(selectedId) || [];
  const incoming = messages.filter(m => !m.outgoing).at(-1);
  if (incoming && currentChat()?.unread) {
    try { await api.read(selectedId, incoming.id); } catch { /* Do not mark locally if the server rejects it. */ }
  }
}
async function selectChat(id, force = false) {
  if (selectedId) drafts.set(selectedId, $('#message-input').value);
  selectedId = id; setReply(null); const generation = ++selectionGeneration;
  document.body.classList.remove('show-chats');
  $('#message-input').value = drafts.get(id) || ''; resizeInput(); updateSend();
  $('#send-status').textContent = uncertain.has(id) ? 'Nicht bestätigt · Chat aktualisieren' : 'Enter zum Senden · Shift + Enter für neue Zeile';
  showError('#conversation-error', null); historyMore = false; renderChats(); renderHeader(); renderMessages(true);
  try {
    if (!histories.has(id) || force) {
      const result = await api.messages(id);
      mergeMessages(id, result.messages);
      if (generation !== selectionGeneration) return;
      historyMore = result.hasMore; renderMessages(true);
    } else {
      // Tell the main process which chat is visible even when the history is cached.
      const result = await api.messages(id);
      mergeMessages(id, result.messages);
      if (generation !== selectionGeneration) return;
      historyMore = result.hasMore; renderMessages(true);
    }
    if (generation === selectionGeneration) { markRead(); $('#message-input').focus(); }
  } catch (error) { if (generation === selectionGeneration) showError('#conversation-error', error); }
}
function renderSettings() {
  const s = state.settings, p = s.profiles[s.profile];
  $('#settings-profile').textContent = s.profile === 'retail' ? 'Retail' : 'Forever';
  $('#opacity').value = p.opacity; $('#opacity-value').value = `${p.opacity} %`;
  $('#compact-setting').checked = p.compact;
  for (const [id, key] of [['auto-hide-setting', 'autoHide'], ['autostart-setting', 'startAtLogin'], ['notifications-setting', 'notifications'], ['previews-setting', 'previews'], ['favorites-setting', 'onlyFavorites'], ['quiet-setting', 'quiet']]) $(`#${id}`).checked = s[key];
  if (document.activeElement !== $('#hotkey-setting')) $('#hotkey-setting').value = s.hotkey;
  if (document.activeElement !== $('#quiet-hotkey-setting')) $('#quiet-hotkey-setting').value = s.quietHotkey;
  $('#autostart-setting').disabled = !state.app.packaged;
  $('#autostart-help').textContent = state.app.packaged ? 'Die App startet im Hintergrund.' : 'In der installierten App verfügbar.';
  const monitor = $('#monitor-setting'); monitor.replaceChildren(); monitor.append(new Option('Hauptbildschirm', 'primary'));
  for (const m of state.monitors) monitor.append(new Option(`${m.label}${m.primary ? ' · primär' : ''}`, m.id));
  monitor.value = s.monitor;
  $('#demo-tools').hidden = state.telegram.mode !== 'demo';
  $('#account-tools').hidden = state.telegram.mode !== 'live' || state.telegram.status !== 'ready';
  $('#version').textContent = state.app.version;
}
function renderAuth() {
  const auth = state.telegram.auth;
  $('#login-config').hidden = !!auth; $('#login-challenge').hidden = !auth;
  showError('#login-error', state.telegram.error);
  if (!auth) { challengeKind = null; return; }
  const labels = {
    connecting: ['Verbindung wird aufgebaut …', 'Wir verbinden dich direkt mit Telegram.'],
    checking: ['Eingabe wird geprüft …', 'Einen Moment bitte.'],
    qr: ['Mit dem Handy bestätigen', 'Telegram → Einstellungen → Geräte → Desktop-Gerät verknüpfen. Den QR-Code scannen und die Anmeldung bestätigen.'],
    code: ['Dein Bestätigungscode', 'Telegram schickt dir den Code meist in der Telegram-App. Bitte dort nachsehen.'],
    password: ['Zwei-Schritt-Passwort', 'Gib das zusätzliche Passwort deines Telegram-Kontos ein. Es wird nicht gespeichert.'],
    email: ['E-Mail bestätigen', 'Telegram benötigt für diese Anmeldung eine E-Mail-Adresse.'],
    emailCode: ['Code aus deiner E-Mail', 'Gib den Bestätigungscode ein, den Telegram dir per E-Mail geschickt hat.'],
  };
  const [title, description] = labels[auth.kind] || labels.connecting;
  $('#challenge-title').textContent = title; $('#challenge-description').textContent = description;
  $('#qr-image').hidden = auth.kind !== 'qr'; if (auth.kind === 'qr') $('#qr-image').src = auth.dataUrl;
  const input = ['code', 'password', 'email', 'emailCode'].includes(auth.kind);
  $('#challenge-form').hidden = !input; $('#auth-spinner').hidden = input || auth.kind === 'qr';
  if (input && challengeKind !== auth.kind) {
    const field = $('#challenge-input'); field.value = ''; field.type = auth.kind === 'password' ? 'password' : auth.kind === 'email' ? 'email' : 'text';
    field.inputMode = ['code', 'emailCode'].includes(auth.kind) ? 'numeric' : 'text';
    $('#challenge-label').firstChild.textContent = auth.kind === 'password' ? 'Passwort' : auth.kind === 'email' ? 'E-Mail-Adresse' : 'Bestätigungscode';
    requestAnimationFrame(() => field.focus());
  }
  challengeKind = auth.kind;
}
function renderState(next) {
  const reset = lastMode !== next.telegram.mode || (state?.telegram.user?.name && !next.telegram.user);
  state = next;
  if (reset) { histories.clear(); drafts.clear(); sending.clear(); uncertain.clear(); selectedId = null; reply = null; $('#message-input').value = ''; }
  lastMode = state.telegram.mode;
  const ready = state.telegram.status === 'ready';
  $('#chat-view').hidden = !ready; $('#login-view').hidden = ready;
  const demo = state.telegram.mode === 'demo';
  const connection = $('#connection'); connection.className = `status-pill${demo ? ' demo' : ready ? ' ready' : ''}`;
  const online = demo || state.telegram.connection === 'online';
  connection.replaceChildren(el('i'), document.createTextNode(demo ? 'Demo · lokal' : ready ? (online ? 'Verbunden' : 'Verbinde erneut …') : state.telegram.status === 'connecting' ? 'Verbinde …' : 'Nicht verbunden'));
  $('#connection-warning').hidden = !ready || online;
  $('#quiet-button').setAttribute('aria-pressed', state.settings.quiet);
  $('#quiet-button').title = state.settings.quiet ? 'Ruhemodus ausschalten' : 'Ruhemodus einschalten';
  $('#profile').value = state.settings.profile; $('#hotkey-label').textContent = prettyHotkey(state.settings.hotkey);
  $('#game-status').textContent = !state.app.hotkeyRegistered ? 'Hotkey prüfen' : state.game.active ? 'WoW aktiv' : state.settings.autoHide ? (state.game.available ? 'Automatisch ausblenden' : 'Spielerkennung nicht verfügbar') : 'Manuelles Profil';
  $('#user-name').textContent = state.telegram.user?.name || 'Dein Konto';
  $('#user-avatar').textContent = state.telegram.user?.initials || 'AR';
  $('#account-caption').textContent = demo ? 'Demo · kein Konto verbunden' : 'Telegram verbunden';
  document.body.classList.toggle('compact', ready && state.settings.profiles[state.settings.profile].compact);
  $('#passive-cover').hidden = !state.app.passive; $('#passive-button').disabled = !ready;
  renderSettings();
  if (ready) {
    renderChats(); renderHeader();
    if (!selectedId && state.telegram.chats.length) selectChat(state.telegram.chats[0].id);
  } else renderAuth();
}
function resizeInput() { const input = $('#message-input'); input.style.height = 'auto'; input.style.height = `${Math.min(110, input.scrollHeight)}px`; }
function updateSend() {
  $('#send-button').disabled = !selectedId || sending.has(selectedId) || !$('#message-input').value.trim();
  $('#send-button').setAttribute('aria-label', uncertain.has(selectedId) ? 'Versand prüfen und erneut senden' : 'Nachricht senden');
}
function confirmAction(title, description, accept = 'Bestätigen') {
  $('#confirm-title').textContent = title; $('#confirm-description').textContent = description; $('#confirm-accept').textContent = accept;
  const dialog = $('#confirm-dialog'); dialog.showModal();
  return new Promise(resolve => {
    const done = value => { dialog.close(); $('#confirm-accept').onclick = null; $('#confirm-cancel').onclick = null; dialog.removeEventListener('cancel', canceled); resolve(value); };
    const canceled = event => { event.preventDefault(); done(false); };
    $('#confirm-accept').onclick = () => done(true); $('#confirm-cancel').onclick = () => done(false); dialog.addEventListener('cancel', canceled);
  });
}
async function settings(patch) {
  try { showError('#settings-error', null); renderState(await api.settings(patch)); return true; }
  catch (error) { showError('#settings-error', error); if (!$('#settings-dialog').open) notice(error.message); renderSettings(); return false; }
}

$('#message-form').addEventListener('submit', async event => {
  event.preventDefault(); const id = selectedId, text = $('#message-input').value.trim(), replyTo = reply?.id;
  if (!id || !text || sending.has(id)) return;
  if ([...text].length > 4096) { showError('#conversation-error', new Error('Telegram erlaubt höchstens 4096 Zeichen pro Nachricht.')); return; }
  if (uncertain.has(id) && !await confirmAction('Noch einmal senden?', 'Der letzte Versand war nicht eindeutig bestätigt. Prüfe zuerst den Chat, auch in Telegram. Erneutes Senden kann eine doppelte Nachricht erzeugen.', 'Erneut senden')) return;
  const requestId = crypto.randomUUID(); sending.add(id); updateSend();
  showError('#conversation-error', null); $('#send-status').textContent = 'Wird gesendet …';
  try {
    const message = await api.send({ chatId: id, text, replyTo, requestId });
    mergeMessages(id, [message]); uncertain.delete(id);
    if ((drafts.get(id) || '').trim() === text) drafts.delete(id);
    if (selectedId === id) {
      if ($('#message-input').value.trim() === text) { $('#message-input').value = ''; drafts.delete(id); resizeInput(); }
      setReply(null); renderMessages(true); $('#send-status').textContent = state.telegram.mode === 'demo' ? 'Demo-Nachricht lokal hinzugefügt' : 'Gesendet';
    }
  } catch (error) {
    uncertain.add(id);
    if (selectedId === id) { showError('#conversation-error', new Error(`${error.message}\nDein Entwurf bleibt erhalten. Vor erneutem Senden den Chat aktualisieren.`)); $('#send-status').textContent = 'Nicht bestätigt · Chat aktualisieren'; }
  } finally { sending.delete(id); updateSend(); }
});
$('#message-input').addEventListener('input', () => {
  if (selectedId) drafts.set(selectedId, $('#message-input').value); resizeInput(); updateSend();
  if (selectedId && Date.now() - lastTyping > 5000 && $('#message-input').value.trim()) { lastTyping = Date.now(); api.typing(selectedId).catch(() => {}); }
});
$('#message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#message-form').requestSubmit(); } });
$('#message-list').addEventListener('scroll', markRead);
$('#cancel-reply').addEventListener('click', () => setReply(null));
$('#search').addEventListener('input', renderChats);
for (const value of ['all', 'favorites']) $(`#filter-${value}`).addEventListener('click', () => { filter = value; $('#filter-all').classList.toggle('selected', value === 'all'); $('#filter-favorites').classList.toggle('selected', value === 'favorites'); renderChats(); });
$('#favorite-button').addEventListener('click', () => { if (!selectedId) return; const ids = state.settings.favorites; settings({ favorites: ids.includes(selectedId) ? ids.filter(id => id !== selectedId) : [...ids, selectedId] }); });
$('#refresh-button').addEventListener('click', async () => {
  $('#refresh-button').disabled = true;
  try { await api.chats(false); if (selectedId) await selectChat(selectedId, true); notice('Chats aktualisiert.'); } catch (error) { notice(error.message); }
  finally { $('#refresh-button').disabled = false; }
});
$('#more-chats').addEventListener('click', async () => { $('#more-chats').disabled = true; try { await api.chats(true); } catch (error) { notice(error.message); } finally { $('#more-chats').disabled = false; } });
$('#older-messages').addEventListener('click', async () => {
  const id = selectedId, first = histories.get(id)?.[0]; if (!first) return;
  $('#older-messages').disabled = true;
  try {
    const result = await api.messages(id, first.id); mergeMessages(id, result.messages);
    if (id !== selectedId) return;
    const list = $('#message-list'), old = list.scrollHeight; historyMore = result.hasMore; renderMessages(); list.scrollTop += list.scrollHeight - old;
  } catch (error) { showError('#conversation-error', error); }
  finally { $('#older-messages').disabled = false; }
});
$('#back-chats').addEventListener('click', () => document.body.classList.add('show-chats'));
$('#compact-button').addEventListener('click', () => { const p = state.settings.profile; settings({ profiles: { [p]: { ...state.settings.profiles[p], compact: !state.settings.profiles[p].compact } } }); });
$('#profile').addEventListener('change', () => settings({ profile: $('#profile').value }));
$('#quiet-button').addEventListener('click', () => settings({ quiet: !state.settings.quiet }));
$('#hide-button').addEventListener('click', () => api.hide());
$('#passive-button').addEventListener('click', () => api.passive());
$('#settings-button').addEventListener('click', () => { renderSettings(); showError('#settings-error', null); $('#settings-dialog').showModal(); });
$('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-dialog').addEventListener('close', markRead);
$('#opacity').addEventListener('change', () => { const p = state.settings.profile; settings({ profiles: { [p]: { ...state.settings.profiles[p], opacity: Number($('#opacity').value) } } }); });
$('#opacity').addEventListener('input', () => { $('#opacity-value').value = `${$('#opacity').value} %`; });
$('#compact-setting').addEventListener('change', () => { const p = state.settings.profile; settings({ profiles: { [p]: { ...state.settings.profiles[p], compact: $('#compact-setting').checked } } }); });
$('#monitor-setting').addEventListener('change', () => settings({ monitor: $('#monitor-setting').value }));
for (const [id, key] of [['auto-hide-setting', 'autoHide'], ['autostart-setting', 'startAtLogin'], ['notifications-setting', 'notifications'], ['previews-setting', 'previews'], ['favorites-setting', 'onlyFavorites'], ['quiet-setting', 'quiet']]) $(`#${id}`).addEventListener('change', () => settings({ [key]: $(`#${id}`).checked }));
$('#hotkey-form').addEventListener('submit', async event => { event.preventDefault(); if (await settings({ hotkey: $('#hotkey-setting').value.trim(), quietHotkey: $('#quiet-hotkey-setting').value.trim() })) notice('Tastenkürzel gespeichert.'); });
$('#get-api').addEventListener('click', () => api.open('api'));
for (const value of ['qr', 'phone']) $(`#method-${value}`).addEventListener('click', () => { method = value; $('#method-qr').classList.toggle('selected', value === 'qr'); $('#method-phone').classList.toggle('selected', value === 'phone'); $('#phone-field').hidden = value !== 'phone'; $('#login-submit').firstChild.textContent = value === 'qr' ? 'QR-Code anzeigen ' : 'Code anfordern '; $('#phone-number').required = value === 'phone'; });
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-submit').disabled = true; showError('#login-error', null);
  try { await api.login({ apiId: $('#api-id').value, apiHash: $('#api-hash').value, method, phone: $('#phone-number').value }); $('#api-hash').value = ''; $('#phone-number').value = ''; }
  catch (error) { showError('#login-error', error); }
  finally { $('#login-submit').disabled = false; }
});
$('#challenge-form').addEventListener('submit', async event => { event.preventDefault(); const value = $('#challenge-input').value; $('#challenge-input').value = ''; try { await api.answer(value); } catch (error) { showError('#login-error', error); } });
$('#cancel-login').addEventListener('click', () => api.cancelLogin().catch(error => showError('#login-error', error)));
async function leaveDemo() { $('#settings-dialog').close(); try { renderState(await api.demo(false)); } catch (error) { notice(error.message); } }
$('#connect-from-demo').addEventListener('click', leaveDemo); $('#leave-demo').addEventListener('click', leaveDemo);
$('#start-demo').addEventListener('click', async () => { try { renderState(await api.demo(true)); } catch (error) { showError('#login-error', error); } });
$('#simulate-message').addEventListener('click', async () => { $('#settings-dialog').close(); await api.simulate(); notice('Demo-Nachricht empfangen.'); });
$('#logout-button').addEventListener('click', async () => {
  if (!await confirmAction('Bei Telegram abmelden?', 'Diese Gerätesitzung wird bei Telegram beendet und die lokale Anmeldung gelöscht.', 'Abmelden')) return;
  try { await api.logout(); $('#settings-dialog').close(); } catch (error) { showError('#settings-error', error); }
});
$('#reset-local').addEventListener('click', async () => {
  if (!await confirmAction('Lokale Anmeldung löschen?', 'Löscht die Anmeldung und Nachrichten aus dieser App. Eine bestehende Gerätesitzung kannst du zusätzlich in Telegram unter Einstellungen → Geräte beenden.', 'Lokal löschen')) return;
  try { if (state.telegram.mode === 'demo') await leaveDemo(); await api.resetLocal(); $('#settings-dialog').close(); } catch (error) { showError('#settings-error', error); }
});
$('#quit-button').addEventListener('click', () => api.quit());
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('#settings-dialog').open || $('#confirm-dialog').open) return;
  event.preventDefault(); if (reply) setReply(null); else api.hide();
});
window.addEventListener('focus', markRead);
api.on(event => {
  if (event.type === 'state') renderState(event.value);
  else if (event.type === 'message' || event.type === 'edited') {
    const { chatId, message } = event.value; const scroll = chatId === selectedId && atBottom();
    mergeMessages(chatId, [message]);
    if (chatId === selectedId) { renderMessages(scroll); if (scroll) markRead(); }
  } else if (event.type === 'deleted') {
    for (const [id, messages] of histories) if (event.value.chatId ? id === event.value.chatId : !id.startsWith('-100')) histories.set(id, messages.filter(m => !event.value.ids.includes(m.id)));
    renderMessages();
  } else if (event.type === 'focus' && event.value) markRead();
  else if (event.type === 'focus-composer' && selectedId && !$('#settings-dialog').open) $('#message-input').focus();
  else if (event.type === 'notice') notice(event.value);
});
api.bootstrap().then(renderState).catch(error => showError('#login-error', error));
