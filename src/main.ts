import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Menu, MenuItem } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { resolveSessionSecret } from './connection-auth';
import { paneIds, removePane, replacePane, splitPane, reorderIds, type PaneTree, type Edge } from './panes';
import { exclusiveAction, clipboardShortcut } from './clipboard';
import { FileEditor } from './file-editor';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';

type Profile = { id: string; name: string; host: string; port: number; username: string; auth: string; keyPath: string; group: string };
type Session = { kind: 'ssh' | 'local'; id: string; profile: Profile; terminal: Terminal; fit: FitAddon; element: HTMLElement; status: string; connectedAt?: number; allowMultilinePaste?: boolean };
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let profiles: Profile[] = [], sessions: Session[] = [], active = '', selected = '', filter = '';
let layout: PaneTree | null = null;
let suppressTabClickUntil = 0;
type ShellInfo = {id:string;label:string};
let platformInfo: {os:string;mobile:boolean;shells:ShellInfo[]} = {os:'',mobile:false,shells:[]};
const icons = {
  panel: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="1.5"/><path d="M7.5 3v14"/></svg>',
  add: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>',
  edit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m4 12-1 5 5-1L17 7l-4-4-9 9Z M11 5l4 4"/></svg>',
  close: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>',
};
$('#app').innerHTML = `
  <aside id="connections-panel" aria-label="Saved connections">
    <div class="list-header"><span class="wordmark"><img id="brand-logo" src="/easyssh-logo.svg" alt="" width="24" height="24">easyssh</span><h1>Connections</h1><button class="icon" id="new" title="New connection (Ctrl+N)" aria-label="New connection">${icons.add}</button></div>
    <div class="search"><input id="search" type="search" placeholder="Search connections" aria-label="Search connections" title="Find connection (Ctrl+K)" autocomplete="off"></div>
    <div id="host-list"></div>
  </aside>
  <main aria-label="SSH terminal">
    <div class="terminal-bar"><button class="icon panel-toggle" id="toggle-panel" aria-label="Hide connections" aria-expanded="true" aria-controls="connections-panel" title="Toggle connections (Ctrl+B)">${icons.panel}</button><div id="tabs" role="tablist" aria-label="Sessions"></div><button id="local-shell" title="Open local shell">Local shell</button><button id="toggle-files" title="Files and editor (Ctrl+Shift+E)" aria-expanded="false">Files</button></div>
    <div class="terminal-workspace"><div id="terminals">
      <div id="pane-layout"></div><div id="terminal-parking" hidden></div>
      <div id="drop-preview" hidden></div>
      <section id="session-empty" aria-labelledby="empty-title">
        <h2 id="empty-title">No active session</h2>
        <p id="empty-description">Select a saved connection and click Connect to open a terminal.</p>
        <button id="empty-action" class="primary" hidden>Show connections</button>
      </section>
    </div>
    <aside id="files-panel" aria-label="File browser and editor" hidden></aside></div>
    <div id="touch-keys" role="group" aria-label="Terminal keys">
      <div class="touch-actions"><button data-key="escape">Esc</button><button data-key="tab">Tab</button><button data-key="interrupt">Ctrl+C</button><button id="touch-paste">Paste</button></div>
      <div class="touch-directions" role="group" aria-label="Arrow keys"><button data-key="up" aria-label="Up">&uarr;</button><button data-key="left" aria-label="Left">&larr;</button><button data-key="down" aria-label="Down">&darr;</button><button data-key="right" aria-label="Right">&rarr;</button></div>
    </div>
    <footer><span id="session-status">No active session</span><div class="session-facts"><span id="session-address"></span><span id="session-time"></span><span id="session-size"></span><span>UTF-8</span></div></footer>
  </main>
  <dialog id="shell-dialog"><form id="shell-form"><h2>Local shell</h2><label>Shell<select id="shell-select" required></select></label><p id="shell-help" class="hint"></p><div class="dialog-actions"><button type="button" id="shell-cancel">Cancel</button><button type="submit" class="primary">Open terminal</button></div></form></dialog>
  <dialog id="editor"><form id="connection-form" autocomplete="off"><div class="dialog-heading"><h2 id="editor-title">New connection</h2><button type="button" class="icon close-dialog" aria-label="Close">×</button></div>
  <input type="hidden" name="id"><label>Connection name<input name="name" required placeholder="Production server" maxlength="100"></label>
  <div class="form-row"><label>Hostname / IP<input name="host" required placeholder="192.168.1.10" maxlength="253"></label><label class="port">Port<input name="port" type="number" min="1" max="65535" value="22" required></label></div>
  <div class="form-row"><label>Username<input name="username" required placeholder="root"></label><label>Group<input name="group" placeholder="Personal"></label></div>
  <label>Authentication<select name="auth"><option value="password">Password</option><option value="key">Private key</option></select></label>
  <label id="key-field" hidden>Private key path<input name="keyPath" placeholder="C:\\Users\\you\\.ssh\\id_ed25519"><small>OpenSSH or PEM private key. The file stays on your disk.</small></label>
  <label><span id="secret-label">Password</span><input name="secret" type="password" autocomplete="new-password" placeholder="Leave blank to keep the saved secret"></label>
  <label class="check"><input name="remember" type="checkbox" checked> Save secret in the operating system credential store</label><p class="hint">Unsaved secrets are requested when you connect. Blank fields preserve an existing saved secret.</p>
  <p class="form-error" id="form-error" role="alert"></p><div class="dialog-actions"><button type="button" id="delete-connection" class="danger" hidden>Delete connection</button><button type="button" class="close-dialog">Cancel</button><button class="primary" type="submit">Save</button></div></form></dialog>
  <dialog id="confirm"><div class="dialog-heading"><h2 id="confirm-title"></h2></div><p id="confirm-message"></p><code id="fingerprint"></code><div class="dialog-actions"><button id="confirm-no">Cancel</button><button class="primary" id="confirm-yes">Continue</button></div></dialog>
  <dialog id="secret-dialog"><form id="secret-form" autocomplete="off"><h2>Session credentials</h2><label id="session-secret-label" for="session-secret">Password</label><input id="session-secret" type="password" autocomplete="new-password"><label class="check"><input id="session-remember" type="checkbox" checked> Save for future connections</label><p id="session-secret-error" class="form-error" role="alert"></p><p class="hint">Saved credentials are used automatically. Enter a replacement only when needed.</p><div class="dialog-actions"><button type="button" id="secret-cancel">Cancel</button><button type="submit" class="primary">Connect</button></div></form></dialog>
  <dialog id="paste-dialog"><h2>Paste multiple lines?</h2><p>This text contains line breaks and may run commands on the server. Approval will be remembered for this session.</p><label class="check"><input type="checkbox" id="paste-always"> Always allow multiline pastes in all sessions</label><div class="dialog-actions"><button id="paste-cancel">Cancel</button><button id="paste-approve" class="primary">Paste</button></div></dialog>
  <div id="toast" role="status" hidden></div>`;
