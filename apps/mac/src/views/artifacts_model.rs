//! Artifacts in the Mac app (07, Artifacts; 04, Artifacts tab and Artifact tab): grouping, labels,
//! paths and image decoding. SVG is rasterized with resvg, which never runs script.

use gpui_kit::{Image, ImageFormat};
use std::sync::Arc;
use tempo_protocol as p;

pub const LOST_TEXT: &str = "This artifact was lost before it was saved.";
pub const NO_ARTIFACTS: &str = "No artifacts yet. Agents publish them with publish_artifact.";
pub const SAVING: &str = "Saving";

#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactGroup {
    pub id: String,
    /// Newest first.
    pub versions: Vec<p::Artifact>,
}

/// One group per artifact, newest version first, groups by their newest version's time.
pub fn groups(list: &[p::Artifact]) -> Vec<ArtifactGroup> {
    let mut out: Vec<ArtifactGroup> = Vec::new();
    for a in list {
        match out.iter_mut().find(|g| g.id == a.id) {
            Some(g) => g.versions.push(a.clone()),
            None => out.push(ArtifactGroup {
                id: a.id.clone(),
                versions: vec![a.clone()],
            }),
        }
    }
    for g in &mut out {
        g.versions.sort_by(|a, b| b.version.total_cmp(&a.version));
    }
    out.sort_by(|a, b| {
        b.versions[0]
            .created_at
            .total_cmp(&a.versions[0].created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    out
}

/// `v<version>` when the version is above 1 (04, artifact card).
pub fn version_label(version: f64) -> Option<String> {
    (version > 1.).then(|| format!("v{version}"))
}

/// HTML and PDF open in the default browser through `openArtifact` (07).
pub fn opens_in_browser(kind: p::ArtifactKind) -> bool {
    matches!(kind, p::ArtifactKind::Pdf | p::ArtifactKind::Html)
}

pub fn kind_label(kind: p::ArtifactKind) -> &'static str {
    match kind {
        p::ArtifactKind::Image => "Image",
        p::ArtifactKind::Markdown => "Markdown",
        p::ArtifactKind::Pdf => "PDF",
        p::ArtifactKind::Html => "HTML",
        p::ArtifactKind::Text => "Text",
    }
}

/// The workspace path of a published file, for the file link; None outside /workspace.
pub fn workspace_relative(path: &str) -> Option<&str> {
    path.strip_prefix("/workspace/")
        .filter(|rest| !rest.is_empty())
}

fn extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

/// 04 file tabs: PNG, JPEG, GIF, WebP, AVIF and SVG show as images.
pub fn image_mime_of_path(path: &str) -> Option<&'static str> {
    Some(match extension(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

pub fn is_markdown_path(path: &str) -> bool {
    matches!(extension(path).as_str(), "md" | "markdown")
}

/// The first letter of a changed file's status (`A`, `M`, `D`, `R`).
pub fn status_letter(status: &str) -> char {
    status
        .chars()
        .next()
        .map(|c| c.to_ascii_uppercase())
        .unwrap_or('M')
}

/// `<dir>/<name>`, else `<stem> (2).<ext>`, `<stem> (3).<ext>`… for the first free name.
pub fn unique_download_path(
    dir: &std::path::Path,
    name: &str,
    exists: impl Fn(&std::path::Path) -> bool,
) -> std::path::PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !exists(p))
        .expect("an unused name")
}

/// SVG to PNG with resvg. None when the SVG does not parse or has no size.
pub fn svg_to_png(svg: &[u8]) -> Option<Vec<u8>> {
    let tree = resvg::usvg::Tree::from_data(svg, &resvg::usvg::Options::default()).ok()?;
    let size = tree.size().to_int_size();
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height())?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::default(),
        &mut pixmap.as_mut(),
    );
    pixmap.encode_png().ok()
}

/// Bytes as an image GPUI can draw: raster as is, SVG through resvg. Run it on the background
/// executor. GPUI has no AVIF decoder, so AVIF is None.
pub fn decode_image(mime: &str, bytes: Vec<u8>) -> Option<Arc<Image>> {
    if bytes.is_empty() {
        return None;
    }
    let (format, bytes) = match mime {
        "image/png" => (ImageFormat::Png, bytes),
        "image/jpeg" => (ImageFormat::Jpeg, bytes),
        "image/gif" => (ImageFormat::Gif, bytes),
        "image/webp" => (ImageFormat::Webp, bytes),
        "image/svg+xml" => (ImageFormat::Png, svg_to_png(&bytes)?),
        _ => return None,
    };
    Some(Arc::new(Image::from_bytes(format, bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(id: &str, version: f64, created_at: f64) -> p::Artifact {
        p::Artifact {
            id: id.into(),
            version,
            session_id: "s1".into(),
            turn_id: None,
            item_id: format!("i{id}{version}"),
            path: "/workspace/plan.md".into(),
            name: "plan.md".into(),
            title: "Plan".into(),
            summary: None,
            mime: "text/markdown".into(),
            kind: p::ArtifactKind::Markdown,
            size: 10.,
            sha256: "x".into(),
            status: p::ArtifactStatus::Ready,
            created_at,
        }
    }

    #[test]
    fn groups_versions_newest_first_by_their_newest_version() {
        let g = groups(&[
            artifact("a", 1., 1.),
            artifact("b", 1., 2.),
            artifact("a", 2., 3.),
        ]);
        assert_eq!(
            g.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(
            g[0].versions.iter().map(|v| v.version).collect::<Vec<_>>(),
            [2., 1.]
        );
    }

    #[test]
    fn labels_and_paths_follow_04() {
        assert_eq!(version_label(1.), None);
        assert_eq!(version_label(3.).as_deref(), Some("v3"));
        assert!(opens_in_browser(p::ArtifactKind::Html) && opens_in_browser(p::ArtifactKind::Pdf));
        assert!(!opens_in_browser(p::ArtifactKind::Image));
        assert_eq!(
            workspace_relative("/workspace/docs/a.md"),
            Some("docs/a.md")
        );
        assert_eq!(workspace_relative("/home/tempo/artifacts/a.md"), None);
        assert_eq!(image_mime_of_path("a/B.PNG"), Some("image/png"));
        assert_eq!(image_mime_of_path("x.svg"), Some("image/svg+xml"));
        assert_eq!(image_mime_of_path("x.txt"), None);
        assert!(is_markdown_path("README.md") && !is_markdown_path("a.mdx"));
    }

    #[test]
    fn downloads_never_overwrite() {
        let dir = std::path::Path::new("/d");
        let taken = ["/d/plan.md", "/d/plan (2).md"];
        let exists = |p: &std::path::Path| taken.iter().any(|t| p == std::path::Path::new(t));
        assert_eq!(
            unique_download_path(dir, "plan.md", exists),
            dir.join("plan (3).md")
        );
        assert_eq!(
            unique_download_path(dir, "new.md", exists),
            dir.join("new.md")
        );
        assert_eq!(status_letter("added"), 'A');
    }

    #[test]
    fn svg_rasterizes_and_scripts_never_run() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><script>alert(1)</script><rect width="4" height="3" fill="red"/></svg>"#;
        let png = svg_to_png(svg).expect("png");
        assert_eq!(&png[..4], &[0x89, b'P', b'N', b'G']);
        assert!(svg_to_png(b"not svg").is_none());
        assert!(decode_image("image/svg+xml", svg.to_vec()).is_some());
        assert!(decode_image("image/avif", vec![1, 2, 3]).is_none());
        assert!(decode_image("image/png", vec![]).is_none());
    }
}
