//! Device/queue bootstrap plus offscreen render targets with CPU readback.
//!
//! Everything in Pocket3D renders through a plain `wgpu::TextureView`, so a
//! window surface and a headless offscreen target are interchangeable. The
//! offscreen path exists for CI, scripted acceptance tests, and screenshots.

use std::path::Path;

use anyhow::{Context, Result};

/// The color format used for offscreen targets (window surfaces negotiate
/// their own, usually Bgra8UnormSrgb).
pub const OFFSCREEN_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
/// Depth format used by every 3D pass.
pub const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

pub struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

impl Gpu {
    /// Create a device with no surface (offscreen rendering only).
    pub fn new_headless() -> Result<Self> {
        pollster::block_on(Self::new_async(
            None,
            wgpu::PowerPreference::HighPerformance,
        ))
    }

    /// Create a device compatible with the given surface.
    pub fn new_for_surface(surface: &wgpu::Surface<'_>) -> Result<Self> {
        Self::new_for_surface_with_power_preference(surface, wgpu::PowerPreference::HighPerformance)
    }

    /// Create a device compatible with the given surface, requesting the
    /// adapter class appropriate for the host's power policy.
    pub fn new_for_surface_with_power_preference(
        surface: &wgpu::Surface<'_>,
        power_preference: wgpu::PowerPreference,
    ) -> Result<Self> {
        pollster::block_on(Self::new_async(Some(surface), power_preference))
    }

    async fn new_async(
        compatible_surface: Option<&wgpu::Surface<'_>>,
        power_preference: wgpu::PowerPreference,
    ) -> Result<Self> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        Self::from_instance_async(instance, compatible_surface, power_preference).await
    }

    /// Create the shared instance first when a surface must be created
    /// before adapter selection (windowed startup path).
    pub fn new_instance() -> wgpu::Instance {
        wgpu::Instance::new(&wgpu::InstanceDescriptor::default())
    }

    /// Finish initialization from an existing instance + surface.
    pub fn from_instance_for_surface(
        instance: wgpu::Instance,
        surface: &wgpu::Surface<'_>,
    ) -> Result<Self> {
        Self::from_instance_for_surface_with_power_preference(
            instance,
            surface,
            wgpu::PowerPreference::HighPerformance,
        )
    }

    /// Finish initialization from an existing instance + surface, requesting
    /// the adapter class appropriate for the host's power policy.
    pub fn from_instance_for_surface_with_power_preference(
        instance: wgpu::Instance,
        surface: &wgpu::Surface<'_>,
        power_preference: wgpu::PowerPreference,
    ) -> Result<Self> {
        pollster::block_on(Self::from_instance_async(
            instance,
            Some(surface),
            power_preference,
        ))
    }

    async fn from_instance_async(
        instance: wgpu::Instance,
        compatible_surface: Option<&wgpu::Surface<'_>>,
        power_preference: wgpu::PowerPreference,
    ) -> Result<Self> {
        let adapter = pick_adapter(&instance, compatible_surface, power_preference)
            .await
            .context("no compatible GPU adapter")?;
        let info = adapter.get_info();
        log::info!(
            "adapter: {:?} ({:?}, requested {:?})",
            info.name,
            info.device_type,
            power_preference
        );
        // Widget hosts ask for LowPower: keep device limits modest so Windows
        // discrete adapters do not reserve game-sized GPU heaps for a sticky note.
        let required_limits = match power_preference {
            wgpu::PowerPreference::LowPower => widget_limits(&adapter),
            _ => wgpu::Limits::default(),
        };
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("pocket3d"),
                required_features: wgpu::Features::empty(),
                required_limits,
                memory_hints: match power_preference {
                    wgpu::PowerPreference::LowPower => wgpu::MemoryHints::MemoryUsage,
                    _ => wgpu::MemoryHints::default(),
                },
                trace: wgpu::Trace::Off,
            })
            .await
            .context("failed to create wgpu device")?;
        Ok(Self {
            instance,
            adapter,
            device,
            queue,
        })
    }
}

