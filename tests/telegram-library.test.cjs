// These tests execute the installed MTProto library, replacing only its network RPC boundary.
// They do not contact Telegram or access any personal account.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('teleproto');
const { LiveTelegram } = require('../src/telegram.cjs');

function fixture(t) {
  const saved = [];
  const live = new LiveTelegram({ available: async () => true, write: async value => saved.push(value) });
  const client = live.makeClient({ apiId: 1234, apiHash: 'a'.repeat(32) });
  t.after(() => live.close());
  return { live, client, saved };
}

test('real Telegram sendMessage preserves plain text and constructs the reply RPC', async t => {
  const { live, client } = fixture(t);
  const peer = new Api.InputPeerUser({ userId: bigInt(101), accessHash: bigInt(7001) });
  live.client = client; live.status = 'ready'; live.connection = 'online';
  live.entities.set('101', peer); live.chats.set('101', { id: '101', unread: 0 });
  let calls = 0;
  client.invoke = async request => {
    calls++;
    assert.ok(request instanceof Api.messages.SendMessage);
    assert.equal(request.message, '**plain** <b>text</b> 🌙');
    assert.equal(request.noWebpage, true);
    assert.deepEqual(request.entities, []);
    assert.ok(request.replyTo instanceof Api.InputReplyToMessage);
    assert.equal(request.replyTo.replyToMsgId, 44);
    return new Api.UpdateShortSentMessage({ id: 901, pts: 1, ptsCount: 1, date: 1700000000, out: true });
  };
  const result = await live.send({ chatId: '101', text: '**plain** <b>text</b> 🌙', replyTo: 44, requestId: 'actual-library-send-0001' });
  assert.equal(calls, 1); assert.equal(result.id, 901); assert.equal(result.outgoing, true);
  assert.equal(result.replyTo, 44, 'short send acknowledgements must retain the submitted reply reference');
  assert.equal(result.text, '**plain** <b>text</b> 🌙');
});

test('real Telegram history iterator translates chronological history and read acknowledgements', async t => {
  const { live, client } = fixture(t);
  live.client = client; live.status = 'ready';
  const id = bigInt(101), peer = new Api.PeerUser({ userId: id });
  live.entities.set('101', new Api.InputPeerUser({ userId: id, accessHash: bigInt(7001) }));
  live.chats.set('101', { id: '101', unread: 2, latestId: 12 });
  const requests = [];
  client.invoke = async request => {
    requests.push(request);
    if (request instanceof Api.messages.GetHistory) {
      assert.equal(request.limit, 50);
      assert.equal(request.offsetId, 0);
      return new Api.messages.Messages({
        messages: [12, 11].map(value => new Api.Message({ id: value, peerId: peer, fromId: peer, message: `Text ${value}`, date: 1700000000 + value })),
        users: [new Api.User({ id, accessHash: bigInt(7001), firstName: 'Contact' })], chats: [],
      });
    }
    assert.ok(request instanceof Api.messages.ReadHistory);
    assert.equal(request.maxId, 12);
    return new Api.messages.AffectedMessages({ pts: 1, ptsCount: 1 });
  };
  const result = await live.messages('101');
  assert.deepEqual(result.messages.map(message => message.id), [11, 12]);
  assert.equal(result.messages[0].sender, 'Contact');
  await live.markRead('101', 12);
  assert.equal(requests.length, 2); assert.equal(live.chats.get('101').unread, 0);
});

test('real Telegram phone authentication retries an invalid code and reaches the actual dialog loader', { timeout: 5000 }, async t => {
  const { live, client, saved } = fixture(t);
  Object.defineProperty(client, 'connected', { get: () => true });
  client.connect = async () => {};
  client.session.save = () => 'synthetic-session-after-RPC-auth';
  const me = new Api.User({ id: bigInt(5000), accessHash: bigInt(7000), firstName: 'Test', self: true });
  let authorized = false, signInCalls = 0, dialogCalls = 0;
  client.invoke = async request => {
    if (request instanceof Api.updates.GetState) {
      if (!authorized) throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
      return new Api.updates.State({ pts: 1, qts: 0, date: 1700000000, seq: 1, unreadCount: 0 });
    }
    if (request instanceof Api.auth.SendCode) {
      assert.equal(request.phoneNumber, '+491234567890');
      return new Api.auth.SentCode({ type: new Api.auth.SentCodeTypeApp({ length: 5 }), phoneCodeHash: 'synthetic-code-hash' });
    }
    if (request instanceof Api.auth.SignIn) {
      signInCalls++;
      if (request.phoneCode !== '22222') throw Object.assign(new Error('PHONE_CODE_INVALID'), { errorMessage: 'PHONE_CODE_INVALID' });
      authorized = true; return new Api.auth.Authorization({ user: me });
    }
    if (request instanceof Api.users.GetUsers) return [me];
    assert.ok(request instanceof Api.messages.GetDialogs);
    dialogCalls++; return new Api.messages.Dialogs({ dialogs: [], users: [], messages: [], chats: [] });
  };
  live.makeClient = () => client;
  await live.beginLogin({ apiId: 1234, apiHash: 'a'.repeat(32), method: 'phone', phone: '+491234567890' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(live.auth.kind, 'code'); live.answer('00000');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(live.auth.kind, 'code'); assert.match(live.error, /ungültig/);
  live.answer('22222'); await live.loginTask;
  assert.equal(live.status, 'ready'); assert.equal(signInCalls, 2); assert.equal(dialogCalls, 1);
  assert.equal(saved[0].session, 'synthetic-session-after-RPC-auth');
  assert.equal(JSON.stringify(saved).includes('22222'), false);
});
