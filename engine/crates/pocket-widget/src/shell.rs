//! The widget window shell: two rates, one clock.
//!
//! The guest ticks at a fixed rate, always — one guest turn per host tick
//! (Law 3), so tapes, goldens and replays hold inside a widget. GPU frames
//! are demand-driven: a frame renders only when the game reports dirt (the
//! embedded UI changed, a part moved, the camera eased). No dirt → no render
//! pass, no present — the compositor retains the last frame and an idle
//! widget costs ticks (microseconds), not frames. macOS occlusion suspends
//! rendering entirely while ticks keep the app live behind other windows.
//!
//! This is a sibling of [`pocket3d::app::run`], not a wrapper: that loop
//! ties simulation to redraws (right for games rendering every frame),
//! while a widget must tick without rendering.
//!
//! Two widget shapes share the governor:
//!
//! - [`WidgetGame`] + [`run`] — the 3D form (a scene, a camera, meshes; the
//!   `ui` surface arrives on a screen mesh via [`crate::embed::EmbeddedUi`]).
//! - [`FlatWidget`] + [`run_flat`] — the 2D form: the window *is* the `ui`
//!   surface, rendered 1:1 by `pocket-ui-wgpu` with no scene pass at all.
//!   The natural shape for text-first widgets (notes, tickers, boards).

use std::num::NonZeroU32;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use glam::Vec2;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Icon, Window, WindowId, WindowLevel};

use pocket3d::app::pick_alpha_mode;
use pocket3d::camera::Camera;
use pocket3d::gpu::Gpu;
use pocket3d::hud::Hud;
use pocket3d::input::Input;
use pocket3d::renderer::Renderer;
use pocket3d::scene::Scene;
use pocketjs_core::damage::DamageRect;

/// Effective window transparency after surface configuration.
///
/// Single-window widget hosts only. `None` until a surface is configured.
/// In-process launchers/tests read [`display_transparent`]; cross-process
/// parents can grep the stable log line `pocket-widget: display_transparent=`.
static DISPLAY_TRANSPARENT: AtomicU8 = AtomicU8::new(0); // 0 unknown, 1 opaque, 2 transparent

/// 读取本进程 widget shell 实际生效的透明合成结果。
pub fn display_transparent() -> Option<bool> {
    // 供同进程 launcher/测试查询
    match DISPLAY_TRANSPARENT.load(Ordering::Relaxed) {
        1 => Some(false),
        2 => Some(true),
        _ => None,
    }
}

/// 测试/重入 boot 前清空透明状态。
pub fn clear_display_transparent() {
    // 恢复 unknown，避免串测粘滞
    DISPLAY_TRANSPARENT.store(0, Ordering::Relaxed);
}

fn set_display_transparent(value: bool) {
    // 单线程 boot 路径写入一次，并打可 grep 的稳定日志
    DISPLAY_TRANSPARENT.store(if value { 2 } else { 1 }, Ordering::Relaxed);
    log::info!(
        "pocket-widget: display_transparent={}",
        if value { 1 } else { 0 }
    );
}

pub struct WidgetConfig {
    pub title: String,
    /// Initial window size in logical px.
    pub size: (u32, u32),
    /// Fixed simulation rate — the guest cadence (60 = the PSP's).
    pub tick_hz: f32,
    /// Render cap for the active case (eases, drags). The loop sleeps
    /// between frames; dirt reported while pacing is latched, never lost.
    pub max_fps: f32,
    pub transparent: bool,
    pub decorations: bool,
    pub always_on_top: bool,
    /// Live window resizing. Borderless windows keep the `Resizable` style
    /// mask on macOS (edge-drag works without decorations); games can also
    /// claim a grip region via `resize_at` for an explicit affordance.
    pub resizable: bool,
    /// Logical px floor enforced by the OS while `resizable`.
    pub min_size: (u32, u32),
    /// Optional logical px ceiling enforced by the OS while `resizable`.
    pub max_size: Option<(u32, u32)>,
    /// Enable OS text composition (IME). Composition arrives on the input's
    /// `ime_events` stream; the game reports its caret rect through
    /// `ime_cursor_area` so candidate windows dock next to the text.
    pub ime: bool,
    /// Optional window icon (title bar / taskbar). The desktop launchers
    /// decode a user-supplied `.ico` and pass it here; `None` keeps the
    /// platform default icon.
    pub icon: Option<Icon>,
    /// Optional system tray (Windows/macOS). With a tray, closing the window
    /// hides to the tray instead of quitting; the tray owns restore + quit.
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    pub tray: Option<crate::tray::TrayConfig>,
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            title: "Pocket Widget".into(),
            size: (480, 260),
            tick_hz: 60.0,
            max_fps: 60.0,
            transparent: true,
            decorations: false,
            always_on_top: true,
            resizable: false,
            min_size: (160, 120),
            max_size: None,
            ime: false,
            icon: None,
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            tray: None,
        }
    }
}

/// What the widget loop needs from a 3D product.
pub trait WidgetGame {
    /// Called once after the GPU exists — build assets, boot guests.
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()>;
    /// One fixed-step tick: the guest turn (`frame(buttons, analog)`), the
    /// embedded UI tick, interaction state. Runs whether or not a frame
    /// will render. `window_px` is the surface size in physical pixels —
    /// the space cursor positions live in, for picking. Mark dirt
    /// internally; the shell collects it via [`take_dirty`](Self::take_dirty).
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32)) -> Result<()>;
    /// Consume the "needs a GPU frame" flag. Latched by the shell until a
    /// frame actually renders, so fps pacing never drops dirt.
    fn take_dirty(&mut self) -> bool;
    /// Record offscreen work that must land before the scene pass samples
    /// it (the embedded UI render). Called only on frames that render.
    fn prepare(&mut self, gpu: &Gpu) -> Result<()>;
    /// Provide the frame to draw. `time` is seconds since launch.
    fn compose(&mut self, time: f32, size: (u32, u32)) -> (&Scene, &Camera, &Hud);
    /// Left-press policy: return true to start an OS window drag at this
    /// cursor position (widget-style move) instead of interacting.
    fn drag_at(&mut self, cursor: Vec2) -> bool {
        let _ = cursor;
        false
    }
    /// Left-press policy: return true to start a window resize drag at this
    /// cursor position (a grip corner). Consulted before `drag_at`.
    fn resize_at(&mut self, cursor: Vec2) -> bool {
        let _ = cursor;
        false
    }
    fn wants_exit(&self) -> bool {
        false
    }
}

