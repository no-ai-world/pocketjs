//! note-widget — a markdown sticky note on the desktop.
//!
//! The first *flat* pocket-widget runtime (docs/WIDGET.md): no scene, no camera —
//! the borderless window IS a live PocketJS `ui` surface, rendered by the
//! same DrawList backend as every other host and governed by the shell's
//! demand rendering: the guest ticks at 60 Hz always, a GPU frame renders
//! only when the DrawList hash moves. A settled note costs ticks
//! (microseconds), zero frames.
//!
//!   bun run note
//!   bun run note -- --file ~/notes/todo.md
//!   bun run app-widget form
//!
//! Chrome is explicit (default `--chrome app`):
//!   - `note` — ambient sticky (borderless / on-top / header drag + grip)
//!   - `app`  — ordinary OS title bar + edges for generic desktop apps
//! `bun run note` always passes `--chrome note`. Do not infer chrome from
//! the `--app` output name.
//!
//! Identity: note chrome uses `macos-widget`/`windows-widget`; ordinary
//! Windows apps use `windows-app` (or `POCKETJS_HOST`).
//! Title: optional `--title`; defaults to "Pocket Note" / `--app`.
//!
//! The host is the guest's companion process over the spec svc channel
//! (ops 30..32): real keyboard/mouse/wheel/resize go in as JSON lines,
//! save/quit intents come back. Clicks synthesize BTN_CIRCLE. Note chrome
//! keeps svc `{t:"mouse"}` for editor gestures; app chrome packs the OS
//! pointer as a touch contact for ordinary onPress apps.
//!
//! Optional external companion (bililive-style business host):
//!   --companion <program> [--companion-arg …] [--companion-cwd <dir>]
//! Guest JSON lines that are not note-local intents are forwarded to the
//! companion stdin; valid companion JSON lines are pushed to the guest svc.

pub mod cjk;
pub mod clipboard;
pub mod companion;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use anyhow::{Context, Result, anyhow};
use glam::Vec2;
use pocket_mod::Guest;
use pocket_ui_wgpu::{UiRenderer, UiSurface};
use pocket_widget::shell::{FlatWidget, WidgetConfig};
use pocket3d::gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
use pocket3d::input::{EditKey, ImeInput, Input};
use winit::keyboard::KeyCode;

/// Header strip height in logical px — mirrors HEADER_H in apps/note/app.tsx.
const HEADER_H: f32 = 30.0;
/// Header pixels reserved for the toggle/••• buttons (not a drag region).
const HEADER_BUTTONS_W: f32 = 112.0;
/// Resize grip square in the bottom-right corner, logical px.
const GRIP: f32 = 18.0;
/// The spec CIRCLE bit — the framework's onPress button.
const BTN_CIRCLE: u32 = 0x2000;
/// Ticks a scripted drag takes from press to its final position.
const DRAG_TICKS: u64 = 8;
/// Default logical minimum for a resizable desktop window.
const DEFAULT_MIN_SIZE: (u32, u32) = (240, 180);
const DEFAULT_MAX_SIZE: (u32, u32) = (4096, 4096);

/// A completed pointer click in host logical coordinates.
#[derive(Clone, Copy)]
struct PointerClick {
    press: (f32, f32),
    release: (f32, f32),
}

/// The terminal outcome of an active held pointer interaction.
#[derive(Clone, Copy)]
enum HeldRelease {
    // Release at an in-window pointer coordinate.
    Inside((f32, f32)),
    // Release after the pointer left the native window.
    Outside,
}

/// The kind of pointer level currently exposed to the guest.
#[derive(Clone, Copy)]
enum PointerOutput {
    // Represent no active pointer level.
    Up,
    // Represent a physical press that remains down or awaits its release.
    Held {
        press: (f32, f32),
        release: Option<HeldRelease>,
    },
    // Represent the release half of one synthesized click.
    Pulse(PointerClick),
}

/// How one completed input record is forwarded to the shell.
#[derive(Clone, Copy)]
enum ShellClick {
    // A click without a prior held owner needs both edges.
    Fresh(PointerClick),
    // A matching held owner already sent its down edge; only send release.
    HeldRelease(PointerClick),
}

/// One ordered pointer press waiting for a guest turn.
#[derive(Clone, Copy)]
enum PointerStart {
    // Represent one completed click.
    Pulse(PointerClick),
    // Represent one physical press that may remain held or has since released.
    Held {
        press: (f32, f32),
        release: Option<(f32, f32)>,
    },
}

impl Default for PointerOutput {
    fn default() -> Self {
        Self::Up
    }
}

/// Serialize ordered pointer presses without merging distinct coordinates.
#[derive(Default)]
struct PointerPulse {
    // Hold each press until the guest can observe its own edge.
    pending: VecDeque<PointerStart>,
    output: PointerOutput,
}

impl PointerPulse {
    /// Queue this host turn's pointer interactions in arrival order.
    fn queue(
        &mut self,
        fast_clicks: &[PointerClick],
        physical_press: Option<(f32, f32)>,
    ) -> Vec<ShellClick> {
        let mut shell_clicks = Vec::with_capacity(fast_clicks.len());
        for click in fast_clicks {
            if self.finish_held(*click) {
                shell_clicks.push(ShellClick::HeldRelease(*click));
            } else {
                self.pending.push_back(PointerStart::Pulse(*click));
                shell_clicks.push(ShellClick::Fresh(*click));
            }
        }
        if let Some(press) = physical_press {
            self.pending.push_back(PointerStart::Held {
                press,
                release: None,
            });
        }
        shell_clicks
    }

    /// Associate an in-window release with the matching physical press.
    fn finish_held(&mut self, click: PointerClick) -> bool {
        if let PointerOutput::Held { press, release } = &mut self.output
            && *press == click.press
            && release.is_none()
        {
            *release = Some(HeldRelease::Inside(click.release));
            return true;
        }
        for start in &mut self.pending {
            if let PointerStart::Held { press, release } = start
                && *press == click.press
                && release.is_none()
            {
                *release = Some(click.release);
                return true;
            }
        }
        false
    }

    /// Cancel the outstanding physical press whose release happened outside.
    fn cancel_held(&mut self) {
        if let PointerOutput::Held { release, .. } = &mut self.output
            && release.is_none()
        {
            *release = Some(HeldRelease::Outside);
            return;
        }
        if let Some(index) = self
            .pending
            .iter()
            .position(|start| matches!(start, PointerStart::Held { release: None, .. }))
        {
            self.pending.remove(index);
        }
    }

    /// Cancel queued and currently synthesized pointer activity.
    fn clear(&mut self) {
        self.pending.clear();
        self.output = PointerOutput::Up;
    }

    /// Keep a leave event behind a synthesized pulse, not a real held drag.
    fn defers_leave(&self) -> bool {
        matches!(self.output, PointerOutput::Pulse(_))
            || matches!(self.output, PointerOutput::Up) && !self.pending.is_empty()
    }

    /// Produce one guest button/contact state for this host tick.
    fn next(
        &mut self,
        physical_down: bool,
        current_position: Option<(f32, f32)>,
        released_outside: bool,
    ) -> (bool, Option<(f32, f32)>) {
        match self.output {
            PointerOutput::Pulse(click) => {
                self.output = PointerOutput::Up;
                (false, Some(click.release))
            }
            PointerOutput::Held { release, .. } => match release {
                Some(HeldRelease::Inside(position)) => {
                    self.output = PointerOutput::Up;
                    (false, Some(position))
                }
                Some(HeldRelease::Outside) => {
                    self.output = PointerOutput::Up;
                    (false, None)
                }
                None if physical_down => (true, current_position),
                None => {
                    self.output = PointerOutput::Up;
                    (
                        false,
                        (!released_outside).then_some(current_position).flatten(),
                    )
                }
            },
            PointerOutput::Up => match self.pending.pop_front() {
                Some(PointerStart::Pulse(click)) => {
                    self.output = PointerOutput::Pulse(click);
                    (true, Some(click.press))
                }
                Some(PointerStart::Held {
                    press,
                    release: Some(release),
                }) => {
                    let click = PointerClick { press, release };
                    self.output = PointerOutput::Pulse(click);
                    (true, Some(click.press))
                }
                Some(PointerStart::Held {
                    press,
                    release: None,
                }) if physical_down => {
                    self.output = PointerOutput::Held {
                        press,
                        release: None,
                    };
                    (true, Some(press))
                }
                Some(PointerStart::Held { .. }) => (false, None),
                None if physical_down && current_position.is_some() => {
                    self.output = PointerOutput::Held {
                        press: current_position.unwrap(),
                        release: None,
                    };
                    (true, current_position)
                }
                None => (false, current_position),
            },
        }
    }
}

