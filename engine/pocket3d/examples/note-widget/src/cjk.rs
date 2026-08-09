//! Runtime font-atlas extension: IME input can commit ANY codepoint, and
//! the pak's baked atlases only cover what the build saw. Instead of
//! guessing a charset at build time (and shipping megabytes of hanzi the
//! user may never type), the host rasterizes missing glyphs from a system
//! CJK font on first sight, appends them to the slot's FONT ATLAS v3 blob
//! (spec.ts — cmap stays codepoint-sorted, coverage is gid-linear, so
//! appending is cheap), and reloads the slot through the spec
//! `loadFontAtlas` op. The renderer re-uploads a slot whose glyph count
//! moved; layout re-measures on the reload's dirty flag. Latin keeps its
//! baked Inter forms — only unseen codepoints go through the fallback.

use std::collections::HashSet;
use std::path::Path;

use ab_glyph::{Font, FontRef, point};

const FONT_MAGIC: u32 = 0x4146_4344; // 'DCFA' LE
const HEADER: usize = 16;
const CMAP_ENTRY: usize = 8;
/// Appended-glyph ceiling per slot — far above any real typing session,
/// well under the u16 gid space and GPU texture limits at 64 columns.
const MAX_GLYPHS: u16 = 6000;

/// Font px per slot — mirrors framework/compiler/tailwind.ts FONT_PX (slots 0..6 =
/// 12/14/16/18/20/24/36, bold = +7 at the same px). tests/note.test.ts pins
/// the same table.
fn slot_px(slot: u8) -> f32 {
    [12.0, 14.0, 16.0, 18.0, 20.0, 24.0, 36.0][(slot % 7) as usize]
}

/// Preferred CJK-capable font *names* — never hardcode drive letters.
/// Resolution joins these and discovered font files with OS font directories / env overrides.
const PREFERRED_FONT_NAMES: &[&str] = &[
    // Windows
    "msyh.ttc",
    "msyhbd.ttc",
    "msyhl.ttc",
    "simsun.ttc",
    "simhei.ttf",
    "malgun.ttf",
    "YuGothM.ttc",
    "YuGothR.ttc",
    "msgothic.ttc",
    "arialuni.ttf",
    // macOS
    "PingFang.ttc",
    "Hiragino Sans GB.ttc",
    "STHeiti Light.ttc",
    "Songti.ttc",
    "Arial Unicode.ttf",
    // Linux common packages
    "NotoSansCJK-Regular.ttc",
    "NotoSansCJKsc-Regular.otf",
    "SourceHanSansSC-Regular.otf",
    "DroidSansFallbackFull.ttf",
    "WenQuanYiMicroHei.ttf",
];

/// Build candidate font files from env + OS font directories + preferred names.
fn font_candidate_paths() -> Vec<std::path::PathBuf> {
    // 按目录发现字体，不写死盘符路径
    use std::path::PathBuf;

    let mut paths = Vec::new();

    // Explicit override wins: file or directory.
    if let Ok(override_path) = std::env::var("POCKETJS_CJK_FONT") {
        let p = PathBuf::from(override_path.trim());
        if p.is_file() {
            paths.push(p);
        } else if p.is_dir() {
            push_named_fonts(&mut paths, &p);
        }
    }

    for dir in system_font_dirs() {
        push_named_fonts(&mut paths, &dir);
    }

    // De-dupe while preserving order.
    let mut seen = HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    paths
}

