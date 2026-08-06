//! Embed a launcher-supplied `.ico` as the exe's icon resources on Windows.
//!
//! The desktop launchers (`tools/desktop-icon.ts`) set `POCKETJS_ICON` to the
//! validated absolute `.ico` path before `cargo build`; when it is absent no
//! icon is embedded and the exe keeps the system default. Non-Windows targets
//! never touch the Windows resource toolchain. The icon is pure launcher
//! input — it never enters the build plan, so plan hashes stay deterministic.

fn main() {
    // Rerun whenever the launcher changes its mind, including unset→set and
    // set→unset: dropping the env var must drop a previously embedded icon.
    println!("cargo:rerun-if-env-changed=POCKETJS_ICON");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let Ok(icon) = std::env::var("POCKETJS_ICON") else {
        return; // no icon requested: no resource (relink strips any old one)
    };
    let path = std::path::Path::new(&icon);
    if !path.is_file() {
        panic!(
            "POCKETJS_ICON={icon}: no such icon file \
             (the desktop launcher must validate the .ico before building)"
        );
    }
    // Rebuild when the icon file itself changes, not just the env var — an
    // in-place replace must re-embed, or the exe keeps the stale resource.
    println!("cargo:rerun-if-changed={icon}");
    let mut res = winresource::WindowsResource::new();
    res.set_icon(&icon);
    res.compile().unwrap_or_else(|error| {
        panic!("POCKETJS_ICON={icon}: winresource embed failed: {error}")
    });
}