/// One CPU-present frame: the framebuffer the game rasterized and the
/// logical-viewport rectangles that were actually repainted (the shell
/// blits only those; everything outside them is retained from earlier
/// frames).
pub struct CpuFrame {
    pub width: u32,
    pub height: u32,
    /// Logical damage rects repainted this frame (always non-empty; a
    /// full redraw is the whole viewport).
    pub damaged: Vec<DamageRect>,
}

/// What the widget loop needs from a 2D (window-is-the-surface) product.
///
/// Same governor, no scene: the game renders whatever it wants straight
/// into the swapchain view — for a PocketJS widget that is one
/// `UiRenderer::render_words` pass over the guest's DrawList. The CPU
/// present path ([`run_flat_cpu`]) never creates a GPU device: it calls
/// [`init_cpu`](Self::init_cpu) instead of [`init`](Self::init) and
/// [`render_cpu`](Self::render_cpu) instead of [`render`](Self::render).
pub trait FlatWidget {
    /// Called once after the GPU exists. `format` is the swapchain format
    /// the game's pipelines must target. CPU runs never call this.
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()>;
    /// CPU present path only: one-time setup with no GPU device (no
    /// renderer to create — the rasterizer lives in the core).
    fn init_cpu(&mut self) -> Result<()> {
        Ok(())
    }
    /// One fixed-step tick — the guest turn. `window_px` is the surface
    /// size in physical pixels; `scale` the window's scale factor (cursor
    /// positions and `window_px` are physical — divide by `scale` for
    /// logical px).
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32), scale: f64) -> Result<()>;
    /// Consume the "needs a GPU frame" flag (latched by the shell).
    fn take_dirty(&mut self) -> bool;
    /// Draw into the swapchain view (submit your own encoder). Called only
    /// on frames that render. CPU runs never call this.
    fn render(&mut self, gpu: &Gpu, view: &wgpu::TextureView, window_px: (u32, u32)) -> Result<()>;
    /// CPU present path only: rasterize the current frame into `fb` — the
    /// shell's persistent framebuffer — resizing it to the game's chosen
    /// viewport × integer scale. Returns the framebuffer dimensions and
    /// the damage rects the frame actually repainted, so the shell blits
    /// only those. Called only on frames that render.
    fn render_cpu(&mut self, fb: &mut Vec<u32>, window_px: (u32, u32)) -> Result<CpuFrame> {
        let _ = (fb, window_px);
        Err(anyhow!("CPU rendering not implemented by this game"))
    }
    /// Left-press policy: OS window drag (move) at this cursor position?
    fn drag_at(&mut self, cursor: Vec2) -> bool {
        let _ = cursor;
        false
    }
    /// Left-press policy: window resize drag at this cursor position?
    /// Consulted before `drag_at`. The shell tracks the drag itself
    /// (macOS has no OS resize session for borderless windows).
    fn resize_at(&mut self, cursor: Vec2) -> bool {
        let _ = cursor;
        false
    }
    /// The caret rect in PHYSICAL px (x, y, w, h) — where the OS should
    /// dock IME candidate windows. Polled after ticks; None clears the
    /// previous placement.
    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)> {
        None
    }
    fn wants_exit(&self) -> bool {
        false
    }

    /// Consume a product-requested close (the guest asked to quit). With a
    /// tray the shell hides to it; without one it exits. Always false on
    /// Linux, where the tray concept does not exist.
    fn take_close_request(&mut self) -> bool {
        false
    }
}

/// Run a 3D widget (scene + camera + demand rendering).
pub fn run(config: WidgetConfig, game: impl WidgetGame) -> Result<()> {
    run_driver(
        config,
        SceneDriver {
            game,
            renderer: None,
        },
        RenderBackend::Wgpu,
    )
}

/// Run a 2D widget (the window is the surface).
pub fn run_flat(config: WidgetConfig, game: impl FlatWidget) -> Result<()> {
    run_driver(
        config,
        FlatDriver { game },
        RenderBackend::Wgpu,
    )
}

/// Run a 2D widget on the CPU present path (softbuffer): the window
/// presents a software framebuffer via GDI DIBs — no wgpu adapter/device,
/// no GPU driver floor — for hosts that must stay cheap at rest. The
/// governor, input, IME and tray are identical to [`run_flat`]; only the
/// frame is rasterized by the game (core raster) into the shell's buffer.
///
/// Consequences (softbuffer blits 1:1 and never stretches):
///
/// - the window is forced opaque (a DIB has no alpha channel);
/// - the game's framebuffer is resampled by the shell to the window
///   client size, so fractional-DPI displays (125%) present a soft
///   bilinear upscale — scale-1.0 displays are pixel-exact. Games that
///   want crisper text on fractional DPI can raster at a higher integer
///   scale and let the same resampler downscale.
pub fn run_flat_cpu(config: WidgetConfig, game: impl FlatWidget) -> Result<()> {
    if config.transparent {
        log::warn!(
            "pocket-widget: CPU present path forces an opaque window; ignoring transparent=true"
        );
    }
    run_driver(
        WidgetConfig {
            transparent: false,
            ..config
        },
        FlatDriver { game },
        RenderBackend::Cpu,
    )
}

/// Which present backend the governor drives: a wgpu device + swapchain,
/// or the shell-owned software framebuffer presented via softbuffer.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RenderBackend {
    Wgpu,
    Cpu,
}

/// View a u32 framebuffer as its in-memory byte layout for core CPU
/// rasterizers. `fb` is u32-aligned by construction, so the byte view is
/// always well-aligned; on little-endian hosts (all supported desktop
/// targets) each word reads as B,G,R,A bytes — exactly what the raster's
/// ARGB output paths emit.
pub fn framebuffer_bytes(fb: &mut [u32]) -> &mut [u8] {
    bytemuck::cast_slice_mut(fb)
}

