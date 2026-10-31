//! Configured AVDs, live emulator discovery, and boot before display attachment.
use super::{Device, android, command_output};
use anyhow::{Context as _, Result};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

#[derive(Clone)]
pub(super) struct RunningDevice {
    pub device: Device,
    pub endpoint: android::Endpoint,
}

pub(super) fn ini(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|s| s.split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect()
}

fn emulator() -> Option<PathBuf> {
    [
        std::env::var_os("ANDROID_HOME"),
        std::env::var_os("ANDROID_SDK_ROOT"),
    ]
    .into_iter()
    .flatten()
    .map(PathBuf::from)
    .chain(std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Android/sdk")))
    .map(|root| root.join("emulator/emulator"))
    .chain(std::env::var_os("PATH").into_iter().flat_map(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join("emulator"))
            .collect::<Vec<_>>()
    }))
    .find(|path| path.is_file())
}

fn registry() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
        .join("Library/Caches/TemporaryItems/avd/running")
}

fn registry_entry(
    path: &Path,
    text: &str,
    is_emulator: impl FnOnce(u32) -> bool,
) -> Option<RunningDevice> {
    // Discovery files can survive emulator exits. A listening port alone can
    // belong to a different process, so validate the owning emulator as well.
    let stem = path.file_stem()?.to_str()?.strip_prefix("pid_")?;
    let pid = stem.strip_suffix("_info").unwrap_or(stem).parse().ok()?;
    if path.extension()? != "ini" || !is_emulator(pid) {
        return None;
    }
    let p = ini(text);
    let serial = p.get("port.serial")?.parse::<u16>().ok()?;
    let avd = p.get("avd.id")?.clone();
    Some(RunningDevice {
        device: Device {
            id: format!("emulator-{serial}"),
            name: p.get("avd.name").unwrap_or(&avd).clone(),
            platform: "android".into(),
            runtime: None,
            running: true,
            avd: Some(avd),
        },
        endpoint: android::Endpoint {
            port: p.get("grpc.port")?.parse().ok()?,
            token: p.get("grpc.token").cloned().unwrap_or_default(),
        },
    })
}

pub(super) async fn running() -> Result<Vec<RunningDevice>> {
    tokio::task::spawn_blocking(|| {
        let Ok(entries) = std::fs::read_dir(registry()) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| {
                let text = std::fs::read_to_string(entry.path()).ok()?;
                registry_entry(&entry.path(), &text, |pid| {
                    std::process::Command::new("/bin/ps")
                        .args(["-p", &pid.to_string(), "-o", "comm="])
                        .output()
                        .ok()
                        .is_some_and(|output| {
                            output.status.success()
                                && String::from_utf8_lossy(&output.stdout).lines().any(|name| {
                                    Path::new(name.trim())
                                        .file_name()
                                        .and_then(|n| n.to_str())
                                        .is_some_and(|n| {
                                            n.starts_with("qemu-system-") || n == "emulator"
                                        })
                                })
                        })
                })
            })
            .collect()
    })
    .await
    .context("Could not read running Android emulators")
}

fn merge_devices(avds: &str, running: Vec<RunningDevice>) -> Vec<Device> {
    let mut devices: Vec<Device> = running.into_iter().map(|r| r.device).collect();
    for avd in avds.lines().map(str::trim).filter(|s| !s.is_empty()) {
        if devices.iter().any(|d| d.avd.as_deref() == Some(avd)) {
            continue;
        }
        devices.push(Device {
            id: format!("avd:{avd}"),
            name: avd.replace('_', " "),
            platform: "android".into(),
            runtime: None,
            running: false,
            avd: Some(avd.into()),
        });
    }
    devices
}

pub(super) async fn devices() -> Result<Vec<Device>> {
    let running = running().await?;
    let Some(emulator) = emulator() else {
        return Ok(merge_devices("", running));
    };
    let avds = command_output(&emulator, &["-list-avds"]).await?;
    Ok(merge_devices(&String::from_utf8_lossy(&avds), running))
}

fn matches_device(running: &RunningDevice, device: &Device) -> bool {
    // AVD identity survives restarts and serial-port reassignment. Never
    // attach an old selection to a different AVD that reused its serial.
    running.device.same_target(device)
}

struct BootProcess(Option<tokio::process::Child>);
impl Drop for BootProcess {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.start_kill();
        }
    }
}