/// Read the optional intent discriminator from an object-shaped guest message.
fn intent_type(value: &serde_json::Value) -> Option<&str> {
    value
        .as_object()
        .and_then(|object| object.get("t"))
        .and_then(serde_json::Value::as_str)
}

/// Read a required string from a guest intent.
fn intent_text<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    // Accept only JSON strings at the host boundary.
    value.get(key).and_then(|field| field.as_str())
}

/// Read a finite number from a guest intent.
fn intent_finite_f32(value: Option<&serde_json::Value>) -> Option<f32> {
    // Reject values that lose finiteness when converted to the native type.
    let number = value?.as_f64()?;
    let converted = number as f32;
    (number.is_finite() && converted.is_finite()).then_some(converted)
}

/// The guest caret rectangle, optionally anchored to a retained UI node.
#[derive(Clone, Copy, Debug, PartialEq)]
struct CaretRect {
    node: Option<i32>,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

/// Parse the guest caret rectangle accepted by the native IME bridge.
fn intent_caret(value: &serde_json::Value) -> Option<CaretRect> {
    // Require finite coordinates and a positive height; scrolled carets may be negative.
    let node = match value.get("node") {
        None => None,
        Some(field) => {
            let raw = field.as_i64()?;
            if !(1..=i32::MAX as i64).contains(&raw) {
                return None;
            }
            Some(raw as i32)
        }
    };
    let x = intent_finite_f32(value.get("x"))?;
    let y = intent_finite_f32(value.get("y"))?;
    let height = intent_finite_f32(value.get("h"))?;
    (height > 0.0).then_some(CaretRect {
        node,
        x,
        y,
        w: 1.0,
        h: height,
    })
}

/// Replace a same-directory temporary file with the saved document.
fn replace_file(tmp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let tmp: Vec<u16> = tmp
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let target: Vec<u16> = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let replaced = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                tmp.as_ptr(),
                target.as_ptr(),
                windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                    | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
            )
        };
        if replaced == 0 {
            return Err(std::io::Error::last_os_error());
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        std::fs::rename(tmp, target)
    }
}

struct NoteGame {
    surface: UiSurface,
    guest: Guest,
    renderer: Option<UiRenderer>,
    /// Runtime CJK atlas extension (IME input → system-font glyphs).
    atlases: cjk::CjkAtlases,
    /// Caret rect reported by the guest (logical px) — docks the IME
    /// candidate window.
    caret_rect: Option<CaretRect>,
    file: PathBuf,
    /// Current logical viewport (the core's), tracked against the window.
    logical: (u32, u32),
    /// DrawList words of the latest tick + their hash (the dirty signal).
    words: Vec<u32>,
    hash: u64,
    dirty: bool,
    exit: bool,
    booted: bool,
    /// Last (x, y, primary-down) sent over svc — mouse lines go out on any
    /// change, including press/release without movement.
    last_mouse: Option<(f32, f32, bool)>,
    /// Whether the effective cursor was present in the previous tick.
    cursor_present: bool,
    /// A leave deferred until a synthesized click pulse has released.
    pending_cursor_leave: bool,
    /// The guest's ••• menu is up: stop claiming header drags/resizes so
    /// clicks anywhere reach the backdrop and close it.
    guest_menu_open: bool,
    /// True only for the note guest — generic desktop apps must not lose
    /// clicks to the note header drag affordance.
    note_chrome: bool,
    /// Window scale factor from the latest tick (cursor px → logical).
    scale: f64,
    ticks: u64,
    /// Headless scripting (--type/--click/--key events by frame).
    script: Vec<(u64, ScriptEvent)>,
    /// Scripted click: CIRCLE held until this tick.
    script_click_until: u64,
    /// Scripted shift modifier (held while a ShiftClick plays out).
    script_shift: bool,
    /// Scripted drag in flight: (x0, y0, x1, y1, start tick).
    script_drag: Option<(f32, f32, f32, f32, u64)>,
    quit_after: Option<u64>,
    /// Optional external companion (JSON lines on stdio).
    companion: Option<companion::CompanionBridge>,
    /// Serializes pointer button pulses across guest turns.
    pointer_pulse: PointerPulse,
}

enum ScriptEvent {
    Click(f32, f32),
    ShiftClick(f32, f32),
    /// Press at (x0,y0), sweep to (x1,y1) over a few ticks, release.
    Drag(f32, f32, f32, f32),
    Type(String),
    Key(String),
    Paste(String),
    /// Scripted IME composition (cursor at the end).
    Preedit(String),
    Scroll(f32),
}

impl NoteGame {
    fn new(
        surface: UiSurface,
        guest: Guest,
        atlases: cjk::CjkAtlases,
        file: PathBuf,
        logical: (u32, u32),
        note_chrome: bool,
    ) -> Self {
        NoteGame {
            surface,
            guest,
            renderer: None,
            atlases,
            caret_rect: None,
            file,
            logical,
            words: Vec::new(),
            hash: 0,
            dirty: true,
            exit: false,
            booted: false,
            last_mouse: None,
            cursor_present: false,
            pending_cursor_leave: false,
            guest_menu_open: false,
            note_chrome,
            scale: 1.0,
            ticks: 0,
            script: Vec::new(),
            script_click_until: 0,
            script_shift: false,
            script_drag: None,
            quit_after: None,
            companion: None,
            pointer_pulse: PointerPulse::default(),
        }
    }

    fn svc(&self, value: serde_json::Value) {
        self.surface.svc_push(value.to_string());
    }

    /// 壳事件：统一打 src=shell，避免与 companion 业务 hello 冲突。
    fn shell_svc(&self, mut value: serde_json::Value) {
        if let Some(obj) = value.as_object_mut() {
            obj.entry("src")
                .or_insert_with(|| serde_json::json!("shell"));
        }
        self.svc(value);
    }

