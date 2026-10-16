//! Each loopback listener belongs to one preview and forwards TCP over its
//! authenticated cloud connection. HTTP and WebSocket traffic share the bridge.
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use vitre_client::EnvironmentClient;

pub(super) struct PreviewTunnel {
    pub remote_port: u16,
    local_port: u16,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for PreviewTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl PreviewTunnel {
    pub async fn open(client: Arc<EnvironmentClient>, remote_port: u16) -> anyhow::Result<Self> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let local_port = listener.local_addr()?.port();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break; };
                        let client = client.clone();
                        connections.spawn(async move { let _ = forward(client, remote_port, socket).await; });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Self {
            remote_port,
            local_port,
            task,
        })
    }
    pub fn local_url(&self, url: &str) -> anyhow::Result<String> {
        let mut url = reqwest::Url::parse(url)?;
        url.set_host(Some("127.0.0.1"))?;
        url.set_port(Some(self.local_port))
            .map_err(|_| anyhow::anyhow!("Invalid preview port"))?;
        Ok(url.to_string())
    }
    pub fn remote_url(&self, url: &str) -> Option<String> {
        let mut url = reqwest::Url::parse(url).ok()?;
        if url.host_str() != Some("127.0.0.1") || url.port() != Some(self.local_port) {
            return None;
        }
        url.set_host(Some("localhost")).ok()?;
        url.set_port(Some(self.remote_port)).ok()?;
        Some(url.to_string())
    }
}
async fn forward(
    client: Arc<EnvironmentClient>,
    port: u16,
    socket: tokio::net::TcpStream,
) -> anyhow::Result<()> {
    let session = client
        .sessions()
        .borrow()
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Cloud disconnected"))?;
    let base = reqwest::Url::parse(&session.target.base_url)?;
    anyhow::ensure!(base.scheme() == "https", "Cloud preview requires HTTPS");
    let mut url = base.join(&format!("/api/preview/tunnel/{port}"))?;
    url.set_scheme("wss")
        .map_err(|_| anyhow::anyhow!("Invalid cloud URL"))?;
    let mut request = url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", session.target.access_token).parse()?,
    );
    let (websocket, _) = tokio_tungstenite::connect_async(request).await?;
    let (mut send, mut receive) = websocket.split();
    let (mut read, mut write) = socket.into_split();
    let upload = async {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let count = read.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            send.send(Message::Binary(buffer[..count].to_vec().into()))
                .await?;
        }
        anyhow::Ok(())
    };
    let download = async {
        while let Some(message) = receive.next().await {
            match message? {
                Message::Binary(bytes) => write.write_all(&bytes).await?,
                Message::Close(_) => break,
                _ => {}
            }
        }
        anyhow::Ok(())
    };
    tokio::select! { result = upload => result, result = download => result }
}
pub(super) fn loopback_port(url: &str) -> Option<u16> {
    let url = reqwest::Url::parse(url).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return None;
    }
    url.port_or_known_default().filter(|port| *port >= 1024)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forwards_only_explicit_loopback_development_ports() {
        assert_eq!(loopback_port("http://localhost:5173/path"), Some(5173));
        assert_eq!(loopback_port("http://127.0.0.1:3000"), Some(3000));
        assert_eq!(loopback_port("https://example.com:3000"), None);
        assert_eq!(loopback_port("http://localhost"), None);
    }
}
