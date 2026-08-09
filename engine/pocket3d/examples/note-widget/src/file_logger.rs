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

/// days since 1970-01-01 → (year, month, day)。Hinnant 公历算法，零依赖。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// UTC 时间戳 `YYYY-MM-DD HH:MM:SS`（无第三方时间依赖）。
fn utc_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02} {hh:02}:{mm:02}:{ss:02}")
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
            utc_timestamp(),
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
