//! Spawning one sidecar process: port selection, bootstrap-envelope delivery
//! over stdin (the server's `--bootstrap-fd 0` path), and readiness polling.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

const DEFAULT_BACKEND_PORT: u16 = 3773;
const READINESS_PATH: &str = "/.well-known/t3/environment";

/// Env vars nulled out before spawning, mirroring `backendChildEnvPatch` in
/// apps/desktop/src/backend/DesktopBackendConfiguration.ts — leaked values
/// from a parent dev runner would override the bootstrap envelope.
const T3CODE_ENV_NAMES: [&str; 10] = [
    "T3CODE_PORT",
    "T3CODE_MODE",
    "T3CODE_NO_BROWSER",
    "T3CODE_HOST",
    "T3CODE_DESKTOP_WS_URL",
    "T3CODE_DESKTOP_LAN_ACCESS",
    "T3CODE_DESKTOP_LAN_HOST",
    "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
    "T3CODE_TAILSCALE_SERVE",
    "T3CODE_TAILSCALE_SERVE_PORT",
];

pub struct SidecarConfig {
    pub node_binary: String,
    pub server_entry: PathBuf,
    pub t3_home: PathBuf,
    pub fixed_port: Option<u16>,
}

/// Where the running sidecar lives and how to authenticate against it.
/// Always 127.0.0.1, never localhost (the server binds IPv4 only; `localhost`
/// can resolve IPv6-first).
#[derive(Debug, Clone)]
pub struct BackendInfo {
    pub port: u16,
    pub bootstrap_token: String,
}

impl BackendInfo {
    pub fn http_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn ws_base_url(&self) -> String {
        format!("ws://127.0.0.1:{}", self.port)
    }
}

pub(crate) fn random_hex_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("OS randomness available");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn pick_port(fixed: Option<u16>) -> Option<u16> {
    if let Some(port) = fixed {
        return Some(port);
    }
    (DEFAULT_BACKEND_PORT..u16::MAX).find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

pub(crate) fn spawn_backend(
    config: &SidecarConfig,
    port: u16,
    bootstrap_token: &str,
) -> std::io::Result<(Child, Receiver<()>)> {
    std::fs::create_dir_all(&config.t3_home)?;

    // The child runs with its cwd set to $HOME (below), so a relative entry
    // path must be resolved against OUR cwd before the spawn.
    let server_entry = config.server_entry.canonicalize()?;

    let mut command = Command::new(&config.node_binary);
    command.arg(&server_entry).arg("--bootstrap-fd").arg("0");
    for name in T3CODE_ENV_NAMES {
        command.env_remove(name);
    }
    command.env_remove("ELECTRON_RUN_AS_NODE");
    command.env("VITRE_READY_SIGNAL", "1");
    command
        .current_dir(
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/")),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Put the backend and any descendants it launches in a dedicated process
    // group. The supervisor can then terminate the whole tree on app exit.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }

    let mut child = command.spawn()?;

    let envelope = serde_json::json!({
        "mode": "desktop",
        "noBrowser": true,
        "port": port,
        "t3Home": config.t3_home.to_string_lossy(),
        "host": "127.0.0.1",
        "desktopBootstrapToken": bootstrap_token,
        "tailscaleServeEnabled": false,
        // Inert while tailscaleServeEnabled is false; PortSchema rejects 0.
        "tailscaleServePort": 443,
    });
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{envelope}\n").as_bytes());
        // Dropping stdin closes it; the server reads the envelope and keeps
        // running (same as the Electron WSL stdin-delivery path).
    }

    let (ready_tx, ready_rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        forward_output("server", stdout, Some(ready_tx));
    }
    if let Some(stderr) = child.stderr.take() {
        forward_output("server!", stderr, None);
    }

    Ok((child, ready_rx))
}

/// Poll readiness until 200, child exit, or timeout.
pub(crate) fn wait_until_ready(
    port: u16,
    child: &mut Child,
    ready: &Receiver<()>,
    timeout: Duration,
) -> bool {
    wait_until_ready_or_shutdown(port, child, ready, timeout, &AtomicBool::new(false))
}

pub(crate) fn wait_until_ready_or_shutdown(
    port: u16,
    child: &mut Child,
    ready: &Receiver<()>,
    timeout: Duration,
    shutting_down: &AtomicBool,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline && !shutting_down.load(Ordering::SeqCst) {
        if ready.try_recv().is_ok() {
            return true;
        }
        if let Ok(Some(_)) = child.try_wait() {
            return false;
        }
        let probe_started = Instant::now();
        let probed = probe_ready_or_shutdown(port, ready, deadline, shutting_down);
        if std::env::var_os("VITRE_PROFILE").is_some() {
            eprintln!(
                "[vitre-perf] readiness HTTP probe: {} ms, success={probed}",
                probe_started.elapsed().as_millis()
            );
        }
        if probed {
            return true;
        }
        match ready.recv_timeout(Duration::from_millis(100)) {
            Ok(()) => return true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                std::thread::sleep(Duration::from_millis(100))
            }
        }
    }
    false
}