    /// companion 行：打 src=companion，guest 用 connectCompanion 过滤。
    fn companion_svc(&self, line: &str) {
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(mut value) => {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("src".into(), serde_json::json!("companion"));
                }
                self.svc(value);
            }
            Err(error) => {
                log::warn!("note-widget: dropping invalid companion JSON line: {error}");
            }
        }
    }

    /// Tell the mounted framework to resize app + overlay roots.
    fn call_resize_viewport(&self, w: u32, h: u32) -> Result<()> {
        // 调用 guest 的 live-viewport hook
        self.guest.with(|ctx| -> Result<()> {
            use pocket_mod::qjs::{Function, Value};
            use std::sync::atomic::{AtomicBool, Ordering};
            static WARNED_MISSING: AtomicBool = AtomicBool::new(false);
            let globals = ctx.globals();
            let Ok(hook) = globals.get::<_, Value>("__pocketResizeViewport") else {
                if !WARNED_MISSING.swap(true, Ordering::Relaxed) {
                    log::warn!(
                        "note-widget: __pocketResizeViewport missing; live resize will leave app/overlay layers stale"
                    );
                }
                return Ok(());
            };
            if !Function::from_value(hook.clone()).is_ok() {
                if !WARNED_MISSING.swap(true, Ordering::Relaxed) {
                    log::warn!(
                        "note-widget: __pocketResizeViewport is not a function; live resize will leave layers stale"
                    );
                }
                return Ok(());
            }
            let hook = Function::from_value(hook)
                .map_err(|e| anyhow!("__pocketResizeViewport: {e}"))?;
            hook.call::<_, ()>((w as f64, h as f64))
                .map_err(|e| anyhow!("__pocketResizeViewport threw: {e}"))?;
            Ok(())
        })
    }

    /// Rasterize any codepoints `text` needs that the baked atlases lack,
    /// and reload the grown slots — call BEFORE pushing text to the guest
    /// so its very first measure sees real glyphs, never tofu.
    fn ensure_text(&mut self, text: &str) {
        for blob in self.atlases.ensure(text) {
            self.surface.with_ui(|ui| {
                if !ui.load_font_atlas(&blob) {
                    log::warn!("note-widget: extended atlas rejected by the core");
                }
            });
        }
    }

    /// The svc hello: viewport first, then the document (order matters — the
    /// app lays text out against the viewport it was just told about).
    fn send_hello(&mut self) -> Result<()> {
        self.shell_svc(serde_json::json!({"t": "hello", "w": self.logical.0, "h": self.logical.1}));
        let text = match std::fs::read_to_string(&self.file) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("reading note document {}", self.file.display()));
            }
        };
        if !text.is_empty() {
            self.ensure_text(&text);
            self.shell_svc(serde_json::json!({"t": "load", "text": text}));
        }
        log::info!(
            "note-widget: {} ({} bytes)",
            self.file.display(),
            text.len()
        );
        Ok(())
    }

    /// 通用 app 壳 hello：只报视口，不夹带 note load/文档语义。
    fn send_shell_hello(&mut self) {
        self.shell_svc(serde_json::json!({"t": "hello", "w": self.logical.0, "h": self.logical.1}));
    }

    fn save(&self, text: &str) {
        // Same-directory replacement keeps the write visible as one file update.
        let tmp = self.file.with_extension("md.tmp");
        let write = std::fs::write(&tmp, text).and_then(|()| replace_file(&tmp, &self.file));
        match write {
            Ok(()) => log::info!("note-widget: saved {} bytes", text.len()),
            Err(e) => log::warn!("note-widget: save failed: {e}"),
        }
    }

    fn forward_edits(&mut self, input: &Input) {
        // Batch runs of typed chars into one line; platform shortcut chords
        // are commands, not text.
        let shift = input.key_down(KeyCode::ShiftLeft) || input.key_down(KeyCode::ShiftRight);
        let mut chars = String::new();
        for key in input.edits() {
            let named = match key {
                EditKey::Char(c) => {
                    if !input.shortcut_down() {
                        chars.push(*c);
                    }
                    continue;
                }
                EditKey::Backspace => "Backspace",
                EditKey::Delete => "Delete",
                EditKey::Enter => "Enter",
                EditKey::Tab => "Tab",
                EditKey::Left => "Left",
                EditKey::Right => "Right",
                EditKey::Up => "Up",
                EditKey::Down => "Down",
                EditKey::Home => "Home",
                EditKey::End => "End",
                EditKey::PageUp => "PageUp",
                EditKey::PageDown => "PageDown",
                EditKey::Escape => "Escape",
            };
            if !chars.is_empty() {
                let batch = std::mem::take(&mut chars);
                self.ensure_text(&batch);
                self.shell_svc(serde_json::json!({"t": "ch", "s": batch}));
            }
            self.shell_svc(serde_json::json!({"t": "key", "k": named, "sh": shift}));
        }
        if !chars.is_empty() {
            self.ensure_text(&chars);
            self.shell_svc(serde_json::json!({"t": "ch", "s": chars}));
        }
    }

    /// Forward IME composition: preedit text (with a JS UTF-16 cursor) and
    /// commits. Plain typing never lands here (winit sends it as KeyEvents
    /// while the IME state is Ground), so there is no double-input path.
    fn forward_ime(&mut self, input: &Input) {
        for ev in input.ime_events().to_vec() {
            match ev {
                ImeInput::Preedit(text, range) => {
                    self.ensure_text(&text);
                    let cursor = range.map(|(lo, _)| text[..lo].encode_utf16().count());
                    self.shell_svc(serde_json::json!({"t": "ime", "s": text, "c": cursor}));
                }
                ImeInput::Commit(text) => {
                    self.ensure_text(&text);
                    self.shell_svc(serde_json::json!({"t": "ch", "s": text}));
                }
                ImeInput::Enabled => {}
                ImeInput::Disabled => {
                    self.shell_svc(serde_json::json!({"t": "ime", "s": "", "c": null}));
                }
            }
        }
    }

    fn run_script(&mut self) {
        let due: Vec<usize> = self
            .script
            .iter()
            .enumerate()
            .filter(|(_, (at, _))| *at == self.ticks)
            .map(|(i, _)| i)
            .collect();
        for i in due.into_iter().rev() {
            let (_, ev) = self.script.remove(i);
            match ev {
                ScriptEvent::Click(x, y) => {
                    // Hold CIRCLE + script_drag position. Note chrome also
                    // hovers via svc mouse; app chrome relies on touch contacts.
                    if self.note_chrome {
                        self.shell_svc(
                            serde_json::json!({"t": "mouse", "x": x, "y": y, "d": false}),
                        );
                    }
                    self.script_click_until = self.ticks + 4;
                    self.script_shift = false;
                    self.script_drag = Some((x, y, x, y, self.ticks));
                }
                ScriptEvent::ShiftClick(x, y) => {
                    if self.note_chrome {
                        self.shell_svc(
                            serde_json::json!({"t": "mouse", "x": x, "y": y, "d": false, "sh": true}),
                        );
                    }
                    self.script_click_until = self.ticks + 4;
                    self.script_shift = true;
                    self.script_drag = Some((x, y, x, y, self.ticks));
                }
                ScriptEvent::Drag(x0, y0, x1, y1) => {
                    if self.note_chrome {
                        self.shell_svc(
                            serde_json::json!({"t": "mouse", "x": x0, "y": y0, "d": false}),
                        );
                    }
                    self.script_click_until = self.ticks + DRAG_TICKS + 2;
                    self.script_drag = Some((x0, y0, x1, y1, self.ticks));
                }
                ScriptEvent::Type(s) => {
                    self.ensure_text(&s);
                    self.shell_svc(serde_json::json!({"t": "ch", "s": s}));
                }
                ScriptEvent::Paste(text) => {
                    self.ensure_text(&text);
                    self.shell_svc(serde_json::json!({"t": "paste", "text": text}));
                }
                ScriptEvent::Preedit(text) => {
                    self.ensure_text(&text);
                    let n = text.encode_utf16().count();
                    self.shell_svc(serde_json::json!({"t": "ime", "s": text, "c": n}));
                }
                ScriptEvent::Key(k) => self.shell_svc(serde_json::json!({"t": "key", "k": k})),
                ScriptEvent::Scroll(dy) => {
                    self.shell_svc(serde_json::json!({"t": "scroll", "dy": dy}))
                }
            }
        }
    }
}

impl FlatWidget for NoteGame {
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()> {
        self.renderer = Some(UiRenderer::new(gpu, format));
        Ok(())
    }

