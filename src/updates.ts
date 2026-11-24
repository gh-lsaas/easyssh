import { getVersion } from '@tauri-apps/api/app';
import { check } from '@tauri-apps/plugin-updater';
import { openUrl } from '@tauri-apps/plugin-opener';

export function startUpdates(os: string, mobile: boolean) {
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  const message = document.createElement('span');
  const install = document.createElement('button');
  const dismiss = document.createElement('button');
  dismiss.textContent = 'Later';
  dismiss.onclick = () => { banner.hidden = true; };
  banner.append(message, install, dismiss);
  document.body.append(banner);
  let busy = false;
  async function checkUpdates() {
    if (busy || !banner.hidden) return;
    busy = true;
    try {
      if (mobile) {
        if (os !== 'android') return;
        const response = await fetch('https://api.github.com/repos/gh-lsaas/easyssh/releases/latest');
        if (!response.ok) throw new Error('Update check failed');
        const release = await response.json();
        const current = (await getVersion()).split('.').map(Number);
        const version = String(release.tag_name).replace(/^v/, '');
        if (!/^\d+\.\d+\.\d+$/.test(version)) return;
        const next = version.split('.').map(Number);
        const difference = next.findIndex((part, index) => part !== current[index]);
        if (difference < 0 || next[difference] <= current[difference]) return;
        const url = `https://github.com/gh-lsaas/easyssh/releases/download/v${version}/easyssh-${version}-android-arm64.apk`;
        if (!release.assets?.some((asset: { browser_download_url: string }) => asset.browser_download_url === url)) return;
        message.textContent = `easyssh ${version} is available`;
        install.textContent = 'Download update';
        install.onclick = () => { void openUrl(url).catch(() => { message.textContent = 'Could not open download. Try again.'; }); };
      } else {
        const update = await check();
        if (!update) return;
        message.textContent = `easyssh ${update.version} is available. Installation may restart the app.`;
        install.textContent = 'Install update';
        install.onclick = async () => {
          install.disabled = true;
          dismiss.disabled = true;
          message.textContent = 'Downloading and installing update…';
          try {
            await update.downloadAndInstall();
            message.textContent = 'Update installed. Reopen easyssh to finish.';
          } catch {
            message.textContent = 'Update failed. Try again.';
            install.disabled = false;
          } finally { dismiss.disabled = false; }
        };
      }
      banner.hidden = false;
    } catch { /* Offline checks retry at the next interval. */ }
    finally { busy = false; }
  }
  void checkUpdates();
  setInterval(() => { void checkUpdates(); }, 6 * 60 * 60 * 1000);
}
