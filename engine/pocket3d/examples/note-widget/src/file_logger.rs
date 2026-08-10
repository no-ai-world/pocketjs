//! app-widget/note-widget 专用双写日志器：文件落盘（可回读排障），stderr 保持 INFO+。
//!
//! `env_logger` 只支持单一输出目标，这里在 `--log-file` 给定时替代它：
//! 同一份日志同时进文件（可回读排障）与控制台（实时状态）。
//! `--log-file` 缺省时 run_app 退回 env_logger，其他引擎宿主不受影响。
//!
//! 双态级别：debug 构建文件收 DEBUG+（开发排障）；release 构建被 log crate
//! 编译期静态级别截为 INFO+（发布版只落有效状态）。debug! 仅剩启动一次性
//! 事件；事件流与性能日志（窗口事件/复制/保存/mem/帧级）都是 trace!，任何
//! 构建都不落盘。
//!
//! 文件策略是追加 + 大小轮转：多次启动的日志累积在同一文件里，每次启动写
//! 一行会话分隔线便于区分；文件达到 `MAX_LOG_BYTES`（启动检查与每次写入
//! 检查）时归档为 `<path>.<本地时间戳>` 并重开新文件。文件系统操作正常时
//! 历史不丢、归档不覆盖：`create_new` 原子占用候选名，同秒竞争自动换 `-N`
//! 序号（Windows rename 会覆盖已存在目标，必须靠占用保证不覆盖），最多
//! `ARCHIVE_ATTEMPTS` 次；耗尽后本轮跳过轮转继续追加，下一轮（通常下一秒）
//! 重新尝试。降级原则：任何一步失败都继续追加（重开失败时写入已归档的
//! 文件），文件通道异常给出一条 stderr 警告（实例级一次性，避免刷屏）；
//! 会话分隔线与 flush 的写失败与日志行同通道，保持静默——日志是附属设施，
//! 绝不阻断应用启动。
//!
//! panic hook（install_panic_hook）在 logger 之外独立 append 同一文件、不
//! 经轮转：panic 时信息要么进当前文件要么进已归档文件，不丢失，但也不参与
//! 大小轮转。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use anyhow::Context;

/// 单文件日志的大小上限（字节）。达到后整个文件归档并重开新文件。
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// 归档名竞争重试上限：同秒多进程竞争时换 `-N` 序号最多尝试这么多次；
/// 耗尽后本轮跳过轮转继续追加（见模块头）。生产 10 MiB 阈值下单秒最多
/// 一次轮转，该上限仅防御性兜底。
const ARCHIVE_ATTEMPTS: usize = 8;

pub struct DualLogger {
    file: Mutex<File>,
    /// 当前日志文件路径：写入时轮转需要它来归档并重开。
    path: PathBuf,
    /// 本实例的轮转阈值（测试注入小值，生产用 `MAX_LOG_BYTES`）。
    max_bytes: u64,
    /// 已发出过 stderr 警告：文件通道异常时若每条日志都告警会刷屏。
    /// 实例级一次性，跨错误类别（metadata/归档/重开/写入）共用同一信号。
    warned: AtomicBool,
}

/// 候选归档名：`<path>.<YYYYMMDD-HHMMSS>`；attempt > 0 时追加 `-N` 序号。
fn archive_candidate(
    path: &Path,
    now: &chrono::DateTime<chrono::Local>,
    attempt: usize,
) -> PathBuf {
    let base = format!("{}.{}", path.display(), now.format("%Y%m%d-%H%M%S"));
    if attempt == 0 {
        PathBuf::from(base)
    } else {
        PathBuf::from(format!("{base}-{attempt}"))
    }
}

/// 归档名租约：`create_new` 成功占用候选名后持有。Drop 时若未提交
/// （rename 未成功）则删除占位文件，panic/unwind 也不会残留空文件；
/// rename 成功覆盖占位后必须 `disarm()`，否则 Drop 会删掉刚归档的内容。
struct Lease {
    path: PathBuf,
    armed: bool,
}

impl Lease {
    /// 尝试占用候选名：目标已存在（竞争）返回 None，调用方换 `-N` 重试。
    fn acquire(path: &Path, now: &chrono::DateTime<chrono::Local>, attempt: usize) -> Option<Self> {
        let candidate = archive_candidate(path, now, attempt);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .ok()?;
        Some(Self {
            path: candidate,
            armed: true,
        })
    }