    fn tick(&mut self, _dt: f32, input: &Input, window_px: (u32, u32), scale: f64) -> Result<()> {
        self.scale = scale;
        if !self.booted {
            self.booted = true;
            // Note chrome: viewport + document. App chrome: viewport-only shell hello.
            if self.note_chrome {
                self.send_hello()?;
            } else {
                self.send_shell_hello();
            }
        }

        // Command/Control+Q/W quit (the widget has no titlebar close button).
        if input.shortcut_down()
            && (input.key_pressed(KeyCode::KeyQ) || input.key_pressed(KeyCode::KeyW))
        {
            self.exit = true;
        }
        // Command/Control+Z/A/C/X/V → guest editing chords (chars are
        // suppressed under the shortcut modifier).
        if input.shortcut_down() && input.key_pressed(KeyCode::KeyZ) {
            let redo = input.key_down(KeyCode::ShiftLeft) || input.key_down(KeyCode::ShiftRight);
            self.shell_svc(
                serde_json::json!({"t": "key", "k": if redo { "Redo" } else { "Undo" }}),
            );
        }
        if input.shortcut_down() && input.key_pressed(KeyCode::KeyA) {
            self.shell_svc(serde_json::json!({"t": "key", "k": "SelectAll"}));
        }
        if input.shortcut_down() && input.key_pressed(KeyCode::KeyC) {
            self.shell_svc(serde_json::json!({"t": "key", "k": "Copy"}));
        }
        if input.shortcut_down() && input.key_pressed(KeyCode::KeyX) {
            self.shell_svc(serde_json::json!({"t": "key", "k": "Cut"}));
        }
        if input.shortcut_down()
            && input.key_pressed(KeyCode::KeyV)
            && let Some(text) = clipboard::paste()
            && !text.is_empty()
        {
            self.ensure_text(&text);
            self.shell_svc(serde_json::json!({"t": "paste", "text": text}));
        }
        if let Some(limit) = self.quit_after
            && self.ticks >= limit
        {
            self.exit = true;
        }

        // Window → core viewport + framework app/overlay roots.
        // set_viewport alone only resizes the native root; generic apps need
        // globalThis.__pocketResizeViewport so mount layers follow the window
        // (otherwise the new area stays uncleared black on opaque demos).
        let logical = (
            ((window_px.0 as f64 / scale).round() as u32).max(1),
            ((window_px.1 as f64 / scale).round() as u32).max(1),
        );
        if logical != self.logical {
            self.logical = logical;
            self.surface
                .with_ui(|ui| ui.set_viewport(logical.0 as f32, logical.1 as f32));
            self.call_resize_viewport(logical.0, logical.1)?;
            self.shell_svc(serde_json::json!({"t": "resize", "w": logical.0, "h": logical.1}));
            self.dirty = true;
        }

        // Cancel guest pointer/editing state when the native window loses focus.
        if input.interaction_cancelled() {
            self.last_mouse = None;
            self.script_click_until = 0;
            self.script_shift = false;
            self.script_drag = None;
            self.caret_rect = None;
            self.cursor_present = false;
            self.pending_cursor_leave = false;
            self.pointer_pulse.clear();
            self.shell_svc(serde_json::json!({"t": "blur"}));
        }
        if input.interaction_restored() {
            self.shell_svc(serde_json::json!({"t": "focus"}));
        }

        // Keyboard / wheel / pointer → svc lines (logical px).
        self.forward_edits(input);
        self.forward_ime(input);
        let scroll = input.scroll();
        if scroll.y != 0.0 {
            self.shell_svc(serde_json::json!({"t": "scroll", "dy": scroll.y / scale as f32}));
        }
        // Headless script events (windowed runs have none).
        if !self.script.is_empty() {
            self.run_script();
        }
        let script_down = self.ticks < self.script_click_until;
        let physical_down = input.mouse_button_down(winit::event::MouseButton::Left);
        // Only a press edge from this turn may start a new queued held state;
        // an already-held button must not enqueue itself again every tick.
        let physical_press = physical_down
            .then(|| {
                input
                    .mouse_button_press_positions(winit::event::MouseButton::Left)
                    .pop()
            })
            .flatten()
            .map(|point| (point.x / scale as f32, point.y / scale as f32));
        let fast_clicks = input
            .mouse_button_clicks(winit::event::MouseButton::Left)
            .into_iter()
            .map(|click| PointerClick {
                press: (click.press.x / scale as f32, click.press.y / scale as f32),
                release: (
                    click.release.x / scale as f32,
                    click.release.y / scale as f32,
                ),
            })
            .collect::<Vec<_>>();
        let release_outside = input.mouse_button_released_outside(winit::event::MouseButton::Left);
        let level_down = physical_down || script_down;
        let mouse_down = level_down || !fast_clicks.is_empty();

        // Pointer → svc: one line per (position, button) change, so the
        // guest sees press and release edges even without movement. A
        // release with the cursor gone reuses the last known position.
        let scripted_pos = if let Some((x0, y0, x1, y1, start)) = self.script_drag {
            let t = ((self.ticks.saturating_sub(start)) as f32 / DRAG_TICKS as f32).min(1.0);
            if t >= 1.0 && !script_down {
                self.script_drag = None;
                self.script_shift = false;
            }
            Some((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
        } else {
            None
        };
        let cursor_pos = input
            .cursor()
            .map(|c| (c.x / scale as f32, c.y / scale as f32));
        // The press snapshot wins over a later move in the same host turn so
        // a physical press keeps its actual hit position.
        let current_pointer_pos = scripted_pos.or(physical_press).or(cursor_pos);
        let cursor_present = scripted_pos.is_some() || cursor_pos.is_some();
        let cursor_entered = cursor_present && !self.cursor_present;
        let cursor_left = !cursor_present && self.cursor_present;
        self.cursor_present = cursor_present;
        if cursor_present {
            self.pending_cursor_leave = false;
        }
        if cursor_left {
            self.pending_cursor_leave = true;
        }
        let shell_pos =
            current_pointer_pos.or_else(|| last_mouse_release(self.last_mouse, mouse_down));
        if release_outside {
            self.pointer_pulse.cancel_held();
        }
        let shell_clicks = self.pointer_pulse.queue(&fast_clicks, physical_press);
        let (pointer_down, guest_pointer_pos) =
            self.pointer_pulse
                .next(level_down, current_pointer_pos, release_outside);
        let shift = input.key_down(KeyCode::ShiftLeft)
            || input.key_down(KeyCode::ShiftRight)
            || self.script_shift;

        // Preserve every completed interaction's original coordinate for shell
        // consumers, without repeating the down edge of an existing held press.
        for shell_click in shell_clicks {
            let (click, send_press) = match shell_click {
                ShellClick::Fresh(click) => (click, true),
                ShellClick::HeldRelease(click) => (click, false),
            };
            if send_press {
                self.shell_svc(serde_json::json!({
                    "t": "mouse",
                    "x": click.press.0,
                    "y": click.press.1,
                    "d": true,
                    "sh": shift,
                }));
            }
            self.shell_svc(serde_json::json!({
                "t": "mouse",
                "x": click.release.0,
                "y": click.release.1,
                "d": false,
                "sh": shift,
            }));
            self.last_mouse = Some((click.release.0, click.release.1, false));
        }
        if (level_down || fast_clicks.is_empty())
            && let Some((x, y)) = shell_pos
        {
            let mouse = (x, y, mouse_down);
            if cursor_entered || self.last_mouse != Some(mouse) {
                self.last_mouse = Some(mouse);
                self.shell_svc(serde_json::json!({
                    "t": "mouse",
                    "x": x,
                    "y": y,
                    "d": mouse_down,
                    "sh": shift,
                    "outside": release_outside,
                }));
            }
        }
        if self.pending_cursor_leave && !cursor_present && !self.pointer_pulse.defers_leave() {
            self.pending_cursor_leave = false;
            self.shell_svc(serde_json::json!({"t": "mouse_leave"}));
        }

        // External companion → guest before the guest turn. Tag src=companion
        // and bake unseen CJK so dynamic host text is not tofu.
        if let Some(bridge) = self.companion.as_mut() {
            let (lines, became_offline) = bridge.poll();
            for line in lines {
                self.ensure_text(&line);
                self.companion_svc(&line);
            }
            if became_offline {
                self.shell_svc(serde_json::json!({"t": "companion_offline"}));
            }
        }

        // The guest turn (Law 3: exactly one per tick). Pointer events are
        // also delivered over svc so TextInput can place its caret; ordinary
        // app targets additionally use the pointer wire form for Focusable.
        let buttons = pointer_buttons(pointer_down);
        if let Some((x, y)) = guest_pointer_pos {
            self.guest
                .frame_with_touches(buttons, 0x8080, &[pack_pointer_position(x, y)])?;
        } else {
            self.guest.frame(buttons)?;
        }
        self.surface.tick();

        // Guest → host intents: only note chrome owns note-local messages;
        // app-widget forwards those names to the companion as ordinary business data.
        for line in self.surface.svc_drain() {
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => match intent_type(&v) {
                    Some("save") if self.note_chrome => match intent_text(&v, "text") {
                        Some(text) => self.save(text),
                        None => log::warn!("note-widget: invalid save intent"),
                    },
                    Some("quit") if self.note_chrome => self.exit = true,
                    Some("menu") if self.note_chrome => {
                        match v.get("open").and_then(|field| field.as_bool()) {
                            Some(open) => self.guest_menu_open = open,
                            None => log::warn!("note-widget: invalid menu intent"),
                        }
                    }
                    Some("copy") => match intent_text(&v, "text") {
                        Some(text) => clipboard::copy(text),
                        None => log::warn!("note-widget: invalid copy intent"),
                    },
                    Some("ensure_text") => match intent_text(&v, "text") {
                        Some(text) => self.ensure_text(text),
                        None => log::warn!("note-widget: invalid ensure_text intent"),
                    },
                    Some("caret") => match intent_caret(&v) {
                        Some(rect) => self.caret_rect = Some(rect),
                        None => log::warn!("note-widget: invalid caret intent"),
                    },
                    Some("caret_clear") => self.caret_rect = None,
                    _ if self.companion.is_some() => {
                        if let Some(bridge) = self.companion.as_mut()
                            && let Err(e) = bridge.send_line(&line)
                        {
                            log::warn!("note-widget: companion send failed: {e}");
                        }
                    }
                    other => log::warn!("note-widget: unknown intent {other:?}"),
                },
                Err(e) => log::warn!("note-widget: bad svc line from guest: {e}"),
            }
        }

        // DrawList content hash → demand rendering (embed.rs's trick, flat).
        let (hash, words) = self.surface.with_ui(|ui| {
            let words = &ui.draw().words;
            let hash = fnv1a64(words);
            (hash, (hash != self.hash).then(|| words.clone()))
        });
        if let Some(words) = words {
            log::debug!("note-widget: DrawList changed at tick {}", self.ticks);
            self.words = words;
            self.hash = hash;
            self.dirty = true;
        }

        self.ticks += 1;
        Ok(())
    }

    fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    fn render(&mut self, gpu: &Gpu, view: &wgpu::TextureView, window_px: (u32, u32)) -> Result<()> {
        let renderer = self.renderer.as_mut().expect("init ran");
        // Render at the WINDOW's scale factor, never at a window/viewport
        // ratio: mid-resize the surface and the last-ticked viewport differ
        // by sub-pixel rounding, and a fractional ratio re-scales every
        // glyph — visible as font/position jitter while dragging the grip.
        // At the true scale a stale viewport is at most one physical px of
        // clipped edge for one frame; a resize is a relayout, never a zoom.
        let scale = if self.scale > 0.0 {
            self.scale as f32
        } else {
            1.0
        };
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        self.surface.with_ui(|ui| {
            renderer.render_words_scaled(
                gpu,
                ui,
                &self.words,
                &mut encoder,
                view,
                window_px,
                scale,
                // Transparent clear: the app's rounded-xl background is the
                // window shape; the corners really are see-through.
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            )
        })?;
        gpu.queue.submit([encoder.finish()]);
        Ok(())
    }

    fn drag_at(&mut self, cursor: Vec2) -> bool {
        // Decorated desktop demos leave move/resize to the OS title bar and
        // edges. Only the borderless note sticky needs an in-content handle.
        if !self.note_chrome || self.guest_menu_open {
            return false;
        }
        let (x, y) = (cursor.x / self.scale as f32, cursor.y / self.scale as f32);
        y < HEADER_H && x < self.logical.0 as f32 - HEADER_BUTTONS_W
    }

    fn resize_at(&mut self, cursor: Vec2) -> bool {
        // Same split: OS edges for decorated demos; grip only for note.
        if !self.note_chrome || self.guest_menu_open {
            return false;
        }
        let (x, y) = (cursor.x / self.scale as f32, cursor.y / self.scale as f32);
        x > self.logical.0 as f32 - GRIP && y > self.logical.1 as f32 - GRIP
    }

    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)> {
        let caret = self.caret_rect?;
        let rect = match caret.node {
            Some(node) => self
                .surface
                .with_ui(|ui| ui.node_screen_rect(node, caret.x, caret.y, caret.w, caret.h)),
            None => Some((caret.x, caret.y, caret.w, caret.h)),
        }?;
        let s = self.scale as f32;
        Some((rect.0 * s, rect.1 * s, rect.2 * s, rect.3 * s))
    }

