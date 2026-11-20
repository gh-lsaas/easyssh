use super::*;
use std::{fs::File, path::PathBuf};

#[derive(Clone, Serialize)]
pub(crate) struct Shell {
  id: String,
  label: String,
  #[serde(skip)]
  program: PathBuf,
  #[serde(skip)]
  args: Vec<String>,
}
fn shells() -> Vec<Shell> {
  let mut list = Vec::new();
  let mut add = |id: &str, label: &str, path: PathBuf, args: &[&str]| {
    if path.is_file() {
      list.push(Shell {
        id: id.into(),
        label: label.into(),
        program: path,
        args: args.iter().map(|s| s.to_string()).collect(),
      });
    }
  };
  #[cfg(windows)]
  {
    let root = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or("C:\\Windows".into()));
    if let Some(programs) = std::env::var_os("ProgramFiles") {
      add(
        "pwsh",
        "PowerShell 7",
        PathBuf::from(programs).join("PowerShell/7/pwsh.exe"),
        &["-NoLogo"],
      );
    }
    add(
      "powershell",
      "Windows PowerShell",
      root.join("System32/WindowsPowerShell/v1.0/powershell.exe"),
      &["-NoLogo"],
    );
    add("cmd", "Command Prompt", root.join("System32/cmd.exe"), &[]);
    add(
      "wsl",
      "WSL (default distribution)",
      root.join("System32/wsl.exe"),
      &["--cd", "~"],
    );
  }
  #[cfg(all(unix, not(target_os = "android")))]
  {
    if let Some(shell) = std::env::var_os("SHELL") {
      add("default", "Default shell", PathBuf::from(shell), &["-l"]);
    }
    for (id, label, path) in [
      ("bash", "Bash", "/bin/bash"),
      ("fish", "Fish", "/usr/bin/fish"),
      ("zsh", "Zsh", "/bin/zsh"),
      ("sh", "POSIX shell", "/bin/sh"),
    ] {
      add(id, label, PathBuf::from(path), &["-l"]);
    }
  }
  #[cfg(target_os = "android")]
  {
    add(
      "android-sh",
      "Android shell",
      PathBuf::from("/system/bin/sh"),
      &[],
    );
    // Executable runtime code must be shipped in the APK's native library directory.
    unsafe {
      let mut info: libc::Dl_info = std::mem::zeroed();
      if libc::dladdr(shells as *const () as *const libc::c_void, &mut info) != 0
        && !info.dli_fname.is_null()
      {
        let library = std::ffi::CStr::from_ptr(info.dli_fname).to_string_lossy();
        if let Some(dir) = Path::new(library.as_ref()).parent() {
          add(
            "android-bash",
            "Bash (bundled runtime)",
            dir.join("libbash.so"),
            &["--noprofile", "--norc", "-i"],
          );
        }
      }
    }
  }
  list
}
pub(crate) fn home(app: &tauri::AppHandle) -> PathBuf {
  #[cfg(mobile)]
  {
    app
      .path()
      .app_data_dir()
      .unwrap_or_else(|_| PathBuf::from("."))
      .join("home")
  }
  #[cfg(not(mobile))]
  {
    let _ = app;
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
      .map(PathBuf::from)
      .unwrap_or_else(|| PathBuf::from("."))
  }
}
#[tauri::command]
pub(crate) fn list_shells() -> serde_json::Value {
  serde_json::json!({"os":std::env::consts::OS,"mobile":cfg!(mobile),"shells":shells()})
}
#[tauri::command]
pub(crate) fn connect_local(
  app: tauri::AppHandle,
  state: State<AppState>,
  shell_id: String,
  session_id: String,
  cols: u32,
  rows: u32,
) -> Result<(), String> {
  let shell = shells()
    .into_iter()
    .find(|s| s.id == shell_id)
    .ok_or("This shell is not installed.")?;
  if session_id.len() > 80 {
    return Err("Invalid session ID.".into());
  }
  let (tx, rx) = mpsc::sync_channel(256);
  let mut sessions = state.sessions.lock().map_err(err)?;
  if sessions.len() >= 16 || sessions.contains_key(&session_id) {
    return Err("Session limit reached or duplicate ID.".into());
  }
  sessions.insert(session_id.clone(), tx);
  std::thread::spawn(move || {
    let result = run(&app, &session_id, shell, cols, rows, rx);
    let _ = app.emit(
      "ssh-status",
      Status {
        id: session_id.clone(),
        status: result
          .err()
          .map(|e| format!("Error: {e}"))
          .unwrap_or("Disconnected".into()),
      },
    );
    let state = app.state::<AppState>();
    let _ = state.sessions.lock().map(|mut map| map.remove(&session_id));
  });
  Ok(())
}
fn run(
  app: &tauri::AppHandle,
  id: &str,
  shell: Shell,
  cols: u32,
  rows: u32,
  rx: mpsc::Receiver<Action>,
) -> Result<(), String> {
  let home = home(app);
  fs::create_dir_all(&home).map_err(err)?;
  let (mut process, mut reader, mut writer) = platform::spawn(&shell, cols, rows, &home)?;
  let reader_app = app.clone();
  let reader_id = id.to_string();
  std::thread::spawn(move || {
    let mut bytes = [0u8; 16384];
    loop {
      match reader.read(&mut bytes) {
        Ok(0) | Err(_) => break,
        Ok(n) => {
          if reader_app
            .emit(
              "ssh-data",
              Output {
                id: reader_id.clone(),
                data: bytes[..n].to_vec(),
              },
            )
            .is_err()
          {
            break;
          }
        }
      }
    }
  });
  app
    .emit(
      "ssh-status",
      Status {
        id: id.into(),
        status: "Connected".into(),
      },
    )
    .map_err(err)?;
  loop {
    if process.exited()? {
      break;
    }
    match rx.recv_timeout(Duration::from_millis(25)) {
      Ok(Action::Input(bytes)) => {
        writer.write_all(&bytes).map_err(err)?;
        writer.flush().map_err(err)?;
      }
      Ok(Action::Resize(c, r)) => process.resize(c, r)?,
      Ok(Action::Files(request, reply)) => {
        let _ = reply.send(files::local_operation(&home, request));
      }
      Err(mpsc::RecvTimeoutError::Disconnected) => break,
      Err(mpsc::RecvTimeoutError::Timeout) => (),
    }
  }
  Ok(())
}