    /// rename 成功后调用：占位名现在指向真实归档，禁止 Drop 清理。
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.armed {
            // 尽力而为：删除失败（杀软/索引器占用）可能残留空占位，极罕见。
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// 把当前文件归档为唯一时间戳名，返回是否成功。竞争安全：先 `create_new`
/// 原子占用候选名（成功 = 名字归我们，绝不覆盖已有归档；失败 = 竞争，换
/// `-N` 序号重试），再 rename 覆盖自己的空占位（占位无数据，覆盖无损）。
/// 任何失败（重试耗尽/权限/占用）返回 false，调用方保持追加旧文件。
fn archive_existing(path: &Path) -> bool {
    archive_existing_at(path, chrono::Local::now())
}

fn archive_existing_at(path: &Path, now: chrono::DateTime<chrono::Local>) -> bool {
    for attempt in 0..ARCHIVE_ATTEMPTS {
        let Some(mut lease) = Lease::acquire(path, &now, attempt) else {
            continue; // 候选名已被占用（竞争），换 `-N` 序号重试
        };
        if std::fs::rename(path, &lease.path).is_ok() {
            // 归档已就位：占位名现在指向真实归档，不可再清理。
            lease.disarm();
            return true;
        }
        // rename 失败：Lease::drop 删除占位，保持目录干净。
        return false;
    }
    false
}

impl DualLogger {
    fn new(path: &Path) -> anyhow::Result<Self> {
        Self::with_max_bytes(path, MAX_LOG_BYTES)
    }

    fn with_max_bytes(path: &Path, max_bytes: u64) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating log dir {}", parent.display()))?;
        }
        // 启动归档：已有文件达到阈值时先整体归档再开新文件。失败不阻断，
        // 继续追加旧文件；未到阈值则原样保留（追加）。文件不存在视为首启。
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() && meta.len() >= max_bytes => {
                if !archive_existing(path) {
                    let _ = writeln!(
                        std::io::stderr(),
                        "file_logger: archive on startup failed; appending to old file"
                    );
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                let _ = writeln!(
                    std::io::stderr(),
                    "file_logger: stat {path:?} failed ({error}); assuming under limit"
                );
            }
            Err(_) => {} // NotFound：首次启动，直接创建
        }
        // 追加模式：create(true) + append(true)，不截断已有内容。
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .with_context(|| format!("opening log file {}", path.display()))?;
        let logger = Self {
            file: Mutex::new(file),
            path: path.to_path_buf(),
            max_bytes,
            warned: AtomicBool::new(false),
        };
        // 追加模式下会话边界必须显式标记，否则多会话日志连成一片。
        logger.write_session_marker();
        Ok(logger)
    }

    /// 每次启动写一行会话分隔线（时间戳 + 启动标记）。
    fn write_session_marker(&self) {
        if let Ok(mut file) = self.file.lock() {
            let marker = format!("\n===== {} session start =====\n", local_timestamp());
            let _ = file.write_all(marker.as_bytes());
            let _ = file.flush();
        }
    }

    /// 文件通道异常的一次性 stderr 警告：重复错误只报第一条，避免刷屏。
    /// GUI 下 stderr 句柄无效时 writeln! 的 Err 被吞掉，不会二次 panic。
    fn warn_once(&self, msg: &str) {
        if !self.warned.swap(true, Ordering::Relaxed) {
            let _ = writeln!(std::io::stderr(), "file_logger: {msg}");
        }
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
            // 写入前检查：文件已达到阈值才归档。不用「加上本行将超过」作条件，
            // 否则单条超大日志会让每次写入都轮转（乒乓 rename）。
            let should_rotate = match file.metadata() {
                Ok(meta) => meta.len() >= self.max_bytes,
                // 读不到长度：本轮跳过轮转、继续追加，但必须可见而非静默。
                Err(error) => {
                    self.warn_once(&format!(
                        "log file metadata failed ({error}); skipping rotation"
                    ));
                    false
                }
            };
            if should_rotate {
                if archive_existing(&self.path) {
                    match OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&self.path)
                    {
                        Ok(fresh) => *file = fresh,
                        // 旧文件已改名，current 仍指向归档文件：日志继续进归档，仅警告。
                        Err(error) => self.warn_once(&format!(
                            "reopen after rotate failed ({error:#}); appending to archived file"
                        )),
                    }
                } else {
                    self.warn_once("archive failed; appending to old file");
                }
            }
            if let Err(error) = file.write_all(line.as_bytes()) {
                self.warn_once(&format!("log write failed ({error}); line lost"));
            }
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
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init()
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
            let _ = writeln!(
                std::io::stderr(),
                "file_logger: {error:#}; logs stay on stderr"
            );
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
    use std::sync::atomic::AtomicU32;
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_DIR_SEQ: AtomicU32 = AtomicU32::new(0);

