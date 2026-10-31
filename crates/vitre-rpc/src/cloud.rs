//! Personal cloud control transport. Model/Daytona credentials are never needed
//! to discover a remote environment. Callers supply their current Clerk token.
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use vitre_contracts::{CloudCommand, CloudConnection, CloudOverview, CloudSavedResult};

use crate::{EnvironmentHttp, PreparedTarget, RpcError};

/// Opt-in connection diagnostics. Only opaque task/attempt IDs and timings are
/// accepted so endpoint URLs and authentication material never enter the log.
pub fn trace_connection_phase(
    event: &'static str,
    task_id: Option<&str>,
    attempt_id: Option<u64>,
    elapsed: std::time::Duration,
) {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ENABLED.get_or_init(|| {
        std::env::var("VITRE_CLOUD_TIMING")
            .is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "on"))
    }) {
        return;
    }
    let epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    eprintln!(
        "[vitre-cloud-timing] epoch_ms={epoch_ms} task_id={} attempt_id={} event={event} elapsed_ms={}",
        task_id.unwrap_or("-"),
        attempt_id.map_or_else(|| "-".into(), |id| id.to_string()),
        elapsed.as_millis(),
    );
}

#[derive(Clone)]
pub struct CloudHttp {
    origin: Url,
    client: Client,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub entity_id: String,
    pub overview: CloudOverview,
}

pub fn https_origin(value: &str) -> Result<Url, RpcError> {
    let url = Url::parse(value).map_err(|_| RpcError::Transport("Invalid cloud origin".into()))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(RpcError::Transport(
            "Cloud connections require an HTTPS origin".into(),
        ));
    }
    Ok(url)
}

fn task_path(id: &str, suffix: &str) -> Result<String, RpcError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(RpcError::Transport("Invalid cloud task ID".into()));
    }
    Ok(format!("/tasks/{id}/{suffix}"))
}

fn cloud_error_detail(status: u16, body: &[u8]) -> String {
    // Only display known application error codes. A proxy response can contain
    // arbitrary data, including request details that must not reach the UI.
    if status == 503
        && body
            .windows(b"Worker exceeded resource limits".len())
            .any(|part| part == b"Worker exceeded resource limits")
        && body.windows(b"1102".len()).any(|part| part == b"1102")
    {
        return "The Vitre cloud service exceeded its Cloudflare Worker resource limit. Check the Worker plan and metrics.".into();
    }
    let code = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("code")?.as_str().map(str::to_owned));
    match (status, code.as_deref()) {
        (_, Some("lens_unavailable")) => "Lens is already reviewing, or its selected AI account is unavailable. Wait for the current review or check your model and account connection.".into(),
        (_, Some("invalid_schedule")) => "Choose a valid IANA time zone, such as Africa/Lagos.".into(),
        (_, Some("revision_conflict")) => "Settings changed on another device. Dismiss this error, review the latest settings, and save again.".into(),
        (_, Some("budget_exhausted")) => "Your cloud compute allowance cannot cover this review.".into(),
        (409, Some("provider_busy")) =>
            "The provider account is still stopping its previous worker. Refresh and retry shortly.".into(),
        (409, Some("workers_busy")) => "Both cloud workers are busy. Retry when one stops.".into(),
        (409, Some("concurrent_update")) => "Cloud state changed during the request. Refresh and retry.".into(),
        (503, Some("disabled")) => "Cloud execution is disabled on this deployment.".into(),
        (503, Some("queue_unavailable")) =>
            "The task was saved, but cloud scheduling is temporarily unavailable. Refresh to check its status.".into(),
        (503, Some("persistence_unavailable")) =>
            "The cloud database is temporarily unavailable. Retry shortly.".into(),
        _ => "Cloud request failed; reload task status or reconnect your account".into(),
    }
}

impl CloudHttp {
    pub async fn lens(&self, bearer: &str) -> Result<vitre_contracts::LensOverview, RpcError> {
        self.request(bearer, Method::GET, "/lens", None::<&()>)
            .await
    }
    pub async fn lens_command(
        &self,
        bearer: &str,
        command: &vitre_contracts::LensCommand,
    ) -> Result<vitre_contracts::LensOverview, RpcError> {
        self.request(bearer, Method::POST, "/lens/commands", Some(command))
            .await
    }

    pub async fn repositories(
        &self,
        bearer: &str,
    ) -> Result<Vec<vitre_contracts::CloudRepository>, RpcError> {
        self.request(bearer, Method::GET, "/repositories/available", None::<&()>)
            .await
    }
    pub async fn start_login(
        &self,
        bearer: &str,
        key: &str,
    ) -> Result<serde_json::Value, RpcError> {
        self.request(
            bearer,
            Method::POST,
            "/provider-login",
            Some(&serde_json::json!({"idempotencyKey":key})),
        )
        .await
    }
    pub async fn login_status(
        &self,
        bearer: &str,
        id: &str,
    ) -> Result<vitre_contracts::CloudLoginStatus, RpcError> {
        task_path(id, "")?;
        self.request(
            bearer,
            Method::GET,
            &format!("/provider-login/{id}"),
            None::<&()>,
        )
        .await
    }
    pub async fn events(
        &self,
        bearer: &str,
        id: &str,
        after: u64,
    ) -> Result<vitre_contracts::CloudTaskFeed, RpcError> {
        self.request(
            bearer,
            Method::GET,
            &format!("{}?after={after}", task_path(id, "events")?),
            None::<&()>,
        )
        .await
    }
    pub async fn save_credential(
        &self,
        bearer: &str,
        provider: &str,
        credential: &str,
        version: u64,
        key: &str,
    ) -> Result<(), RpcError> {
        let _: serde_json::Value = self.request(bearer, Method::POST, "/provider-credentials", Some(&serde_json::json!({"provider":provider,"credential":credential,"expectedVersion":version,"idempotencyKey":key}))).await?;
        Ok(())
    }
    pub fn new(origin: &str) -> Result<Self, RpcError> {
        Ok(Self {
            origin: https_origin(origin)?,
            client: crate::http::pooled_client(),
        })
    }