/// Copy the given logical rects 1:1 from `src` into `dst` (same size),
/// returning the corresponding destination rects for
/// [`Buffer::present_with_damage`].
fn copy_rects(
    src: &[u32],
    dst: &mut [u32],
    w: u32,
    h: u32,
    rects: &[DamageRect],
) -> Vec<softbuffer::Rect> {
    assert_eq!(src.len() as u32, w * h);
    assert_eq!(dst.len() as u32, w * h);
    let (w, h) = (w as usize, h as usize);
    let mut present = Vec::with_capacity(rects.len());
    for &rect in rects {
        let x0 = rect.x0.clamp(0, w as i32) as usize;
        let x1 = rect.x1.clamp(0, w as i32) as usize;
        let y0 = rect.y0.clamp(0, h as i32) as usize;
        let y1 = rect.y1.clamp(0, h as i32) as usize;
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        for y in y0..y1 {
            let src_row = &src[y * w + x0..y * w + x1];
            let dst_row = &mut dst[y * w + x0..y * w + x1];
            dst_row.copy_from_slice(src_row);
        }
        present.push(softbuffer::Rect {
            x: x0 as u32,
            y: y0 as u32,
            width: NonZeroU32::new((x1 - x0) as u32).expect("rect width > 0"),
            height: NonZeroU32::new((y1 - y0) as u32).expect("rect height > 0"),
        });
    }
    present
}

/// Bilinear resampler from the game's logical framebuffer to the window
/// client size (fractional-DPI displays; scale-1.0 displays never use it
/// — sizes match and [`copy_rects`] handles the blit).
///
/// Fixed-point Q7 blending (fractions in 0..=128) with axis tables rebuilt
/// only when a size changes, so the per-pixel inner loop has no divisions
/// and no float math.
#[derive(Default)]
struct Resampler {
    src: (u32, u32),
    dst: (u32, u32),
    /// Per destination x: (x0, x1, f) — f in Q7.
    xs: Vec<(u32, u32, u32)>,
    /// Per destination y: (y0, y1, f) — f in Q7.
    ys: Vec<(u32, u32, u32)>,
}

impl Resampler {
    /// Full-frame resample (test helper).
    #[cfg(test)]
    fn run(&mut self, src: &[u32], sw: u32, sh: u32, dst: &mut [u32], dw: u32, dh: u32) {
        let rect = DamageRect::new(0, 0, sw as i32, sh as i32);
        self.run_rects(src, sw, sh, dst, dw, dh, &[rect]);
    }

    /// Resample only the given logical damage rects from `src` into `dst`
    /// (dest rects are the client-scaled equivalents). Returns the
    /// corresponding destination rectangles for [`Buffer::present_with_damage`].
    #[allow(clippy::too_many_arguments)] // (src, src size, dst, dst size, rects)
    fn run_rects(
        &mut self,
        src: &[u32],
        sw: u32,
        sh: u32,
        dst: &mut [u32],
        dw: u32,
        dh: u32,
        rects: &[DamageRect],
    ) -> Vec<softbuffer::Rect> {
        assert_eq!(src.len() as u32, sw * sh);
        assert_eq!(dst.len() as u32, dw * dh);
        if self.src != (sw, sh) || self.dst != (dw, dh) {
            self.xs = resample_axis(sw, dw);
            self.ys = resample_axis(sh, dh);
            self.src = (sw, sh);
            self.dst = (dw, dh);
        }
        let (xs, ys) = (&self.xs, &self.ys);
        let (sw, dw) = (sw as usize, dw as usize);
        let mut present = Vec::with_capacity(rects.len());
        for &rect in rects {
            // Scale the logical rect outwards to the client grid.
            let (dx0, dy0) = (
                (rect.x0 as u64 * dw as u64 / sw as u64) as usize,
                (rect.y0 as u64 * dh as u64 / sh as u64) as usize,
            );
            let (dx1, dy1) = (
                ((rect.x1 as u64 * dw as u64).div_ceil(sw as u64)) as usize,
                ((rect.y1 as u64 * dh as u64).div_ceil(sh as u64)) as usize,
            );
            if dx0 >= dx1 || dy0 >= dy1 {
                continue;
            }
            for (y, &(y0, y1, fy)) in ys[dy0..dy1].iter().enumerate() {
                let y = y + dy0;
                let row0 = y0 as usize * sw;
                let row1 = y1 as usize * sw;
                let inv_fy = 128 - fy;
                for (x, &(x0, x1, fx)) in xs[dx0..dx1].iter().enumerate() {
                    let x = x + dx0;
                    let p00 = src[row0 + x0 as usize];
                    let p01 = src[row0 + x1 as usize];
                    let p10 = src[row1 + x0 as usize];
                    let p11 = src[row1 + x1 as usize];
                    // x-lerp on 16-bit lanes (B,R and G,A pairs never carry
                    // across lanes: products <= 255*128 < 2^15), y-lerp per
                    // byte on the two x-blended pixels.
                    let top = lerp_x(p00, p01, fx, 128 - fx);
                    let bottom = lerp_x(p10, p11, fx, 128 - fx);
                    let mut out = 0u32;
                    for shift in [0, 8, 16, 24] {
                        let c = (((top >> shift) & 0xFF) * inv_fy
                            + ((bottom >> shift) & 0xFF) * fy)
                            >> 7;
                        out |= (c & 0xFF) << shift;
                    }
                    dst[y * dw + x] = out;
                }
            }
            present.push(softbuffer::Rect {
                x: dx0 as u32,
                y: dy0 as u32,
                width: NonZeroU32::new((dx1 - dx0) as u32).expect("rect width > 0"),
                height: NonZeroU32::new((dy1 - dy0) as u32).expect("rect height > 0"),
            });
        }
        present
    }
}