#[cfg(windows)]
mod platform {
  use super::*;
  use std::os::windows::io::{AsRawHandle, FromRawHandle};
  use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
      Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
      System::{Console::*, Pipes::CreatePipe, Threading::*},
    },
  };
  pub(super) struct Process {
    console: HPCON,
    process: HANDLE,
  }
  impl Drop for Process {
    fn drop(&mut self) {
      unsafe {
        let _ = TerminateProcess(self.process, 0);
        ClosePseudoConsole(self.console);
        let _ = CloseHandle(self.process);
      }
    }
  }
  impl Process {
    pub(super) fn exited(&mut self) -> Result<bool, String> {
      Ok(unsafe { WaitForSingleObject(self.process, 0) == WAIT_OBJECT_0 })
    }
    pub(super) fn resize(&self, c: u32, r: u32) -> Result<(), String> {
      unsafe {
        ResizePseudoConsole(
          self.console,
          COORD {
            X: c.clamp(2, 500) as i16,
            Y: r.clamp(2, 300) as i16,
          },
        )
        .map_err(err)
      }
    }
  }
  fn pipe() -> Result<(File, File), String> {
    unsafe {
      let mut r = HANDLE::default();
      let mut w = HANDLE::default();
      CreatePipe(&mut r, &mut w, None, 0).map_err(err)?;
      Ok((File::from_raw_handle(r.0), File::from_raw_handle(w.0)))
    }
  }
  struct Attributes {
    _buffer: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
  }
  impl Drop for Attributes {
    fn drop(&mut self) {
      unsafe {
        DeleteProcThreadAttributeList(self.list);
      }
    }
  }
  pub(super) fn spawn(
    shell: &Shell,
    c: u32,
    r: u32,
    home: &Path,
  ) -> Result<(Process, File, File), String> {
    unsafe {
      let (input, writer) = pipe()?;
      let (reader, output) = pipe()?;
      let console = CreatePseudoConsole(
        COORD {
          X: c.clamp(2, 500) as i16,
          Y: r.clamp(2, 300) as i16,
        },
        HANDLE(input.as_raw_handle()),
        HANDLE(output.as_raw_handle()),
        0,
      )
      .map_err(err)?;
      let mut process = Process {
        console,
        process: HANDLE::default(),
      };
      let mut size = 0;
      let _ = InitializeProcThreadAttributeList(None, 1, None, &mut size);
      let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
      let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr().cast());
      InitializeProcThreadAttributeList(Some(list), 1, None, &mut size).map_err(err)?;
      let attributes = Attributes {
        _buffer: buffer,
        list,
      };
      UpdateProcThreadAttribute(
        list,
        0,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
        Some(console.0 as *const _),
        std::mem::size_of::<HPCON>(),
        None,
        None,
      )
      .map_err(err)?;
      let mut startup = STARTUPINFOEXW::default();
      startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
      // Prevent redirected stdio from the parent build/GUI process leaking into
      // the child instead of the attached pseudoconsole.
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      startup.lpAttributeList = list;
      let native_program = shell.program.to_string_lossy().replace('/', "\\");
      let program: Vec<u16> = native_program.encode_utf16().chain(Some(0)).collect();
      let command = format!("\"{}\" {}", native_program, shell.args.join(" "));
      let mut command: Vec<u16> = command.encode_utf16().chain(Some(0)).collect();
      let cwd: Vec<u16> = home
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
      let mut info = PROCESS_INFORMATION::default();
      CreateProcessW(
        PCWSTR(program.as_ptr()),
        Some(PWSTR(command.as_mut_ptr())),
        None,
        None,
        false,
        EXTENDED_STARTUPINFO_PRESENT,
        None,
        PCWSTR(cwd.as_ptr()),
        &startup.StartupInfo,
        &mut info,
      )
      .map_err(err)?;
      process.process = info.hProcess;
      let _ = CloseHandle(info.hThread);
      drop(attributes);
      drop(input);
      drop(output);
      Ok((process, reader, writer))
    }
  }
}
#[cfg(unix)]
mod platform {
  use super::*;
  use std::{
    os::{
      fd::{AsRawFd, FromRawFd},
      unix::process::CommandExt,
    },
    process::{Child, Command, Stdio},
  };
  pub(super) struct Process {
    child: Child,
    master: File,
  }
  impl Drop for Process {
    fn drop(&mut self) {
      unsafe {
        libc::kill(-(self.child.id() as i32), libc::SIGHUP);
      }
      let _ = self.child.kill();
      let _ = self.child.wait();
    }
  }
  impl Process {
    pub(super) fn exited(&mut self) -> Result<bool, String> {
      self.child.try_wait().map(|s| s.is_some()).map_err(err)
    }
    pub(super) fn resize(&self, c: u32, r: u32) -> Result<(), String> {
      let size = libc::winsize {
        ws_row: r.clamp(2, 300) as u16,
        ws_col: c.clamp(2, 500) as u16,
        ws_xpixel: 0,
        ws_ypixel: 0,
      };
      if unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
        Err(err(std::io::Error::last_os_error()))
      } else {
        Ok(())
      }
    }
  }
  pub(super) fn spawn(
    shell: &Shell,
    c: u32,
    r: u32,
    home: &Path,
  ) -> Result<(Process, File, File), String> {
    unsafe {
      let (mut master, mut slave) = (-1, -1);
      let size = libc::winsize {
        ws_row: r.clamp(2, 300) as u16,
        ws_col: c.clamp(2, 500) as u16,
        ws_xpixel: 0,
        ws_ypixel: 0,
      };
      if libc::openpty(
        &mut master,
        &mut slave,
        std::ptr::null_mut(),
        std::ptr::null(),
        &size,
      ) < 0
      {
        return Err(err(std::io::Error::last_os_error()));
      }
      let master = File::from_raw_fd(master);
      let slave = File::from_raw_fd(slave);
      let mut cmd = Command::new(&shell.program);
      cmd
        .args(&shell.args)
        .current_dir(home)
        .env("TERM", "xterm-256color")
        .env("HOME", home)
        .stdin(Stdio::from(slave.try_clone().map_err(err)?))
        .stdout(Stdio::from(slave.try_clone().map_err(err)?))
        .stderr(Stdio::from(slave));
      cmd.pre_exec(|| {
        if libc::setsid() < 0 {
          return Err(std::io::Error::last_os_error());
        }
        if libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
          return Err(std::io::Error::last_os_error());
        }
        Ok(())
      });
      let child = cmd.spawn().map_err(err)?;
      let reader = master.try_clone().map_err(err)?;
      let writer = master.try_clone().map_err(err)?;
      Ok((Process { child, master }, reader, writer))
    }
  }
}
#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn native_shell_has_a_real_pty_and_returns_output() {
    #[cfg(windows)]
    let shell = Shell {
      id: "test".into(),
      label: "test".into(),
      program: PathBuf::from(std::env::var_os("SystemRoot").unwrap_or("C:\\Windows".into()))
        .join("System32/cmd.exe"),
      args: vec!["/D".into(), "/Q".into()],
    };
    #[cfg(unix)]
    let shell = Shell {
      id: "test".into(),
      label: "test".into(),
      program: PathBuf::from("/bin/sh"),
      args: vec!["-i".into()],
    };
    let (mut process, mut reader, mut writer) =
      platform::spawn(&shell, 80, 24, &std::env::temp_dir()).unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
      let mut bytes = Vec::new();
      let _ = reader.read_to_end(&mut bytes);
      let _ = tx.send(bytes);
    });
    process.resize(100, 32).unwrap();
    writer
      .write_all(b"echo eassh-pty-test\r\nexit\r\n")
      .unwrap();
    writer.flush().unwrap();
    let start = std::time::Instant::now();
    while !process.exited().unwrap() && start.elapsed() < Duration::from_secs(5) {
      std::thread::sleep(Duration::from_millis(20));
    }
    drop(process);
    drop(writer);
    let bytes = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
      String::from_utf8_lossy(&bytes).contains("eassh-pty-test"),
      "PTY output was {:?}",
      String::from_utf8_lossy(&bytes)
    );
  }
}
