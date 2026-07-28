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

use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};

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

/// Preferred CJK-capable font *names* only — never hardcode drive letters.
/// Resolution joins these with OS font directories / env overrides at runtime.
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
        dirs.push(PathBuf::from(&home).join(".local").join("share").join("fonts"));
    }

    // Linux
    dirs.push(PathBuf::from("/usr/share/fonts"));
    dirs.push(PathBuf::from("/usr/local/share/fonts"));

    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// Join preferred names under a font directory (direct + one subdirectory).
fn push_named_fonts(out: &mut Vec<std::path::PathBuf>, dir: &Path) {
    // 在目录中解析首选字体文件名
    for name in PREFERRED_FONT_NAMES {
        let direct = dir.join(name);
        if direct.is_file() {
            out.push(direct);
        }
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let sub = entry.path();
        if !sub.is_dir() {
            continue;
        }
        for name in PREFERRED_FONT_NAMES {
            let nested = sub.join(name);
            if nested.is_file() {
                out.push(nested);
            }
        }
    }
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
            dirty: false,
        })
    }

    fn glyph_count(&self) -> u16 {
        self.cmap.len() as u16
    }

    /// Rasterize `cp` from `font` into a new appended cell.
    fn append(&mut self, font: &FontRef<'_>, cp: char) {
        if self.glyph_count() >= MAX_GLYPHS {
            return;
        }
        let gid_font = font.glyph_id(cp);
        if gid_font.0 == 0 {
            return; // fallback font lacks it too — the core's tofu handles it
        }
        let px = slot_px(self.slot);
        let density = self.density as f32;
        let advance = font
            .as_scaled(PxScale::from(px))
            .h_advance(gid_font)
            .round()
            .clamp(0.0, 255.0) as u8;

        let cov_w = self.cell_w as usize * self.density as usize;
        let cov_h = self.cell_h as usize * self.density as usize;
        let mut cell = vec![0u8; cov_w * cov_h];
        let glyph = gid_font.with_scale_and_position(
            PxScale::from(px * density),
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
    source: Option<GlyphSource>,
    slots: Vec<SlotAtlas>,
}

impl CjkAtlases {
    pub fn from_pak(pak: &[u8]) -> CjkAtlases {
        let slots: Vec<SlotAtlas> = pocket_ui_wgpu::walk_pak(pak)
            .into_iter()
            .filter(|e| e.key.starts_with("ui:font."))
            .filter_map(|e| SlotAtlas::parse(e.blob))
            .collect();
        let source = match GlyphSource::find() {
            Some((source, name)) => {
                log::info!("note-widget: CJK fallback font {name}");
                Some(source)
            }
            None => {
                log::warn!("note-widget: no CJK-capable system font found — non-Latin input will tofu");
                None
            }
        };
        CjkAtlases { source, slots }
    }

    /// Make sure every non-ASCII codepoint in `text` exists in every slot.
    /// Returns the rebuilt blobs of the slots that grew (feed them to
    /// `Ui::load_font_atlas`); empty when nothing was missing.
    pub fn ensure(&mut self, text: &str) -> Vec<Vec<u8>> {
        let missing: Vec<char> = {
            let mut seen = HashSet::new();
            text.chars()
                .filter(|c| (*c as u32) > 0x7f && !c.is_control())
                .filter(|c| self.slots.iter().any(|s| !s.known.contains(&(*c as u32))))
                .filter(|c| seen.insert(*c))
                .collect()
        };
        if missing.is_empty() {
            return Vec::new();
        }
        let Some(font) = self.source.as_ref().and_then(|s| s.font()) else {
            return Vec::new();
        };
        for cp in &missing {
            for slot in &mut self.slots {
                if !slot.known.contains(&(*cp as u32)) {
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
            log::info!(
                "note-widget: extended {} font slot(s) with {} new glyph(s)",
                blobs.len(),
                missing.len()
            );
        }
        blobs
    }
}