    fn wants_exit(&self) -> bool {
        self.exit
    }
}

/// FNV-1a 64 over the DrawList words (embed.rs's dirty signal).
/// Pack the primary Windows pointer without the 1023px limit of the
/// legacy touch form (framework/src/touch.ts `__packTouchDesktop`).
fn pack_pointer_position(x: f32, y: f32) -> u32 {
    const MARKER: u32 = 0xc000_0000;
    const COORD_BITS: u32 = 15;
    const MASK: f32 = 32_767.0;
    let x = x.round().clamp(0.0, MASK) as u32;
    let y = y.round().clamp(0.0, MASK) as u32;
    MARKER | (y << COORD_BITS) | x
}

/// Reuse the last in-window point only for a release edge.
fn last_mouse_release(
    last_mouse: Option<(f32, f32, bool)>,
    mouse_down: bool,
) -> Option<(f32, f32)> {
    last_mouse
        .filter(|(_, _, last_down)| !mouse_down && *last_down)
        .map(|(x, y, _)| (x, y))
}

/// Generate the guest press button from the physical pointer level.
fn pointer_buttons(mouse_down: bool) -> u32 {
    mouse_down.then_some(BTN_CIRCLE).unwrap_or(0)
}

fn fnv1a64(words: &[u32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for w in words {
        for b in w.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

// ---------------------------------------------------------------------------
// boot + CLI
// ---------------------------------------------------------------------------

/// Desktop window chrome policy for the stock host.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ChromeMode {
    /// Borderless ambient sticky: in-content drag/resize grip.
    Note,
    /// Ordinary OS title bar + edges.
    App,
}

impl ChromeMode {
    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "note" | "sticky" => Ok(Self::Note),
            "app" | "window" | "decorated" => Ok(Self::App),
            other => Err(anyhow!(
                "unsupported --chrome '{other}' (expected note|app)"
            )),
        }
    }
}

struct Args {
    app: String,
    js: Option<PathBuf>,
    pak: Option<PathBuf>,
    plan: Option<PathBuf>,
    file: Option<PathBuf>,
    size: (u32, u32),
    size_overrides: (bool, bool),
    density: u32,
    /// Optional override for ui.__host (desktop target id).
    host: Option<String>,
    /// Window chrome: sticky note affordances vs ordinary OS decorations.
    /// Default is App; note launchers must pass `--chrome note` explicitly.
    chrome: ChromeMode,
    /// Lock an ordinary app window to its fixed manifest viewport.
    fixed: bool,
    /// Optional window title; defaults depend on chrome mode.
    title: Option<String>,
    /// Optional logical window floor for dynamic app chrome.
    min_size: Option<(u32, u32)>,
    /// Optional logical window ceiling for dynamic app chrome.
    max_size: Option<(u32, u32)>,
    screenshot: Option<PathBuf>,
    frames: u64,
    script: Vec<(u64, ScriptEvent)>,
    auto_quit: Option<f32>,
    /// External companion program (JSON lines on stdio).
    companion: Option<PathBuf>,
    /// Extra args for the companion program.
    companion_args: Vec<String>,
    /// Working directory for the companion program.
    companion_cwd: Option<PathBuf>,
}

/// Parse a logical window bound from the launcher's `WIDTHxHEIGHT` form.
fn parse_size(raw: &str, flag: &str) -> Result<(u32, u32)> {
    let (width, height) = raw
        .split_once('x')
        .ok_or_else(|| anyhow!("{flag} wants WIDTHxHEIGHT"))?;
    let width = width
        .parse()
        .with_context(|| format!("invalid {flag} width"))?;
    let height = height
        .parse()
        .with_context(|| format!("invalid {flag} height"))?;
    if width == 0 || height == 0 {
        return Err(anyhow!("{flag} wants positive dimensions"));
    }
    Ok((width, height))
}

/// Read the resolved logical default from a launcher build plan.
fn plan_default_size(path: &Path) -> Result<(u32, u32)> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading build plan {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parsing build plan {}", path.display()))?;
    let logical = value
        .get("viewport")
        .and_then(|viewport| viewport.get("logical"))
        .and_then(|logical| logical.as_array())
        .filter(|logical| logical.len() == 2)
        .ok_or_else(|| anyhow!("build plan {} has no viewport.logical", path.display()))?;
    let width = logical[0]
        .as_u64()
        .filter(|value| *value > 0 && *value <= u32::MAX as u64)
        .ok_or_else(|| {
            anyhow!(
                "build plan {} has an invalid viewport width",
                path.display()
            )
        })? as u32;
    let height = logical[1]
        .as_u64()
        .filter(|value| *value > 0 && *value <= u32::MAX as u64)
        .ok_or_else(|| {
            anyhow!(
                "build plan {} has an invalid viewport height",
                path.display()
            )
        })? as u32;
    Ok((width, height))
}

/// Apply plan defaults without overriding explicit command-line dimensions.
fn apply_plan_defaults(args: &mut Args) -> Result<()> {
    let Some(path) = args.plan.as_deref() else {
        return Ok(());
    };
    let (width, height) = plan_default_size(path)?;
    if !args.size_overrides.0 {
        args.size.0 = width;
    }
    if !args.size_overrides.1 {
        args.size.1 = height;
    }
    Ok(())
}

