fn main() {
    use std::path::PathBuf;
    use std::process::Command;

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let output = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set"));
    let archive = output.join("libvitre_capture_window.a");
    let mut objects = Vec::new();
    for name in ["capture_window", "mobile_view"] {
        let source = PathBuf::from(format!("native/{name}.m"));
        let object = output.join(format!("{name}.o"));
        println!("cargo:rerun-if-changed={}", source.display());

        let status = Command::new("clang")
            .args(["-fobjc-arc", "-fblocks", "-c"])
            .arg(&source)
            .arg("-o")
            .arg(&object)
            .status()
            .expect("clang is required to build Vitre's macOS capture helper");
        assert!(status.success(), "failed to compile macOS capture helper");
        objects.push(object);
    }
    let status = Command::new("ar")
        .arg("rcs")
        .arg(&archive)
        .args(&objects)
        .status()
        .expect("ar is required to build Vitre's macOS capture helper");
    assert!(status.success(), "failed to archive macOS capture helper");

    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=vitre_capture_window");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
    for framework in [
        "Metal",
        "QuartzCore",
        "IOSurface",
        "CoreVideo",
        "CoreImage",
        "Accelerate",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