    /// 每个测试独占的临时日志路径：进程 id + 启动纳秒 + 序号保证唯一，
    /// 即使 PID 被系统复用也不会撞上残留目录。
    fn temp_log(name: &str) -> PathBuf {
        let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "pocketjs-file-logger-{}-{nanos}-{seq}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("session.log")
    }

    /// 删除测试目录；失败即 panic，让句柄未释放等真实问题可见而非静默。
    fn cleanup(path: &Path) {
        let dir = path.parent().unwrap();
        std::fs::remove_dir_all(dir).unwrap_or_else(|error| {
            panic!("cleanup {} failed: {error}", dir.display());
        });
    }

    /// 构造一条测试日志记录；用宏展开到调用点，format_args! 的生命周期才成立。
    macro_rules! rec {
        ($level:expr, $($arg:tt)*) => {
            log::Record::builder()
                .args(format_args!($($arg)*))
                .level($level)
                .target("file_logger_test")
                .build()
        };
    }

    /// 目录里 `session.log.<...>` 归档文件的路径列表（排序保证确定性）。
    fn archives(path: &Path) -> Vec<PathBuf> {
        let mut names: Vec<PathBuf> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("session.log."))
            })
            .collect();
        names.sort();
        names
    }

    /// 追加模式：已有内容必须保留，新日志拼在后面，且带会话分隔线。
    #[test]
    fn append_preserves_prior_content() {
        let path = temp_log("append");
        std::fs::write(&path, b"old line\n").unwrap();
        let logger = DualLogger::with_max_bytes(&path, u64::MAX).unwrap();
        log::Log::log(&logger, &rec!(log::Level::Info, "new line"));
        drop(logger);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with("old line\n"),
            "prior content must survive: {text:?}"
        );
        assert!(text.contains("new line"), "new content appended: {text:?}");
        assert!(
            text.contains("session start"),
            "session marker written: {text:?}"
        );
        cleanup(&path);
    }

    /// 启动归档：已有文件超过阈值时整体改名归档，新文件只含本会话分隔线。
    #[test]
    fn startup_archives_oversized_file() {
        let path = temp_log("startup_archive");
        {
            use std::io::Write as _;
            let big = vec![b'x'; 4096];
            let mut old = std::fs::File::create(&path).unwrap();
            for _ in 0..4 {
                old.write_all(&big).unwrap();
            }
        }
        let logger = DualLogger::with_max_bytes(&path, 10_000).unwrap();
        drop(logger);
        let archived = archives(&path);
        assert_eq!(archived.len(), 1, "exactly one archive: {archived:?}");
        let text = std::fs::read_to_string(&archived[0]).unwrap();
        assert_eq!(text.len(), 4 * 4096, "archive keeps the full old content");
        let fresh = std::fs::read_to_string(&path).unwrap();
        assert!(
            fresh.starts_with("\n====="),
            "fresh session marker: {fresh:?}"
        );
        cleanup(&path);
    }

    /// 精确边界：文件大小**恰好等于**阈值时启动也必须归档（>= 语义）。
    #[test]
    fn startup_archives_at_exact_threshold() {
        let path = temp_log("exact_threshold");
        // marker 固定 47 字节：`\n` + `=====` + 空格 + 19 字符时间戳 + 空格
        // + `session start` + 空格 + `=====` + `\n`。阈值直接用推导出的
        // 长度，不硬编码字节数。
        let marker_len = format!("\n===== {} session start =====\n", "2026-01-01 00:00:00").len();
        std::fs::write(&path, vec![b'x'; marker_len]).unwrap();
        let logger = DualLogger::with_max_bytes(&path, marker_len as u64).unwrap();
        drop(logger);
        let archived = archives(&path);
        assert_eq!(
            archived.len(),
            1,
            "len == max must rotate at startup: {archived:?}"
        );
        assert_eq!(
            std::fs::metadata(&archived[0]).unwrap().len(),
            marker_len as u64,
            "archive keeps the exact-threshold old content"
        );
        let fresh = std::fs::read_to_string(&path).unwrap();
        assert!(
            fresh.starts_with("\n====="),
            "fresh session marker: {fresh:?}"
        );
        cleanup(&path);
    }

    /// 写入时轮转：当前文件 + 全部归档里每条日志行恰好出现一次——
    /// 无丢失、无重复、无覆盖，直接锁定轮转不变量。阈值取 250：20 行日志
    /// 触发约 4 次轮转，不会耗尽 `ARCHIVE_ATTEMPTS`（耗尽路径见
    /// `archive_attempts_exhausted_falls_back_to_append`）。
    #[test]
    fn write_time_rotate_keeps_every_line_exactly_once() {
        let path = temp_log("write_rotate");
        let logger = DualLogger::with_max_bytes(&path, 250).unwrap();
        for i in 0..20 {
            log::Log::log(&logger, &rec!(log::Level::Info, "line {}", i));
        }
        drop(logger);
        assert!(!archives(&path).is_empty(), "rotation must have happened");
        let mut all = std::fs::read_to_string(&path).unwrap();
        for archive in &archives(&path) {
            all.push_str(&std::fs::read_to_string(archive).unwrap());
        }
        for i in 0..20 {
            // 带行尾界定，避免 "line 1" 命中 "line 10..19" 的子串
            let needle = format!(" line {i}\n");
            assert_eq!(
                all.matches(&needle).count(),
                1,
                "line {i} must appear exactly once across all files"
            );
        }
        cleanup(&path);
    }

    /// 归档名竞争：候选名已被占用时换 `-N` 序号重试，不覆盖已有归档。
    /// 用注入时钟让测试与真实时间无关（无跨秒竞争）。
    #[test]
    fn archive_retries_occupied_name() {
        let path = temp_log("occupied");
        std::fs::write(&path, b"old content").unwrap();
        // 模拟同秒竞争：无序号候选名已被另一进程占用
        let now = chrono::Local::now();
        let occupied = archive_candidate(&path, &now, 0);
        std::fs::write(&occupied, b"someone else's archive").unwrap();
        assert!(
            archive_existing_at(&path, now),
            "must fall back to -1 suffix"
        );
        let expected = archive_candidate(&path, &now, 1);
        assert!(expected.exists(), "-1 archive exists: {expected:?}");
        assert_eq!(
            std::fs::read_to_string(&expected).unwrap(),
            "old content",
            "our archive lands in the suffixed name"
        );
        assert_eq!(
            std::fs::read_to_string(&occupied).unwrap(),
            "someone else's archive",
            "occupied archive must not be overwritten"
        );
        cleanup(&path);
    }

    /// 两次「启动」模拟：第二次 init 必须追加而不是截断，且每次启动各带
    /// 一条会话分隔线——直接覆盖用户报告的「启动清空日志」问题。
    #[test]
    fn two_startups_append_instead_of_truncate() {
        let path = temp_log("two_starts");
        {
            let logger = DualLogger::with_max_bytes(&path, u64::MAX).unwrap();
            log::Log::log(&logger, &rec!(log::Level::Info, "first run line"));
        }
        {
            let logger = DualLogger::with_max_bytes(&path, u64::MAX).unwrap();
            log::Log::log(&logger, &rec!(log::Level::Info, "second run line"));
        }
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text.matches("session start").count(),
            2,
            "two session markers: {text:?}"
        );
        assert!(
            text.contains("first run line"),
            "first run survives: {text:?}"
        );
        assert!(
            text.contains("second run line"),
            "second run appended: {text:?}"
        );
        cleanup(&path);
    }

    /// `ARCHIVE_ATTEMPTS` 耗尽降级：同秒内超过 8 次轮转后，本轮跳过轮转
    /// 继续追加，不 panic、不丢行（20 行在 8 个归档 + 当前文件里恰好一次）。
    #[test]
    fn archive_attempts_exhausted_falls_back_to_append() {
        let path = temp_log("exhaust");
        let logger = DualLogger::with_max_bytes(&path, 1).unwrap();
        // 阈值 1：每条日志都触发一次轮转，很快耗尽同秒的 8 个候选名
        for i in 0..20 {
            log::Log::log(&logger, &rec!(log::Level::Info, "line {}", i));
        }
        drop(logger);
        let archived = archives(&path);
        assert_eq!(
            archived.len(),
            ARCHIVE_ATTEMPTS,
            "exactly {ARCHIVE_ATTEMPTS} archives in the same second"
        );
        // 耗尽后行仍不丢：0..7 在归档，其余在已停止轮转的当前文件
        let mut all = std::fs::read_to_string(&path).unwrap();
        for archive in &archived {
            all.push_str(&std::fs::read_to_string(archive).unwrap());
        }
        for i in 0..20 {
            let needle = format!(" line {i}\n");
            assert_eq!(
                all.matches(&needle).count(),
                1,
                "line {i} must survive archive-attempt exhaustion"
            );
        }
        cleanup(&path);
    }

    /// 本地时间戳必须与 chrono::Local 时钟一致（±2 秒内）。用 naive 本地墙钟直接
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