/// Validate the launcher-resolved target contract for a desktop host boot.
fn validate_resolved_plan(path: Option<&Path>, expected_id: &str, expected_abi: u32) -> Result<()> {
    let path = path.ok_or_else(|| anyhow!("desktop host requires a resolved --plan"))?;
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading build plan {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parsing build plan {}", path.display()))?;
    let target = value
        .get("target")
        .ok_or_else(|| anyhow!("build plan {} has no target", path.display()))?;
    let actual_id = target
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("build plan {} has no target.id", path.display()))?;
    let actual_abi = target
        .get("hostAbi")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| anyhow!("build plan {} has no target.hostAbi", path.display()))?;
    if actual_id != expected_id || actual_abi != u64::from(expected_abi) {
        return Err(anyhow!(
            "build plan target {} ABI {} does not match host {} ABI {}",
            actual_id,
            actual_abi,
            expected_id,
            expected_abi
        ));
    }
    Ok(())
}

/// Reject contradictory or out-of-contract logical window bounds.
fn validate_size_bounds(args: &Args) -> Result<()> {
    let min = args.min_size.unwrap_or(DEFAULT_MIN_SIZE);
    let max = args.max_size.unwrap_or(DEFAULT_MAX_SIZE);
    if min.0 < DEFAULT_MIN_SIZE.0 || min.1 < DEFAULT_MIN_SIZE.1 {
        return Err(anyhow!(
            "window minimum {}x{} is below the desktop target minimum {}x{}",
            min.0,
            min.1,
            DEFAULT_MIN_SIZE.0,
            DEFAULT_MIN_SIZE.1
        ));
    }
    if max.0 > DEFAULT_MAX_SIZE.0 || max.1 > DEFAULT_MAX_SIZE.1 {
        return Err(anyhow!(
            "window maximum {}x{} exceeds the desktop target maximum {}x{}",
            max.0,
            max.1,
            DEFAULT_MAX_SIZE.0,
            DEFAULT_MAX_SIZE.1
        ));
    }
    if min.0 > max.0 || min.1 > max.1 {
        return Err(anyhow!(
            "window minimum {}x{} exceeds maximum {}x{}",
            min.0,
            min.1,
            max.0,
            max.1
        ));
    }
    if args.size.0 < min.0 || args.size.1 < min.1 || args.size.0 > max.0 || args.size.1 > max.1 {
        return Err(anyhow!(
            "initial window size {}x{} is outside {}x{}..{}x{}",
            args.size.0,
            args.size.1,
            min.0,
            min.1,
            max.0,
            max.1
        ));
    }
    Ok(())
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        app: "note-main".into(),
        js: None,
        pak: None,
        plan: None,
        file: None,
        size: (420, 560),
        size_overrides: (false, false),
        density: 2,
        host: None,
        chrome: ChromeMode::App,
        fixed: false,
        title: None,
        min_size: None,
        max_size: None,
        screenshot: None,
        frames: 40,
        script: Vec::new(),
        auto_quit: None,
        companion: None,
        companion_args: Vec::new(),
        companion_cwd: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = |name: &str| -> Result<String> {
            it.next().ok_or_else(|| anyhow!("{name} needs a value"))
        };
        /// `spec@frame` → (frame, spec).
        fn at(v: &str, flag: &str) -> Result<(u64, String)> {
            let (spec, frame) = v
                .rsplit_once('@')
                .ok_or_else(|| anyhow!("{flag} wants value@frame"))?;
            Ok((frame.parse()?, spec.to_string()))
        }
        match a.as_str() {
            "--app" => args.app = val("--app")?,
            "--js" => args.js = Some(PathBuf::from(val("--js")?)),
            "--pak" => args.pak = Some(PathBuf::from(val("--pak")?)),
            "--plan" => args.plan = Some(PathBuf::from(val("--plan")?)),
            "--file" => args.file = Some(PathBuf::from(val("--file")?)),
            "--width" => {
                args.size.0 = val("--width")?.parse()?;
                args.size_overrides.0 = true;
            }
            "--height" => {
                args.size.1 = val("--height")?.parse()?;
                args.size_overrides.1 = true;
            }
            "--density" => args.density = val("--density")?.parse()?,
            "--host" => args.host = Some(val("--host")?),
            "--chrome" => args.chrome = ChromeMode::parse(&val("--chrome")?)?,
            "--fixed" => args.fixed = true,
            "--title" => args.title = Some(val("--title")?),
            "--min-size" => args.min_size = Some(parse_size(&val("--min-size")?, "--min-size")?),
            "--max-size" => args.max_size = Some(parse_size(&val("--max-size")?, "--max-size")?),
            "--companion" => args.companion = Some(PathBuf::from(val("--companion")?)),
            "--companion-arg" => args.companion_args.push(val("--companion-arg")?),
            "--companion-cwd" => args.companion_cwd = Some(PathBuf::from(val("--companion-cwd")?)),
            "--screenshot" => args.screenshot = Some(PathBuf::from(val("--screenshot")?)),
            "--frames" => args.frames = val("--frames")?.parse()?,
            "--click" => {
                let (frame, spec) = at(&val("--click")?, "--click")?;
                let (x, y) = spec
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--click wants x,y@frame"))?;
                args.script.push((
                    frame,
                    ScriptEvent::Click(x.trim().parse()?, y.trim().parse()?),
                ));
            }
            "--shift-click" => {
                let (frame, spec) = at(&val("--shift-click")?, "--shift-click")?;
                let (x, y) = spec
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--shift-click wants x,y@frame"))?;
                args.script.push((
                    frame,
                    ScriptEvent::ShiftClick(x.trim().parse()?, y.trim().parse()?),
                ));
            }
            "--drag" => {
                let (frame, spec) = at(&val("--drag")?, "--drag")?;
                let (from, to) = spec
                    .split_once('-')
                    .ok_or_else(|| anyhow!("--drag wants x0,y0-x1,y1@frame"))?;
                let (x0, y0) = from
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--drag wants x0,y0-x1,y1@frame"))?;
                let (x1, y1) = to
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--drag wants x0,y0-x1,y1@frame"))?;
                args.script.push((
                    frame,
                    ScriptEvent::Drag(
                        x0.trim().parse()?,
                        y0.trim().parse()?,
                        x1.trim().parse()?,
                        y1.trim().parse()?,
                    ),
                ));
            }
            "--type" => {
                let (frame, s) = at(&val("--type")?, "--type")?;
                args.script.push((frame, ScriptEvent::Type(s)));
            }
            "--key" => {
                let (frame, k) = at(&val("--key")?, "--key")?;
                args.script.push((frame, ScriptEvent::Key(k)));
            }
            "--paste" => {
                let (frame, text) = at(&val("--paste")?, "--paste")?;
                args.script.push((frame, ScriptEvent::Paste(text)));
            }
            "--preedit" => {
                let (frame, text) = at(&val("--preedit")?, "--preedit")?;
                args.script.push((frame, ScriptEvent::Preedit(text)));
            }
            "--scroll" => {
                let (frame, dy) = at(&val("--scroll")?, "--scroll")?;
                args.script.push((frame, ScriptEvent::Scroll(dy.parse()?)));
            }
            "--auto-quit" => args.auto_quit = Some(val("--auto-quit")?.parse()?),
            other => return Err(anyhow!("unknown flag {other}")),
        }
    }
    apply_plan_defaults(&mut args)?;
    validate_size_bounds(&args)?;
    Ok(args)
}

/// `<repo>/dist` — relative to this crate in the source tree, or
/// POCKETJS_DIST, or ./dist for standalone binaries.
fn dist_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("POCKETJS_DIST") {
        return Some(PathBuf::from(d));
    }
    let from_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../dist")
        .canonicalize()
        .ok();
    from_manifest.or_else(|| {
        let cwd = PathBuf::from("dist");
        cwd.is_dir().then_some(cwd)
    })
}

fn resolve_asset(explicit: Option<PathBuf>, app: &str, ext: &str) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return p
            .canonicalize()
            .with_context(|| format!("missing {}", p.display()));
    }
    let dist =
        dist_dir().ok_or_else(|| anyhow!("cannot find PocketJS dist/ (set POCKETJS_DIST)"))?;
    let candidates = [format!("{app}.{ext}"), format!("{app}-main.{ext}")];
    for c in &candidates {
        let p = dist.join(c);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no {ext} for app '{app}' in {} — build it first: bun tools/build.ts {app} --density=2",
        dist.display()
    ))
}

fn note_file(explicit: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(|| {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        Path::new(&home).join(".pocket-note.md")
    })
}

