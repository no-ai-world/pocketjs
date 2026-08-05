//! note-widget binary: markdown sticky note + generic `--chrome app` shell.
//! See `lib.rs` for the implementation; this is the note-flavored entry point
//! (accepts `--chrome note | app`).

// Windows GUI binaries: no console window (subsystem=WINDOWS). Non-Windows
// targets ignore this attribute. Keep stdout off the main path — a GUI-launched
// process has no console, so println! would panic on the invalid handle.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() -> anyhow::Result<()> {
    note_widget::run()
}
