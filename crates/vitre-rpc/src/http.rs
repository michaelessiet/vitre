//! HTTP-side auth against the sidecar: the form-urlencoded `/oauth/token`
//! bootstrap exchange (`AuthTokenExchangeRequest` in
//! `packages/contracts/src/auth.ts`) and the `/api/auth/websocket-ticket`
//! ticket that gates `/ws`.

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;

use crate::error::RpcError;

const TOKEN_EXCHANGE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE: &str =
    "urn:t3:params:oauth:token-type:environment-bootstrap";

/// Requests carry their own authentication. Sharing only the transport lets
/// relay polling and bootstrap/ticket/snapshot calls reuse established TLS
/// connections without retaining an account's token in default headers.
pub(crate) fn pooled_client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("HTTP client configuration is valid")
        })
        .clone()
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccessToken {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: f64,
    pub scope: String,
    #[serde(default)]
    pub websocket_ticket: Option<WebSocketTicket>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WebSocketTicket {
    pub ticket: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

pub struct EnvironmentHttp {
    /// e.g. `http://127.0.0.1:3773` — always 127.0.0.1, never localhost
    /// (the server binds IPv4 only; `localhost` can resolve IPv6-first).
    pub base_url: String,
    client: reqwest::Client,
}

impl EnvironmentHttp {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            client: pooled_client(),
        }
    }

    pub(crate) fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// Exchange the sidecar bootstrap token (delivered to the server via the
    /// stdin envelope) for a bearer access token.
    pub async fn exchange_bootstrap_token(
        &self,
        bootstrap_token: &str,
    ) -> Result<AccessToken, RpcError> {
        let response = self
            .client
            .post(format!("{}/oauth/token", self.base_url))
            .form(&[
                ("grant_type", TOKEN_EXCHANGE_GRANT_TYPE),
                ("subject_token", bootstrap_token),
                ("subject_token_type", ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE),
                ("requested_token_type", ACCESS_TOKEN_TYPE),
                ("client_label", "Vitre"),
                ("client_device_type", "desktop"),
                ("include_websocket_ticket", "true"),
            ])
            .send()
            .await?;
        Ok(check(response).await?.json().await?)
    }

    /// Issue a short-lived session-bound ticket for the `/ws` handshake.
    pub async fn websocket_ticket(&self, access_token: &str) -> Result<String, RpcError> {
        let response = self
            .client
            .post(format!("{}/api/auth/websocket-ticket", self.base_url))
            .bearer_auth(access_token)
            .send()
            .await?;
        let ticket: WebSocketTicket = check(response).await?.json().await?;
        Ok(ticket.ticket)
    }

    /// Consume a ticket from this preparation once; older servers use the
    /// authenticated ticket endpoint. Reconnection prepares a fresh session.
    pub(crate) async fn initial_websocket_ticket(
        &self,
        access_token: &str,
        prepared_ticket: &mut Option<String>,
    ) -> Result<String, RpcError> {
        match prepared_ticket.take() {
            Some(ticket) => Ok(ticket),
            None => self.websocket_ticket(access_token).await,
        }
    }

    /// `ws://…/ws?wsTicket=<ticket>` for [`crate::RpcSession::connect`].
    pub fn ws_url(&self, ticket: &str) -> String {
        let ws_base = self
            .base_url
            .replacen("http://", "ws://", 1)
            .replacen("https://", "wss://", 1);
        format!(
            "{ws_base}/ws?wsTicket={}",
            utf8_percent_encode(ticket, NON_ALPHANUMERIC)
        )
    }
}

pub(crate) async fn check(response: reqwest::Response) -> Result<reqwest::Response, RpcError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    Err(RpcError::HttpStatus {
        status: status.as_u16(),
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn bootstrap_ticket_skips_the_extra_request_and_older_servers_fall_back() {
        for bundled in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(stream.read_u8().await.unwrap());
                }
                let headers = String::from_utf8(headers).unwrap().to_ascii_lowercase();
                assert!(headers.starts_with("post /oauth/token "));
                let length: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                assert!(
                    String::from_utf8(body)
                        .unwrap()
                        .contains("include_websocket_ticket=true")
                );
                let mut response = serde_json::json!({
                    "access_token": "same-session", "token_type": "Bearer", "expires_in": 3600, "scope": "orchestration:read"
                });
                let ticket =
                    serde_json::json!({"ticket":"fresh-ticket","expiresAt":"2026-10-15T00:05:00Z"});
                if bundled {
                    response["websocket_ticket"] = ticket.clone();
                }
                let body = response.to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                if !bundled {
                    let mut headers = Vec::new();
                    while !headers.ends_with(b"\r\n\r\n") {
                        headers.push(stream.read_u8().await.unwrap());
                    }
                    let headers = String::from_utf8(headers).unwrap().to_ascii_lowercase();
                    assert!(headers.starts_with("post /api/auth/websocket-ticket "));
                    assert!(headers.contains("authorization: bearer same-session\r\n"));
                    let body = ticket.to_string();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                }
            });
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                let http = EnvironmentHttp::new(origin);
                let access = http.exchange_bootstrap_token("bootstrap").await.unwrap();
                let mut prepared = access.websocket_ticket.map(|ticket| ticket.ticket);
                assert_eq!(
                    http.initial_websocket_ticket(&access.access_token, &mut prepared)
                        .await
                        .unwrap(),
                    "fresh-ticket"
                );
                assert!(prepared.is_none());
                server.await.unwrap();
            })
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn fresh_environment_handles_reuse_connection_with_request_local_auth() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            // Both requests must arrive on this single accepted connection.
            let (mut stream, _) = listener.accept().await.unwrap();
            for token in ["first-account", "second-account"] {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let byte = stream.read_u8().await.unwrap();
                    request.push(byte);
                }
                let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(request.contains(&format!("authorization: bearer {token}\r\n")));
                let body = r#"{"ticket":"ticket","expiresAt":"2026-10-15T00:05:00Z"}"#;
                stream.write_all(format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                ).as_bytes()).await.unwrap();
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            for token in ["first-account", "second-account"] {
                assert_eq!(
                    EnvironmentHttp::new(&origin)
                        .websocket_ticket(token)
                        .await
                        .unwrap(),
                    "ticket"
                );
            }
            server.await.unwrap();
        })
        .await
        .unwrap();
    }
}