/// Resolve the stock target identity and reject chrome/target mismatches.
fn host_identity(explicit: Option<&str>, chrome: ChromeMode) -> Result<(&'static str, u32)> {
    // Keep explicit and environment-selected targets aligned with this binary's OS.
    let raw = explicit
        .map(str::to_owned)
        .or_else(|| std::env::var("POCKETJS_HOST").ok())
        .unwrap_or_else(|| {
            match (
                chrome,
                cfg!(target_os = "windows"),
                cfg!(target_os = "macos"),
            ) {
                (ChromeMode::App, true, _) => "windows-app".into(),
                (ChromeMode::Note, true, _) => "windows-widget".into(),
                (ChromeMode::Note, _, true) => "macos-widget".into(),
                _ => "unsupported".into(),
            }
        });
    let host_matches_os = match raw.as_str() {
        "macos-widget" => cfg!(target_os = "macos"),
        "windows-widget" | "windows-app" => cfg!(target_os = "windows"),
        _ => true,
    };
    if !host_matches_os {
        return Err(anyhow!("desktop host '{raw}' does not match the native OS"));
    }
    match (raw.as_str(), chrome) {
        ("macos-widget", ChromeMode::Note) => Ok(("macos-widget", 4)),
        ("windows-widget", ChromeMode::Note) => Ok(("windows-widget", 4)),
        ("windows-app", ChromeMode::App) => Ok(("windows-app", 4)),
        ("macos-widget" | "windows-widget", ChromeMode::App) => Err(anyhow!(
            "ordinary app chrome requires the windows-app target; widget targets are only for Pocket Note"
        )),
        ("windows-app", ChromeMode::Note) => Err(anyhow!(
            "Pocket Note requires a widget target, not windows-app"
        )),
        (other, _) => Err(anyhow!(
            "unsupported desktop host id '{other}' (expected macos-widget, windows-widget, or windows-app)"
        )),
    }
}

/// Boot the guest: feed the pak, mount `ui` (svc included), eval the bundle.
fn boot(args: &Args) -> Result<(Guest, UiSurface)> {
    // Plan-built bundles assert ui.__host/__hostAbi against the selected
    // stock target; chrome and target are deliberately kept one-to-one.
    let (host_id, host_abi) = host_identity(args.host.as_deref(), args.chrome)?;
    validate_resolved_plan(args.plan.as_deref(), host_id, host_abi)?;
    let js_path = resolve_asset(args.js.clone(), &args.app, "js")?;
    let pak_path = resolve_asset(args.pak.clone(), &args.app, "pak")?;
    let bundle = std::fs::read_to_string(&js_path)
        .with_context(|| format!("reading {}", js_path.display()))?;
    let pak =
        std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;

    let surface =
        UiSurface::new_with_density((args.size.0 as f32, args.size.1 as f32), args.density);
    surface.set_identity(host_id, host_abi);
    // 通用壳通道名：input（框架 connectHostInput）+ note（旧 note app）+ app 输出名。
    surface.set_svc_allowlist(["input", "note", args.app.as_str()]);
    surface.feed_pak(&pak);
    let guest = Guest::new()?;
    surface.mount(&guest)?;
    guest.eval(&args.app, &bundle)?;
    if !guest.has_frame() {
        return Err(anyhow!(
            "bundle evaluated but installed no frame() — is this a PocketJS app?"
        ));
    }
    Ok((guest, surface))
}

fn run_with_args(mut args: Args) -> Result<()> {
    let (guest, surface) = boot(&args)?;
    let atlases = cjk::CjkAtlases::from_pak(&std::fs::read(resolve_asset(
        args.pak.clone(),
        &args.app,
        "pak",
    )?)?);
    // Chrome is explicit: default App. Note launchers pass `--chrome note`.
    let note_chrome = args.chrome == ChromeMode::Note;
    let title = args.title.clone().unwrap_or_else(|| {
        if note_chrome {
            "Pocket Note".into()
        } else {
            args.app.clone()
        }
    });
    let mut game = NoteGame::new(
        surface,
        guest,
        atlases,
        note_file(args.file.clone()),
        args.size,
        note_chrome,
    );
    game.script = std::mem::take(&mut args.script);
    game.quit_after = args.auto_quit.map(|s| (s * 60.0) as u64);
    if let Some(program) = args.companion.take() {
        let bridge = companion::CompanionBridge::spawn_simple(
            program.clone(),
            std::mem::take(&mut args.companion_args),
            args.companion_cwd.take(),
        )?;
        log::info!("note-widget: companion {}", program.display());
        game.companion = Some(bridge);
    }

    if let Some(out) = args.screenshot.clone() {
        headless(game, args, &out)
    } else if note_chrome {
        // Pocket Note: ambient sticky — borderless, transparent, always-on-top.
        // Transparent may degrade to opaque on some Windows adapters; shell logs it.
        pocket_widget::run_flat(
            WidgetConfig {
                title,
                size: args.size,
                resizable: !args.fixed,
                min_size: args.min_size.unwrap_or(DEFAULT_MIN_SIZE),
                max_size: args.max_size.or(Some(DEFAULT_MAX_SIZE)),
                ime: true,
                ..Default::default()
            },
            game,
        )
    } else {
        // Ordinary OS window chrome: title bar + edges, no custom grip.
        pocket_widget::run_flat(
            WidgetConfig {
                title,
                size: args.size,
                transparent: false,
                decorations: true,
                always_on_top: false,
                resizable: !args.fixed,
                min_size: args.min_size.unwrap_or(DEFAULT_MIN_SIZE),
                max_size: args.max_size.or(Some(DEFAULT_MAX_SIZE)),
                ime: true,
                ..Default::default()
            },
            game,
        )
    }
}

/// Entry for the `note-widget` binary: full chrome menu (note | app).
pub fn run() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args()?;
    run_with_args(args)
}

/// Entry for the `app-widget` binary: forces `--chrome app` (no note mode).
/// The app-widget shell never exposes note document/save/quit semantics —
/// it is the generic desktop App Shell for arbitrary `*-main.js/.pak` apps.
pub fn run_app() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut args = parse_args()?;
    if args.chrome == ChromeMode::Note {
        log::warn!("app-widget: ignoring --chrome note; app-widget is app-only");
    }
    args.chrome = ChromeMode::App;
    run_with_args(args)
}

