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
  const checkButton = document.createElement('button');
  checkButton.id = 'check-updates';
  checkButton.textContent = 'Check for updates';
  document.querySelector('#connections-panel')!.append(checkButton);
  checkButton.onclick = () => { void checkUpdates(true); };
  function showStatus(text: string) {
    message.textContent = text;
    install.hidden = true;
    dismiss.textContent = 'Close';
    banner.hidden = false;
  }
  let busy = false;
  async function checkUpdates(manual = false) {
    if (busy || (!manual && !banner.hidden)) return;
    busy = true;
    checkButton.disabled = true;
    install.hidden = true;
    if (manual) showStatus('Checking for updates…');
    try {
      if (mobile) {
        if (os !== 'android') { if (manual) showStatus('Updates are unavailable on this platform.'); return; }
        const response = await fetch('https://api.github.com/repos/gh-lsaas/easyssh/releases/latest');
        if (!response.ok) throw new Error('Update check failed');
        const release = await response.json();
        const current = (await getVersion()).split('.').map(Number);
        const version = String(release.tag_name).replace(/^v/, '');
        if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
        const next = version.split('.').map(Number);
        const difference = next.findIndex((part, index) => part !== current[index]);
        if (difference < 0 || next[difference] <= current[difference]) { if (manual) showStatus(`easyssh ${await getVersion()} is up to date.`); return; }
        const url = `https://github.com/gh-lsaas/easyssh/releases/download/v${version}/easyssh-${version}-android-arm64.apk`;
        if (!release.assets?.some((asset: { browser_download_url: string }) => asset.browser_download_url === url)) throw new Error('Android update asset missing');
        message.textContent = `easyssh ${version} is available`;
        install.textContent = 'Download update';
        install.onclick = () => { void openUrl(url).catch(() => { message.textContent = 'Could not open download. Try again.'; }); };
      } else {
        const update = await check();
        if (!update) { if (manual) showStatus(`easyssh ${await getVersion()} is up to date.`); return; }
        message.textContent = `easyssh ${update.version} is available. Installation may restart the app.`;
        install.textContent = 'Install update';
        install.onclick = async () => {
          install.disabled = true;
          dismiss.disabled = true;
          message.textContent = 'Downloading and installing updateâ€¦';
          try {
            await update.downloadAndInstall();
            message.textContent = 'Update installed. Reopen easyssh to finish.';
          } catch {
            message.textContent = 'Update failed. Try again.';
            install.disabled = false;
          } finally { dismiss.disabled = false; }
        };
      }
      install.hidden = false;
      dismiss.textContent = 'Later';
      banner.hidden = false;
    } catch {
      showStatus('Could not check for updates. Check your connection and try again.');
    }
    finally { busy = false; checkButton.disabled = false; }
  }
  void checkUpdates();
  setInterval(() => { void checkUpdates(); }, 6 * 60 * 60 * 1000);
}
