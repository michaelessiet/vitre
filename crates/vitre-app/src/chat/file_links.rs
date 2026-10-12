//! Chat links share the workspace file viewer; unsupported local files are
//! revealed, never executed or mounted by clicking an assistant message.
use super::*;
use std::io::Read;

fn previewable(path: &Path) -> std::io::Result<bool> {
    if !std::fs::metadata(path)?.is_file() {
        return Ok(false);
    }
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "ico"
    ) {
        return Ok(true);
    }
    if matches!(
        extension.as_str(),
        "dmg"
            | "app"
            | "pkg"
            | "zip"
            | "gz"
            | "tar"
            | "pdf"
            | "mp4"
            | "mov"
            | "mp3"
            | "wav"
            | "exe"
            | "wasm"
    ) {
        return Ok(false);
    }
    // Bound the sniff, including for disk images with misleading extensions.
    let mut file = std::fs::File::open(path)?;
    let mut sample = vec![0; 8192];
    let count = file.read(&mut sample)?;
    sample.truncate(count);
    Ok(!sample.contains(&0)
        && match std::str::from_utf8(&sample) {
            Ok(_) => true,
            Err(error) => error.error_len().is_none(), // UTF-8 split at the sample boundary.
        })
}

fn parse_reference(value: &str, cwd: &str) -> Option<terminal_links::TerminalLink> {
    let decoded;
    let value = if !value.contains("://") {
        decoded = percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .ok()?;
        decoded.as_ref()
    } else {
        value
    };
    // Markdown generators use both /file:12:3 and /file#L12-L20.
    if !value.starts_with("http://")
        && !value.starts_with("https://")
        && let Some((path, fragment)) = value.rsplit_once("#L")
    {
        let line = fragment.split('-').next()?.parse::<u32>().ok()?;
        return terminal_links::parse_link(&format!("{path}:{line}"), cwd);
    }
    terminal_links::parse_link(value, cwd)
}

impl ChatApp {
    pub(super) fn file_viewer_root(&self) -> Option<String> {
        self.dock_thread_key()
            .and_then(|key| match self.right_panel.map.active_surface(&key) {
                Some(vitre_state::right_panel::RightPanelSurface::File {
                    root_path: Some(root),
                    ..
                }) => Some(root.clone()),
                _ => None,
            })
            .or_else(|| self.search_root())
    }

    pub(super) fn open_chat_link(
        &mut self,
        url: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let root = self.search_root();
        let Some(link) = parse_reference(url, root.as_deref().unwrap_or("/")) else {
            window.push_notification(
                Notification::warning("This link is not a supported local file or web URL."),
                cx,
            );
            return;
        };
        let terminal_links::TerminalLink::File { path, line, column } = link else {
            if let terminal_links::TerminalLink::Url(url) = link {
                cx.open_url(&url);
            }
            return;
        };
        let key = self.dock_thread_key();
        let inspect = path.clone();
        let task = cx
            .background_executor()
            .spawn(async move { previewable(&inspect) });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |chat, window, cx| {
                match result {
                    Ok(supported) => {
                        let viewer_root = root
                            .as_deref()
                            .map(Path::new)
                            .filter(|root| path.starts_with(root))
                            .or_else(|| path.parent());
                        let relative = viewer_root.and_then(|root| path.strip_prefix(root).ok());
                        if supported && let (Some(relative), Some(key)) = (relative, key.as_ref()) {
                            let root = viewer_root
                                .map(|root| root.to_string_lossy().into_owned())
                                .filter(|root| Some(root) != chat.open_project_root().as_ref());
                            chat.right_panel.map.open_file(
                                key,
                                &relative.to_string_lossy(),
                                line,
                                column,
                                root.as_deref(),
                            );
                            // Do not switch another conversation's dock if the user navigated while reading.
                            if chat.dock_thread_key().as_ref() == Some(key) {
                                chat.after_dock_change(true, window, cx);
                            }
                        } else {
                            cx.reveal_path(&path);
                        }
                    }
                    Err(error) => window.push_notification(
                        Notification::warning(format!(
                            "Could not open {}: {error}",
                            path.display()
                        )),
                        cx,
                    ),
                }
            });
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_reference_locations_and_safe_urls() {
        for value in [
            "src/main.rs:12",
            "/repo/src/main.rs#L12-L20",
            "file:///repo/src/main.rs:12",
        ] {
            assert_eq!(
                parse_reference(value, "/repo"),
                Some(terminal_links::TerminalLink::File {
                    path: "/repo/src/main.rs".into(),
                    line: Some(12),
                    column: None
                })
            );
        }
        assert_eq!(parse_reference("javascript:alert(1)", "/repo"), None);
        assert_eq!(
            parse_reference("https://example.com/a#L12", "/repo"),
            Some(terminal_links::TerminalLink::Url(
                "https://example.com/a#L12".into()
            ))
        );
    }

    #[test]
    fn preview_text_images_but_reveal_installers_and_binary_files() {
        let dir = std::env::temp_dir().join(fresh_id("vitre-file-links"));
        std::fs::create_dir(&dir).unwrap();
        for (name, bytes, expected) in [
            ("source.rs", b"fn main() {}".as_slice(), true),
            ("README", b"hello", true),
            ("archive.dmg", b"koly", false),
            ("unknown.bin", b"a\0b", false),
            ("preview.png", b"\x89PNG\0", true),
        ] {
            let path = dir.join(name);
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(previewable(&path).unwrap(), expected, "{name}");
            std::fs::remove_file(path).unwrap();
        }
        assert!(!previewable(&dir).unwrap());
        assert!(previewable(&dir.join("missing")).is_err());
        std::fs::remove_dir(dir).unwrap();
    }
}