/// OS font directories derived from env / well-known roots (no drive-letter font files).
fn system_font_dirs() -> Vec<std::path::PathBuf> {
    // 收集本机字体目录
    use std::path::PathBuf;
    let mut dirs = Vec::new();

    if let Ok(windir) = std::env::var("WINDIR").or_else(|_| std::env::var("SystemRoot")) {
        dirs.push(PathBuf::from(windir).join("Fonts"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(
            PathBuf::from(local)
                .join("Microsoft")
                .join("Windows")
                .join("Fonts"),
        );
    }

    // macOS roots are directory roots, not individual font files.
    dirs.push(PathBuf::from("/System/Library/Fonts"));
    dirs.push(PathBuf::from("/System/Library/Fonts/Supplemental"));
    dirs.push(PathBuf::from("/Library/Fonts"));
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(&home).join("Library").join("Fonts"));
        dirs.push(PathBuf::from(&home).join(".fonts"));
        dirs.push(
            PathBuf::from(&home)
                .join(".local")
                .join("share")
                .join("fonts"),
        );
    }

    // Linux
    dirs.push(PathBuf::from("/usr/share/fonts"));
    dirs.push(PathBuf::from("/usr/local/share/fonts"));

    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "ttc", "otc"];

/// Recognize font files accepted by the runtime fallback loader.
fn is_font_file(path: &Path) -> bool {
    // Keep directory overrides useful for custom font filenames.
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            let extension = extension.to_ascii_lowercase();
            FONT_EXTENSIONS.iter().any(|known| *known == extension)
        })
        .unwrap_or(false)
}

/// Collect font files below a directory without following symlinked directories.
fn collect_font_files(out: &mut Vec<std::path::PathBuf>, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file() && is_font_file(&path) {
            out.push(path);
        } else if file_type.is_dir() {
            collect_font_files(out, &path);
        }
    }
}

/// Join preferred names and discovered font files under a font directory.
fn push_named_fonts(out: &mut Vec<std::path::PathBuf>, dir: &Path) {
    // Prefer known CJK filenames before scanning custom directory entries.
    for name in PREFERRED_FONT_NAMES {
        let direct = dir.join(name);
        if direct.is_file() {
            out.push(direct);
        }
    }
    collect_font_files(out, dir);
}

struct GlyphSource {
    map: memmap2::Mmap,
    index: u32,
}

impl GlyphSource {
    fn find() -> Option<(GlyphSource, String)> {
        for path in font_candidate_paths() {
            if !path.is_file() {
                continue;
            }
            let Ok(file) = std::fs::File::open(&path) else {
                continue;
            };
            let Ok(map) = (unsafe { memmap2::Mmap::map(&file) }) else {
                continue;
            };
            for index in 0..8u32 {
                let Ok(font) = FontRef::try_from_slice_and_index(&map, index) else {
                    break;
                };
                if font.glyph_id('中').0 != 0 {
                    return Some((
                        GlyphSource { map, index },
                        format!("{}#{index}", path.display()),
                    ));
                }
            }
        }
        None
    }

    fn font(&self) -> Option<FontRef<'_>> {
        FontRef::try_from_slice_and_index(&self.map, self.index).ok()
    }
}

/// One slot's parsed FONT ATLAS blob, appendable.
struct SlotAtlas {
    slot: u8,
    cell_w: u8,
    cell_h: u8,
    baseline: u8,
    line_height: u8,
    flags: u8,
    density: u8,
    /// (codepoint, gid, advance, xoff) — serialized codepoint-sorted.
    cmap: Vec<(u32, u16, u8, u8)>,
    /// gid-linear coverage cells.
    coverage: Vec<u8>,
    known: HashSet<u32>,
    /// Codepoints this slot can never provide (the font lacks the glyph, or
    /// the atlas hit `MAX_GLYPHS`) — `ensure` skips them instead of
    /// re-probing the font on every text report.
    failed: HashSet<u32>,
    dirty: bool,
}

