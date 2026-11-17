window.relay.on(event => {
  if (event.type !== 'notification') return;
  const data = event.value;
  document.getElementById('title').textContent = data.title;
  document.getElementById('body').textContent = data.body;
  document.getElementById('shortcut').textContent = data.hotkey.replace('CommandOrControl', 'Ctrl / ⌘').replace('Shift', '⇧').replace(/\+/g, ' ');
  document.getElementById('badge').textContent = data.demo ? 'DEMO · LOKAL' : 'AZEROTH RELAY';
});
