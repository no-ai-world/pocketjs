//! System tray icon + context menu for the widget shell.
//!
//! Sole responsibility: own the tray icon lifecycle and translate tray/menu
//! events into shell actions. Only compiled on Windows and macOS — Linux has
//! no tray-icon build (no GTK system libs on CI).
//!
//! Interaction contract (per platform):
//! - Windows: left click must NOT open the menu (`menu_on_left_click =
//!   false`); a `Click(Left, Up)` toggles visibility. Right click opens the
//!   menu (Quit only).
//! - macOS: with `menu_on_left_click = false` the OS only highlights the
//!   item and forwards `Click(Left, Up)` without popping the menu, so a
//!   left click toggles visibility; right click opens the menu
//!   ("Show/Hide" + "Quit"), whose items are the second restore path.

#![cfg(any(target_os = "windows", target_os = "macos"))]

use anyhow::{Result, anyhow};
use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

/// The tray "Quit" menu label (all platforms).
const QUIT_LABEL: &str = "Quit";
/// The macOS-only "Show/Hide" menu label — macOS needs a menu item to
/// restore a hidden window.
#[cfg(target_os = "macos")]
const SHOW_HIDE_LABEL: &str = "Show/Hide";
/// Stable menu ids, matched against `MenuEvent::id`.
const QUIT_MENU_ID: &str = "tray-quit";
#[cfg(target_os = "macos")]
const SHOW_HIDE_MENU_ID: &str = "tray-show-hide";

/// Everything the shell needs to create a tray icon.
#[derive(Clone)]
pub struct TrayConfig {
    /// Tooltip shown when hovering the tray icon (the window title).
    pub tooltip: String,
    /// RGBA pixels decoded once from the window `.ico`.
    ///
    /// Must be a square of at most 32×32: Windows' `CreateIcon` produces
    /// handles that `Shell_NotifyIconW` rejects (E_FAIL) above that size.
    pub icon_rgba: Vec<u8>,
    /// Square side length of `icon_rgba`.
    pub icon_size: u32,
}

/// A live tray icon; kept alive for the whole widget lifetime — dropping it
/// removes the icon from the platform tray.
///
/// The fields exist to be *held*, not read: the platform keeps the icon
/// alive as long as the [`TrayIcon`] and its menu items are alive.
#[allow(dead_code)]
pub struct TrayState {
    tray: TrayIcon,
    quit_item: MenuItem,
    #[cfg(target_os = "macos")]
    show_item: MenuItem,
}

impl TrayState {
    /// Create the tray icon + menu. Explicit failure: the shell reports it
    /// at boot instead of silently degrading to no-tray.
    pub fn create(config: &TrayConfig) -> Result<Self> {
        let menu = Menu::new();
        #[cfg(target_os = "macos")]
        let show_item = MenuItem::with_id(SHOW_HIDE_MENU_ID, SHOW_HIDE_LABEL, true, None);
        let quit_item = MenuItem::with_id(QUIT_MENU_ID, QUIT_LABEL, true, None);
        #[cfg(target_os = "macos")]
        menu.append(&show_item)
            .map_err(|e| anyhow!("tray menu append failed: {e}"))?;
        menu.append(&quit_item)
            .map_err(|e| anyhow!("tray menu append failed: {e}"))?;
        let icon = Icon::from_rgba(config.icon_rgba.clone(), config.icon_size, config.icon_size)
            .map_err(|e| anyhow!("invalid tray icon: {e}"))?;
        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip(&config.tooltip)
            .with_icon(icon)
            // Disable the menu on left click so `Click(Left, Up)` can toggle
            // visibility on Windows. This flag is documented macOS-only but
            // tray-icon's Windows window proc honors it too (undocumented;
            // re-verify on tray-icon upgrades). On macOS it keeps left click
            // from popping the menu, leaving right click as the menu entry.
            .with_menu_on_left_click(false)
            .build()
            .map_err(|e| anyhow!("tray icon creation failed: {e}"))?;
        Ok(Self {
            tray,
            quit_item,
            #[cfg(target_os = "macos")]
            show_item,
        })
    }
}

/// What the shell must do in response to a tray interaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayAction {
    /// Show the window if hidden, hide it if visible.
    ToggleVisibility,
    /// Quit the whole app — the tray's real exit path.
    Quit,
}

/// Drain pending tray/menu events into shell actions.
///
/// Polled by the shell's governor on every `about_to_wait`; the receivers
/// are tray-icon's global channels. On Windows a left-click posts to the
/// thread's message queue, which wakes the winit loop, so the poll is
/// prompt; on macOS menu-item events reach the loop the same way and are
/// the second restore path after the left-click toggle.
pub fn poll_actions() -> Vec<TrayAction> {
    let mut actions = Vec::new();
    while let Ok(event) = MenuEvent::receiver().try_recv() {
        match event.id().0.as_str() {
            QUIT_MENU_ID => actions.push(TrayAction::Quit),
            #[cfg(target_os = "macos")]
            SHOW_HIDE_MENU_ID => actions.push(TrayAction::ToggleVisibility),
            _ => {}
        }
    }
    while let Ok(event) = TrayIconEvent::receiver().try_recv() {
        // Windows sends Click(Left, Down) and Click(Left, Up); matching the
        // Up edge only makes one click toggle exactly once.
        if let TrayIconEvent::Click {
            button: tray_icon::MouseButton::Left,
            button_state: tray_icon::MouseButtonState::Up,
            ..
        } = event
        {
            actions.push(TrayAction::ToggleVisibility);
        }
    }
    actions
}