impl SlotAtlas {
    fn parse(blob: &[u8]) -> Option<SlotAtlas> {
        if blob.len() < HEADER {
            return None;
        }
        let u16at = |o: usize| u16::from_le_bytes([blob[o], blob[o + 1]]);
        if u32::from_le_bytes([blob[0], blob[1], blob[2], blob[3]]) != FONT_MAGIC {
            return None;
        }
        let version = u16at(4);
        if version != 2 && version != 3 {
            return None;
        }
        let glyph_count = u16at(6) as usize;
        let (cell_w, cell_h, baseline, line_height, slot, flags) =
            (blob[8], blob[9], blob[10], blob[11], blob[12], blob[13]);
        let density = if version == 3 { blob[14].max(1) } else { 1 };
        let cmap_end = HEADER + glyph_count * CMAP_ENTRY;
        let cell_bytes = cell_w as usize * cell_h as usize * (density as usize).pow(2);
        if blob.len() < cmap_end + glyph_count * cell_bytes {
            return None;
        }
        let mut cmap = Vec::with_capacity(glyph_count);
        let mut known = HashSet::with_capacity(glyph_count);
        for g in 0..glyph_count {
            let o = HEADER + g * CMAP_ENTRY;
            let cp = u32::from_le_bytes([blob[o], blob[o + 1], blob[o + 2], blob[o + 3]]);
            cmap.push((cp, u16at(o + 4), blob[o + 6], blob[o + 7]));
            known.insert(cp);
        }
        Some(SlotAtlas {
            slot,
            cell_w,
            cell_h,
            baseline,
            line_height,
            flags,
            density,
            cmap,
            coverage: blob[cmap_end..cmap_end + glyph_count * cell_bytes].to_vec(),
            known,
            failed: HashSet::new(),
            dirty: false,
        })
    }

    fn glyph_count(&self) -> u16 {
        self.cmap.len() as u16
    }

    /// Rasterize `cp` from `font` into a new appended cell.
    fn append(&mut self, font: &FontRef<'_>, cp: char) {
        if self.glyph_count() >= MAX_GLYPHS {
            self.failed.insert(cp as u32);
            return;
        }
        let gid_font = font.glyph_id(cp);
        if gid_font.0 == 0 {
            // Fallback font lacks it too — the core's tofu renders it, and
            // `ensure` must not re-probe this codepoint on every report.
            self.failed.insert(cp as u32);
            return;
        }
        let px = slot_px(self.slot);
        let density = self.density as f32;
        // ab_glyph 的 PxScale 以行高（ascent - descent）为分母，不是 em；而
        // bake-font 用 px / upm（em 基准）烘焙。不补偿会让运行时补的 CJK 字形
        // 比同槽烘焙字形小（雅黑行高 1.32em → 缩水 ~24%）。这里统一回 em 基准：
        // 每 font unit 的像素数 = px / upm，再乘回 height 得到 ab_glyph 语义的 scale。
        let upm = font.units_per_em().unwrap_or(2048.0);
        let em_scale = px / upm;
        let advance = (font.h_advance_unscaled(gid_font) * em_scale)
            .round()
            .clamp(0.0, 255.0) as u8;

        let cov_w = self.cell_w as usize * self.density as usize;
        let cov_h = self.cell_h as usize * self.density as usize;
        let mut cell = vec![0u8; cov_w * cov_h];
        let ab_scale = em_scale * font.height_unscaled();
        let glyph = gid_font.with_scale_and_position(
            ab_scale * density,
            point(0.0, self.baseline as f32 * density),
        );
        if let Some(outlined) = font.outline_glyph(glyph) {
            let bounds = outlined.px_bounds();
            outlined.draw(|x, y, c| {
                let cx = bounds.min.x as i32 + x as i32;
                let cy = bounds.min.y as i32 + y as i32;
                if cx >= 0 && (cx as usize) < cov_w && cy >= 0 && (cy as usize) < cov_h {
                    let dst = &mut cell[cy as usize * cov_w + cx as usize];
                    *dst = (*dst).max((c * 255.0) as u8);
                }
            });
        }

        let gid = self.glyph_count();
        self.coverage.extend_from_slice(&cell);
        self.cmap.push((cp as u32, gid, advance, 0));
        self.known.insert(cp as u32);
        self.dirty = true;
    }

