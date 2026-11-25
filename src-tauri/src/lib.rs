mod files;
mod local;
mod sudo_prompt;
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh2::{ExtendedData, Session};
use std::{
  collections::HashMap,
  fs,
  io::{Read, Write},
  net::{TcpStream, ToSocketAddrs},
  path::Path,
  sync::{mpsc, Mutex},
  time::Duration,
};
use tauri::{Emitter, Manager, State};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
  id: String,
  name: String,
  host: String,
  port: u16,
  username: String,
  auth: String,
  key_path: String,
  group: String,
  #[serde(default)]
  sudo_autofill: bool,
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
  profiles: Vec<Profile>,
  hosts: HashMap<String, String>,
}
struct AppState {
  store: Mutex<Store>,
  sessions: Mutex<HashMap<String, mpsc::SyncSender<Action>>>,
}
enum Action {
  Input(Vec<u8>),
  Resize(u32, u32),
  Files(
    files::FileRequest,
    mpsc::Sender<Result<serde_json::Value, String>>,
  ),
}
#[derive(Clone, Serialize)]
struct Output {
  id: String,
  data: Vec<u8>,
}
#[derive(Clone, Serialize)]
struct Status {
  id: String,
  status: String,
}
#[derive(Serialize)]
struct HostInfo {
  fingerprint: String,
  known: Option<String>,
}
fn err(e: impl std::fmt::Display) -> String {
  e.to_string()
}
#[cfg(not(mobile))]
fn entry(id: &str, kind: &str) -> Result<keyring::Entry, String> {
  keyring::Entry::new("fi.eassh.desktop", &format!("{id}:{kind}")).map_err(err)
}
#[cfg(target_os = "android")]
use keyring_core as keyring;
#[cfg(target_os = "android")]
fn entry(id: &str, kind: &str) -> Result<keyring::Entry, String> {
  // Tauri initializes ndk-context before commands and SSH workers can run.
  static STORE: std::sync::OnceLock<std::sync::Arc<keyring::CredentialStore>> = std::sync::OnceLock::new();
  let store = match STORE.get() {
    Some(store) => store.clone(),
    None => {
      let store: std::sync::Arc<keyring::CredentialStore> = android_native_keyring_store::Store::new().map_err(err)?;
      let _ = STORE.set(store.clone());
      STORE.get().cloned().unwrap_or(store)
    }
  };
  keyring::Entry::new_in_store(&store, "fi.eassh.desktop", &format!("{id}:{kind}")).map_err(err)
}
#[cfg(all(mobile, not(target_os = "android")))]
struct MobileSecret;
#[cfg(all(mobile, not(target_os = "android")))]
impl MobileSecret {
  fn get_password(&self) -> Result<String, String> {
    Err("Saved credentials are not supported on mobile yet. Use session-only credentials.".into())
  }
  fn set_password(&self, _: &str) -> Result<(), String> {
    Err("Saved credentials are not supported on mobile yet. Uncheck Save secret.".into())
  }
}
#[cfg(all(mobile, not(target_os = "android")))]
fn entry(_: &str, _: &str) -> Result<MobileSecret, String> {
  Ok(MobileSecret)
}
fn persist(app: &tauri::AppHandle, store: &Store) -> Result<(), String> {
  let dir = app.path().app_data_dir().map_err(err)?;
  fs::create_dir_all(&dir).map_err(err)?;
  let temp = dir.join("connections.tmp");
  fs::write(&temp, serde_json::to_vec_pretty(store).map_err(err)?).map_err(err)?;
  fs::rename(temp, dir.join("connections.json")).map_err(err)
}
fn profile(state: &AppState, id: &str) -> Result<Profile, String> {
  state
    .store
    .lock()
    .map_err(err)?
    .profiles
    .iter()
    .find(|p| p.id == id)
    .cloned()
    .ok_or("Connection no longer exists.".into())
}
fn handshake(p: &Profile) -> Result<(Session, String), String> {
  let addresses: Vec<_> = (p.host.as_str(), p.port)
    .to_socket_addrs()
    .map_err(err)?
    .take(8)
    .collect();
  let tcp = addresses
    .iter()
    .find_map(|a| TcpStream::connect_timeout(a, Duration::from_secs(8)).ok())
    .ok_or("Could not reach server. Check the address, port and network.")?;
  let mut session = Session::new().map_err(err)?;
  session.set_tcp_stream(tcp);
  session.set_timeout(15000);
  session.handshake().map_err(err)?;
  let (key, _) = session
    .host_key()
    .ok_or("Server did not provide a host key.")?;
  let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(key)));
  Ok((session, fingerprint))
}
#[tauri::command]
fn list_profiles(state: State<AppState>) -> Result<Vec<Profile>, String> {
  Ok(state.store.lock().map_err(err)?.profiles.clone())
}
#[cfg(any(not(mobile), target_os = "android"))]
fn stored_secret(id: &str, auth: &str) -> Result<String, String> {
  match entry(id, auth)?.get_password() {
    Ok(secret) => Ok(secret),
    Err(keyring::Error::NoEntry) => Ok(String::new()),
    Err(e) => Err(err(e)),
  }
}
#[cfg(all(mobile, not(target_os = "android")))]
fn stored_secret(_: &str, _: &str) -> Result<String, String> {
  Ok(String::new())
}
// Report existence only; secrets never leave Rust.
#[tauri::command]
async fn has_saved_secret(state: State<'_, AppState>, id: String) -> Result<bool, String> {
  let p = profile(&state, &id)?;
  tauri::async_runtime::spawn_blocking(move || stored_secret(&p.id, &p.auth).map(|s| !s.is_empty()))
    .await
    .map_err(err)?
}

