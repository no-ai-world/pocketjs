//! app-widget 专用双写日志器：文件落盘（可回读排障），stderr 保持 INFO+。
//!
//! `env_logger` 只支持单一输出目标，这里在 `--log-file` 给定时替代它：
//! 同一份日志同时进文件（可回读排障）与控制台（实时状态）。
//! `--log-file` 缺省时 run_app 退回 env_logger，其他引擎宿主不受影响。
//!
//! 双态级别：debug 构建文件收 DEBUG+（开发排障）；release 构建被 log crate
//! 编译期静态级别截为 INFO+（发布版只落有效状态）。debug! 仅剩启动一次性
//! 事件；事件流与性能日志（窗口事件/复制/保存/mem/帧级）都是 trace!，任何
//! 构建都不落盘。

use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use anyhow::Context;

pub struct DualLogger {
    file: Mutex<File>,
}

impl DualLogger {
    fn new(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating log dir {}", parent.display()))?;
        }
        let file =
            File::create(path).with_context(|| format!("opening log file {}", path.display()))?;
        Ok(Self {
            file: Mutex::new(file),
        })
    }
}

/// 本地时间戳 `YYYY-MM-DD HH:MM:SS`（chrono Local，全平台统一本地时区）。
fn local_timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

impl log::Log for DualLogger {
    // log 0.4 的 Level 排序反直觉：Debug > Info > Warn > Error（不严重方向更大），
    // 因此「不低于 Debug」用 <= Debug 表达（放行 Debug/Info/Warn/Error，拦 Trace）
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Debug
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "[{} {} {}] {}\n",
            local_timestamp(),
            record.level(),
            record.target(),
            record.args()
        );
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(line.as_bytes());
        }
        // 控制台保持 INFO+（帧级噪音已 trace，不达此处），DEBUG 细节只进文件；
        // GUI 启动（快捷方式）无控制台时 stderr 句柄无效，写失败静默忽略——
        // 文件仍是唯一通道，eprint! 会因无效句柄 panic
        if record.level() <= log::Level::Info {
            let _ = std::io::stderr().write_all(line.as_bytes());
        }
    }

    fn flush(&self) {
        if let Ok(mut file) = self.file.lock() {
            let _ = file.flush();
        }
    }
}

/// 初始化为全局 logger（进程内唯一，与 env_logger 二选一）。
///
/// 日志是附属设施，绝不阻断应用启动：路径含未展开的 `%` 引用、文件创建
/// 失败、logger 已存在等降级路径都回退 env_logger（stderr），仅返回 Ok。
pub fn init(path: &Path) -> anyhow::Result<()> {
    // 降级回退：文件日志不可用时日志改走 stderr（env_logger 与缺省路径一致）
    let fallback = || {
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
            .init()
    };
    if path.to_string_lossy().contains('%') {
        let _ = writeln!(
            std::io::stderr(),
            "file_logger: log path {path:?} contains unexpanded env ref; logs stay on stderr"
        );
        fallback();
        return Ok(());
    }
    let logger = match DualLogger::new(path) {
        Ok(logger) => logger,
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "file_logger: {error:#}; logs stay on stderr");
            fallback();
            return Ok(());
        }
    };
    let logger: &'static DualLogger = Box::leak(Box::new(logger));
    // 双态级别：debug 构建下 log crate 编译期静态级别是 Debug，文件收 DEBUG+；
    // release 构建下静态级别是 Info（未启用 release_max_level_debug），
    // debug! 在宏层被截断——发布版只落 INFO+，debug 细节仅开发构建可见
    log::set_max_level(log::LevelFilter::Debug);
    // 唯一可能 Err 的路径：logger 已存在（重复 init 是调用方 bug，保持 loud）
    log::set_logger(logger)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 时间戳必须与 chrono::Local 时钟一致（±2 秒内）。用 naive 本地墙钟直接
    /// 比较：若实现误用 Utc，差值会是一整个时区偏移，断言立即失败。
    #[test]
    fn local_timestamp_tracks_local_clock() {
        let ts = local_timestamp();
        assert_eq!(ts.len(), 19, "timestamp shape: {ts}");
        let parsed = chrono::NaiveDateTime::parse_from_str(&ts, "%Y-%m-%d %H:%M:%S")
            .expect("parse timestamp");
        let local_now = chrono::Local::now().naive_local();
        let drift = (parsed - local_now).num_seconds().abs();
        assert!(
            drift <= 2,
            "local_timestamp {ts} diverges from Local clock by {drift}s (now {local_now})"
        );
    }
}