/// Pick an adapter honoring power preference more strictly than wgpu's default.
async fn pick_adapter(
    instance: &wgpu::Instance,
    compatible_surface: Option<&wgpu::Surface<'_>>,
    power_preference: wgpu::PowerPreference,
) -> Option<wgpu::Adapter> {
    // 按功耗偏好选择适配器
    if power_preference == wgpu::PowerPreference::LowPower {
        let mut adapters = instance.enumerate_adapters(wgpu::Backends::all());
        // Prefer iGPU for ambient widgets; fall back to dGPU before WARP/CPU.
        adapters.sort_by_key(|adapter| match adapter.get_info().device_type {
            wgpu::DeviceType::IntegratedGpu => 0u8,
            wgpu::DeviceType::DiscreteGpu => 1,
            wgpu::DeviceType::VirtualGpu => 2,
            wgpu::DeviceType::Other => 3,
            wgpu::DeviceType::Cpu => 4,
        });
        for adapter in adapters {
            if let Some(surface) = compatible_surface
                && !adapter.is_surface_supported(surface)
            {
                continue;
            }
            return Some(adapter);
        }
    }
    instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference,
            compatible_surface,
            force_fallback_adapter: false,
        })
        .await
        .ok()
}

/// Modest 2D-UI limits for ambient widget hosts.
fn widget_limits(adapter: &wgpu::Adapter) -> wgpu::Limits {
    // 收紧 widget 设备上限
    let supported = adapter.limits();
    let mut limits = wgpu::Limits::downlevel_defaults();
    limits.max_texture_dimension_2d = supported.max_texture_dimension_2d.min(8192);
    limits.max_texture_dimension_1d = supported.max_texture_dimension_1d.min(8192);
    limits.max_buffer_size = supported.max_buffer_size.min(256 * 1024 * 1024);
    limits.max_storage_buffer_binding_size =
        supported.max_storage_buffer_binding_size.min(128 * 1024 * 1024);
    limits
}

/// An offscreen color target that can be rendered to and read back.
pub struct OffscreenTarget {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub size: (u32, u32),
}

impl OffscreenTarget {
    pub fn new(gpu: &Gpu, width: u32, height: u32) -> Self {
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("offscreen color"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: OFFSCREEN_FORMAT,
            // TEXTURE_BINDING so composite passes (upscale blits, overlays)
            // can sample the result.
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self {
            texture,
            view,
            size: (width, height),
        }
    }

    /// Read the target back as tightly packed RGBA8 rows.
    pub fn read_rgba(&self, gpu: &Gpu) -> Result<Vec<u8>> {
        let (w, h) = self.size;
        let unpadded = w * 4;
        let padded = unpadded.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: (padded * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("readback"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        gpu.queue.submit([encoder.finish()]);

        let slice = buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        gpu.device.poll(wgpu::PollType::Wait)?;
        rx.recv().context("map_async callback dropped")??;

        let data = slice.get_mapped_range();
        let mut out = Vec::with_capacity((unpadded * h) as usize);
        for row in 0..h {
            let start = (row * padded) as usize;
            out.extend_from_slice(&data[start..start + unpadded as usize]);
        }
        drop(data);
        buffer.unmap();
        Ok(out)
    }

    pub fn save_png(&self, gpu: &Gpu, path: &Path) -> Result<()> {
        let rgba = self.read_rgba(gpu)?;
        save_png(path, self.size.0, self.size.1, &rgba)
    }
}

pub fn save_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let file =
        std::fs::File::create(path).with_context(|| format!("creating {}", path.display()))?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header()?;
    writer.write_image_data(rgba)?;
    Ok(())
}

/// Depth buffer paired with a color target size.
pub struct DepthTarget {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub size: (u32, u32),
}

impl DepthTarget {
    pub fn new(gpu: &Gpu, width: u32, height: u32) -> Self {
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("depth"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self {
            texture,
            view,
            size: (width, height),
        }
    }
}
