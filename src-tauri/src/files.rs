use super::*;
use serde_json::{json, Value};
use std::path::PathBuf;
const MAX_FILE: usize = 1024 * 1024;
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub(crate) enum FileRequest {
  List {
    path: String,
  },
  Read {
    path: String,
  },
  Write {
    path: String,
    content: String,
    revision: String,
  },
}
impl FileRequest {
  fn validate(&self) -> Result<(), String> {
    let path = match self {
      Self::List { path } | Self::Read { path } | Self::Write { path, .. } => path,
    };
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
      return Err("Invalid file path.".into());
    }
    if let Self::Write {
      content, revision, ..
    } = self
    {
      if content.len() > MAX_FILE {
        return Err("The editor supports files up to 1 MiB.".into());
      }
      if revision.len() != 64 {
        return Err("Missing file revision. Reopen the file first.".into());
      }
    }
    Ok(())
  }
}
fn hash(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}
fn document(path: String, bytes: Vec<u8>) -> Result<Value, String> {
  if bytes.len() > MAX_FILE {
    return Err("The editor supports files up to 1 MiB.".into());
  }
  if bytes.contains(&0) {
    return Err("Binary files cannot be opened in the text editor.".into());
  }
  let revision = hash(&bytes);
  let content = String::from_utf8(bytes).map_err(|_| "This file is not UTF-8 text.")?;
  Ok(json!({"path":path,"content":content,"revision":revision}))
}
fn bounded_read(reader: impl Read) -> Result<Vec<u8>, String> {
  let mut bytes = Vec::new();
  reader
    .take((MAX_FILE + 1) as u64)
    .read_to_end(&mut bytes)
    .map_err(err)?;
  if bytes.len() > MAX_FILE {
    return Err("The editor supports files up to 1 MiB.".into());
  }
  Ok(bytes)
}
#[tauri::command]
pub(crate) async fn file_request(
  state: State<'_, AppState>,
  session_id: String,
  request: FileRequest,
) -> Result<Value, String> {
  request.validate()?;
  let (tx, rx) = mpsc::channel();
  send(&state, &session_id, Action::Files(request, tx))?;
  tauri::async_runtime::spawn_blocking(move || {
    rx.recv_timeout(Duration::from_secs(35))
      .map_err(|_| "File request timed out or the session closed.".to_string())?
  })
  .await
  .map_err(err)?
}
pub(crate) fn remote_operation(session: &Session, request: FileRequest) -> Result<Value, String> {
  request.validate()?;
  let sftp = session
    .sftp()
    .map_err(|e| format!("SFTP is unavailable: {e}"))?;
  let path = match &request {
    FileRequest::List { path } | FileRequest::Read { path } | FileRequest::Write { path, .. } => {
      path
    }
  };
  let canonical = sftp.realpath(Path::new(path)).map_err(err)?;
  let display = canonical.to_str().ok_or("Path is not UTF-8.")?.to_string();
  match request {
    FileRequest::List { .. } => {
      let mut entries = Vec::new();
      for (path, stat) in sftp
        .readdir(&canonical)
        .map_err(err)?
        .into_iter()
        .take(10000)
      {
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
          if name != "." && name != ".." {
            entries.push(json!({"name":name,"path":path.to_string_lossy(),"directory":stat.is_dir(),"size":stat.size}));
          }
        }
      }
      Ok(
        json!({"path":display,"parent":canonical.parent().unwrap_or(Path::new("/")).to_string_lossy(),"entries":entries}),
      )
    }
    FileRequest::Read { .. } => {
      document(display, bounded_read(sftp.open(&canonical).map_err(err)?)?)
    }
    FileRequest::Write {
      content, revision, ..
    } => {
      let stat = sftp.stat(&canonical).map_err(err)?;
      let current = bounded_read(sftp.open(&canonical).map_err(err)?)?;
      if hash(&current) != revision {
        return Err(
          "The file changed on the server. Reopen it and merge your changes before saving.".into(),
        );
      }
      let temp = canonical
        .parent()
        .ok_or("Invalid file location.")?
        .join(format!(".eassh-{}.tmp", uuid::Uuid::new_v4()));
      let result = (|| {
        let mut file = sftp
          .open_mode(
            &temp,
            ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
            0o600,
            ssh2::OpenType::File,
          )
          .map_err(err)?;
        file.write_all(content.as_bytes()).map_err(err)?;
        file.close().map_err(err)?;
        // Preserve ownership and permission bits; do not silently replace a file
        // with different ownership if the server refuses metadata preservation.
        sftp
          .setstat(
            &temp,
            ssh2::FileStat {
              size: None,
              uid: stat.uid,
              gid: stat.gid,
              perm: stat.perm,
              atime: None,
              mtime: None,
            },
          )
          .map_err(err)?;
        // Check once more immediately before replacement. SFTP has no server-side CAS.
        if hash(&bounded_read(sftp.open(&canonical).map_err(err)?)?) != revision {
          return Err("The file changed while saving. Original was kept.".into());
        }
        sftp
          .rename(
            &temp,
            &canonical,
            Some(
              ssh2::RenameFlags::OVERWRITE | ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::NATIVE,
            ),
          )
          .map_err(|e| {
            format!("Server could not atomically replace this file; original kept: {e}")
          })?;
        document(display, content.into_bytes())
      })();
      if result.is_err() {
        let _ = sftp.unlink(&temp);
      }
      result
    }
  }
}
fn display_path(path: &Path) -> String {
  let text = path.to_string_lossy();
  if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
    format!("//{}", unc.replace('\\', "/"))
  } else {
    text.trim_start_matches(r"\\?\").replace('\\', "/")
  }
}
pub(crate) fn local_operation(home: &Path, request: FileRequest) -> Result<Value, String> {
  request.validate()?;
  let path = match &request {
    FileRequest::List { path } | FileRequest::Read { path } | FileRequest::Write { path, .. } => {
      path
    }
  };
  let path = PathBuf::from(path);
  let canonical = fs::canonicalize(if path.is_absolute() {
    path
  } else {
    home.join(path)
  })
  .map_err(err)?;
  let display = display_path(&canonical);
  match request {
    FileRequest::List { .. } => {
      let mut entries = Vec::new();
      for entry in fs::read_dir(&canonical).map_err(err)?.take(10000) {
        let entry = entry.map_err(err)?;
        let stat = entry.metadata().map_err(err)?;
        entries.push(json!({"name":entry.file_name().to_string_lossy(),"path":display_path(&entry.path()),"directory":stat.is_dir(),"size":stat.len()}));
      }
      Ok(
        json!({"path":display,"parent":display_path(canonical.parent().unwrap_or(&canonical)),"entries":entries}),
      )
    }
    FileRequest::Read { .. } => document(
      display,
      bounded_read(fs::File::open(&canonical).map_err(err)?)?,
    ),
    FileRequest::Write {
      content, revision, ..
    } => {
      if hash(&bounded_read(fs::File::open(&canonical).map_err(err)?)?) != revision {
        return Err("The file changed on disk. Reopen it before saving.".into());
      }
      let stat = fs::metadata(&canonical).map_err(err)?;
      let temp = canonical
        .parent()
        .ok_or("Invalid file location.")?
        .join(format!(".eassh-{}.tmp", uuid::Uuid::new_v4()));
      let result = (|| {
        let mut file = fs::OpenOptions::new()
          .create_new(true)
          .write(true)
          .open(&temp)
          .map_err(err)?;
        file.write_all(content.as_bytes()).map_err(err)?;
        file.sync_all().map_err(err)?;
        #[cfg(unix)]
        {
          use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
          if unsafe { libc::fchown(file.as_raw_fd(), stat.uid(), stat.gid()) } < 0 {
            return Err(err(std::io::Error::last_os_error()));
          }
        }
        fs::set_permissions(&temp, stat.permissions()).map_err(err)?;
        drop(file);
        if hash(&bounded_read(fs::File::open(&canonical).map_err(err)?)?) != revision {
          return Err("The file changed while saving. Original was kept.".into());
        }
        fs::rename(&temp, &canonical).map_err(err)?;
        document(display, content.into_bytes())
      })();
      if result.is_err() {
        let _ = fs::remove_file(temp);
      }
      result
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn rejects_binary_and_oversized_files() {
    assert!(document("x".into(), vec![0]).is_err());
    assert!(document("x".into(), vec![b'a'; MAX_FILE + 1]).is_err());
  }
  #[test]
  fn local_editor_detects_conflicts_and_saves_atomically() {
    let dir = std::env::temp_dir().join(format!("eassh-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    let path = dir.join("test.txt");
    fs::write(&path, "before\r\n").unwrap();
    let name = path.to_string_lossy().into_owned();
    let doc = local_operation(&dir, FileRequest::Read { path: name.clone() }).unwrap();
    fs::write(&path, "external").unwrap();
    assert!(local_operation(
      &dir,
      FileRequest::Write {
        path: name.clone(),
        content: "mine".into(),
        revision: doc["revision"].as_str().unwrap().into()
      }
    )
    .is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    let doc = local_operation(&dir, FileRequest::Read { path: name.clone() }).unwrap();
    local_operation(
      &dir,
      FileRequest::Write {
        path: name,
        content: "saved".into(),
        revision: doc["revision"].as_str().unwrap().into(),
      },
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "saved");
    fs::remove_file(path).unwrap();
    fs::remove_dir(dir).unwrap();
  }
}
