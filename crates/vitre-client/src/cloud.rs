//! Cloud account access is mediated by the local sidecar. Every operation gets
//! a fresh access token; refresh credentials stay in the sidecar secret store.
use std::sync::Arc;

use vitre_contracts::{
    CloudCommand, CloudDesktopSession, CloudGetDesktopSessionPayload, CloudOverview,
    CloudSavedResult, methods::CloudGetDesktopSession,
};
use vitre_rpc::{
    RpcError,
    cloud::{CloudHttp, CommandResult, trace_connection_phase},
    supervisor::PrepareFn,
};

use crate::EnvironmentClient;

#[derive(Clone)]
pub struct CloudClient {
    local: Arc<EnvironmentClient>,
}

fn cloud_request_error<E: serde::Serialize>(error: vitre_rpc::TypedError<E>) -> RpcError {
    match error {
        vitre_rpc::TypedError::Rpc(error) => error,
        vitre_rpc::TypedError::Failed(ref value) => {
            let encoded = serde_json::to_value(value).unwrap_or_default();
            RpcError::CloudRequest {
                message: error.user_message(),
                code: encoded
                    .get("code")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned),
                rejected: encoded.get("requestDisposition").and_then(|v| v.as_str())
                    == Some("rejected"),
                retryable: encoded
                    .get("retryable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            }
        }
    }
}

impl CloudClient {
    pub async fn read_file(
        &self,
        task_id: String,
        path: String,
    ) -> Result<vitre_contracts::ProjectReadFileResult, RpcError> {
        let path = path
            .strip_prefix("/workspace/repository/")
            .unwrap_or(&path)
            .to_owned();
        if path.starts_with('/') || path.split('/').any(|part| part == ".." || part.is_empty()) {
            return Err(RpcError::Transport("Invalid remote repository path".into()));
        }
        let remote = self.connect(task_id);
        let mut sessions = remote.sessions();
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            vitre_rpc::wait_for_session(&mut sessions),
        )
        .await
        .map_err(|_| RpcError::Transport("Cloud environment is not ready".into()))?
        .ok_or(RpcError::ConnectionClosed)?;
        remote
            .call::<vitre_contracts::methods::ProjectsReadFile>(
                &vitre_contracts::ProjectReadFileInput {
                    cwd: vitre_contracts::TrimmedNonEmptyString("/workspace/repository".into()),
                    relative_path: vitre_contracts::TrimmedNonEmptyString(path),
                },
            )
            .await
            .map_err(|_| RpcError::Transport("Remote file could not be read".into()))
    }
    pub async fn repositories(&self) -> Result<Vec<vitre_contracts::CloudRepository>, RpcError> {
        let (http, token) = self.authenticated().await?;
        http.repositories(&token).await
    }
    pub async fn respond(
        &self,
        task_id: String,
        command: vitre_contracts::ClientOrchestrationCommand,
    ) -> Result<(), RpcError> {
        let remote = self.connect(task_id);
        let mut sessions = remote.sessions();
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            vitre_rpc::wait_for_session(&mut sessions),
        )
        .await
        .map_err(|_| RpcError::Transport("Cloud environment is still reconnecting".into()))?
        .ok_or(RpcError::ConnectionClosed)?;
        remote.dispatch(&command).await.map_err(|_| {
            RpcError::Transport("Cloud response failed; reconnect to check request status".into())
        })?;
        Ok(())
    }
    pub async fn start_login(&self, key: &str) -> Result<serde_json::Value, RpcError> {
        let (http, token) = self.authenticated().await?;
        http.start_login(&token, key).await
    }
    pub async fn login_status(
        &self,
        id: &str,
    ) -> Result<vitre_contracts::CloudLoginStatus, RpcError> {
        let (http, token) = self.authenticated().await?;
        http.login_status(&token, id).await
    }
    pub async fn events(
        &self,
        id: &str,
        after: u64,
    ) -> Result<vitre_contracts::CloudTaskFeed, RpcError> {
        let (http, token) = self.authenticated().await?;
        http.events(&token, id, after).await
    }
    pub async fn save_credential(
        &self,
        provider: &str,
        credential: &str,
        version: u64,
        key: &str,
    ) -> Result<(), RpcError> {
        let (http, token) = self.authenticated().await?;
        http.save_credential(&token, provider, credential, version, key)
            .await
    }
    pub fn new(local: Arc<EnvironmentClient>) -> Self {
        Self { local }
    }

    pub async fn cancel_signin(&self) -> Result<(), RpcError> {
        self.local
            .call::<CloudGetDesktopSession>(&CloudGetDesktopSessionPayload {
                authorize: false,
                cancel: Some(true),
            })
            .await
            .map(|_| ())
            .map_err(|e| RpcError::Transport(e.to_string()))
    }

    /// Only explicit user sign-in may open a browser.
    pub async fn session(&self, authorize: bool) -> Result<CloudDesktopSession, RpcError> {
        self.session_with_timing(authorize, None).await
    }

    async fn session_with_timing(
        &self,
        authorize: bool,
        task_id: Option<&str>,
    ) -> Result<CloudDesktopSession, RpcError> {
        // Cloud attaches while the sidecar WebSocket is still connecting. A
        // one-shot probe before readiness must not appear to sign the user out.
        let started = std::time::Instant::now();
        if task_id.is_some() {
            trace_connection_phase("account_session_start", task_id, None, started.elapsed());
        }
        let mut sessions = self.local.sessions();
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            vitre_rpc::wait_for_session(&mut sessions),
        )
        .await
        .map_err(|_| RpcError::Transport("The local account service is still connecting".into()))?
        .ok_or(RpcError::ConnectionClosed)?;
        if task_id.is_some() {
            trace_connection_phase("local_session_ready", task_id, None, started.elapsed());
        }
        let started = std::time::Instant::now();
        let session = self
            .local
            .call::<CloudGetDesktopSession>(&CloudGetDesktopSessionPayload {
                authorize,
                cancel: None,
            })
            .await
            .map_err(|_| {
                RpcError::Transport(
                    "Cloud sign-in is unavailable; check the personal deployment configuration"
                        .into(),
                )
            })?;
        if task_id.is_some() {
            trace_connection_phase("account_token_received", task_id, None, started.elapsed());
        }
        Ok(session)
    }

    async fn authenticated(&self) -> Result<(CloudHttp, String), RpcError> {
        authenticated_session(self.session(false).await?)
    }

    pub async fn continue_workspace(
        &self,
        input: &vitre_contracts::CloudContinueConversationInput,
    ) -> Result<vitre_contracts::CloudStartConversationResult, RpcError> {
        let result = self
            .local
            .call::<vitre_contracts::methods::CloudContinueConversation>(input)
            .await
            .map_err(cloud_request_error)?;
        // Opt-in native recovery verification: the real remote command has
        // succeeded, but its reply is unavailable to the presentation layer.
        // Release builds have no fault injection or environment lookup.
        #[cfg(debug_assertions)]
        {
            static LOST_REPLY: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if std::env::var("VITRE_VERIFY_CLOUD_LOST_REPLY_ONCE").as_deref() == Ok("1")
                && !LOST_REPLY.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                eprintln!("[vitre-cloud-verification] accepted continuation reply dropped");
                return Err(RpcError::ConnectionClosed);
            }
        }
        Ok(result)
    }
    pub async fn switch_workspace(
        &self,
        input: &vitre_contracts::CloudSwitchInput,
    ) -> Result<vitre_contracts::CloudSwitchStatus, RpcError> {
        self.local
            .call::<vitre_contracts::methods::CloudSwitchConversation>(input)
            .await
            .map_err(cloud_request_error)
    }
    pub async fn switch_status(
        &self,
        conversation_id: String,
    ) -> Result<vitre_contracts::CloudSwitchStatus, RpcError> {
        self.local
            .call::<vitre_contracts::methods::CloudSwitchStatus>(
                &vitre_contracts::CloudSwitchStatusInput { conversation_id },
            )
            .await
            .map_err(cloud_request_error)
    }
    pub async fn resolve_switch(
        &self,
        input: &vitre_contracts::CloudSwitchResolveInput,
    ) -> Result<vitre_contracts::CloudSwitchStatus, RpcError> {
        self.local
            .call::<vitre_contracts::methods::CloudResolveSwitch>(input)
            .await
            .map_err(cloud_request_error)
    }
    pub async fn cancel_switch(
        &self,
        operation_id: String,
    ) -> Result<vitre_contracts::CloudSwitchStatus, RpcError> {
        self.local
            .call::<vitre_contracts::methods::CloudCancelSwitch>(
                &vitre_contracts::CloudSwitchCancelInput { operation_id },
            )
            .await
            .map_err(cloud_request_error)
    }

    pub async fn start_workspace(
        &self,
        input: &vitre_contracts::CloudStartConversationInput,
    ) -> Result<vitre_contracts::CloudStartConversationResult, RpcError> {
        self.local
            .call::<vitre_contracts::methods::CloudStartConversation>(input)
            .await
            .map_err(cloud_request_error)
    }

    pub async fn start_progress(
        &self,
        idempotency_key: String,
        cancel: bool,
    ) -> Result<vitre_contracts::CloudStartProgress, RpcError> {
        let result = self
            .local
            .call::<vitre_contracts::methods::CloudStartProgress>(
                &vitre_contracts::CloudStartProgressPayload {
                    idempotency_key: vitre_contracts::TrimmedNonEmptyString(idempotency_key),
                    cancel,
                },
            )
            .await
            .map_err(cloud_request_error)?;
        Ok(result)
    }

    pub async fn lens(&self) -> Result<vitre_contracts::LensOverview, RpcError> {
        #[cfg(debug_assertions)]
        if std::env::var("VITRE_LENS_PREVIEW").as_deref() == Ok("1") {
            return vitre_rpc::cloud::lens_preview(None).await;
        }
        let (http, token) = self.authenticated().await?;
        http.lens(&token).await
    }
    pub async fn lens_command(
        &self,
        command: &vitre_contracts::LensCommand,
    ) -> Result<vitre_contracts::LensOverview, RpcError> {
        #[cfg(debug_assertions)]
        if std::env::var("VITRE_LENS_PREVIEW").as_deref() == Ok("1") {
            return vitre_rpc::cloud::lens_preview(Some(command)).await;
        }
        let (http, token) = self.authenticated().await?;
        http.lens_command(&token, command).await
    }
    pub async fn overview(&self) -> Result<CloudOverview, RpcError> {
        let (http, token) = self.authenticated().await?;
        http.overview(&token).await
    }

    /// The caller retains the same command/idempotency key for an explicit retry.
    pub async fn command(&self, command: &CloudCommand) -> Result<CommandResult, RpcError> {
        let (http, token) = self.authenticated().await?;
        http.command(&token, command).await
    }

    pub async fn result(&self, task_id: &str) -> Result<CloudSavedResult, RpcError> {
        let (http, token) = self.authenticated().await?;
        http.result(&token, task_id).await
    }

    /// Each cloud task owns an independent supervisor and projection. The local
    /// sidecar is used only for account access, never as a connection fallback.
    pub fn connect(&self, task_id: String) -> EnvironmentClient {
        let cloud = self.clone();
        let prepare: PrepareFn = Box::new(move || {
            let cloud = cloud.clone();
            let task_id = task_id.clone();
            Box::pin(async move {
                let (http, token) =
                    authenticated_session(cloud.session_with_timing(false, Some(&task_id)).await?)?;
                http.prepare_environment(&token, &task_id).await
            })
        });
        EnvironmentClient::start_remote(prepare)
    }
}