#[cfg(test)]
mod readiness_tests {
    use super::*;

    #[test]
    fn stdout_readiness_interrupts_a_stalled_http_probe() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            socket.read(&mut request).unwrap();
            // Match startup: a socket accepts a request but no handler responds.
            std::thread::sleep(Duration::from_millis(50));
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        });
        let started = Instant::now();
        let result = probe_ready(port, &ready_rx, started + Duration::from_secs(2));
        let elapsed = started.elapsed();
        release_tx.send(()).unwrap();
        server.join().unwrap();
        assert!(result);
        assert!(
            elapsed < Duration::from_millis(500),
            "stdout marker was blocked for {elapsed:?}"
        );
    }

    #[test]
    fn http_fallback_accepts_a_split_status_line_without_a_marker() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (_tx, rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 ").unwrap();
            std::thread::sleep(Duration::from_millis(60));
            socket
                .write_all(b"200 OK\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        assert!(probe_ready(
            port,
            &rx,
            Instant::now() + Duration::from_secs(2)
        ));
        server.join().unwrap();
    }

    #[test]
    fn stalled_probe_respects_the_startup_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (_tx, rx) = mpsc::channel();
        let started = Instant::now();
        assert!(!probe_ready(port, &rx, started + Duration::from_millis(80)));
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn readiness_signal_is_exact_and_survives_log_forwarding() {
        let (tx, rx) = mpsc::channel();
        forward_output(
            "test",
            std::io::Cursor::new(b"starting\nVITRE_BACKEND_READY_V1\n"),
            Some(tx),
        );
        assert!(rx.recv_timeout(Duration::from_secs(1)).is_ok());
        let (tx, rx) = mpsc::channel();
        forward_output(
            "test",
            std::io::Cursor::new(b"log mentions VITRE_BACKEND_READY_V1\n"),
            Some(tx),
        );
        assert!(rx.recv_timeout(Duration::from_secs(1)).is_err());
    }
}

/// Compatibility HTTP probe for backends without the stdout readiness marker.
/// Short socket waits let a marker interrupt an in-flight request, including
/// requests accepted before the server has installed its HTTP handler.
#[cfg(test)]
fn probe_ready(port: u16, ready: &Receiver<()>, deadline: Instant) -> bool {
    probe_ready_or_shutdown(port, ready, deadline, &AtomicBool::new(false))
}

fn probe_ready_or_shutdown(
    port: u16,
    ready: &Receiver<()>,
    deadline: Instant,
    shutting_down: &AtomicBool,
) -> bool {
    const POLL: Duration = Duration::from_millis(20);
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("loopback addr parses"),
        POLL.min(remaining),
    ) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(POLL.min(remaining)));
    let request = format!(
        "GET {READINESS_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let deadline = deadline.min(Instant::now() + Duration::from_millis(1500));
    let mut buffer = [0u8; 64];
    let mut used = 0;
    loop {
        if shutting_down.load(Ordering::SeqCst) {
            return false;
        }
        if ready.try_recv().is_ok() {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let _ = stream.set_read_timeout(Some(POLL.min(remaining)));
        match stream.read(&mut buffer[used..]) {
            Ok(0) => return false,
            Ok(read) => {
                used += read;
                if buffer[..used].windows(2).any(|pair| pair == b"\r\n") || used == buffer.len() {
                    let status_line = String::from_utf8_lossy(&buffer[..used]);
                    return status_line.starts_with("HTTP/1.1 200")
                        || status_line.starts_with("HTTP/1.0 200");
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return false,
        }
    }
}

fn forward_output(
    prefix: &'static str,
    mut stream: impl Read + Send + 'static,
    ready: Option<Sender<()>>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(read) = stream.read(&mut buffer) {
            if read == 0 {
                if !pending.is_empty() {
                    eprintln!("[{prefix}] {}", String::from_utf8_lossy(&pending));
                }
                break;
            }
            pending.extend_from_slice(&buffer[..read]);
            while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = pending.drain(..=newline).collect();
                if line == b"VITRE_BACKEND_READY_V1\n" {
                    if std::env::var_os("VITRE_PROFILE").is_some() {
                        eprintln!(
                            "[vitre-perf] readiness stdout signal received at {} ms since epoch",
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis()
                        );
                    }
                    if let Some(ready) = &ready {
                        let _ = ready.send(());
                    }
                } else {
                    eprintln!("[{prefix}] {}", String::from_utf8_lossy(&line).trim_end());
                }
            }
            // A child may emit arbitrary output without a newline. Keep the
            // readiness scanner bounded while continuing to forward its logs.
            if pending.len() >= 8192 {
                eprintln!("[{prefix}] {}", String::from_utf8_lossy(&pending));
                pending.clear();
            }
        }
    });
}