pub(super) async fn prepare(device: Device) -> Result<Device> {
    static START: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = START.lock().await;
    let mut child = BootProcess(None);
    if !running().await?.iter().any(|r| matches_device(r, &device)) {
        let executable = emulator().context(
            "Android Emulator is not installed. Install it with Android Studio's SDK Manager.",
        )?;
        let avd = device.avd.as_deref().context(
            "The emulator stopped. Reopen Devices and select its configured virtual device.",
        )?;
        let avds = command_output(&executable, &["-list-avds"]).await?;
        anyhow::ensure!(
            String::from_utf8_lossy(&avds)
                .lines()
                .any(|line| line.trim() == avd),
            "The Android virtual device {avd} no longer exists. Reopen Devices."
        );
        let log_dir = crate::vitre_home().join("logs");
        std::fs::create_dir_all(&log_dir)?;
        let log_path = log_dir.join("android-emulator.log");
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        child.0 = Some(
            tokio::process::Command::new(executable)
                .args(["-avd", avd, "-no-window", "-grpc-use-token"])
                .stdin(Stdio::null())
                .stdout(log.try_clone()?)
                .stderr(log)
                // Cancelling/closing a panel during boot stops only the process
                // it started. Once booted, disconnecting leaves the device running.
                .spawn()
                .context("Could not start Android Emulator")?,
        );
    }
    loop {
        if let Some(child) = child.0.as_mut()
            && let Some(status) = child.try_wait()?
        {
            anyhow::bail!(
                "Android Emulator exited before booting ({status}). See {}",
                crate::vitre_home()
                    .join("logs/android-emulator.log")
                    .display()
            );
        }
        if let Some(running) = running()
            .await?
            .into_iter()
            .find(|r| matches_device(r, &device))
        {
            anyhow::ensure!(
                !running.endpoint.token.is_empty(),
                "This emulator has no local authentication token. Restart it from Vitre or Android Studio."
            );
            // A discovery record is published before gRPC and Android finish
            // booting. Probe authenticated status, not merely the TCP port.
            if android::booted(&running.endpoint).await.unwrap_or(false) {
                if let Some(mut child) = child.0.take() {
                    tokio::spawn(async move {
                        let _ = child.wait().await;
                    });
                }
                return Ok(running.device);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

pub(super) async fn stop(device: &Device) -> Result<()> {
    let Some(target) = running()
        .await?
        .into_iter()
        .find(|r| matches_device(r, device))
    else {
        return Ok(());
    };
    let result = android::shutdown(&target.endpoint).await;
    // The RPC can lose its connection as the emulator exits. Confirm process
    // disappearance instead of mistaking either an acknowledgement or a socket
    // error for the final shutdown state.
    tokio::time::timeout(Duration::from_secs(45), async {
        while running().await?.iter().any(|r| matches_device(r, device)) {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .with_context(|| match result {
        Ok(()) => "The emulator is still running. Try Stop again.".to_owned(),
        Err(error) => format!("Could not stop the emulator: {error:#}. Try Stop again."),
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    const RECORD: &str =
        "avd.id=Pixel_10\navd.name=Pixel 10\nport.serial=5554\ngrpc.port=8554\ngrpc.token=a=b==";
    #[test]
    fn stale_registry_file_becomes_a_startable_avd() {
        let stale = registry_entry(Path::new("pid_16807.ini"), RECORD, |_| false);
        assert!(stale.is_none());
        let devices = merge_devices("Pixel_10\n", stale.into_iter().collect());
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "avd:Pixel_10");
        assert!(!devices[0].running);
    }
    #[test]
    fn live_avd_is_not_duplicated_and_keeps_its_authenticated_endpoint() {
        let live = registry_entry(Path::new("pid_42_info.ini"), RECORD, |pid| pid == 42).unwrap();
        assert_eq!(live.endpoint.token, "a=b==");
        let devices = merge_devices("Pixel_10\nTablet\n", vec![live]);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, "emulator-5554");
        assert!(devices[0].running);
        assert!(!devices[1].running);
    }
    #[test]
    fn selection_follows_avd_across_restart_instead_of_reused_serial() {
        let selected = registry_entry(Path::new("pid_42.ini"), RECORD, |_| true)
            .unwrap()
            .device;
        let other = registry_entry(
            Path::new("pid_43.ini"),
            &RECORD.replace("Pixel_10", "Tablet"),
            |_| true,
        )
        .unwrap();
        assert!(!matches_device(&other, &selected));
        let restarted = registry_entry(
            Path::new("pid_44.ini"),
            &RECORD.replace("5554", "5556"),
            |_| true,
        )
        .unwrap();
        assert!(matches_device(&restarted, &selected));
    }
}
