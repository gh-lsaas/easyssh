#[derive(Default)]
pub(crate) struct Detector {
  tail: Vec<u8>,
  used: bool,
}
impl Detector {
  pub(crate) fn feed(&mut self, bytes: &[u8], username: &str) -> bool {
    if self.used { return false; }
    self.tail.extend_from_slice(bytes);
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
  fn matches_split_prompt_once_and_only_for_current_user() {
    let mut detector = Detector::default();
    assert!(!detector.feed(b"[sudo] password for other: ", "me"));
    assert!(!detector.feed(b"\r\n[sudo] pass", "me"));
    assert!(detector.feed(b"word for me: ", "me"));
    assert!(!detector.feed(b"\r\n[sudo] password for me: ", "me"));
  }
}
