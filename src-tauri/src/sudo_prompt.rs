#[derive(Default)]
pub(crate) struct Detector {
  tail: Vec<u8>,
  used: bool,
  escape: u8,
}
impl Detector {
  pub(crate) fn user_input(&mut self, bytes: &[u8]) {
    if bytes.iter().any(|byte| matches!(byte, b'\r' | b'\n' | 3)) {
      self.used = false;
      self.tail.clear();
      self.escape = 0;
    }
  }
  pub(crate) fn feed(&mut self, bytes: &[u8], username: &str) -> bool {
    if self.used { return false; }
    for &byte in bytes {
      match (self.escape, byte) {
        (0, 0x1b) => self.escape = 1,
        (1, b'[') => self.escape = 2,
        (1, b']') => self.escape = 3,
        (1, _) => self.escape = 0,
        (2, 0x40..=0x7e) => self.escape = 0,
        (2, _) => (),
        (3, 7) => self.escape = 0,
        (3, 0x1b) => self.escape = 4,
        (3, _) => (),
        (4, b'\\') => self.escape = 0,
        (4, _) => self.escape = 3,
        (_, 8 | 127) => { self.tail.pop(); },
        _ => self.tail.push(byte),
      }
    }
    if self.tail.len() > 4096 {
      self.tail.drain(..self.tail.len() - 4096);
    }
    let text = String::from_utf8_lossy(&self.tail);
    let prompt = format!("[sudo] password for {username}:");
    let line = text.rsplit(['\n', '\r']).next().unwrap_or("").trim();
    if line == prompt {
      self.used = true;
      return true;
    }
    false
  }
}
#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn colored_prompts_and_later_commands() {
    let mut detector = Detector::default();
    assert!(!detector.feed(b"\x1b[", "me"));
    assert!(detector.feed(b"31m[sudo] password for me:\x1b[0m ", "me"));
    detector.user_input(b"sudo whoami\r");
    assert!(detector.feed(b"[sudo] password for me: ", "me"));
  }
  #[test]
  fn matches_split_prompt_once_and_only_for_current_user() {
    let mut detector = Detector::default();
    assert!(!detector.feed(b"[sudo] password for other: ", "me"));
    assert!(!detector.feed(b"\r\n[sudo] pass", "me"));
    assert!(detector.feed(b"word for me: ", "me"));
    assert!(!detector.feed(b"\r\n[sudo] password for me: ", "me"));
  }
}
