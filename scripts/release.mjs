import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const manifests = ['package.json', 'src-tauri/tauri.conf.json'];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const version = read(manifests[0]).version;
const cargo = 'src-tauri/Cargo.toml', lock = 'src-tauri/Cargo.lock';
const cargoVersion = /^version = "([^"]+)"/m;
const lockVersion = /(^name = "easyssh"\r?\nversion = ")[^"]+/m;
if (!/^\d+\.\d+\.\d+$/.test(version) || read(manifests[1]).version !== version ||
    readFileSync(cargo, 'utf8').match(cargoVersion)?.[1] !== version ||
    readFileSync(lock, 'utf8').match(lockVersion)?.[0].split('"').at(-1) !== version) {
  throw new Error('Version mismatch across manifests and Cargo.lock');
}
if (process.argv[2] === '--check') {
  if (process.env.GITHUB_REF_NAME !== 'v' + version) throw new Error('Tag must match v' + version);
} else {
  if (git('status', '--porcelain')) throw new Error('Commit your changes before cutting a release.');
  if (git('branch', '--show-current') !== 'main') throw new Error('Switch to main before cutting a release.');
  git('remote', 'get-url', 'origin');
  const kind = process.argv[2] ?? 'patch';
  const index = ['major', 'minor', 'patch'].indexOf(kind);
  if (index < 0) throw new Error('Use major, minor, or patch.');
  const next = version.split('.').map(Number).map((n, i) => i < index ? n : i === index ? n + 1 : 0).join('.');
  const tag = 'v' + next;
  if (git('tag', '--list', tag) || git('ls-remote', '--tags', 'origin', 'refs/tags/' + tag)) throw new Error(tag + ' already exists.');
  for (const path of manifests) writeFileSync(path, JSON.stringify({ ...read(path), version: next }, null, 2) + '\n');
  writeFileSync(cargo, readFileSync(cargo, 'utf8').replace(cargoVersion, 'version = "' + next + '"'));
  writeFileSync(lock, readFileSync(lock, 'utf8').replace(lockVersion, (_, prefix) => prefix + next));
  git('add', ...manifests, cargo, lock);
  git('commit', '-m', 'Release ' + tag);
  git('tag', '-a', tag, '-m', 'easyssh ' + tag);
  git('push', '--atomic', 'origin', 'HEAD:main', 'refs/tags/' + tag);
}
