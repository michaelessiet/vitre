use super::{Device, command_output};
use anyhow::{Context as _, Result};

pub async fn devices() -> Result<Vec<Device>> {
    let output = command_output(
        "xcrun",
        &["simctl", "list", "devices", "available", "--json"],
    )
    .await?;
    parse_devices(&output)
}

fn parse_devices(output: &[u8]) -> Result<Vec<Device>> {
    let value: serde_json::Value = serde_json::from_slice(output)?;
    let runtimes = value["devices"]
        .as_object()
        .context("Missing simulator inventory")?;
    let mut devices = Vec::new();
    for (runtime, list) in runtimes {
        if !runtime.contains(".iOS-") {
            continue;
        }
        for d in list.as_array().into_iter().flatten() {
            if d["isAvailable"] != true {
                continue;
            }
            if let (Some(id), Some(name)) = (d["udid"].as_str(), d["name"].as_str()) {
                let version = runtime.rsplit_once(".iOS-").map_or("", |(_, v)| v);
                devices.push(Device {
                    id: id.into(),
                    name: name.into(),
                    platform: "ios".into(),
                    runtime: Some(format!("iOS {}", version.replace('-', "."))),
                    running: matches!(d["state"].as_str(), Some("Booted" | "Booting")),
                    avd: None,
                });
            }
        }
    }
    Ok(devices)
}

pub async fn prepare(mut device: Device) -> Result<Device> {
    // bootstatus -b handles already-booted devices and starts stopped devices,
    // waiting for data migration and system services before native HID attaches.
    let output = tokio::process::Command::new("xcrun")
        .args(["simctl", "bootstatus", &device.id, "-b"])
        .kill_on_drop(true)
        .output()
        .await
        .context("Could not start the iOS simulator")?;
    anyhow::ensure!(
        output.status.success(),
        "Could not boot {}: {}",
        device.name,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    device.running = true;
    Ok(device)
}

pub async fn stop(device: &Device) -> Result<()> {
    stop_with(&device.id, async |args| command_output("xcrun", args).await).await
}

async fn stop_with(id: &str, mut run: impl AsyncFnMut(&[&str]) -> Result<Vec<u8>>) -> Result<()> {
    let result = run(&["simctl", "shutdown", id]).await;
    // simctl reports an error for an already-shutdown device. Treat that as
    // success only after checking this exact UDID in CoreSimulator's inventory.
    let output = run(&["simctl", "list", "devices", "--json"]).await?;
    let value: serde_json::Value = serde_json::from_slice(&output)?;
    let stopped = value["devices"]
        .as_object()
        .into_iter()
        .flat_map(|runtimes| runtimes.values())
        .flat_map(|devices| devices.as_array().into_iter().flatten())
        .any(|device| device["udid"] == id && device["state"] == "Shutdown");
    if stopped {
        return Ok(());
    }
    result?;
    anyhow::bail!("The simulator has not shut down. Try Stop again.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn shutdown_targets_only_selected_simulator_and_checks_its_final_state() {
        for (state, command_ok, expected_ok) in [
            ("Shutdown", true, true),
            ("Shutdown", false, true),
            ("Booted", false, false),
            ("Shutting Down", true, false),
        ] {
            let mut calls = Vec::new();
            let result = stop_with("selected", async |args| {
                calls.push(args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
                if args[1] == "shutdown" {
                    anyhow::ensure!(command_ok, "shutdown failed");
                    return Ok(Vec::new());
                }
                Ok(serde_json::to_vec(
                    &serde_json::json!({"devices":{"runtime":[
                        {"udid":"selected","state":state},
                        {"udid":"other","state":"Shutdown"}
                    ]}}),
                )?)
            })
            .await;
            assert_eq!(
                result.is_ok(),
                expected_ok,
                "{state}, command_ok={command_ok}"
            );
            assert_eq!(
                calls,
                [
                    vec!["simctl", "shutdown", "selected"],
                    vec!["simctl", "list", "devices", "--json"]
                ]
            );
        }
    }
    #[test]
    fn includes_stopped_simulators_but_excludes_unavailable_and_other_platforms() {
        let devices = parse_devices(
            br#"{"devices":{
            "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
                {"udid":"booted","name":"iPhone","state":"Booted","isAvailable":true},
                {"udid":"stopped","name":"iPad","state":"Shutdown","isAvailable":true},
                {"udid":"missing","name":"iPhone","state":"Shutdown","isAvailable":false}
            ],
            "com.apple.CoreSimulator.SimRuntime.tvOS-26-4":[
                {"udid":"tv","name":"Apple TV","state":"Shutdown","isAvailable":true}
            ]}}"#,
        )
        .unwrap();
        assert_eq!(devices.len(), 2);
        assert!(devices[0].running);
        assert!(!devices[1].running);
        assert_eq!(devices[1].name, "iPad");
        assert_eq!(devices[1].runtime.as_deref(), Some("iOS 26.4"));
    }
}
