use super::*;
use serde_json::{json, Value};
use std::sync::Arc;
#[derive(Clone, Serialize)]
pub struct Request { id: String, tool: String, arguments: Value, expires: u64 }
struct Inner { pending: Vec<Request>, replies: HashMap<String,mpsc::SyncSender<Value>> }
pub struct Bridge { inner: Arc<Mutex<Inner>>, enabled: Arc<std::sync::atomic::AtomicU64> }
impl Default for Bridge {
  fn default() -> Self { Self { inner:Arc::new(Mutex::new(Inner {pending:vec![],replies:HashMap::new()})),enabled:Arc::new(std::sync::atomic::AtomicU64::new(0)) } }
}
#[tauri::command]
pub fn bridge_enable(state: State<Bridge>, enabled: bool) -> Result<Option<String>,String> {
  use std::sync::atomic::Ordering;
  let generation=state.enabled.fetch_add(1,Ordering::SeqCst)+1;
  { let mut inner=state.inner.lock().map_err(err)?; inner.pending.clear(); inner.replies.clear(); }
  if !enabled { return Ok(None); }
  let server=tiny_http::Server::http("127.0.0.1:0").map_err(err)?;
  let address=server.server_addr().to_ip().ok_or("No local address")?;
  let token=uuid::Uuid::new_v4().to_string();
  let config=json!({"url":format!("http://{address}"),"token":token});
  let inner=state.inner.clone();
  let active=state.enabled.clone();

  std::thread::spawn(move || {
    while active.load(Ordering::SeqCst)==generation {
      let Ok(Some(mut request))=server.recv_timeout(Duration::from_millis(200)) else {continue};
      let authorized=request.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str()==format!("Bearer {token}"));
      if !authorized || request.method()!=&tiny_http::Method::Post || request.url()!="/" || request.body_length().unwrap_or(0)>65536 {
        let _=request.respond(tiny_http::Response::empty(403)); continue;
      }
      let mut body=String::new();
      if request.as_reader().take(65537).read_to_string(&mut body).is_err() || body.len()>65536 { let _=request.respond(tiny_http::Response::empty(400));continue; }
      let Ok(value)=serde_json::from_str::<Value>(&body) else {let _=request.respond(tiny_http::Response::empty(400));continue;};
      let tool=value["tool"].as_str().unwrap_or("").to_string();
      if !["list_connections","list_sessions","read_terminal","open_connection","type_terminal"].contains(&tool.as_str()) {let _=request.respond(tiny_http::Response::empty(400));continue;}
      let id=uuid::Uuid::new_v4().to_string(); let (tx,rx)=mpsc::sync_channel(1);
      if let Ok(mut state)=inner.lock() {state.replies.insert(id.clone(),tx);state.pending.push(Request{id:id.clone(),tool,arguments:value["arguments"].clone(),expires:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 + 85000});}
      let result=rx.recv_timeout(Duration::from_secs(90)).unwrap_or(json!({"error":"Approval timed out or bridge disabled"}));
      if let Ok(mut state)=inner.lock(){state.replies.remove(&id);state.pending.retain(|r|r.id!=id);}
      let _=request.respond(tiny_http::Response::from_string(result.to_string()));
    }
  });
  Ok(Some(config.to_string()))
}
#[tauri::command]
pub fn bridge_poll(state: State<Bridge>) -> Result<Vec<Request>,String> { Ok(std::mem::take(&mut state.inner.lock().map_err(err)?.pending)) }
#[tauri::command]
pub fn bridge_reply(state: State<Bridge>, id:String, result:Value) -> Result<(),String> {
  if let Some(tx)=state.inner.lock().map_err(err)?.replies.remove(&id) { let _=tx.send(result); } Ok(())
}
