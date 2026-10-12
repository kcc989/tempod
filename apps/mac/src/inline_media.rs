use gpui_kit::{Image, ImageFormat};
use serde_json::Value;
use std::sync::Arc;

pub fn image(block: &Value) -> Option<Arc<Image>> {
    let block = if block["type"] == "content" {
        &block["content"]
    } else {
        block
    };
    if block["type"] != "image" {
        return None;
    }
    let format = match block["mimeType"].as_str()? {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::Webp,
        _ => return None,
    };
    let bytes = decode_base64(block["data"].as_str()?)?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    if text.len() > 14 * 1024 * 1024 || !text.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    fn digit(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    for (ix, group) in text.as_bytes().chunks_exact(4).enumerate() {
        let a = digit(group[0])?;
        let b = digit(group[1])?;
        out.push(a << 2 | b >> 4);
        if group[2] == b'=' {
            if group[3] != b'=' || ix + 1 != text.len() / 4 || b & 15 != 0 {
                return None;
            }
            continue;
        }
        let c = digit(group[2])?;
        out.push(b << 4 | c >> 2);
        if group[3] == b'=' {
            if ix + 1 != text.len() / 4 || c & 3 != 0 {
                return None;
            }
            continue;
        }
        out.push(c << 6 | digit(group[3])?);
    }
    if out.len() as u64 > tempo_client::MAX_ATTACHMENT_BYTES {
        return None;
    }
    Some(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_only_and_strict_encoding() {
        assert_eq!(decode_base64("YWJj").unwrap(), b"abc");
        assert_eq!(decode_base64("YQ==").unwrap(), b"a");
        for bad in [
            "YQ=",
            "YR==",
            "=Q==",
            "YQ==YQ==",
            "YWJ=",
            "https://tracker.test/a",
        ] {
            assert!(decode_base64(bad).is_none());
        }
        assert!(
            image(&serde_json::json!({"type":"image","mimeType":"image/svg+xml","data":"YQ=="}))
                .is_none()
        );
        assert!(image(&serde_json::json!({"type":"image","mimeType":"image/png","uri":"https://tracker.test"})).is_none());
    }
}
