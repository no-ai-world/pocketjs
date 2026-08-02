//! note-widget binary: markdown sticky note + generic `--chrome app` shell.
//! See `lib.rs` for the implementation; this is the note-flavored entry point
//! (accepts `--chrome note | app`).

fn main() -> anyhow::Result<()> {
    note_widget::run()
}
