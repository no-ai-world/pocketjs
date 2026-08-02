//! 外部 companion 进程桥：JSONL stdio，可观测崩溃与可选重启。

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError, TrySendError};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};

/// companion 生命周期策略。
#[derive(Clone, Debug)]
pub struct CompanionConfig {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// 崩溃后是否自动重启；None=不重启。
    pub restart: Option<RestartPolicy>,
}

#[derive(Clone, Debug)]
pub struct RestartPolicy {
    pub max_restarts: u32,
    pub delay: Duration,
}

enum RxMsg {
    Line(String),
    /// stdout 线程结束（进程退出或管道断开）。
    Eof,
    /// stdin writer 线程无法继续写入。
    StdinError(String),
}

/// 双向 JSONL 管道 + 崩溃观测。
const WRITE_QUEUE_CAPACITY: usize = 64;

pub struct CompanionBridge {
    config: CompanionConfig,
    child: Child,
    stdin_tx: SyncSender<String>,
    rx: Receiver<RxMsg>,
    restarts: u32,
    restart_attempts: u32,
    offline_notified: bool,
    stdin_failed: bool,
    dropped_lines: u64,
    next_restart_at: Option<Instant>,
}

impl CompanionBridge {
    /// 按配置启动 companion。
    pub fn spawn(config: CompanionConfig) -> Result<Self> {
        let (child, stdin_tx, rx) = spawn_child(&config)?;
        Ok(Self {
            config,
            child,
            stdin_tx,
            rx,
            restarts: 0,
            restart_attempts: 0,
            offline_notified: false,
            stdin_failed: false,
            dropped_lines: 0,
            next_restart_at: None,
        })
    }

    /// 兼容旧 API：program + args + cwd。
    pub fn spawn_simple(program: PathBuf, args: Vec<String>, cwd: Option<PathBuf>) -> Result<Self> {
        Self::spawn(CompanionConfig {
            program,
            args,
            cwd,
            restart: Some(RestartPolicy {
                max_restarts: 3,
                delay: Duration::from_millis(500),
            }),
        })
    }

    /// 写一行 guest→companion（补换行）。
    pub fn send_line(&mut self, line: &str) -> Result<()> {
        // Queue guest output without blocking the native event loop.
        if self.offline_notified || self.stdin_failed {
            return Err(anyhow!("companion offline"));
        }
        let payload = line.trim_end_matches(['\r', '\n']);
        if payload.contains(['\r', '\n']) {
            return Err(anyhow!("companion payload must be one JSONL line"));
        }
        let mut payload = payload.to_owned();
        payload.push('\n');
        match self.stdin_tx.try_send(payload) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.dropped_lines = self.dropped_lines.saturating_add(1);
                self.stdin_failed = true;
                log::warn!(
                    "note-widget: companion stdin queue saturated; marking bridge offline ({} dropped)",
                    self.dropped_lines
                );
                Err(anyhow!(
                    "companion stdin queue is full; bridge marked offline"
                ))
            }
            Err(TrySendError::Disconnected(_)) => {
                self.stdin_failed = true;
                Err(anyhow!("companion stdin writer is offline"))
            }
        }
    }

    /// 非阻塞排空 companion→guest 行；并推进崩溃/重启状态。
    /// 返回 (业务行, 是否刚变为 offline)。
    pub fn poll(&mut self) -> (Vec<String>, bool) {
        let mut out = Vec::new();
        let mut eof = self.stdin_failed;
        loop {
            match self.rx.try_recv() {
                Ok(RxMsg::Line(line)) => out.push(line),
                Ok(RxMsg::Eof) => {
                    eof = true;
                    break;
                }
                Ok(RxMsg::StdinError(error)) => {
                    log::warn!("note-widget: companion stdin failed: {error}");
                    eof = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    eof = true;
                    break;
                }
            }
        }

        // 探测子进程是否已退出
        if !eof {
            match self.child.try_wait() {
                Ok(Some(_)) => eof = true,
                Ok(None) => {}
                Err(_) => eof = true,
            }
        }

        let mut became_offline = false;
        if eof && !self.offline_notified {
            if !matches!(self.child.try_wait(), Ok(Some(_))) {
                log::warn!(
                    "note-widget: companion stdout closed while process was alive; terminating {}",
                    self.config.program.display()
                );
                if let Err(error) = self.child.kill() {
                    log::warn!("note-widget: companion termination failed: {error}");
                }
            }
            if let Err(error) = self.child.wait() {
                log::warn!("note-widget: companion reap failed: {error}");
            }
            self.offline_notified = true;
            became_offline = true;
            log::warn!(
                "note-widget: companion exited ({})",
                self.config.program.display()
            );
            if let Some(policy) = &self.config.restart
                && self.restart_attempts < policy.max_restarts
            {
                self.next_restart_at = Some(Instant::now() + policy.delay);
            }
        }

        // 到点尝试重启
        if self.offline_notified
            && let Some(at) = self.next_restart_at
            && Instant::now() >= at
        {
            self.next_restart_at = None;
            let can_attempt = self
                .config
                .restart
                .as_ref()
                .is_some_and(|policy| self.restart_attempts < policy.max_restarts);
            if !can_attempt {
                return (out, became_offline);
            }
            self.restart_attempts = self.restart_attempts.saturating_add(1);
            match spawn_child(&self.config) {
                Ok((child, stdin_tx, rx)) => {
                    self.child = child;
                    self.stdin_tx = stdin_tx;
                    self.rx = rx;
                    self.restarts += 1;
                    self.offline_notified = false;
                    self.stdin_failed = false;
                    self.dropped_lines = 0;
                    log::info!("note-widget: companion restarted (#{})", self.restarts);
                }
                Err(e) => {
                    log::warn!("note-widget: companion restart failed: {e}");
                    if let Some(policy) = &self.config.restart
                        && self.restart_attempts < policy.max_restarts
                    {
                        self.next_restart_at = Some(Instant::now() + policy.delay);
                    }
                }
            }
        }

        (out, became_offline)
    }
}

