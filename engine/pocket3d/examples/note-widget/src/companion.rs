//! 外部 companion 进程桥：JSONL stdio，可观测崩溃与可选重启。

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
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
}

/// 双向 JSONL 管道 + 崩溃观测。
pub struct CompanionBridge {
    config: CompanionConfig,
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<RxMsg>,
    restarts: u32,
    offline_notified: bool,
    next_restart_at: Option<Instant>,
}

impl CompanionBridge {
    /// 按配置启动 companion。
    pub fn spawn(config: CompanionConfig) -> Result<Self> {
        let (child, stdin, rx) = spawn_child(&config)?;
        Ok(Self {
            config,
            child,
            stdin,
            rx,
            restarts: 0,
            offline_notified: false,
            next_restart_at: None,
        })
    }

    /// 兼容旧 API：program + args + cwd。
    pub fn spawn_simple(
        program: PathBuf,
        args: Vec<String>,
        cwd: Option<PathBuf>,
    ) -> Result<Self> {
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
        if self.offline_notified {
            return Err(anyhow!("companion offline"));
        }
        let mut payload = line.trim_end_matches(['\r', '\n']).to_string();
        payload.push('\n');
        self.stdin
            .write_all(payload.as_bytes())
            .context("write companion stdin")?;
        self.stdin.flush().context("flush companion stdin")?;
        Ok(())
    }

    /// 非阻塞排空 companion→guest 行；并推进崩溃/重启状态。
    /// 返回 (业务行, 是否刚变为 offline)。
    pub fn poll(&mut self) -> (Vec<String>, bool) {
        let mut out = Vec::new();
        let mut eof = false;
        loop {
            match self.rx.try_recv() {
                Ok(RxMsg::Line(line)) => out.push(line),
                Ok(RxMsg::Eof) => {
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
            let _ = self.child.wait();
            self.offline_notified = true;
            became_offline = true;
            log::warn!(
                "note-widget: companion exited ({})",
                self.config.program.display()
            );
            if let Some(policy) = &self.config.restart {
                if self.restarts < policy.max_restarts {
                    self.next_restart_at = Some(Instant::now() + policy.delay);
                }
            }
        }

        // 到点尝试重启
        if self.offline_notified
            && let Some(at) = self.next_restart_at
            && Instant::now() >= at
        {
            self.next_restart_at = None;
            match spawn_child(&self.config) {
                Ok((child, stdin, rx)) => {
                    self.child = child;
                    self.stdin = stdin;
                    self.rx = rx;
                    self.restarts += 1;
                    self.offline_notified = false;
                    log::info!(
                        "note-widget: companion restarted (#{})",
                        self.restarts
                    );
                }
                Err(e) => {
                    log::warn!("note-widget: companion restart failed: {e}");
                    if let Some(policy) = &self.config.restart {
                        if self.restarts < policy.max_restarts {
                            self.next_restart_at = Some(Instant::now() + policy.delay);
                        }
                    }
                }
            }
        }

        (out, became_offline)
    }

}

fn spawn_child(config: &CompanionConfig) -> Result<(Child, ChildStdin, Receiver<RxMsg>)> {
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
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("companion missing stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("companion missing stdout"))?;

    let (tx, rx) = mpsc::channel::<RxMsg>();
    thread::Builder::new()
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
        .context("spawn companion stdout thread")?;

    Ok((child, stdin, rx))
}

impl Drop for CompanionBridge {
    fn drop(&mut self) {
        // 窗口与 companion 同生共死：壳退出时杀子进程
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