let toastTimer: ReturnType<typeof setTimeout>;
function notify(message: unknown) { $('#toast').textContent = String(message); $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 6000); }
async function reload() { profiles = await invoke<Profile[]>('list_profiles'); if (!profiles.some(p => p.id === selected)) selected = profiles[0]?.id ?? ''; renderHosts(); }
function renderHosts() {
  const visible = profiles.filter(p => `${p.name} ${p.host} ${p.username} ${p.group}`.toLowerCase().includes(filter));
  $('#host-list').innerHTML = visible.length ? visible.sort((a,b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)).map((p,i,all) => {
    const connected = sessions.some(s => s.profile.id === p.id && s.status === 'Connected');
    return `${i === 0 || p.group !== all[i-1].group ? `<h2 class="group-label">${esc(p.group || 'Ungrouped')}</h2>` : ''}
      <div class="host-row ${selected === p.id ? 'selected' : ''}" data-profile="${p.id}">
        <button class="host" data-id="${p.id}" title="Select ${esc(p.name)}" aria-pressed="${selected === p.id}">
          <span class="host-heading"><span class="dot ${connected ? 'connected' : ''}" title="${connected ? 'Connected session' : 'No connected session'}"></span><strong>${esc(p.name)}</strong></span>
          <span class="host-address">${esc(p.username)}@${esc(p.host)}:${p.port}</span>
          <span class="host-meta">${p.auth === 'key' ? 'Private key' : 'Password'}${connected ? ' &middot; Connected' : ''}</span>
        </button>
        <div class="host-actions"><button class="host-connect" data-connect="${p.id}" ${connecting ? 'disabled' : ''} aria-label="Connect to ${esc(p.name)}">${connecting && selected === p.id ? 'Connecting…' : 'Connect'}</button>
        <button class="icon host-edit" data-edit="${p.id}" title="Edit ${esc(p.name)}" aria-label="Edit ${esc(p.name)}">${icons.edit}</button></div>
      </div>`;
  }).join('') : filter ? '<p class="list-empty">No matching connections</p>' : '';
  document.querySelectorAll<HTMLButtonElement>('.host').forEach(b => {
    b.onclick = () => { selected = b.dataset.id!; renderHosts(); };
    b.ondblclick = () => { void start(b.dataset.id!); };
  });
  document.querySelectorAll<HTMLButtonElement>('[data-connect]').forEach(b => b.onclick = () => { void start(b.dataset.connect!); });
  document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach(b => b.onclick = () => edit(profiles.find(p => p.id === b.dataset.edit)));
  renderEmptyState();
}
let panelVisible = true;
function togglePanel(show = !panelVisible, focusSearch = false) {
  panelVisible = show;
  $('#connections-panel').hidden = !show;
  $('#toggle-panel').setAttribute('aria-expanded', String(show));
  $('#toggle-panel').setAttribute('aria-label', show ? 'Hide connections' : 'Show connections');
  renderEmptyState();
  if (focusSearch) { $('#search').focus(); $<HTMLInputElement>('#search').select(); }
  else if (!show) { const s = sessions.find(s => s.id === active); if (s) s.terminal.focus(); else $('#toggle-panel').focus(); }
}
$('#toggle-panel').onclick = () => togglePanel();
function renderEmptyState() {
  $('#session-empty').hidden = sessions.length > 0;
  if (sessions.length) return;
  const noConnections = profiles.length === 0;
  $('#empty-title').textContent = noConnections ? 'No saved connections' : 'No active session';
  $('#empty-description').textContent = noConnections
    ? 'Add a connection with your server address and login details to start an SSH session.'
    : 'Select a saved connection and click Connect to open a terminal.';
  $('#empty-action').textContent = noConnections ? 'New connection' : 'Show connections';
  $('#empty-action').hidden = !noConnections && panelVisible;
}
$('#empty-action').onclick = () => profiles.length ? togglePanel(true, true) : edit();
function confirmAction(title: string, message: string, fingerprint = ''): Promise<boolean> {
  $('#confirm-title').textContent = title; $('#confirm-message').textContent = message; $('#fingerprint').textContent = fingerprint;
  const dialog = $<HTMLDialogElement>('#confirm'); dialog.showModal();
  return new Promise(resolve => { const finish = (value: boolean) => { dialog.close(); resolve(value); }; $('#confirm-no').onclick = () => finish(false); $('#confirm-yes').onclick = () => finish(true); dialog.oncancel = () => resolve(false); });
}
function edit(p?: Profile) {
  const form = $<HTMLFormElement>('#connection-form'); form.reset(); $('#form-error').textContent = '';
  for (const key of ['id','name','host','port','username','group','auth','keyPath'] as const) (form.elements.namedItem(key) as HTMLInputElement).value = String(p?.[key] ?? (key === 'port' ? 22 : key === 'auth' ? 'password' : ''));
  if (platformInfo.mobile) $<HTMLInputElement>('[name="remember"]').checked = false;
  $('#editor-title').textContent = p ? 'Edit connection' : 'New connection'; $('#delete-connection').hidden = !p; authChange(); $<HTMLDialogElement>('#editor').showModal();
}
function authChange() { const isKey = ($('[name="auth"]') as HTMLSelectElement).value === 'key'; $('#key-field').hidden = !isKey; $('#secret-label').textContent = isKey ? 'Key passphrase (optional)' : 'Password'; ($('[name="keyPath"]') as HTMLInputElement).required = isKey; }
async function deleteConnection(id: string) {
  const p = profiles.find(p => p.id === id);
  if (!p) return;
  if (await confirmAction('Delete connection?', `Remove ${p.name} and its saved credentials? Existing sessions stay open.`)) {
    try {
      await invoke('delete_profile', {id}); ephemeral.delete(id);
      if (($('[name="id"]') as HTMLInputElement).value === id) $<HTMLDialogElement>('#editor').close();
      await reload();
    } catch(e) { notify(e); }
  }
}
$('#delete-connection').onclick = () => deleteConnection(($('[name="id"]') as HTMLInputElement).value);
$('[name="auth"]').onchange = authChange;
$('#new').onclick = () => edit();
document.querySelectorAll<HTMLButtonElement>('.close-dialog').forEach(b => b.onclick = () => $<HTMLDialogElement>('#editor').close());
const ephemeral = new Map<string,string>();
$('#connection-form').onsubmit = async e => {
  e.preventDefault(); const form = e.currentTarget as HTMLFormElement; const data = new FormData(form); const get = (k:string) => String(data.get(k) ?? '');
  const connection: Profile = {id:get('id'),name:get('name').trim(),host:get('host').trim(),port:Number(get('port')),username:get('username').trim(),auth:get('auth'),keyPath:get('keyPath').trim(),group:get('group').trim()};
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!; submit.disabled = true;
  try { const p = await invoke<Profile>('save_profile',{connection,secret:data.has('remember') ? get('secret') : null}); ephemeral.delete(p.id); if (!data.has('remember') && get('secret')) ephemeral.set(p.id,get('secret')); selected = p.id; form.reset(); $<HTMLDialogElement>('#editor').close(); await reload(); } catch(e) { $('#form-error').textContent = String(e); } finally { submit.disabled = false; }
};
let hostPress: ReturnType<typeof setTimeout> | undefined;
$('#host-list').addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-profile]');
  if (row) hostPress = setTimeout(() => { const p = profiles.find(p => p.id === row.dataset.profile); if (p) edit(p); },600);
});
for (const event of ['pointerup','pointercancel','pointermove']) $('#host-list').addEventListener(event,()=>clearTimeout(hostPress));
$('#search').oninput = e => { filter = (e.target as HTMLInputElement).value.toLowerCase(); renderHosts(); };
function askSecret(p: Profile): Promise<string | null> {
  $('#session-secret-label').textContent = p.auth === 'key' ? 'Key passphrase (optional)' : 'Password';
  const input = $<HTMLInputElement>('#session-secret'); input.value = ''; input.required = p.auth === 'password';
  const remember = $<HTMLInputElement>('#session-remember'); remember.checked = !platformInfo.mobile;
  $('#session-secret-error').textContent = '';
  const dialog = $<HTMLDialogElement>('#secret-dialog'); dialog.showModal(); input.focus();
  return new Promise(resolve => {
    let saving = false;
    const finish = (value: string | null) => { input.value = ''; dialog.close(); resolve(value); };
    $('#secret-form').onsubmit = async e => {
      e.preventDefault(); if (saving) return;
      const secret = input.value;
      const submit = $('#secret-form').querySelector<HTMLButtonElement>('[type="submit"]')!;
      saving = true; submit.disabled = true;
      try {
        if (remember.checked && secret) await invoke('save_secret', {id:p.id, secret});
        finish(secret);
      } catch(e) { $('#session-secret-error').textContent = String(e); }
      finally { saving = false; submit.disabled = false; }
    };
    $('#secret-cancel').onclick = () => { if (!saving) finish(null); };
    dialog.oncancel = e => { if (saving) { e.preventDefault(); return; } input.value = ''; resolve(null); };
  });
}
let connecting = false;
async function start(profileId:string, forceCredentials = false) {
  if (connecting) return; connecting = true; selected = profileId; renderHosts();
  try {
    const p = profiles.find(p => p.id === profileId)!;
    const info = await invoke<{fingerprint:string;known:string|null}>('inspect_host',{id:p.id});
    if (info.known && info.known !== info.fingerprint) throw new Error('The server host key has changed. Connection blocked. Verify the server before updating your trusted hosts.');
    if (!info.known) { if (!await confirmAction('Trust this server?', `Verify this fingerprint with the owner of ${p.host}:${p.port} before connecting.`, info.fingerprint)) return; await invoke('trust_host',{id:p.id,fingerprint:info.fingerprint}); }
    const secret = await resolveSessionSecret({
      auth: p.auth,
      forcePrompt: forceCredentials,
      temporarySecret: ephemeral.get(p.id),
      hasSavedSecret: () => invoke<boolean>('has_saved_secret', {id:p.id}),
      prompt: () => askSecret(p),
    });
    if (secret === null) return;
    ephemeral.delete(p.id);
    const session = createTerminal(p, 'ssh'); const {id,terminal} = session;
    try { await invoke('connect',{id:p.id,sessionId:id,cols:terminal.cols,rows:terminal.rows,secret}); } catch(e) { session.status = `Error: ${e}`; terminal.writeln(`\r\n${session.status}`); renderTabs(); }
  } catch(e) { notify(e); } finally { connecting = false; renderHosts(); }
}
function createTerminal(p: Profile, kind: 'ssh' | 'local'): Session {
    const id = crypto.randomUUID(), element = document.createElement('div'); element.className = 'terminal-view'; element.dataset.session = id; element.id = `terminal-${id}`; element.setAttribute('role', 'tabpanel'); element.setAttribute('aria-label', `${p.name} terminal`); $('#terminals').append(element);
    const terminal = new Terminal({cursorBlink:true,fontSize:13,fontFamily:'"Cascadia Code", "SFMono-Regular", Consolas, monospace',scrollback:10000,theme:{background:'#101010',foreground:'#d4d4d4',cursor:'#d4d4d4',selectionBackground:'#3a3a3a',black:'#141a22',red:'#ef8282',green:'#91d7ad',yellow:'#e7c78c',blue:'#8bb9ee',magenta:'#bf9be9',cyan:'#88d5db',white:'#dae2ec'}});
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element);
    const session:Session = {kind,id,profile:p,terminal,fit,element,status:'Connecting…'}; sessions.push(session); activate(id);
    terminal.onData(data => { if(session.status !== 'Connected') return; inputQueues.set(id,(inputQueues.get(id) ?? Promise.resolve()).then(() => invoke('input',{id,data})).catch(notify)); });
    terminal.onResize(({cols,rows}) => { renderStatus(); if(session.status === 'Connected') invoke('resize',{id,cols,rows}).catch(notify); });
    terminal.attachCustomKeyEventHandler(e => !(e.ctrlKey && ((!e.shiftKey && ['k','b','n'].includes(e.key.toLowerCase())) || (e.shiftKey && e.key.toLowerCase() === 'e'))));
    if (matchMedia('(max-width: 700px)').matches) togglePanel(false);
    return session;
}
$('#local-shell').onclick = () => {
  if (!platformInfo.shells.length) { notify('No supported local shell was found on this device.'); return; }
  $<HTMLDialogElement>('#shell-dialog').showModal();
};
$('#shell-cancel').onclick = () => $<HTMLDialogElement>('#shell-dialog').close();
async function startLocal(shellId: string) {
  const shell = platformInfo.shells.find(s => s.id === shellId); if (!shell) return;
  const p: Profile = {id:`local:${shell.id}`,name:shell.label,host:'localhost',port:0,username:'local',auth:'local',keyPath:'',group:'Local'};
  const session = createTerminal(p,'local');
  try { await invoke('connect_local',{shellId:shell.id,sessionId:session.id,cols:session.terminal.cols,rows:session.terminal.rows}); }
  catch(e) { session.status = `Error: ${e}`; session.terminal.writeln(session.status); renderTabs(); }
}
$('#shell-form').onsubmit = e => {
  e.preventDefault(); $<HTMLDialogElement>('#shell-dialog').close();
  void startLocal($<HTMLSelectElement>('#shell-select').value);
};
const fileEditor = new FileEditor($('#files-panel'), {confirm:confirmAction,notify,onVisibility:visible => {
  $('#toggle-files').setAttribute('aria-expanded',String(visible)); requestAnimationFrame(fitVisible);
}});
$('#toggle-files').onclick = () => {
  const s = sessions.find(s => s.id === active);
  if (!s || s.status !== 'Connected') { notify('Connect a terminal first.'); return; }
  void fileEditor.toggle(s.id, s.kind === 'local' ? `${s.profile.name} · Host files` : `${s.profile.username}@${s.profile.host}`);
};
document.querySelectorAll<HTMLButtonElement>('[data-key]').forEach(button => button.onpointerdown = e => {
  e.preventDefault(); const s = sessions.find(s => s.id === active);
  if (s?.status === 'Connected') { void invoke('input',{id:s.id,data:({escape:'\u001b',tab:'\t',interrupt:'\u0003',up:'\u001b[A',down:'\u001b[B',left:'\u001b[D',right:'\u001b[C'} as Record<string,string>)[button.dataset.key!]}).catch(notify); s.terminal.focus(); }
});
$('#touch-paste').onclick = () => { void paste(); };
const inputQueues = new Map<string,Promise<unknown>>();
function fitVisible() {
  for (const id of paneIds(layout)) {
    const s = sessions.find(s => s.id === id);
    if (s && s.element.clientWidth > 0 && s.element.clientHeight > 0) s.fit.fit();
  }
}
function renderLayout() {
  // Move existing terminals, preserving their process, scrollback and selection.
  const parking = $('#terminal-parking');
  for (const s of sessions) parking.append(s.element);
  const root = $('#pane-layout'); root.replaceChildren();
  const build = (node: PaneTree): HTMLElement => {
    if (node.kind === 'pane') {
      const s = sessions.find(s => s.id === node.session)!;
      const pane = document.createElement('section'); pane.className = 'terminal-pane'; pane.dataset.pane = s.id;
      pane.setAttribute('aria-label', `${s.profile.name} pane`);
      const title = document.createElement('div'); title.className = 'pane-title'; title.textContent = s.kind === 'local' ? s.profile.name : `${s.profile.name} — ${s.profile.username}@${s.profile.host}`;
      title.hidden = paneIds(layout).length === 1;
      pane.append(title, s.element); s.element.hidden = false;
      return pane;
    }
    const split = document.createElement('div'); split.className = `pane-split ${node.axis}`;
    const first = build(node.first), second = build(node.second);
    first.style.flex = `${node.ratio} 1 0`; second.style.flex = `${1 - node.ratio} 1 0`;
    const divider = document.createElement('div'); divider.className = 'pane-divider'; divider.tabIndex = 0;
    divider.setAttribute('role','separator'); divider.setAttribute('aria-label','Resize split');
    divider.setAttribute('aria-orientation', node.axis === 'row' ? 'vertical' : 'horizontal');
    const adjust = (ratio: number) => {
      node.ratio = Math.max(.15, Math.min(.85, ratio));
      first.style.flexGrow = String(node.ratio); second.style.flexGrow = String(1 - node.ratio);
      divider.setAttribute('aria-valuenow', String(Math.round(node.ratio * 100)));
      fitVisible();
    };
    divider.onpointerdown = e => {
      e.preventDefault(); divider.setPointerCapture(e.pointerId);
      divider.onpointermove = event => { const rect = split.getBoundingClientRect(); adjust(node.axis === 'row' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height); };
      const stop = () => { divider.onpointermove = null; divider.onpointerup = null; divider.onpointercancel = null; };
      divider.onpointerup = stop; divider.onpointercancel = stop;
    };
    divider.onkeydown = e => {
      const backward = node.axis === 'row' ? 'ArrowLeft' : 'ArrowUp', forward = node.axis === 'row' ? 'ArrowRight' : 'ArrowDown';
      if (e.key === backward || e.key === forward) { e.preventDefault(); adjust(node.ratio + (e.key === backward ? -.05 : .05)); }
    };
    divider.setAttribute('aria-valuemin','15'); divider.setAttribute('aria-valuemax','85'); divider.setAttribute('aria-valuenow',String(Math.round(node.ratio * 100)));
    split.append(first, divider, second); return split;
  };
  if (layout) root.append(build(layout));
  markActivePane(); requestAnimationFrame(fitVisible);
}
function markActivePane() {
  document.querySelectorAll<HTMLElement>('[data-pane]').forEach(pane => pane.classList.toggle('focused', pane.dataset.pane === active));
}
function activate(id: string) {
  const s = sessions.find(s => s.id === id);
  if (s && !paneIds(layout).includes(id)) {
    layout = layout ? replacePane(layout, paneIds(layout).includes(active) ? active : paneIds(layout)[0], id) : {kind:'pane',session:id};
    active = id; renderLayout();
  } else active = id;
  markActivePane();
  if (s) requestAnimationFrame(() => { fitVisible(); s.terminal.focus(); });
  renderTabs(); renderHosts();
}
$('#pane-layout').addEventListener('pointerdown', e => {
  const pane = (e.target as HTMLElement).closest<HTMLElement>('[data-pane]');
  if (pane && active !== pane.dataset.pane) { active = pane.dataset.pane!; markActivePane(); renderTabs(); }
});
$('#pane-layout').addEventListener('focusin', e => {
  const pane = (e.target as HTMLElement).closest<HTMLElement>('[data-pane]');
  if (pane && active !== pane.dataset.pane) { active = pane.dataset.pane!; markActivePane(); renderTabs(); }
});
function renderStatus() {
  const s = sessions.find(s => s.id === active);
  $('#session-status').textContent = s?.status ?? 'No active session';
  $('#session-address').textContent = s ? s.kind === 'local' ? s.profile.name : `${s.profile.username}@${s.profile.host}:${s.profile.port}` : '';
  $<HTMLButtonElement>('#toggle-files').disabled = !s || s.status !== 'Connected';
  $('#session-address').title = $('#session-address').textContent ?? '';
  $('#session-size').textContent = s ? `${s.terminal.cols} × ${s.terminal.rows}` : '';
  if (s?.connectedAt && s.status === 'Connected') {
    const seconds = Math.floor((Date.now() - s.connectedAt) / 1000);
    $('#session-time').textContent = `${Math.floor(seconds / 3600).toString().padStart(2,'0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2,'0')}:${(seconds % 60).toString().padStart(2,'0')}`;
  } else $('#session-time').textContent = '';
}
function renderTabs() {
  $('#tabs').innerHTML = sessions.map(s => `<div class="tab ${s.id === active ? 'active' : ''} ${paneIds(layout).includes(s.id) ? 'visible-pane' : ''}" data-session-tab="${s.id}"><button role="tab" tabindex="${s.id === active ? 0 : -1}" aria-selected="${s.id === active}" aria-controls="terminal-${s.id}" data-tab="${s.id}" title="${esc(s.profile.username)}@${esc(s.profile.host)}:${s.profile.port}"><span class="dot ${s.status === 'Connected' ? 'connected' : ''}"></span>${esc(s.profile.name)}</button><button class="tab-close icon" data-close="${s.id}" title="Close session" aria-label="Close ${esc(s.profile.name)}">${icons.close}</button></div>`).join('');
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = () => { if (Date.now() >= suppressTabClickUntil) activate(b.dataset.tab!); });
  document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(b => b.onclick = () => { if (Date.now() >= suppressTabClickUntil) void closeSession(b.dataset.close!); });
  renderStatus();
}
$('#tabs').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !sessions.length) return;
  e.preventDefault();
  const current = sessions.findIndex(s => s.id === active);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? sessions.length - 1 : (current + (e.key === 'ArrowRight' ? 1 : -1) + sessions.length) % sessions.length;
  activate(sessions[next].id);
});
type TabDrop = {kind:'tab'; target:string | null; after:boolean} | {kind:'pane'; target:string; edge:Edge | 'center'};
let tabDrag: {id:string; pointer:number; x:number; y:number; moved:boolean; drop:TabDrop | null} | null = null;
const dragLabel = document.createElement('div'); dragLabel.className = 'tab-drag-label'; dragLabel.hidden = true; document.body.append(dragLabel);
function clearDropPreview() {
  $('#drop-preview').hidden = true;
  document.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before','drop-after'));
  $('#tabs').classList.remove('drop-end');
}
function cancelTabDrag() {
  if (tabDrag?.moved) suppressTabClickUntil = Date.now() + 300;
  tabDrag = null; dragLabel.hidden = true; clearDropPreview(); document.body.classList.remove('dragging-tab');
}
$('#tabs').addEventListener('pointerdown', e => {
  if (e.button !== 0 || (e.target as HTMLElement).closest('[data-close]')) return;
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-session-tab]'); if (!tab) return;
  tabDrag = {id:tab.dataset.sessionTab!, pointer:e.pointerId, x:e.clientX, y:e.clientY, moved:false, drop:null};
});
document.addEventListener('pointermove', e => {
  const drag = tabDrag; if (!drag || e.pointerId !== drag.pointer) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
  e.preventDefault(); drag.moved = true; clearDropPreview(); drag.drop = null;
  document.body.classList.add('dragging-tab');
  dragLabel.textContent = sessions.find(s => s.id === drag.id)?.profile.name ?? 'Session';
  dragLabel.hidden = false; dragLabel.style.left = `${e.clientX + 12}px`; dragLabel.style.top = `${e.clientY + 12}px`;
  const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  const tab = hit?.closest<HTMLElement>('[data-session-tab]');
  if (hit?.closest('#tabs')) {
    const strip = $('#tabs'), rect = strip.getBoundingClientRect();
    if (e.clientX > rect.right - 30) strip.scrollLeft += 16;
    if (e.clientX < rect.left + 30) strip.scrollLeft -= 16;
    if (tab) {
      const after = e.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
      drag.drop = {kind:'tab', target:tab.dataset.sessionTab!, after};
      if (tab.dataset.sessionTab !== drag.id) tab.classList.add(after ? 'drop-after' : 'drop-before');
    } else { drag.drop = {kind:'tab',target:null,after:true}; strip.classList.add('drop-end'); }
    return;
  }
  const pane = hit?.closest<HTMLElement>('[data-pane]'); if (!pane || pane.dataset.pane === drag.id) return;
  const rect = pane.getBoundingClientRect(), root = $('#terminals').getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width, y = (e.clientY - rect.top) / rect.height;
  const distances: [Edge,number][] = [['left',x],['right',1-x],['top',y],['bottom',1-y]];
  distances.sort((a,b) => a[1]-b[1]);
  const edge: Edge | 'center' = distances[0][1] < .25 ? distances[0][0] : 'center';
  drag.drop = {kind:'pane', target:pane.dataset.pane!,edge};
  const preview = $('#drop-preview'); preview.hidden = false;
  preview.textContent = edge === 'center' ? 'Move here' : `Split ${edge}`;
  preview.style.left = `${rect.left - root.left + (edge === 'right' ? rect.width/2 : 0)}px`;
  preview.style.top = `${rect.top - root.top + (edge === 'bottom' ? rect.height/2 : 0)}px`;
  preview.style.width = `${edge === 'left' || edge === 'right' ? rect.width/2 : rect.width}px`;
  preview.style.height = `${edge === 'top' || edge === 'bottom' ? rect.height/2 : rect.height}px`;
});
document.addEventListener('pointerup', e => {
  const drag = tabDrag; if (!drag || e.pointerId !== drag.pointer) return;
  const drop = drag.drop; cancelTabDrag();
  if (!drag.moved || !drop || !sessions.some(s => s.id === drag.id)) return;
  if (drop.kind === 'tab') {
    const order = reorderIds(sessions.map(s => s.id),drag.id,drop.target,drop.after);
    sessions = order.map(id => sessions.find(s => s.id === id)!); renderTabs();
  } else {
    if (drop.edge === 'center') {
      const base = removePane(layout, drag.id);
      layout = base ? replacePane(base, drop.target, drag.id) : {kind:'pane',session:drag.id};
    } else layout = splitPane(layout,drag.id,drop.target,drop.edge);
    active = drag.id; renderLayout(); activate(drag.id);
  }
});
document.addEventListener('pointercancel',cancelTabDrag);
window.addEventListener('blur',cancelTabDrag);
document.addEventListener('keydown',e => { if (e.key === 'Escape') cancelTabDrag(); });
setInterval(renderStatus, 1000);
async function copy(s = sessions.find(s => s.id === active)) {
  if (s?.terminal.hasSelection()) {
    try { await navigator.clipboard.writeText(s.terminal.getSelection()); } catch(e) { notify(`Clipboard: ${e}`); }
  }
}
let alwaysAllowMultiline = false;
try { alwaysAllowMultiline = localStorage.getItem('eassh.allowMultilinePaste') === 'true'; } catch { /* Session approval remains available without storage. */ }
const runPaste = exclusiveAction();
function approveMultiline(s: Session): Promise<boolean> {
  if (alwaysAllowMultiline || s.allowMultilinePaste) return Promise.resolve(true);
  const dialog = $<HTMLDialogElement>('#paste-dialog'), remember = $<HTMLInputElement>('#paste-always');
  remember.checked = false; dialog.showModal();
  return new Promise(resolve => {
    const finish = (approved: boolean) => {
      if (approved) {
        s.allowMultilinePaste = true;
        if (remember.checked) {
          alwaysAllowMultiline = true;
          try { localStorage.setItem('eassh.allowMultilinePaste','true'); } catch { notify('Allowed for this run; the preference could not be saved.'); }
        }
      }
      dialog.close(); resolve(approved);
    };
    $('#paste-approve').onclick = () => finish(true); $('#paste-cancel').onclick = () => finish(false);
    dialog.oncancel = () => resolve(false);
  });
}
async function paste(s = sessions.find(s => s.id === active), suppliedText?: string) {
  if (!s || s.status !== 'Connected' || document.querySelector('dialog[open]')) return;
  await runPaste(async () => {
    try {
      const text = suppliedText ?? await navigator.clipboard.readText();
      if (new TextEncoder().encode(text).length > 60000) { notify('Paste must be smaller than 60 KB.'); return; }
      if (/[\r\n]/.test(text) && !await approveMultiline(s)) return;
      if (!sessions.includes(s) || s.status !== 'Connected') return;
      s.terminal.paste(text); s.terminal.focus();
    } catch(e) { notify(`Clipboard: ${e}`); }
  });
}
// Own clipboard events before xterm or the browser can handle the same gesture.
$('#terminals').addEventListener('keydown', e => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-session]')?.dataset.session;
  const s = sessions.find(s => s.id === id); if (!s) return;
  const action = clipboardShortcut(e); if (!action) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.repeat) return;
  if (action === 'copy') void copy(s); else void paste(s);
}, true);
$('#terminals').addEventListener('paste', e => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-session]')?.dataset.session;
  const s = sessions.find(s => s.id === id); if (!s) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.clipboardData) void paste(s, e.clipboardData.getData('text/plain'));
}, true);
// Disable the browser menu everywhere. Native app menus are scoped to the
// clicked connection/tab/terminal instead of offering WebView navigation tools.
let connectionMenu: Menu, terminalMenu: Menu;
let menuProfileId = '', menuSessionId = '';
let copyItem: MenuItem, pasteItem: MenuItem, disconnectItem: MenuItem, editSessionItem: MenuItem;
async function closeSession(id: string) {
  cancelTabDrag();
  const s = sessions.find(s => s.id === id); if (!s) return;
  if (!await fileEditor.beforeSessionClose(id)) return;
  try { await invoke('disconnect', {id}); } catch(e) { notify(e); return; }
  s.terminal.dispose(); s.element.remove(); sessions = sessions.filter(s => s.id !== id);
  inputQueues.delete(id);
  layout = removePane(layout, id);
  const next = active === id ? paneIds(layout)[0] ?? sessions.at(-1)?.id ?? '' : active;
  renderLayout(); activate(next);
}
async function createContextMenus() {
  connectionMenu = await Menu.new({items: [
    {text:'Connect', action:() => { void start(menuProfileId); }},
    {text:'Connect with credentials…', action:() => { void start(menuProfileId, true); }},
    {item:'Separator'},
    {text:'Edit connection…', action:() => edit(profiles.find(p => p.id === menuProfileId))},
    {text:'Delete connection…', action:() => { void deleteConnection(menuProfileId); }},
  ]});
  copyItem = await MenuItem.new({text:'Copy selection', action:() => { void copy(); }});
  pasteItem = await MenuItem.new({text:'Paste', action:() => { void paste(); }});
  disconnectItem = await MenuItem.new({text:'Disconnect', action:() => { void invoke('disconnect', {id:menuSessionId}).catch(notify); }});
  editSessionItem = await MenuItem.new({text:'Edit connection…', action:() => {
    const s = sessions.find(s => s.id === menuSessionId);
    const p = profiles.find(p => p.id === s?.profile.id); if (p) edit(p);
  }});
  terminalMenu = await Menu.new({items: [copyItem, pasteItem,
    {text:'Clear scrollback', action:() => sessions.find(s => s.id === menuSessionId)?.terminal.clear()},
    {text:'Reset multiline paste approval', action:() => {
      alwaysAllowMultiline = false; sessions.forEach(s => { s.allowMultilinePaste = false; });
      try { localStorage.removeItem('eassh.allowMultilinePaste'); } catch { notify('The saved preference could not be cleared.'); }
    }},
    {item:'Separator'},
    {text:'Open another session', action:() => {
      const s = sessions.find(s => s.id === menuSessionId);
      if (s?.kind === 'local') void startLocal(s.profile.id.slice(6));
      else if (s && profiles.some(p => p.id === s.profile.id)) void start(s.profile.id);
    }}, editSessionItem, disconnectItem,
    {text:'Close tab', action:() => { void closeSession(menuSessionId); }},
  ]});
}
document.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (document.querySelector('dialog[open]')) return;
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('[data-profile]');
  const tab = target.closest<HTMLElement>('.tab');
  void (async () => {
    if (row && connectionMenu) {
      menuProfileId = row.dataset.profile!;
      selected = menuProfileId; renderHosts();
      await connectionMenu.popup(new LogicalPosition(e.clientX, e.clientY));
    } else if (terminalMenu && (target.closest('#terminals') || tab)) {
      const id = tab?.querySelector<HTMLElement>('[data-tab]')?.dataset.tab ?? target.closest<HTMLElement>('[data-pane]')?.dataset.pane ?? active;
      const s = sessions.find(s => s.id === id); if (!s) return;
      menuSessionId = id;
      if (active !== id) activate(id);
      await copyItem.setEnabled(s.terminal.hasSelection());
      await pasteItem.setEnabled(s.status === 'Connected');
      await disconnectItem.setEnabled(s.status === 'Connected');
      await editSessionItem.setEnabled(profiles.some(p => p.id === s.profile.id));
      await terminalMenu.popup(new LogicalPosition(e.clientX, e.clientY));
    }
  })().catch(notify);
});
// Form hints also prevent suggestion UI in non-Windows webviews.
document.querySelectorAll<HTMLInputElement>('input').forEach(input => {
  input.autocomplete = input.type === 'password' ? 'new-password' : 'off';
  input.spellcheck = false; input.setAttribute('autocorrect', 'off'); input.setAttribute('autocapitalize', 'off');
});
new ResizeObserver(fitVisible).observe($('#pane-layout'));
const updateViewport = () => {
  if (platformInfo.mobile || matchMedia('(max-width: 700px)').matches) document.documentElement.style.setProperty('--app-height',`${window.visualViewport?.height ?? innerHeight}px`);
  else document.documentElement.style.removeProperty('--app-height');
};
window.visualViewport?.addEventListener('resize',updateViewport);window.addEventListener('resize',updateViewport);
document.addEventListener('pointerdown', e => {
  if (panelVisible && matchMedia('(max-width: 700px)').matches && !(e.target as HTMLElement).closest('#connections-panel, #toggle-panel')) togglePanel(false);
});
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return;
  if(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); $('#toggle-files').click(); }
  if(e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); togglePanel(true, true); }
  if(e.ctrlKey && e.key.toLowerCase() === 'b') { e.preventDefault(); togglePanel(); }
  if(e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); edit(); }
});
async function init() {
  platformInfo = await invoke('list_shells');
  document.body.classList.toggle('mobile',platformInfo.mobile); updateViewport();
  if (platformInfo.mobile || matchMedia('(max-width: 700px)').matches) togglePanel(false);
  $('#shell-select').innerHTML = platformInfo.shells.map(shell => `<option value="${esc(shell.id)}">${esc(shell.label)}</option>`).join('');
  $('#shell-help').textContent = platformInfo.os === 'android' ? 'Runs inside the app sandbox. Android shell is available; Bash appears when its runtime is packaged in the APK.' : 'Installed shells run locally in a pseudoterminal. WSL uses your default installed distribution.';
  if (platformInfo.mobile) {
    document.querySelectorAll<HTMLInputElement>('[name="remember"], #session-remember').forEach(input => { input.checked=false; input.disabled=true; });
    $('#connection-form .hint').textContent = 'Mobile currently uses session-only credentials; passwords are not saved.';
  } else { await createContextMenus(); }
  await listen<{id:string;data:number[]}>('ssh-data',({payload}) => { sessions.find(s => s.id === payload.id)?.terminal.write(new Uint8Array(payload.data)); });
  await listen<{id:string;status:string}>('ssh-status',({payload}) => { const s = sessions.find(s => s.id === payload.id); if(s) { s.status = payload.status; if(s.status === 'Connected') s.connectedAt = Date.now(); if(s.status !== 'Connected') s.terminal.writeln(`\r\n\x1b[90m${s.status}\x1b[0m`); else { fitVisible(); invoke('resize',{id:s.id,cols:s.terminal.cols,rows:s.terminal.rows}).catch(notify); } renderTabs(); renderHosts(); } });
  await reload();
}
init().catch(e => { renderHosts(); notify(`Could not open workspace: ${e}. Run with pnpm tauri dev.`); });
