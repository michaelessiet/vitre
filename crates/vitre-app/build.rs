fn main() {
    use std::path::PathBuf;
    use std::process::Command;

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let source = PathBuf::from("native/capture_window.m");
    let output = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set"));
    let object = output.join("capture_window.o");
    let archive = output.join("libvitre_capture_window.a");
    println!("cargo:rerun-if-changed={}", source.display());

    let status = Command::new("clang")
        .args(["-fobjc-arc", "-fblocks", "-c"])
        .arg(&source)
        .arg("-o")
        .arg(&object)
        .status()
        .expect("clang is required to build Vitre's macOS capture helper");
    assert!(status.success(), "failed to compile macOS capture helper");
    let status = Command::new("ar")
        .arg("rcs")
        .arg(&archive)
        .arg(&object)
        .status()
        .expect("ar is required to build Vitre's macOS capture helper");
    assert!(status.success(), "failed to archive macOS capture helper");

    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=vitre_capture_window");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
}