/// Q7 lerp of the B,R lane pair and the G,A lane pair in one pass each
/// (each 16-bit lane product stays below 2^15, so packed adds never carry
/// across lanes).
fn lerp_x(p0: u32, p1: u32, f: u32, inv: u32) -> u32 {
    let lo = (p0 & 0x00FF00FF) * inv + (p1 & 0x00FF00FF) * f;
    let hi = ((p0 >> 24) << 16 | ((p0 >> 8) & 0xFF)) * inv
        + (((p1 >> 24) << 16 | ((p1 >> 8) & 0xFF)) * f);
    ((lo >> 7) & 0x00FF00FF) | (((hi >> 7) & 0x00FF00FF) << 8)
}

/// One resample axis: for each destination index, the floor source index,
/// its +1 neighbour, and the Q7 blend fraction. Source coordinates follow
/// the centre-aligned bilinear convention: sx = (x + 0.5)*src/dst - 0.5.
fn resample_axis(src_len: u32, dst_len: u32) -> Vec<(u32, u32, u32)> {
    let den = (2 * dst_len) as i64;
    (0..dst_len)
        .map(|x| {
            // ((2x+1)*src - dst) / (2*dst), floored
            let mut num = (2 * x as i64 + 1) * src_len as i64 - dst_len as i64;
            let sx = num.div_euclid(den);
            num -= sx * den; // 0 <= num < den
            let f = ((num * 128) / den) as u32;
            let x0 = sx.clamp(0, src_len as i64 - 1) as u32;
            let x1 = (sx + 1).clamp(0, src_len as i64 - 1) as u32;
            (x0, x1, f)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The governor, generic over the two widget shapes.
// ---------------------------------------------------------------------------

/// Internal adapter: what the event loop actually drives. Both public
/// traits funnel into this so the governor exists exactly once.
trait Driver {
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()>;
    /// CPU present path: one-time setup with no GPU device.
    fn init_cpu(&mut self) -> Result<()> {
        Ok(())
    }
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32), scale: f64) -> Result<()>;
    fn take_dirty(&mut self) -> bool;
    fn render(
        &mut self,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        window_px: (u32, u32),
        time: f32,
    ) -> Result<()>;
    /// CPU present path: rasterize into the shell's framebuffer.
    fn render_cpu(&mut self, fb: &mut Vec<u32>, window_px: (u32, u32)) -> Result<CpuFrame> {
        let _ = (fb, window_px);
        Err(anyhow!("CPU rendering not supported by this driver"))
    }
    fn drag_at(&mut self, cursor: Vec2) -> bool;
    fn resize_at(&mut self, cursor: Vec2) -> bool;
    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)>;
    fn wants_exit(&self) -> bool;
    /// Product-requested close (default: none). The 3D shape has no close
    /// request concept; flat products override it.
    fn take_close_request(&mut self) -> bool {
        false
    }
}

struct SceneDriver<G: WidgetGame> {
    game: G,
    renderer: Option<Renderer>,
}

impl<G: WidgetGame> Driver for SceneDriver<G> {
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()> {
        let mut renderer = Renderer::new(gpu, format)?;
        self.game.init(gpu, &mut renderer)?;
        self.renderer = Some(renderer);
        Ok(())
    }
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32), _scale: f64) -> Result<()> {
        self.game.tick(dt, input, window_px)
    }
    fn take_dirty(&mut self) -> bool {
        self.game.take_dirty()
    }
    fn render(
        &mut self,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        window_px: (u32, u32),
        time: f32,
    ) -> Result<()> {
        self.game.prepare(gpu)?;
        let (scene, camera, hud) = self.game.compose(time, window_px);
        let renderer = self.renderer.as_mut().expect("init ran");
        renderer.render(gpu, view, window_px, scene, camera, hud);
        Ok(())
    }
    fn drag_at(&mut self, cursor: Vec2) -> bool {
        self.game.drag_at(cursor)
    }
    fn resize_at(&mut self, cursor: Vec2) -> bool {
        self.game.resize_at(cursor)
    }
    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)> {
        None
    }
    fn wants_exit(&self) -> bool {
        self.game.wants_exit()
    }
}

struct FlatDriver<G: FlatWidget> {
    game: G,
}

impl<G: FlatWidget> Driver for FlatDriver<G> {
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()> {
        self.game.init(gpu, format)
    }
    fn init_cpu(&mut self) -> Result<()> {
        self.game.init_cpu()
    }
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32), scale: f64) -> Result<()> {
        self.game.tick(dt, input, window_px, scale)
    }
    fn take_dirty(&mut self) -> bool {
        self.game.take_dirty()
    }
    fn render(
        &mut self,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        window_px: (u32, u32),
        _time: f32,
    ) -> Result<()> {
        self.game.render(gpu, view, window_px)
    }
    fn render_cpu(&mut self, fb: &mut Vec<u32>, window_px: (u32, u32)) -> Result<CpuFrame> {
        self.game.render_cpu(fb, window_px)
    }
    fn drag_at(&mut self, cursor: Vec2) -> bool {
        self.game.drag_at(cursor)
    }
    fn resize_at(&mut self, cursor: Vec2) -> bool {
        self.game.resize_at(cursor)
    }
    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)> {
        self.game.ime_cursor_area()
    }
    fn wants_exit(&self) -> bool {
        self.game.wants_exit()
    }
    fn take_close_request(&mut self) -> bool {
        self.game.take_close_request()
    }
}

/// Reject a window configuration whose resize bounds cannot be represented safely.
fn validate_config(config: &WidgetConfig) -> Result<()> {
    if let Some((max_width, max_height)) = config.max_size
        && (config.min_size.0 > max_width || config.min_size.1 > max_height)
    {
        return Err(anyhow!(
            "window minimum {}x{} exceeds maximum {}x{}",
            config.min_size.0,
            config.min_size.1,
            max_width,
            max_height
        ));
    }
    Ok(())
}

