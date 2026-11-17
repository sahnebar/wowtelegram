"""Collect CI installers and tracked source into a release without account data."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile


def prepare(artifact_root, output):
    package = json.loads(Path('package.json').read_text(encoding='utf-8'))
    version = package['version']
    expected = {
        f'Azeroth-Relay-{version}-Windows-x64.exe': f'Azeroth-Relay-{version}-Windows-x64.exe',
        f'Azeroth Relay-{version}-arm64.dmg': f'Azeroth-Relay-{version}-macOS-arm64.dmg',
        f'Azeroth Relay-{version}.dmg': f'Azeroth-Relay-{version}-macOS-x64.dmg',
        f'Azeroth Relay-{version}-arm64-mac.zip': f'Azeroth-Relay-{version}-macOS-arm64.zip',
        f'Azeroth Relay-{version}-mac.zip': f'Azeroth-Relay-{version}-macOS-x64.zip',
    }
    found = {}
    for file in artifact_root.rglob('*'):
        if file.is_file() and file.name in expected:
            if file.name in found:
                raise RuntimeError(f'Duplicate installer: {file.name}')
            found[file.name] = file
    missing = set(expected) - set(found)
    if missing:
        raise RuntimeError(f'Missing installers: {sorted(missing)}')
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise RuntimeError('Release output must be empty to avoid including stale files.')
    for name, file in found.items():
        shutil.copyfile(file, output / expected[name])
    tracked = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
    source_path = output / f'Azeroth-Relay-{version}-source.zip'
    with zipfile.ZipFile(source_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(filter(None, tracked)):
            relative = Path(name)
            if relative.parts[0] in {'release', 'node_modules', 'test-results', '.git'}:
                raise RuntimeError(f'Unexpected generated file in Git: {name}')
            if relative.name == 'account.enc' or '.session' in relative.name or (relative.name.startswith('.env') and relative.name != '.env.example'):
                raise RuntimeError(f'Unexpected account file in Git: {name}')
            archive.write(relative, Path('Azeroth-Relay') / relative)
    sums = []
    for file in sorted(output.iterdir()):
        sums.append(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}')
    (output / 'SHA256SUMS').write_text('\n'.join(sums) + '\n', encoding='utf-8')
    print(f'Prepared {len(found)} installers and tracked source for v{version}.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    prepare(args.artifact_root, args.output)
