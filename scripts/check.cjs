const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
function walk(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]); }
let failed = false;
for (const file of [...walk('src'), ...walk('scripts'), ...walk('tests')].filter(file => /\.(?:cjs|js)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status) { console.error(result.stderr); failed = true; }
}
if (failed) process.exit(1);
console.log('All JavaScript files pass syntax validation.');