    /// Serialize back to a v3 blob (cmap re-sorted by codepoint).
    fn blob(&self) -> Vec<u8> {
        let count = self.glyph_count();
        let mut cmap = self.cmap.clone();
        cmap.sort_by_key(|&(cp, ..)| cp);
        let mut out = Vec::with_capacity(HEADER + cmap.len() * CMAP_ENTRY + self.coverage.len());
        out.extend_from_slice(&FONT_MAGIC.to_le_bytes());
        out.extend_from_slice(&3u16.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&[
            self.cell_w,
            self.cell_h,
            self.baseline,
            self.line_height,
            self.slot,
            self.flags,
            self.density,
            0,
        ]);
        for (cp, gid, adv, xoff) in cmap {
            out.extend_from_slice(&cp.to_le_bytes());
            out.extend_from_slice(&gid.to_le_bytes());
            out.push(adv);
            out.push(xoff);
        }
        out.extend_from_slice(&self.coverage);
        out
    }
}

/// All of a pak's font slots + the system fallback face.
pub struct CjkAtlases {
    /// Lazily opened on first non-ASCII ensure — Latin-only apps skip mmap.
    source: Option<GlyphSource>,
    source_resolved: bool,
    slots: Vec<SlotAtlas>,
}

impl CjkAtlases {
    pub fn from_pak(pak: &[u8]) -> CjkAtlases {
        let slots: Vec<SlotAtlas> = pocket_ui_wgpu::walk_pak(pak)
            .into_iter()
            .filter(|e| e.key.starts_with("ui:font."))
            .filter_map(|e| SlotAtlas::parse(e.blob))
            .collect();
        CjkAtlases {
            source: None,
            source_resolved: false,
            slots,
        }
    }

    /// Open the system CJK face on first non-ASCII ensure.
    fn resolve_source(&mut self) {
        if self.source_resolved {
            return;
        }
        self.source_resolved = true;
        self.source = match GlyphSource::find() {
            Some((source, name)) => {
                log::debug!("note-widget: CJK fallback font {name}");
                Some(source)
            }
            None => {
                log::warn!(
                    "note-widget: no CJK-capable system font found — non-Latin input will tofu"
                );
                None
            }
        };
    }

    /// Make sure every non-ASCII codepoint in `text` exists in every slot.
    /// Returns the rebuilt blobs of the slots that grew (feed them to
    /// `Ui::load_font_atlas`); empty when nothing was missing.
    pub fn ensure(&mut self, text: &str) -> Vec<Vec<u8>> {
        let missing: Vec<char> = {
            let mut seen = HashSet::new();
            text.chars()
                .filter(|c| (*c as u32) > 0x7f && !c.is_control())
                .filter(|c| {
                    self.slots.iter().any(|s| {
                        !s.known.contains(&(*c as u32)) && !s.failed.contains(&(*c as u32))
                    })
                })
                .filter(|c| seen.insert(*c))
                .collect()
        };
        if missing.is_empty() {
            return Vec::new();
        }
        self.resolve_source();
        let Some(font) = self.source.as_ref().and_then(|s| s.font()) else {
            return Vec::new();
        };
        for cp in &missing {
            for slot in &mut self.slots {
                if !slot.known.contains(&(*cp as u32)) && !slot.failed.contains(&(*cp as u32)) {
                    slot.append(&font, *cp);
                }
            }
        }
        let mut blobs = Vec::new();
        for slot in &mut self.slots {
            if std::mem::take(&mut slot.dirty) {
                blobs.push(slot.blob());
            }
        }
        if !blobs.is_empty() {
            log::debug!(
                "note-widget: extended {} font slot(s) with {} new glyph(s)",
                blobs.len(),
                missing.len()
            );
        }
        blobs
    }
}

#[cfg(test)]
mod tests {
    use super::{CjkAtlases, SlotAtlas, is_font_file};
    use std::collections::HashSet;
    use std::path::Path;

    #[test]
    fn recognizes_common_font_extensions_case_insensitively() {
        // Directory overrides must accept custom filenames.
        assert!(is_font_file(Path::new("custom.ttf")));
        assert!(is_font_file(Path::new("custom.OTC")));
        assert!(!is_font_file(Path::new("custom.txt")));
        assert!(!is_font_file(Path::new("custom")));
    }

