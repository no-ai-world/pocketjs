//! app-widget: the generic desktop App Shell for arbitrary PocketJS apps.
//!
//! The shared flat runtime lives in the note-widget library because Pocket Note
//! and ordinary apps use the same rendering/input machinery. This binary only
//! exposes the app-only entry point, which forces ordinary window chrome and
//! never enables note document/save/menu handling.

fn main() -> anyhow::Result<()> {
    // Launch the generic desktop app shell.
    note_widget::run_app()
}