fn run_driver(config: WidgetConfig, driver: impl Driver, backend: RenderBackend) -> Result<()> {
    validate_config(&config)?;
    let event_loop = EventLoop::new()?;
    let mut app = WidgetApp {
        config,
        backend,
        driver,
        state: None,
        error: None,
        ticks: 0,
        frames: 0,
        arms: ArmCounts::default(),
    };
    event_loop.run_app(&mut app)?;
    // The governor's receipt: how many fixed ticks ran vs. GPU frames
    // actually rendered. A settled widget should show frames ≪ ticks.
    log::info!(
        "pocket-widget: {} ticks, {} frames rendered ({:.1}%) — armed by dirt {}, resize {}, occlusion {}, scale {}; {} unarmed OS redraws skipped",
        app.ticks,
        app.frames,
        100.0 * app.frames as f64 / app.ticks.max(1) as f64,
        app.arms.dirty,
        app.arms.resized,
        app.arms.occlusion,
        app.arms.scale,
        app.arms.unarmed_redraws
    );
    match app.error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Catch-up bound: after an app-nap the loop resyncs instead of replaying
/// the gap (a widget needs liveness, not history).
const MAX_CATCHUP_TICKS: u32 = 6;

/// Why frames were armed — logged with the exit receipt so a hot widget
/// explains itself (dirt is the only healthy steady-state source).
#[derive(Default)]
struct ArmCounts {
    dirty: u64,
    resized: u64,
    occlusion: u64,
    scale: u64,
    /// OS-initiated RedrawRequested with nothing pending (skipped).
    unarmed_redraws: u64,
}

struct WindowState {
    window: Arc<Window>,
    present: Present,
    input: Input,
    start: Instant,
    next_tick: Instant,
    last_render: Instant,
    /// Dirt latched from the game, waiting for a paced render.
    render_pending: bool,
    occluded: bool,
    /// Last IME caret rect handed to the OS (dedupe).
    ime_area: Option<(f32, f32, f32, f32)>,
    /// Live grip resize: (cursor at press, window physical size at press).
    /// The shell tracks the drag itself — macOS offers no OS resize
    /// session for borderless windows.
    resizing: Option<(Vec2, (u32, u32))>,
    /// Live tray icon; must outlive the loop (Drop removes it from the
    /// platform tray).
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    tray: Option<crate::tray::TrayState>,
}

impl WindowState {
    /// The current surface size in physical px (the space cursor
    /// positions and `window_px` live in).
    fn window_px(&self) -> (u32, u32) {
        match &self.present {
            Present::Wgpu { surface_config, .. } => {
                (surface_config.width, surface_config.height)
            }
            // CPU: the framebuffer follows the window client exactly (the
            // scale factor is pinned to 1.0), so inner_size IS the surface.
            Present::Cpu { .. } => {
                let size = self.window.inner_size();
                (size.width.max(1), size.height.max(1))
            }
        }
    }
}

/// The present backend a [`WindowState`] drives.
///
/// Field order matters for drop: the softbuffer context must outlive the
/// surface that borrows it.
enum Present {
    Wgpu {
        surface: wgpu::Surface<'static>,
        surface_config: wgpu::SurfaceConfiguration,
        gpu: Gpu,
    },
    Cpu {
        /// Kept alive so the softbuffer [`Context`] outlives the surface
        /// that borrows it (the surface holds a raw pointer to it).
        #[allow(dead_code)]
        context: softbuffer::Context<Arc<Window>>,
        surface: softbuffer::Surface<Arc<Window>, Arc<Window>>,
        /// Persistent software framebuffer (ARGB words) the game
        /// rasterizes into each frame; copied to the softbuffer buffer
        /// on present. Retained so damage tracking stays valid across
        /// frames.
        fb: Vec<u32>,
        /// Client-size resampler (fractional-DPI displays); caches its
        /// axis tables across frames.
        resampler: Resampler,
        /// Last client size the DIB was (re)created at — a change means
        /// the retained pixels were lost and everything must repaint.
        last_client: (u32, u32),
    },
}

struct WidgetApp<D: Driver> {
    config: WidgetConfig,
    backend: RenderBackend,
    driver: D,
    state: Option<WindowState>,
    error: Option<anyhow::Error>,
    ticks: u64,
    frames: u64,
    arms: ArmCounts,
}

impl<D: Driver> WidgetApp<D> {
    fn init_state(&mut self, event_loop: &ActiveEventLoop) -> Result<WindowState> {
        let mut attrs = Window::default_attributes()
            .with_title(self.config.title.clone())
            .with_inner_size(winit::dpi::LogicalSize::new(
                self.config.size.0,
                self.config.size.1,
            ))
            .with_transparent(self.config.transparent)
            .with_decorations(self.config.decorations)
            .with_resizable(self.config.resizable)
            .with_window_level(if self.config.always_on_top {
                WindowLevel::AlwaysOnTop
            } else {
                WindowLevel::Normal
            });
        if let Some(icon) = &self.config.icon {
            attrs = attrs.with_window_icon(Some(icon.clone()));
        }
        if self.config.resizable {
            attrs = attrs.with_min_inner_size(winit::dpi::LogicalSize::new(
                self.config.min_size.0,
                self.config.min_size.1,
            ));
            if let Some((width, height)) = self.config.max_size {
                attrs = attrs.with_max_inner_size(winit::dpi::LogicalSize::new(width, height));
            }
        }
        let window = Arc::new(event_loop.create_window(attrs)?);
        if self.config.ime {
            window.set_ime_allowed(true);
        }
        // Tray creation happens on the event-loop thread (required by
        // tray-icon on both platforms). A tray is an enhancement, not the
        // product: a NIM_ADD rejection must degrade to no-tray, never abort
        // boot (Shell_NotifyIconW can transiently reject right after a
        // previous tray owner exits — NIM_ADD's own result is the
        // authoritative signal, so no retry is attempted).
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let tray = match &self.config.tray {
            Some(config) => match crate::tray::TrayState::create(config) {
                Ok(tray) => Some(tray),
                Err(error) => {
                    log::warn!("pocket-widget: tray unavailable, continuing without it: {error}");
                    None
                }
            },
            None => None,
        };
        let present = match self.backend {
            RenderBackend::Wgpu => {
                let instance = Gpu::new_instance_for_widgets();
                let surface = instance.create_surface(window.clone())?;
                let gpu = Gpu::from_instance_for_surface_with_power_preference(
                    instance,
                    &surface,
                    wgpu::PowerPreference::LowPower,
                )?;

                let px = window.inner_size();
                let mut surface_config = surface
                    .get_default_config(&gpu.adapter, px.width.max(1), px.height.max(1))
                    .ok_or_else(|| anyhow::anyhow!("surface not supported by adapter"))?;
                // Demand-rendered widgets rarely present; keep a single buffered frame
                // of latency so DX12 does not retain multi-frame swapchain images.
                surface_config.desired_maximum_frame_latency = 1;
                surface_config.present_mode = wgpu::PresentMode::AutoVsync;
                if self.config.transparent {
                    // Windows DX12 swapchains often only advertise Opaque. Prefer a
                    // real composite alpha when offered; otherwise degrade explicitly
                    // so ambient sticky hosts still boot, without pretending the
                    // surface stayed transparent.
                    match pick_alpha_mode(&surface, &gpu.adapter) {
                        Ok(mode) => {
                            set_display_transparent(true);
                            surface_config.alpha_mode = mode;
                        }
                        Err(error) => {
                            // Explicit degrade: sticky hosts still boot, but callers can
                            // observe the loss via display_transparent() == Some(false).
                            set_display_transparent(false);
                            log::warn!(
                                "pocket-widget: transparent composite unavailable ({error}); \
                                 degrading to opaque (display_transparent=false)"
                            );
                            surface_config.alpha_mode = wgpu::CompositeAlphaMode::Opaque;
                        }
                    }
                } else {
                    set_display_transparent(false);
                }
                surface.configure(&gpu.device, &surface_config);

                self.driver.init(&gpu, surface_config.format)?;
                Present::Wgpu {
                    surface,
                    surface_config,
                    gpu,
                }
            }
            RenderBackend::Cpu => {
                // A software framebuffer has no alpha channel: the window
                // is opaque by construction (run_flat_cpu already forced
                // it; this is the authoritative record for observers).
                set_display_transparent(false);
                let context = softbuffer::Context::new(window.clone())
                    .map_err(|e| anyhow::anyhow!("softbuffer context: {e}"))?;
                let surface = softbuffer::Surface::new(&context, window.clone())
                    .map_err(|e| anyhow::anyhow!("softbuffer surface: {e}"))?;
                self.driver.init_cpu()?;
                Present::Cpu {
                    context,
                    surface,
                    fb: Vec::new(),
                    resampler: Resampler::default(),
                    last_client: (0, 0),
                }
            }
        };

        let now = Instant::now();
        Ok(WindowState {
            window,
            present,
            input: Input::default(),
            start: now,
            next_tick: now,
            last_render: now - Duration::from_secs(1),
            render_pending: true, // first frame
            occluded: false,
            ime_area: None,
            resizing: None,
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            tray,
        })
    }

    /// The governor: run due fixed ticks, collect dirt, schedule the next
    /// wake at whichever comes first — the next tick or a due render.
    fn pump(&mut self, event_loop: &ActiveEventLoop) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        let tick_dt = 1.0 / self.config.tick_hz.max(1.0);
        let tick_interval = Duration::from_secs_f32(tick_dt);
        let now = Instant::now();

        let window_px = state.window_px();
        let scale = state.window.scale_factor();
        let mut ran = 0u32;
        while now >= state.next_tick && ran < MAX_CATCHUP_TICKS {
            if let Err(e) = self.driver.tick(tick_dt, &state.input, window_px, scale) {
                self.error = Some(e);
                event_loop.exit();
                return;
            }
            // Pressed edges and device deltas belong to one simulation turn,
            // even when the governor catches up multiple fixed ticks in one
            // pump. Held state remains set until the matching release event.
            state.input.end_frame();
            state.next_tick += tick_interval;
            ran += 1;
        }
        self.ticks += ran as u64;
        if ran == MAX_CATCHUP_TICKS && now >= state.next_tick {
            state.next_tick = now + tick_interval;
        }
        if self.driver.wants_exit() {
            event_loop.exit();
            return;
        }

        // Tray actions: restore/hide via the tray (Windows and macOS:
        // left-click toggle, plus the macOS Show/Hide menu item). Quit is
        // the tray's real exit.
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if state.tray.is_some() {
            for action in crate::tray::poll_actions() {
                match action {
                    crate::tray::TrayAction::ToggleVisibility => {
                        // Windows/macOS always report Some; unwrap_or(false)
                        // only guards platforms where visibility is
                        // unknowable (X11), which cannot reach here because
                        // the tray module is cfg'd to Windows/macOS.
                        let visible = !state.window.is_visible().unwrap_or(false);
                        state.window.set_visible(visible);
                        if visible {
                            // Repaint + focus on restore; the retained
                            // frame may predate the hide.
                            state.window.focus_window();
                            state.render_pending = true;
                        }
                    }
                    crate::tray::TrayAction::Quit => {
                        event_loop.exit();
                        return;
                    }
                }
            }
        }

        // A product close request hides under a tray (the tray keeps the
        // app alive and owns restore) and exits without one.
        if self.driver.take_close_request() {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            if state.tray.is_some() {
                state.window.set_visible(false);
                return;
            }
            event_loop.exit();
            return;
        }

        if self.driver.take_dirty() {
            state.render_pending = true;
            self.arms.dirty += 1;
        }

        if self.config.ime {
            let area = self.driver.ime_cursor_area();
            if area != state.ime_area {
                state.ime_area = area;
                match area {
                    Some((x, y, w, h)) => state.window.set_ime_cursor_area(
                        winit::dpi::PhysicalPosition::new(x, y),
                        winit::dpi::PhysicalSize::new(w, h),
                    ),
                    None => state.window.set_ime_cursor_area(
                        winit::dpi::PhysicalPosition::new(0.0, 0.0),
                        winit::dpi::PhysicalSize::new(0.0, 0.0),
                    ),
                }
            }
        }

        let frame_interval = Duration::from_secs_f32(1.0 / self.config.max_fps.max(1.0));
        let mut wake = state.next_tick;
        if state.render_pending && !state.occluded {
            let due = state.last_render + frame_interval;
            if now >= due {
                state.window.request_redraw();
            } else {
                wake = wake.min(due);
            }
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(wake));
    }

    fn redraw(&mut self) -> Result<()> {
        let Some(state) = self.state.as_mut() else {
            return Ok(());
        };
        // Only render when the governor armed a frame. macOS occasionally
        // streams RedrawRequested on its own (compositor moods); honoring
        // those would turn a settled widget into a 40 fps space heater.
        // Every event that genuinely needs pixels (resize, scale change,
        // un-occlusion, first show) sets render_pending — the compositor
        // retains the last frame for everything else.
        if !state.render_pending {
            self.arms.unarmed_redraws += 1;
            return Ok(());
        }
        let window_px = state.window_px();
        let client_size = state.window.inner_size();
        match &mut state.present {
            Present::Wgpu {
                surface,
                surface_config,
                gpu,
            } => {
                let frame = match surface.get_current_texture() {
                    Ok(f) => f,
                    Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                        surface.configure(&gpu.device, surface_config);
                        return Ok(()); // render_pending stays latched; next wake retries
                    }
                    Err(e) => return Err(anyhow::anyhow!("surface error: {e}")),
                };
                let view = frame
                    .texture
                    .create_view(&wgpu::TextureViewDescriptor::default());
                let size = (surface_config.width, surface_config.height);
                self.driver
                    .render(gpu, &view, size, state.start.elapsed().as_secs_f32())?;
                state.window.pre_present_notify();
                frame.present();
            }
            Present::Cpu {
                surface,
                fb,
                resampler,
                last_client,
                ..
            } => {
                let started = Instant::now();
                let frame = self.driver.render_cpu(fb, window_px)?;
                let width = NonZeroU32::new(frame.width).ok_or_else(|| {
                    anyhow::anyhow!("cpu render produced a zero-width framebuffer")
                })?;
                let height = NonZeroU32::new(frame.height).ok_or_else(|| {
                    anyhow::anyhow!("cpu render produced a zero-height framebuffer")
                })?;
                if fb.len() != (width.get() as usize) * (height.get() as usize) {
                    return Err(anyhow::anyhow!(
                        "cpu framebuffer length {} does not match {}x{}",
                        fb.len(),
                        width,
                        height
                    ));
                }
                // softbuffer's win32 backend blits 1:1 (BitBlt SRCCOPY from
                // the DIB); it never stretches. resize() short-circuits on
                // unchanged size and is safe to call every frame. The
                // client size (not the framebuffer size) drives the DIB:
                // the framebuffer is resampled to it below.
                let (client_w, client_h) = (client_size.width.max(1), client_size.height.max(1));
                surface.resize(
                    NonZeroU32::new(client_w).expect("client width clamped to >= 1"),
                    NonZeroU32::new(client_h).expect("client height clamped to >= 1"),
                )
                .map_err(|e| anyhow::anyhow!("softbuffer resize: {e}"))?;
                // A recreated DIB (client resize) loses the retained
                // pixels: everything must be repainted, not just the
                // damage rects.
                let damaged = if *last_client == (client_w, client_h) {
                    frame.damaged
                } else {
                    *last_client = (client_w, client_h);
                    vec![DamageRect::new(
                        0,
                        0,
                        width.get() as i32,
                        height.get() as i32,
                    )]
                };
                let mut buffer = surface
                    .buffer_mut()
                    .map_err(|e| anyhow::anyhow!("softbuffer buffer: {e}"))?;
                let t_blit = Instant::now();
                // Blit only the repainted rects (scaled to the client for
                // fractional DPI), leaving retained pixels untouched.
                let present_rects = if client_w == width.get() && client_h == height.get() {
                    copy_rects(fb, &mut buffer, width.get(), height.get(), &damaged)
                } else {
                    resampler.run_rects(
                        fb,
                        width.get(),
                        height.get(),
                        &mut buffer,
                        client_w,
                        client_h,
                        &damaged,
                    )
                };
                buffer
                    .present_with_damage(&present_rects)
                    .map_err(|e| anyhow::anyhow!("softbuffer present: {e}"))?;
                log::debug!(
                    "pocket-widget: cpu present total {:.2}ms (fb {}x{} -> client {}x{}; \
                     blit {:.2}ms, {} rect(s))",
                    started.elapsed().as_secs_f64() * 1000.0,
                    width,
                    height,
                    client_w,
                    client_h,
                    t_blit.elapsed().as_secs_f64() * 1000.0,
                    present_rects.len()
                );
            }
        }

        state.render_pending = false;
        state.last_render = Instant::now();
        self.frames += 1;
        Ok(())
    }
}

