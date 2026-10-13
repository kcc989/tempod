use gpui_kit::component::tree::TreeItem;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct FileNode {
    path: String,
    children: BTreeMap<String, FileNode>,
}
impl FileNode {
    pub fn from_paths(paths: &[String]) -> Self {
        let mut root = Self::default();
        for path in paths {
            if path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            {
                continue;
            }
            let mut node = &mut root;
            let mut prefix = String::new();
            for part in path.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                node = node.children.entry(part.into()).or_insert_with(|| Self {
                    path: prefix.clone(),
                    ..Default::default()
                });
            }
        }
        root
    }
    pub fn items(self) -> Vec<TreeItem> {
        self.children
            .into_iter()
            .map(|(name, node)| {
                let item = TreeItem::new(node.path.clone(), name);
                item.children(node.items())
            })
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nesting_uses_exact_paths_and_rejects_outside_segments() {
        let tree = FileNode::from_paths(&[
            "src/a.rs".into(),
            "src/nested/b.rs".into(),
            "Cargo.toml".into(),
            "../private".into(),
        ]);
        let items = tree.items();
        assert_eq!(items.len(), 2);
        let src = items.iter().find(|i| i.id.as_ref() == "src").unwrap();
        assert_eq!(src.children[0].id.as_ref(), "src/a.rs");
        assert_eq!(src.children[1].children[0].id.as_ref(), "src/nested/b.rs");
    }
}