fn authenticated_session(session: CloudDesktopSession) -> Result<(CloudHttp, String), RpcError> {
    if !session.enabled {
        return Err(RpcError::Transport("Cloud capability is disabled".into()));
    }
    let origin = session
        .relay_url
        .ok_or_else(|| RpcError::Transport("Configure your personal cloud deployment".into()))?;
    let token = session
        .access_token
        .filter(|token| !token.0.is_empty())
        .ok_or_else(|| RpcError::Transport("Sign into your cloud deployment".into()))?;
    Ok((CloudHttp::new(&origin.0)?, token.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use vitre_contracts::TrimmedNonEmptyString;

    #[test]
    fn structured_cloud_failure_preserves_certainty_and_code() {
        let error = cloud_request_error(vitre_rpc::TypedError::Failed(serde_json::json!({
            "message": "Workspace is unavailable",
            "code": "workspace_missing",
            "requestDisposition": "rejected",
            "retryable": true
        })));
        assert!(matches!(error, RpcError::CloudRequest {
            code: Some(code), rejected: true, retryable: true, ..
        } if code == "workspace_missing"));
    }

    #[test]
    fn missing_or_ambiguous_disposition_never_restores_input() {
        for disposition in [None, Some("unknown"), Some("accepted"), Some("invalid")] {
            let mut value = serde_json::json!({"message": "Reply was lost"});
            if let Some(disposition) = disposition {
                value["requestDisposition"] = disposition.into();
            }
            let error = cloud_request_error(vitre_rpc::TypedError::Failed(value));
            assert!(matches!(
                error,
                RpcError::CloudRequest {
                    rejected: false,
                    ..
                }
            ));
        }
        let error = cloud_request_error::<serde_json::Value>(vitre_rpc::TypedError::Rpc(
            RpcError::ConnectionClosed,
        ));
        assert!(matches!(error, RpcError::ConnectionClosed));
    }

    #[test]
    fn disabled_unsigned_and_insecure_sessions_fail_closed() {
        let mut session = CloudDesktopSession {
            enabled: false,
            relay_url: Some(TrimmedNonEmptyString("https://cloud.example.test".into())),
            access_token: Some(TrimmedNonEmptyString("access".into())),
            expires_at_epoch_ms: None,
        };
        assert!(authenticated_session(session.clone()).is_err());
        session.enabled = true;
        assert!(authenticated_session(session.clone()).is_ok());
        session.relay_url = Some(TrimmedNonEmptyString("http://localhost:3773".into()));
        assert!(authenticated_session(session.clone()).is_err());
        session.access_token = None;
        assert!(authenticated_session(session).is_err());
    }
}