impl<D: Driver> ApplicationHandler for WidgetApp<D> {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_none() {
            match self.init_state(event_loop) {
                Ok(s) => self.state = Some(s),
                Err(e) => {
                    self.error = Some(e);
                    event_loop.exit();
                }
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        state.input.on_window_event(&event);
        match event {
            WindowEvent::Focused(false) => {
                state.resizing = None;
            }
            WindowEvent::CloseRequested => {
                // With a tray the close button hides to the tray (the tray
                // owns quit); without one it exits as before.
                #[cfg(any(target_os = "windows", target_os = "macos"))]
                if state.tray.is_some() {
                    state.window.set_visible(false);
                    return;
                }
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                log::debug!("pocket-widget: Resized {size:?}");
                match &mut state.present {
                    Present::Wgpu {
                        surface,
                        surface_config,
                        gpu,
                    } => {
                        surface_config.width = size.width.max(1);
                        surface_config.height = size.height.max(1);
                        surface.configure(&gpu.device, surface_config);
                    }
                    Present::Cpu { .. } => {
                        // The framebuffer is re-derived from the game's
                        // viewport on the next CPU redraw (the softbuffer
                        // resize happens there too); nothing to do here.
                    }
                }
                state.render_pending = true;
                self.arms.resized += 1;
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                log::debug!("pocket-widget: ScaleFactorChanged({scale_factor})");
                state.render_pending = true;
                self.arms.scale += 1;
            }
            WindowEvent::Occluded(occluded) => {
                log::debug!("pocket-widget: Occluded({occluded})");
                state.occluded = occluded;
                if !occluded {
                    state.render_pending = true; // repaint on reveal
                    self.arms.occlusion += 1;
                }
            }
            WindowEvent::MouseInput {
                state: elem_state,
                button: MouseButton::Left,
                ..
            } => match elem_state {
                ElementState::Pressed => {
                    if let Some(cursor) = state.input.cursor() {
                        if self.config.resizable && self.driver.resize_at(cursor) {
                            let size = state.window_px();
                            state.resizing = Some((cursor, size));
                            // The grip press is a window gesture, not app
                            // input — take the button back.
                            state.input.cancel_mouse_button(MouseButton::Left);
                        } else if self.driver.drag_at(cursor) {
                            match state.window.drag_window() {
                                Ok(()) => {
                                    // macOS swallows the release once the OS drag
                                    // session starts; clear the button so the next
                                    // press edges.
                                    state.input.cancel_mouse_button(MouseButton::Left);
                                }
                                Err(error) => {
                                    log::warn!("pocket-widget: window drag failed: {error}");
                                }
                            }
                        }
                    }
                }
                ElementState::Released => {
                    state.resizing = None;
                }
            },
            WindowEvent::CursorMoved { position, .. } => {
                if let Some((grab, size0)) = state.resizing {
                    let scale = state.window.scale_factor();
                    let min_w = (self.config.min_size.0 as f64 * scale) as i64;
                    let min_h = (self.config.min_size.1 as f64 * scale) as i64;
                    let max_w = self
                        .config
                        .max_size
                        .map(|(width, _)| (width as f64 * scale) as i64)
                        .unwrap_or(i64::MAX);
                    let max_h = self
                        .config
                        .max_size
                        .map(|(_, height)| (height as f64 * scale) as i64)
                        .unwrap_or(i64::MAX);
                    let w =
                        (size0.0 as i64 + (position.x - grab.x as f64) as i64).clamp(min_w, max_w);
                    let h =
                        (size0.1 as i64 + (position.y - grab.y as f64) as i64).clamp(min_h, max_h);
                    let _ = state
                        .window
                        .request_inner_size(winit::dpi::PhysicalSize::new(w as u32, h as u32));
                }
            }
            WindowEvent::RedrawRequested => {
                // Ignore redraws while occluded. Unsolicited OS redraws while
                // the retained frame is current are rejected and counted by
                // `redraw`; resize/reveal and game dirt arm real frames.
                if state.occluded {
                    return;
                }
                if let Err(e) = self.redraw() {
                    self.error = Some(e);
                    event_loop.exit();
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.pump(event_loop);
    }
}

#[cfg(test)]
mod tests {
    use super::{Resampler, WidgetConfig, framebuffer_bytes, validate_config};

    #[test]
    fn rejects_reverse_resize_bounds() {
        let config = WidgetConfig {
            resizable: true,
            min_size: (800, 600),
            max_size: Some((640, 480)),
            ..WidgetConfig::default()
        };
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn accepts_valid_resize_bounds() {
        let config = WidgetConfig {
            resizable: true,
            min_size: (320, 240),
            max_size: Some((1280, 720)),
            ..WidgetConfig::default()
        };
        assert!(validate_config(&config).is_ok());
    }

    /// ARGB words viewed as bytes must read B,G,R,A on little-endian
    /// hosts (all supported desktop targets) — the contract the CPU
    /// raster's ARGB output paths and softbuffer's u32 buffers share.
    #[cfg(target_endian = "little")]
    #[test]
    fn framebuffer_bytes_reads_bgra_little_endian() {
        let mut fb = vec![0x01_02_03_04u32];
        assert_eq!(framebuffer_bytes(&mut fb), [0x04, 0x03, 0x02, 0x01]);
    }

    #[test]
    fn resampler_identity_passthrough_is_exact() {
        let src: Vec<u32> = (0..12).map(|i| 0xFF00_0000 | (i << 4) | i).collect();
        let mut dst = vec![0u32; 12];
        let mut r = Resampler::default();
        r.run(&src, 4, 3, &mut dst, 4, 3);
        assert_eq!(dst, src);
    }

    #[test]
    fn resampler_2x_upscale_centres_and_blends() {
        // Two half-red / half-blue columns -> the seam lands in the
        // middle of the destination (centre-aligned sampling), and the
        // blended column sits between the two source colours.
        let src = [0xFF00_00FFu32, 0xFFFF_0000u32];
        let mut dst = [0u32; 4];
        let mut r = Resampler::default();
        r.run(&src, 2, 1, &mut dst, 4, 1);
        // x = 0 -> src 0; x = 3 -> src 1; x = 1,2 -> blends of both.
        assert_eq!(dst[0], 0xFF00_00FF);
        assert_eq!(dst[3], 0xFFFF_0000);
        let b = dst[1] & 0xFF;
        let r = (dst[1] >> 16) & 0xFF;
        assert!(b > 0 && b < 255 && r > 0 && r < 255, "mid blend {dst:08x?}");
    }

    /// Manual probe for the fractional-DPI hot path: 1280x720 -> 1600x900.
    #[test]
    fn resampler_125_percent_cost_probe() {
        let mut src = vec![0xFF33_6699u32; 1280 * 720];
        for (i, px) in src.iter_mut().enumerate() {
            let i = i as u32;
            *px = 0xFF00_0000
                | (i.wrapping_mul(2654435761) & 0xFF) << 16
                | (i.wrapping_mul(40503) & 0xFF) << 8
                | (i.wrapping_mul(11) & 0xFF);
        }
        let mut dst = vec![0u32; 1600 * 900];
        let mut r = Resampler::default();
        let t = std::time::Instant::now();
        for _ in 0..10 {
            r.run(&src, 1280, 720, &mut dst, 1600, 900);
        }
        let per = t.elapsed().as_secs_f64() * 100.0;
        println!("resample 1280x720->1600x900: {per:.2}ms/frame");
    }
}