/// Headless: N fixed ticks at 1x scale (logical == physical), scripted svc
/// events, then one PNG at density scale. No window required.
fn headless(mut game: NoteGame, args: Args, out: &std::path::Path) -> Result<()> {
    let gpu = Gpu::new_headless()?;
    game.init(&gpu, OFFSCREEN_FORMAT)?;
    let mut input = Input::default();
    let px = (args.size.0, args.size.1);
    let has_companion = game.companion.is_some();
    // companion 子进程冷启动需要墙钟时间；每 30 tick 让出 ~50ms
    for i in 0..args.frames {
        game.tick(1.0 / 60.0, &input, px, 1.0)?;
        input.end_frame();
        if has_companion && i % 30 == 29 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    // 再抽几帧，吃掉迟到的 companion 快照并重绘
    if has_companion {
        for _ in 0..60 {
            game.tick(1.0 / 60.0, &input, px, 1.0)?;
            input.end_frame();
        }
    }
    let scale = args.density.max(1);
    let (w, h) = (args.size.0 * scale, args.size.1 * scale);
    let target = OffscreenTarget::new(&gpu, w, h);
    game.take_dirty();
    let renderer = game.renderer.as_mut().expect("init ran");
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    game.surface.with_ui(|ui| {
        renderer.render_words_scaled(
            &gpu,
            ui,
            &game.words,
            &mut encoder,
            &target.view,
            (w, h),
            scale as f32,
            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
        )
    })?;
    gpu.queue.submit([encoder.finish()]);
    target.save_png(&gpu, out)?;
    println!(
        "note-widget: wrote {} after {} frames ({}x{} @{}x)",
        out.display(),
        args.frames,
        w,
        h,
        scale
    );
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[cfg(test)]
mod tests {
    use super::{
        BTN_CIRCLE, CaretRect, ChromeMode, PointerClick, PointerPulse, ShellClick, host_identity,
        intent_caret, intent_text, intent_type, last_mouse_release, pack_pointer_position,
        plan_default_size, pointer_buttons, validate_resolved_plan,
    };

    #[test]
    fn guest_intents_require_typed_fields() {
        // Keep malformed guest data outside native side effects.
        assert_eq!(
            intent_type(&serde_json::json!({"t": "status"})),
            Some("status")
        );
        assert_eq!(intent_type(&serde_json::json!({"type": "status"})), None);
        assert_eq!(intent_type(&serde_json::json!(["status"])), None);
        assert_eq!(
            intent_text(&serde_json::json!({"text": "ok"}), "text"),
            Some("ok")
        );
        assert!(intent_text(&serde_json::json!({"text": 7}), "text").is_none());
        assert_eq!(
            intent_caret(&serde_json::json!({"x": 4, "y": 5, "h": 16})),
            Some(CaretRect {
                node: None,
                x: 4.0,
                y: 5.0,
                w: 1.0,
                h: 16.0
            }),
        );
        assert_eq!(
            intent_caret(&serde_json::json!({"node": 7, "x": -1, "y": -5, "h": 16})),
            Some(CaretRect {
                node: Some(7),
                x: -1.0,
                y: -5.0,
                w: 1.0,
                h: 16.0
            }),
        );
        assert!(intent_caret(&serde_json::json!({"node": 0, "x": 4, "y": 5, "h": 16})).is_none());
        assert!(intent_caret(&serde_json::json!({"x": 4, "y": 5, "h": 0})).is_none());
    }

    #[test]
    fn desktop_boot_requires_a_matching_resolved_plan() {
        assert!(validate_resolved_plan(None, "windows-app", 4).is_err());

        let path = std::env::temp_dir().join(format!(
            "pocketjs-note-contract-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, r#"{"target":{"id":"windows-app","hostAbi":4}}"#).unwrap();
        assert!(validate_resolved_plan(Some(&path), "windows-app", 4).is_ok());
        assert!(validate_resolved_plan(Some(&path), "windows-widget", 4).is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn plan_default_and_pointer_wire_are_bounded() {
        let plan_path =
            std::env::temp_dir().join(format!("pocketjs-note-plan-{}.json", std::process::id()));
        std::fs::write(&plan_path, r#"{"viewport":{"logical":[480,360]}}"#).unwrap();
        assert_eq!(plan_default_size(&plan_path).unwrap(), (480, 360));
        std::fs::remove_file(&plan_path).ok();

        let packed = pack_pointer_position(32_767.0, 32_767.0);
        assert_eq!(packed, 0xffff_ffff);
        assert_eq!(pack_pointer_position(-1.0, 40_000.0), 0xffff_8000);
    }

    #[test]
    fn last_mouse_only_releases_after_cursor_leave() {
        let point = Some((12.0, 18.0, true));
        assert_eq!(last_mouse_release(point, false), Some((12.0, 18.0)));
        assert_eq!(last_mouse_release(point, true), None);
        assert_eq!(last_mouse_release(Some((12.0, 18.0, false)), false), None);
        assert_eq!(last_mouse_release(None, false), None);
    }

    #[test]
    fn pointer_buttons_preserve_a_held_press_without_a_contact() {
        assert_eq!(pointer_buttons(true), BTN_CIRCLE);
        assert_eq!(pointer_buttons(false), 0);
    }

    #[test]
    fn pointer_pulse_keeps_a_held_press_after_cursor_leave() {
        // Preserve physical button ownership while the cursor has no coordinate.
        let mut pulse = PointerPulse::default();
        let press = (10.0, 20.0);
        pulse.queue(&[], Some(press));
        assert_eq!(pulse.next(true, Some(press), false), (true, Some(press)));

        let (pointer_down, position) = pulse.next(true, None, false);
        assert_eq!((pointer_down, position), (true, None));
        assert_eq!(pointer_buttons(pointer_down), BTN_CIRCLE);

        let (pointer_down, position) = pulse.next(false, None, true);
        assert_eq!((pointer_down, position), (false, None));
        assert_eq!(pointer_buttons(pointer_down), 0);
    }

    #[test]
    fn pointer_pulse_separates_adjacent_fast_clicks() {
        let mut pulse = PointerPulse::default();
        let first = PointerClick {
            press: (10.0, 20.0),
            release: (11.0, 21.0),
        };
        let second = PointerClick {
            press: (30.0, 40.0),
            release: (31.0, 41.0),
        };
        pulse.queue(&[first], None);
        assert_eq!(
            pulse.next(false, Some(first.press), false),
            (true, Some(first.press))
        );
        pulse.queue(&[second], None);
        assert_eq!(
            pulse.next(false, Some(second.press), false),
            (false, Some(first.release))
        );
        assert_eq!(
            pulse.next(false, Some(second.press), false),
            (true, Some(second.press))
        );
        assert_eq!(
            pulse.next(false, Some(second.press), false),
            (false, Some(second.release))
        );
    }

    #[test]
    fn pointer_pulse_releases_after_cursor_leaves() {
        let mut pulse = PointerPulse::default();
        let click = PointerClick {
            press: (10.0, 20.0),
            release: (10.0, 20.0),
        };
        pulse.queue(&[click], None);
        assert_eq!(pulse.next(false, None, false), (true, Some(click.press)));
        assert_eq!(pulse.next(false, None, false), (false, Some(click.release)));
    }

    #[test]
    fn pointer_pulse_preserves_click_before_physical_press() {
        let mut pulse = PointerPulse::default();
        let click = PointerClick {
            press: (10.0, 20.0),
            release: (10.0, 20.0),
        };
        pulse.queue(&[click], Some((30.0, 40.0)));
        assert_eq!(
            pulse.next(true, Some((30.0, 40.0)), false),
            (true, Some(click.press))
        );
        assert_eq!(
            pulse.next(true, Some((50.0, 60.0)), false),
            (false, Some(click.release))
        );
        assert_eq!(
            pulse.next(true, Some((50.0, 60.0)), false),
            (true, Some((30.0, 40.0)))
        );
        assert_eq!(
            pulse.next(false, Some((50.0, 60.0)), false),
            (false, Some((50.0, 60.0)))
        );
    }

    #[test]
    fn pointer_pulse_keeps_an_inside_released_queued_hold_as_a_click() {
        let mut pulse = PointerPulse::default();
        let click = PointerClick {
            press: (10.0, 20.0),
            release: (10.0, 20.0),
        };
        pulse.queue(&[click], Some((30.0, 40.0)));
        assert_eq!(
            pulse.next(true, Some((30.0, 40.0)), false),
            (true, Some(click.press))
        );
        let held_click = PointerClick {
            press: (30.0, 40.0),
            release: (35.0, 45.0),
        };
        // The release resolves the queued held press instead of adding a second pulse.
        let shell_clicks = pulse.queue(&[held_click], None);
        assert!(
            matches!(shell_clicks.as_slice(), [ShellClick::HeldRelease(click)] if click.press == held_click.press)
        );
        assert_eq!(
            pulse.next(false, Some((35.0, 45.0)), false),
            (false, Some(click.release))
        );
        assert_eq!(
            pulse.next(false, Some((35.0, 45.0)), false),
            (true, Some(held_click.press))
        );
        assert_eq!(
            pulse.next(false, Some((35.0, 45.0)), false),
            (false, Some(held_click.release))
        );
        assert_eq!(pulse.next(false, None, false), (false, None));
    }

    #[test]
    fn pointer_pulse_cancels_a_queued_hold_released_outside() {
        let mut pulse = PointerPulse::default();
        let click = PointerClick {
            press: (10.0, 20.0),
            release: (10.0, 20.0),
        };
        pulse.queue(&[click], Some((30.0, 40.0)));
        assert_eq!(
            pulse.next(true, Some((30.0, 40.0)), false),
            (true, Some(click.press))
        );
        pulse.cancel_held();
        assert_eq!(pulse.next(false, None, true), (false, Some(click.release)));
        assert_eq!(pulse.next(false, None, false), (false, None));
    }

    #[test]
    fn explicit_host_must_match_native_os() {
        // Keep the final native boundary stricter than launcher arguments.
        if cfg!(target_os = "windows") {
            assert!(host_identity(Some("macos-widget"), ChromeMode::Note).is_err());
            assert!(host_identity(Some("windows-widget"), ChromeMode::Note).is_ok());
            assert_eq!(
                host_identity(Some("windows-app"), ChromeMode::App).unwrap(),
                ("windows-app", 4)
            );
        } else {
            assert!(host_identity(Some("windows-widget"), ChromeMode::Note).is_err());
            assert!(host_identity(Some("macos-widget"), ChromeMode::Note).is_ok());
        }
    }
}
