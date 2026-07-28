// 系统剪贴板读写

/// 写入系统剪贴板文本。
pub fn copy(text: &str) {
    // 跳过空串
    if text.is_empty() {
        return;
    }
    match arboard::Clipboard::new().and_then(|mut clipboard| clipboard.set_text(text.to_owned())) {
        Ok(()) => log::info!("note-widget: copied {} bytes", text.len()),
        Err(error) => log::warn!("note-widget: clipboard copy failed: {error}"),
    }
}

/// 读取系统剪贴板文本。
pub fn paste() -> Option<String> {
    // 打开剪贴板并取文本
    match arboard::Clipboard::new().and_then(|mut clipboard| clipboard.get_text()) {
        Ok(text) => Some(text),
        Err(error) => {
            log::warn!("note-widget: clipboard paste failed: {error}");
            None
        }
    }
}
