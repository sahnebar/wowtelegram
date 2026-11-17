class UserError extends Error { constructor(message) { super(message); this.public = true; } }
function credentials(input) {
  const apiId = Number(input?.apiId);
  const apiHash = String(input?.apiHash || '').trim();
  if (!Number.isSafeInteger(apiId) || apiId < 1 || apiId > 2147483647 || !/^[0-9a-f]{32}$/i.test(apiHash)) {
    throw new UserError('Bitte eine gültige API-ID und den 32-stelligen API-Hash von my.telegram.org eingeben.');
  }
  return { apiId, apiHash };
}
function chatId(value) {
  if (typeof value !== 'string' || !/^-?\d{1,24}$/.test(value)) throw new UserError('Ungültiger Chat.');
  return value;
}
function outgoing(input) {
  const id = chatId(input?.chatId);
  const text = String(input?.text || '').trim();
  if (!text || [...text].length > 4096) throw new UserError('Eine Nachricht muss zwischen 1 und 4096 Zeichen enthalten.');
  let replyTo;
  if (input?.replyTo != null) {
    replyTo = Number(input.replyTo);
    if (!Number.isSafeInteger(replyTo) || replyTo <= 0) throw new UserError('Ungültige Antwortnachricht.');
  }
  if (typeof input?.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)) throw new UserError('Ungültige Nachrichtenkennung.');
  return { chatId: id, text, replyTo, requestId: input.requestId };
}
function errorText(error) {
  if (error?.public) return error.message;
  const code = String(error?.errorMessage || error?.code || error?.message || '');
  const seconds = Number(error?.seconds) || Number(code.match(/FLOOD_WAIT_(\d+)/)?.[1]);
  if (seconds) return `Telegram bittet um eine Pause. Bitte in ${seconds} Sekunden erneut versuchen.`;
  if (/PHONE_CODE_(INVALID|EMPTY)/.test(code)) return 'Der Bestätigungscode ist ungültig. Bitte erneut eingeben.';
  if (/PHONE_CODE_EXPIRED/.test(code)) return 'Der Bestätigungscode ist abgelaufen. Bitte die Anmeldung neu starten.';
  if (/PHONE_NUMBER_INVALID/.test(code)) return 'Bitte die Telefonnummer mit Ländervorwahl eingeben, z. B. +49 …';
  if (/PASSWORD_HASH_INVALID/.test(code)) return 'Das Zwei-Schritt-Passwort ist nicht richtig. Bitte erneut versuchen.';
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(code)) return 'Telegram akzeptiert diese API-Zugangsdaten nicht. Bitte die eigenen App-Daten von my.telegram.org verwenden.';
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED/.test(code)) return 'Die Telegram-Sitzung ist abgelaufen oder wurde widerrufen. Bitte neu anmelden.';
  if (/CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHAT_SEND_PLAIN_FORBIDDEN/.test(code)) return 'Du darfst in diesem Chat keine Textnachrichten senden.';
  if (/AUTH_RESTART|UPDATE_APP_TO_LOGIN|EMAIL_/.test(code)) return 'Telegram verlangt einen anderen Anmeldeablauf. Bitte QR-Anmeldung verwenden oder in Telegram die Anmeldung prüfen.';
  if (/TIMEOUT|TIMED_OUT|ENOTFOUND|ECONN|not connected|disconnected/i.test(code)) return 'Die Verbindung zu Telegram ist unterbrochen. Der Versandstatus kann unklar sein. Bitte zuerst den Chat aktualisieren.';
  // Never send raw transport errors to a renderer: they can contain credentials or message bodies.
  return 'Die Aktion konnte nicht abgeschlossen werden. Bitte Verbindung und Telegram-Sitzung prüfen und erneut versuchen.';
}
function placeBounds(saved, workArea, compact = false) {
  const width = Math.min(saved?.width || (compact ? 480 : 820), workArea.width);
  const height = Math.min(saved?.height || 680, workArea.height);
  const x = Math.max(workArea.x, Math.min(saved?.x ?? workArea.x + workArea.width - width - 28, workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(saved?.y ?? workArea.y + (workArea.height - height) / 2, workArea.y + workArea.height - height));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
module.exports = { UserError, credentials, chatId, outgoing, errorText, placeBounds };