    async fn request<T: DeserializeOwned>(
        &self,
        bearer: &str,
        method: Method,
        path: &str,
        body: Option<&impl Serialize>,
    ) -> Result<T, RpcError> {
        if bearer.is_empty() {
            return Err(RpcError::Transport(
                "Sign into your cloud deployment".into(),
            ));
        }
        let url = self
            .origin
            .join(&format!("v1/cloud{path}"))
            .map_err(|_| RpcError::Transport("Invalid cloud path".into()))?;
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(bearer)
            .header("Cache-Control", "no-store");
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.bytes().await.unwrap_or_default();
            return Err(RpcError::HttpStatus {
                status,
                body: cloud_error_detail(status, &body),
            });
        }
        Ok(response.json().await?)
    }

    pub async fn overview(&self, bearer: &str) -> Result<CloudOverview, RpcError> {
        self.request(bearer, Method::GET, "", None::<&()>).await
    }

    pub async fn command(
        &self,
        bearer: &str,
        command: &CloudCommand,
    ) -> Result<CommandResult, RpcError> {
        self.request(bearer, Method::POST, "/commands", Some(command))
            .await
    }

    pub async fn result(&self, bearer: &str, task_id: &str) -> Result<CloudSavedResult, RpcError> {
        self.request(
            bearer,
            Method::GET,
            &task_path(task_id, "result")?,
            None::<&()>,
        )
        .await
    }

    pub async fn connection(
        &self,
        bearer: &str,
        task_id: &str,
    ) -> Result<CloudConnection, RpcError> {
        let result: CloudConnection = self
            .request(
                bearer,
                Method::GET,
                &task_path(task_id, "connection")?,
                None::<&()>,
            )
            .await?;
        https_origin(&result.http_base_url.0)?;
        Ok(result)
    }

    /// Run for every reconnect so stopped/replaced environments resolve afresh.
    pub async fn prepare_environment(
        &self,
        bearer: &str,
        task_id: &str,
    ) -> Result<PreparedTarget, RpcError> {
        let started = std::time::Instant::now();
        trace_connection_phase(
            "relay_connection_start",
            Some(task_id),
            None,
            started.elapsed(),
        );
        let connection = self.connection(bearer, task_id).await?;
        trace_connection_phase(
            "relay_connection_ready",
            Some(task_id),
            None,
            started.elapsed(),
        );
        let base_url = connection.http_base_url.0.trim_end_matches('/').to_owned();
        let http = EnvironmentHttp::new(base_url.clone());
        let started = std::time::Instant::now();
        let access = http
            .exchange_bootstrap_token(&connection.bootstrap_token)
            .await?;
        trace_connection_phase(
            "bootstrap_exchanged",
            Some(task_id),
            None,
            started.elapsed(),
        );
        Ok(PreparedTarget {
            base_url,
            access_token: access.access_token,
            initial_websocket_ticket: access.websocket_ticket.map(|ticket| ticket.ticket),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_targets_cannot_resolve_to_local_paths_or_insecure_endpoints() {
        for origin in [
            "http://localhost:3773",
            "file:///tmp/repo",
            "https://token@example.com",
            "https://example.com/path",
            "https://example.com?token=secret",
        ] {
            assert!(https_origin(origin).is_err(), "{origin}");
        }
        assert!(https_origin("https://vitre.example.com").is_ok());
        assert!(task_path("../local", "connection").is_err());
        assert_eq!(
            task_path("cloud-task_1", "connection").unwrap(),
            "/tasks/cloud-task_1/connection"
        );
    }

    #[test]
    fn cloud_errors_show_only_known_safe_details() {
        assert!(
            cloud_error_detail(503, br#"{"code":"queue_unavailable"}"#).contains("task was saved")
        );
        assert!(cloud_error_detail(409, br#"{"code":"provider_busy"}"#).contains("still stopping"));
        assert!(
            !cloud_error_detail(503, br#"{"code":"unknown","message":"secret-token"}"#)
                .contains("secret-token")
        );
        assert!(!cloud_error_detail(503, b"secret-token").contains("secret-token"));
        assert!(
            cloud_error_detail(
                503,
                b"<title>Worker exceeded resource limits</title> Error 1102"
            )
            .contains("Cloudflare Worker resource limit")
        );
    }
}

/// Explicit debug-only fixture. The fixed loopback endpoint receives no account credentials.
#[cfg(debug_assertions)]
pub async fn lens_preview(
    command: Option<&vitre_contracts::LensCommand>,
) -> Result<vitre_contracts::LensOverview, RpcError> {
    let client = reqwest::Client::new();
    let request = if let Some(command) = command {
        client.post("http://127.0.0.1:4897/lens").json(command)
    } else {
        client.get("http://127.0.0.1:4897/lens")
    };
    request
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| {
            RpcError::Transport(
                "Start scripts/vitre/lens-preview.ts for the Lens development preview.".into(),
            )
        })?
        .error_for_status()
        .map_err(|_| RpcError::Transport("The Lens preview rejected this request.".into()))?
        .json()
        .await
        .map_err(|_| RpcError::Transport("Invalid Lens preview response.".into()))
}