#[tauri::command]
fn save_secret(state: State<AppState>, id: String, secret: String) -> Result<(), String> {
  let p = profile(&state, &id)?;
  if secret.is_empty() || secret.len() > 2400 {
    return Err("Enter a secret shorter than 2401 bytes.".into());
  }
  entry(&p.id, &p.auth)?
    .set_password(&secret)
    .map_err(|e| format!("OS credential store: {e}"))
}

#[tauri::command]
fn save_profile(
  app: tauri::AppHandle,
  state: State<AppState>,
  mut connection: Profile,
  secret: Option<String>,
  clear_secret: Option<bool>,
) -> Result<Profile, String> {
  if connection.name.trim().is_empty()
    || connection.host.trim().is_empty()
    || connection.username.trim().is_empty()
    || connection.port == 0
  {
    return Err("Name, host, username and valid port are required.".into());
  }
  if !["password", "key"].contains(&connection.auth.as_str()) {
    return Err("Invalid authentication method.".into());
  }
  if connection.auth == "key" && connection.key_path.trim().is_empty() {
    return Err("Enter a private key file path.".into());
  }
  let mut store = state.store.lock().map_err(err)?;
  if connection.id.is_empty() {
    connection.id = uuid::Uuid::new_v4().to_string();
  } else if !store.profiles.iter().any(|p| p.id == connection.id) {
    return Err("Unknown connection.".into());
  }
  if clear_secret.unwrap_or(false) {
    #[cfg(any(not(mobile), target_os = "android"))]
    match entry(&connection.id, &connection.auth)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => (),
      Err(e) => return Err(err(e)),
    }
  }
  if let Some(secret) = secret.filter(|s| !s.is_empty() && !clear_secret.unwrap_or(false)) {
    if secret.len() > 2400 {
      return Err("Secret is too long for the credential store.".into());
    }
    entry(&connection.id, &connection.auth)?
      .set_password(&secret)
      .map_err(|e| format!("OS credential store: {e}"))?;
  }
  let old = store.profiles.clone();
  store.profiles.retain(|p| p.id != connection.id);
  store.profiles.push(connection.clone());
  if let Err(e) = persist(&app, &store) {
    store.profiles = old;
    return Err(e);
  }
  Ok(connection)
}
#[tauri::command]
fn delete_profile(app: tauri::AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
  let mut store = state.store.lock().map_err(err)?;
  #[cfg(any(not(mobile), target_os = "android"))]
  for kind in ["password", "key"] {
    match entry(&id, kind)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => (),
      Err(e) => return Err(err(e)),
    }
  }
  let old = store.profiles.clone();
  store.profiles.retain(|p| p.id != id);
  if let Err(e) = persist(&app, &store) {
    store.profiles = old;
    return Err(e);
  }
  Ok(())
}
#[tauri::command]
async fn inspect_host(state: State<'_, AppState>, id: String) -> Result<HostInfo, String> {
  let p = profile(&state, &id)?;
  let known = state
    .store
    .lock()
    .map_err(err)?
    .hosts
    .get(&format!("{}:{}", p.host, p.port))
    .cloned();
  tauri::async_runtime::spawn_blocking(move || {
    let (_, fingerprint) = handshake(&p)?;
    Ok(HostInfo { fingerprint, known })
  })
  .await
  .map_err(err)?
}
#[tauri::command]
fn trust_host(
  app: tauri::AppHandle,
  state: State<AppState>,
  id: String,
  fingerprint: String,
) -> Result<(), String> {
  let p = profile(&state, &id)?;
  if !fingerprint.starts_with("SHA256:") || fingerprint.len() != 50 {
    return Err("Invalid fingerprint.".into());
  }
  let mut store = state.store.lock().map_err(err)?;
  let key = format!("{}:{}", p.host, p.port);
  if store.hosts.get(&key).is_some_and(|old| old != &fingerprint) {
    return Err("Host key changed. Connection blocked.".into());
  }
  store.hosts.insert(key.clone(), fingerprint);
  if let Err(e) = persist(&app, &store) {
    store.hosts.remove(&key);
    return Err(e);
  }
  Ok(())
}
#[tauri::command]
fn connect(
  app: tauri::AppHandle,
  state: State<AppState>,
  id: String,
  session_id: String,
  cols: u32,
  rows: u32,
  secret: Option<String>,
) -> Result<(), String> {
  if session_id.len() > 80 {
    return Err("Invalid session ID.".into());
  }
  let p = profile(&state, &id)?;
  let expected = state
    .store
    .lock()
    .map_err(err)?
    .hosts
    .get(&format!("{}:{}", p.host, p.port))
    .cloned()
    .ok_or("Verify the host fingerprint first.")?;
  let (tx, rx) = mpsc::sync_channel(256);
  let mut sessions = state.sessions.lock().map_err(err)?;
  if sessions.len() >= 16 || sessions.contains_key(&session_id) {
    return Err("Session limit reached or duplicate ID.".into());
  }
  sessions.insert(session_id.clone(), tx);
  std::thread::spawn(move || {
    let result = run_session(&app, &p, &session_id, &expected, cols, rows, secret, rx);
    let status = match result {
      Ok(()) => "Disconnected".into(),
      Err(e) => format!("Error: {e}"),
    };
    let _ = app.emit(
      "ssh-status",
      Status {
        id: session_id.clone(),
        status,
      },
    );
    let state = app.state::<AppState>();
    let _ = state
      .sessions
      .lock()
      .map(|mut sessions| sessions.remove(&session_id));
  });
  Ok(())
}
fn run_session(
  app: &tauri::AppHandle,
  p: &Profile,
  id: &str,
  expected: &str,
  cols: u32,
  rows: u32,
  secret: Option<String>,
  rx: mpsc::Receiver<Action>,
) -> Result<(), String> {
  let (session, fingerprint) = handshake(p)?;
  if fingerprint != expected {
    return Err("Host key changed. Authentication blocked.".into());
  }
  let secret = match secret.filter(|s| !s.is_empty()) {
    Some(s) => s,
    None => stored_secret(&p.id, &p.auth)?,
  };
  if p.auth == "key" {
    session
      .userauth_pubkey_file(
        &p.username,
        None,
        Path::new(&p.key_path),
        if secret.is_empty() {
          None
        } else {
          Some(&secret)
        },
      )
      .map_err(err)?;
  } else {
    session
      .userauth_password(&p.username, &secret)
      .map_err(err)?;
  }
  if !session.authenticated() {
    return Err("Authentication failed.".into());
  }
  let mut channel = session.channel_session().map_err(err)?;
  channel
    .handle_extended_data(ExtendedData::Merge)
    .map_err(err)?;
  channel
    .request_pty(
      "xterm-256color",
      None,
      Some((cols.clamp(2, 500), rows.clamp(2, 300), 0, 0)),
    )
    .map_err(err)?;
  channel.shell().map_err(err)?;
  session.set_blocking(false);
  let _ = app.emit(
    "ssh-status",
    Status {
      id: id.into(),
      status: "Connected".into(),
    },
  );
  let mut sudo_prompt = sudo_prompt::Detector::default();
  let mut pending = Vec::new();
  let mut offset = 0;
  let mut size = None;
  let mut buf = [0u8; 32768];
  loop {
    for _ in 0..64 {
      match rx.try_recv() {
        Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
        Ok(Action::Input(bytes)) => {
          sudo_prompt.user_input(&bytes);
          if pending.len() + bytes.len() > 4 * 1024 * 1024 {
            return Err("Input buffer exceeded.".into());
          }
          pending.extend(bytes);
        }
        Ok(Action::Resize(c, r)) => size = Some((c, r)),
        Ok(Action::Files(request, reply)) => {
          session.set_blocking(true);
          let result = files::remote_operation(&session, request);
          session.set_blocking(false);
          let _ = reply.send(result);
        }
        Err(mpsc::TryRecvError::Empty) => break,
      }
    }
    if let Some((c, r)) = size {
      match channel.request_pty_size(c, r, None, None) {
        Ok(()) => size = None,
        Err(e) if e.code() == ssh2::ErrorCode::Session(-37) => (),
        Err(e) => return Err(err(e)),
      }
    }
    if offset < pending.len() {
      match channel.write(&pending[offset..]) {
        Ok(n) => offset += n,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
        Err(e) => return Err(err(e)),
      }
      if offset == pending.len() {
        pending.clear();
        offset = 0;
      }
    }
    for _ in 0..16 {
      match channel.read(&mut buf) {
        Ok(0) => break,
        Ok(n) => {
          if p.sudo_autofill && p.auth == "password" && !secret.is_empty()
            && !secret.contains(['\r', '\n']) && pending.is_empty()
            && sudo_prompt.feed(&buf[..n], &p.username) {
            pending.extend_from_slice(secret.as_bytes());
            pending.push(b'\n');
          }
          app
            .emit(
              "ssh-data",
              Output {
                id: id.into(),
                data: buf[..n].to_vec(),
              },
            )
            .map_err(err)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
        Err(e) => return Err(err(e)),
      }
    }
    if channel.eof() {
      return Ok(());
    }
    std::thread::sleep(Duration::from_millis(8));
  }
}
#[tauri::command]
fn input(state: State<AppState>, id: String, data: String) -> Result<(), String> {
  if data.len() > 65536 {
    return Err("Paste too large.".into());
  }
  send(&state, &id, Action::Input(data.into_bytes()))
}
fn send(state: &AppState, id: &str, action: Action) -> Result<(), String> {
  state
    .sessions
    .lock()
    .map_err(err)?
    .get(id)
    .ok_or("Session is closed.")?
    .try_send(action)
    .map_err(err)
}
#[tauri::command]
fn resize(state: State<AppState>, id: String, cols: u32, rows: u32) -> Result<(), String> {
  send(
    &state,
    &id,
    Action::Resize(cols.clamp(2, 500), rows.clamp(2, 300)),
  )
}
#[tauri::command]
fn disconnect(state: State<AppState>, id: String) -> Result<(), String> {
  state.sessions.lock().map_err(err)?.remove(&id);
  Ok(())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
      let path = app.path().app_data_dir()?.join("connections.json");
      let store = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Store::default(),
        Err(e) => return Err(e.into()),
      };
      #[cfg(windows)]
      if let Some(window) = app.get_webview_window("main") {
        window.with_webview(|webview| {
          use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
          use windows::core::Interface;
          // Must run on the WebView UI thread. Keep OS credential storage separate
          // from the browser's autofill/password manager.
          let result = (|| -> windows::core::Result<()> {
            unsafe {
              let settings = webview.controller().CoreWebView2()?.Settings()?;
              settings.SetAreDefaultContextMenusEnabled(false)?;
              let settings4: ICoreWebView2Settings4 = settings.cast()?;
              settings4.SetIsGeneralAutofillEnabled(false)?;
              settings4.SetIsPasswordAutosaveEnabled(false)?;
            }
            Ok(())
          })();
          if let Err(error) = result {
            eprintln!("Could not configure WebView preferences: {error}");
          }
        })?;
      }
      app.manage(AppState {
        store: Mutex::new(store),
        sessions: Mutex::new(HashMap::new()),
      });
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      local::list_shells,
      local::connect_local,
      files::file_request,
      list_profiles,
      has_saved_secret,
      save_secret,
      save_profile,
      delete_profile,
      inspect_host,
      trust_host,
      connect,
      input,
      resize,
      disconnect
    ])
    .run(tauri::generate_context!())
    .expect("Unable to start easyssh");
}
