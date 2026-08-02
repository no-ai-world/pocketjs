// 系统剪贴板读写

use std::sync::Mutex;

use arboard::Clipboard;

static CLIPBOARD: Mutex<Option<Clipboard>> = Mutex::new(None);

/// 取得（或重建）进程内剪贴板句柄。
fn with_clipboard<T>(
    f: impl FnOnce(&mut Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    // 复用句柄，失败时下次重建
    let mut guard = CLIPBOARD.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(Clipboard::new()?);
    }
    match f(guard.as_mut().expect("clipboard just installed")) {
        Ok(value) => Ok(value),
        Err(error) => {
            *guard = None;
            Err(error)
        }
    }
}

/// 写入系统剪贴板文本。
pub fn copy(text: &str) {
    // 跳过空串
    if text.is_empty() {
        return;
    }
    match with_clipboard(|clipboard| clipboard.set_text(text.to_owned())) {
        Ok(()) => log::info!("note-widget: copied {} bytes", text.len()),
        Err(error) => log::warn!("note-widget: clipboard copy failed: {error}"),
    }
}

/// 读取系统剪贴板文本。
pub fn paste() -> Option<String> {
    // 打开剪贴板并取文本
    match with_clipboard(|clipboard| clipboard.get_text()) {
        Ok(text) => Some(text),
        Err(error) => {
            log::warn!("note-widget: clipboard paste failed: {error}");
            None
        }
    }
}
