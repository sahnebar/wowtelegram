const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const source = require('../package.json');
const output = source.build.directories.output;

function walk(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]); }
const sourceFiles = [...walk('src'), ...walk('assets')];
const archives = [
  `${output}/mac-arm64/Azeroth Relay.app/Contents/Resources/app.asar`,
  `${output}/mac/Azeroth Relay.app/Contents/Resources/app.asar`,
  `${output}/win-unpacked/resources/app.asar`,
];
const verified = [];
for (const archive of archives) {
  if (!fs.existsSync(archive)) throw new Error(`Missing package: ${archive}`);
  for (const file of sourceFiles) {
    const expected = fs.readFileSync(file), actual = asar.extractFile(archive, file.split(path.sep).join('/'));
    if (!expected.equals(actual)) throw new Error(`Outdated packaged source: ${archive} → ${file}`);
  }
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  if (packaged.version !== source.version || packaged.main !== source.main) throw new Error(`Incorrect package metadata: ${archive}`);
  verified.push({ archive, matchingSourceFiles: sourceFiles.length, version: packaged.version });
}
const files = fs.readdirSync(output).filter(name => /\.(exe|dmg|zip)$/.test(name));
const artifacts = files.map(name => {
  const file = fs.readFileSync(path.join(output, name));
  return { name, bytes: file.length, sha256: crypto.createHash('sha256').update(file).digest('hex') };
});
const unitXml = fs.readFileSync('test-results/unit.xml', 'utf8');
const unitTests = (unitXml.match(/<testcase(?:\s|>)/g) || []).length;
if (!unitTests || /<(failure|error|skipped)(?:\s|>)/.test(unitXml)) throw new Error('Unit report is missing, failed or incomplete.');
const ui = JSON.parse(fs.readFileSync('test-results/ui-report.json', 'utf8'));
if (!ui.passed || ui.rendererErrors.length || ui.version !== source.version) throw new Error('Desktop UI report did not pass for the current version.');
const macPackages = ['arm64', 'x64'].map(architecture => JSON.parse(fs.readFileSync(`test-results/packaged-report-${architecture}.json`, 'utf8')));
if (macPackages.some(p => !p.packaged || !p.protectedRoundTrip || !p.foreground.available || p.version !== source.version)) throw new Error('A packaged app smoke test did not pass for the current version.');
const report = { createdAt: new Date().toISOString(), host: { platform: process.platform, architecture: process.arch, node: process.version }, verified, artifacts,
  tests: { unit: { passed: unitTests }, desktopUi: { passed: ui.tests.length, rendererErrors: ui.rendererErrors }, macPackages, intelTestEnvironment: 'x64 build executed via Rosetta on this Apple Silicon Mac' },
  liveTelegramVerified: false, nativeWindowsVerified: false, inGameRetailVerified: false, inGameForeverVerified: false,
  note: 'Source matching and automated desktop tests do not replace the pending account and in-game tests. Builds have no Developer ID / Authenticode distribution signature.' };
fs.writeFileSync(path.join(output, 'VERIFICATION.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(output, 'SHA256SUMS'), artifacts.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
console.log(`All ${archives.length} packages match ${sourceFiles.length} current source/asset files. Artifact checksums saved to ${output}/VERIFICATION.json.`);
