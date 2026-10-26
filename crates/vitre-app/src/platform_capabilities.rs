//! Native features are gated here, independently of server-side availability.
pub(crate) const BROWSER: bool = cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const CAPTURE: bool = cfg!(target_os = "macos");
pub(crate) const BROWSER_UNAVAILABLE: &str = "Embedded browser is unsupported on this platform.";
pub(crate) const CAPTURE_UNAVAILABLE: &str =
    "Browser capture and recording are unsupported on this platform.";

pub(crate) fn automation_operations() -> Vec<vitre_contracts::PreviewAutomationOperation> {
    use vitre_contracts::PreviewAutomationOperation::*;
    if !BROWSER {
        return vec![];
    }
    let mut operations = vec![
        Status,
        Open,
        Navigate,
        Click,
        Type,
        Press,
        Scroll,
        Evaluate,
        WaitFor,
        Resize,
        SetColorScheme,
    ];
    if CAPTURE {
        operations.extend([Snapshot, RecordingStart, RecordingStop, Mobile]);
    }
    operations
}

#[cfg(test)]
mod tests {
    #[test]
    fn automation_advertises_only_supported_operations() {
        use vitre_contracts::PreviewAutomationOperation;
        let operations = super::automation_operations();
        assert_eq!(
            operations.contains(&PreviewAutomationOperation::Open),
            super::BROWSER
        );
        assert_eq!(
            operations.contains(&PreviewAutomationOperation::RecordingStart),
            super::CAPTURE
        );
    }
}