    #[test]
    fn em_based_rasterization_matches_bake_font_semantics() {
        // 运行时补字形必须按 1em = px 渲染（bake-font 的 px / upm 基准），
        // 而不是 ab_glyph PxScale 的行高基准（行高 > em 时字形会缩水）。
        use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};
        let manifest = env!("CARGO_MANIFEST_DIR");
        let font_path = Path::new(manifest)
            .join("../../../../assets/fonts/Inter-Regular.ttf");
        let data = std::fs::read(font_path).expect("Inter-Regular.ttf");
        let leaked: &'static [u8] = Box::leak(data.into_boxed_slice());
        let font = FontRef::try_from_slice(leaked).expect("parse Inter");
        let px = 12.0f32;
        let upm = font.units_per_em().unwrap();
        let em_scale = px / upm;

        // em 基准 advance = font units * px / upm；行高基准（PxScale）必然更小。
        let gid = font.glyph_id('A');
        let em_advance = font.h_advance_unscaled(gid) * em_scale;
        let line_advance = font.as_scaled(PxScale::from(px)).h_advance(gid);
        assert!(em_advance > line_advance, "em-basis must exceed line-height basis");

        // outline 按 em 基准渲染：'A' 大写高 ≈ 0.74em。
        let glyph = gid.with_scale_and_position(
            em_scale * font.height_unscaled(),
            point(0.0, 0.0),
        );
        let bounds = font.outline_glyph(glyph).expect("outline").px_bounds();
        let ink = bounds.height();
        assert!(
            (ink - px * 0.74).abs() < 1.2,
            "Inter 'A' cap height at 1em={px}px should be ~{:.1}px, got {ink:.1}px",
            px * 0.74
        );
    }

    #[test]
    fn append_records_unrasterizable_codepoints() {
        // Inter has no CJK glyphs: append must fail fast and record the
        // codepoint in `failed` instead of silently retrying every report.
        use ab_glyph::FontRef;
        let manifest = env!("CARGO_MANIFEST_DIR");
        let font_path = Path::new(manifest).join("../../../../assets/fonts/Inter-Regular.ttf");
        let data = std::fs::read(font_path).expect("Inter-Regular.ttf");
        let leaked: &'static [u8] = Box::leak(data.into_boxed_slice());
        let font = FontRef::try_from_slice(leaked).expect("parse Inter");

        let mut slot = SlotAtlas {
            slot: 0,
            cell_w: 8,
            cell_h: 8,
            baseline: 6,
            line_height: 8,
            flags: 0,
            density: 1,
            cmap: Vec::new(),
            coverage: Vec::new(),
            known: HashSet::new(),
            failed: HashSet::new(),
            dirty: false,
        };
        slot.append(&font, '中');
        assert!(slot.failed.contains(&('中' as u32)));
        assert!(!slot.known.contains(&('中' as u32)));
        assert_eq!(slot.glyph_count(), 0, "nothing rasterized");
        // A repeated probe (what `ensure` would do) must not keep growing.
        slot.append(&font, '中');
        assert_eq!(slot.failed.len(), 1);
    }

    #[test]
    fn ensure_skips_codepoints_a_slot_cannot_provide() {
        let mut atlases = CjkAtlases {
            source: None,
            source_resolved: false,
            slots: vec![SlotAtlas {
                slot: 0,
                cell_w: 8,
                cell_h: 8,
                baseline: 6,
                line_height: 8,
                flags: 0,
                density: 1,
                cmap: Vec::new(),
                coverage: Vec::new(),
                known: HashSet::new(),
                failed: HashSet::from([('中' as u32)]),
                dirty: false,
            }],
        };
        // The slot already knows it cannot provide '中' — even though the
        // codepoint is absent from `known`, ensure must report nothing
        // missing (no re-probe, no blobs) for it.
        assert!(atlases.ensure("中").is_empty());
    }
}
