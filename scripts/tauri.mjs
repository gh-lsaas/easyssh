import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(import.meta.resolve('@tauri-apps/cli/tauri.js'));
const [command, ...args] = process.argv.slice(2);
function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function initAndroid(args) {
  run('android', 'init', '--ci', ...args);
  cpSync('src-tauri/icons/android', 'src-tauri/gen/android/app/src/main/res', { recursive: true });
}
function android(action, args) {
  const ndk = process.env.NDK_HOME ?? process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_ROOT;
  if (ndk) {
    const host = { win32: 'windows-x86_64', linux: 'linux-x86_64', darwin: 'darwin-x86_64' }[process.platform];
    process.env.NDK_HOME = ndk;
    process.env.ANDROID_NDK_ROOT = ndk;
    process.env.PATH = [join(ndk, 'toolchains/llvm/prebuilt', host, 'bin'), process.env.PATH].join(delimiter);
  }
  if (action === 'init') {
    initAndroid(args);
    return;
  }
  if (!existsSync('src-tauri/gen/android/gradlew') ||
      !existsSync('src-tauri/gen/android/gradlew.bat')) {
    initAndroid(action === 'build' ? ['--skip-targets-install'] : []);
  }
  if (action === 'build') {
    run('android', 'build', '--apk', '--target', 'aarch64', ...args);
  } else {
    run('android', 'dev', ...args);
  }
}
if (command === 'build' && args.length === 0) {
  const bundles = { win32: 'nsis,msi', linux: 'deb,appimage', darwin: 'dmg' }[process.platform];
  if (!bundles) throw new Error('Unsupported desktop build platform.');
  run('build', '--bundles', bundles);
  android('build', []);
} else if (command === 'build-desktop') {
  run('build', ...args);
} else if (command === 'build-android') {
  android('build', args);
} else if (command === 'android-init') {
  android('init', args);
} else if (command === 'android-dev') {
  android('dev', args);
} else {
  run(...process.argv.slice(2));
}