/// Terminate a child whose bridge initialization cannot complete.
fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_child(config: &CompanionConfig) -> Result<(Child, SyncSender<String>, Receiver<RxMsg>)> {
    let mut cmd = Command::new(&config.program);
    cmd.args(&config.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(dir) = &config.cwd {
        cmd.current_dir(dir);
    }
    // 继承环境；调用方可在启动前改 process env
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn companion {}", config.program.display()))?;
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            terminate_child(&mut child);
            return Err(anyhow!("companion missing stdin"));
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err(anyhow!("companion missing stdout"));
        }
    };

    let (tx, rx) = mpsc::channel::<RxMsg>();
    let (stdin_tx, stdin_rx) = mpsc::sync_channel::<String>(WRITE_QUEUE_CAPACITY);
    let writer_tx = tx.clone();
    if let Err(error) = thread::Builder::new()
        .name("companion-stdin".into())
        .spawn(move || write_stdin(stdin, stdin_rx, writer_tx))
    {
        terminate_child(&mut child);
        return Err(error).context("spawn companion stdin thread");
    }
    if let Err(error) = thread::Builder::new()
        .name("companion-stdout".into())
        .spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        let text = text.trim_end_matches(['\r', '\n']).to_string();
                        if text.is_empty() {
                            continue;
                        }
                        if tx.send(RxMsg::Line(text)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(RxMsg::Eof);
        })
    {
        drop(stdin_tx);
        terminate_child(&mut child);
        return Err(error).context("spawn companion stdout thread");
    }

    Ok((child, stdin_tx, rx))
}

fn write_stdin(mut stdin: ChildStdin, rx: Receiver<String>, events: Sender<RxMsg>) {
    // Perform potentially blocking pipe writes away from the GUI thread.
    while let Ok(payload) = rx.recv() {
        if let Err(error) = stdin
            .write_all(payload.as_bytes())
            .and_then(|()| stdin.flush())
        {
            let _ = events.send(RxMsg::StdinError(error.to_string()));
            break;
        }
    }
}

impl Drop for CompanionBridge {
    fn drop(&mut self) {
        // 窗口与 companion 同生共死：壳退出时杀子进程
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::{CompanionBridge, CompanionConfig, RestartPolicy};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn full_stdin_queue_marks_companion_offline() {
        let (program, args) = exit_command();
        let mut bridge = CompanionBridge::spawn(CompanionConfig {
            program,
            args,
            cwd: None,
            restart: None,
        })
        .expect("initial companion must start");
        let (tx, _rx) = mpsc::sync_channel(0);
        bridge.stdin_tx = tx;

        let error = bridge
            .send_line("{}")
            .expect_err("zero-capacity queue is full");
        assert!(error.to_string().contains("bridge marked offline"));
        assert!(bridge.stdin_failed);
        assert_eq!(bridge.dropped_lines, 1);
        assert!(bridge.poll().1);
        assert!(bridge.offline_notified);
    }

    #[test]
    fn failed_restart_attempts_stop_at_the_policy_limit() {
        let (program, args) = exit_command();
        let mut bridge = CompanionBridge::spawn(CompanionConfig {
            program,
            args,
            cwd: None,
            restart: Some(RestartPolicy {
                max_restarts: 2,
                delay: Duration::ZERO,
            }),
        })
        .expect("initial companion must start");
        bridge.config.program = missing_program();

        let mut offline = false;
        for _ in 0..100 {
            let (_, became_offline) = bridge.poll();
            offline |= became_offline;
            if offline {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(offline, "initial companion must report EOF");
        for _ in 0..4 {
            bridge.poll();
        }
        assert_eq!(bridge.restart_attempts, 2);
        assert!(bridge.next_restart_at.is_none());
    }

    /// Return a portable command that exits immediately.
    fn exit_command() -> (PathBuf, Vec<String>) {
        #[cfg(windows)]
        {
            return (
                PathBuf::from("cmd"),
                vec!["/C".into(), "exit".into(), "0".into()],
            );
        }
        #[cfg(not(windows))]
        {
            (PathBuf::from("sh"), vec!["-c".into(), "exit 0".into()])
        }
    }

    /// Return a command path that cannot be spawned by the test process.
    fn missing_program() -> PathBuf {
        PathBuf::from(format!("pocketjs-companion-missing-{}", std::process::id()))
    }
}