/// One-shot sidecar (no restart supervision) — used by spikes and selftests.
pub struct Sidecar {
    child: Child,
    ready: Receiver<()>,
    pub port: u16,
    pub bootstrap_token: String,
}

impl Sidecar {
    pub fn spawn(config: &SidecarConfig) -> std::io::Result<Self> {
        let port = pick_port(config.fixed_port)
            .ok_or_else(|| std::io::Error::other("no free backend port from 3773 upward"))?;
        let bootstrap_token = random_hex_token();
        let (child, ready) = spawn_backend(config, port, &bootstrap_token)?;
        Ok(Self {
            child,
            ready,
            port,
            bootstrap_token,
        })
    }

    pub fn info(&self) -> BackendInfo {
        BackendInfo {
            port: self.port,
            bootstrap_token: self.bootstrap_token.clone(),
        }
    }

    pub fn http_base_url(&self) -> String {
        self.info().http_base_url()
    }

    pub fn ws_base_url(&self) -> String {
        self.info().ws_base_url()
    }

    pub fn wait_ready(&mut self, timeout: Duration) -> std::io::Result<()> {
        if wait_until_ready(self.port, &mut self.child, &self.ready, timeout) {
            Ok(())
        } else if let Ok(Some(status)) = self.child.try_wait() {
            Err(std::io::Error::other(format!(
                "sidecar exited before readiness: {status}"
            )))
        } else {
            Err(std::io::Error::other("sidecar readiness timeout"))
        }
    }

    /// Graceful teardown: SIGTERM (lets the server close its SQLite home),
    /// then SIGKILL if its process group lingers past 600 ms.
    pub fn shutdown(mut self) {
        terminate(&mut self.child);
    }
}

/// Keep ordinary exits graceful without holding native quit behind hung
/// providers or network finalizers. Always clean up same-group descendants,
/// including when Node exits before its children do.
pub(crate) fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        let pgid = child.id() as i32;
        unsafe {
            libc::kill(-pgid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_millis(600);
        while Instant::now() < deadline {
            let exited = matches!(child.try_wait(), Ok(Some(_)));
            let group_exists = unsafe { libc::kill(-pgid, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
            if exited && !group_exists {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    // On non-Unix platforms there is no POSIX process group or SIGTERM.
    // Kill and reap the child directly instead of waiting for an unsent signal.
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod shutdown_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt as _;

    fn fixture(script: &str) -> (Child, String) {
        let mut child = Command::new("sh")
            .args(["-c", script])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        (child, ready)
    }

    #[test]
    fn graceful_shutdown_does_not_wait_for_the_grace_deadline() {
        let (mut child, _) = fixture("echo ready; exec sleep 30");
        let started = Instant::now();
        terminate(&mut child);
        assert!(child.try_wait().unwrap().is_some());
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn stubborn_descendant_is_killed_even_when_the_leader_exits() {
        // The group leader exits on TERM; its child deliberately ignores TERM.
        let (mut child, ready) =
            fixture("sh -c 'trap \"\" TERM; echo $$; while :; do sleep 1; done' & wait");
        let descendant = ready.trim().parse::<u32>().unwrap();
        let started = Instant::now();
        terminate(&mut child);
        assert!(child.try_wait().unwrap().is_some());
        assert!(started.elapsed() < Duration::from_secs(2));
        // An orphan may briefly remain a zombie until the OS reaps it.
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let status = Command::new("ps")
                .args(["-p", &descendant.to_string(), "-o", "stat="])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&status.stdout);
            if state.trim().is_empty() || state.trim().starts_with('Z') {
                break;
            }
            if Instant::now() >= deadline {
                unsafe {
                    libc::kill(descendant as i32, libc::SIGKILL);
                }
                panic!("descendant survived group shutdown: {state}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn readiness_can_be_cancelled_while_http_is_stalled() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (_tx, ready) = mpsc::channel();
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            flag.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        assert!(!probe_ready_or_shutdown(
            port,
            &ready,
            started + Duration::from_secs(60),
            &stop
        ));
        cancel.join().unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
