import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
const version = JSON.parse(readFileSync('package.json')).version;
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const all = files('artifacts');
const platforms = {};
for (const [platform, suffix] of [['windows-x86_64', '.exe'], ['linux-x86_64', '.AppImage'], ['darwin-aarch64', '.app.tar.gz']]) {
  const artifact = all.find(path => path.endsWith(suffix) && all.includes(path + '.sig'));
  if (!artifact) throw new Error(`Missing signed updater artifact for ${platform}`);
  platforms[platform] = { signature: readFileSync(artifact + '.sig', 'utf8').trim(), url: `https://github.com/gh-lsaas/easyssh/releases/download/v${version}/${basename(artifact)}` };
}
writeFileSync('artifacts/latest.json', JSON.stringify({version, platforms, pub_date: new Date().toISOString()}, null, 2));
