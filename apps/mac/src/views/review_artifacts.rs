//! Artifacts in the review panel (07, Artifacts): the Artifacts tab, the Artifact tab, image and
//! Markdown file tabs, and image diffs. HTML and PDF open in the default browser.

use super::super::artifacts_model::{
    self as model, LOST_TEXT, NO_ARTIFACTS, decode_image, opens_in_browser,
};
use super::super::tokens::{Token, color};
use super::{Extra, ReviewEvent, ReviewPanel};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Editor, EditorState};
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Image, InteractiveElement as _, IntoElement, ObjectFit,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Window, div, px,
};
use std::sync::Arc;
use tempo_protocol::{self as p, api};

/// Changes whenever an `artifact` item is added or changes status.
fn artifact_items_key(state: &tempo_client::state::WorkspaceState) -> String {
    let mut keys: Vec<String> = state
        .items
        .values()
        .filter(|item| matches!(item.content, p::ItemContent::Artifact(_)))
        .map(|item| format!("{}:{:?}", item.id, item.status))
        .collect();
    keys.sort();
    keys.join(";")
}

impl ReviewPanel {
    /// Reloads `listArtifacts` on every `item.upsert` of kind `artifact` (04, Artifacts tab).
    pub(super) fn sync_artifacts(&mut self, cx: &mut Context<Self>) {
        let key = artifact_items_key(&self.store.read(cx).state);
        if key == self.artifacts_key {
            return;
        }
        self.artifacts_key = key;
        if self.artifacts.is_some() || self.tab == 3 || self.extra.artifact.is_some() {
            self.load_artifacts(cx);
        }
    }

    /// `listArtifacts` reads only the DO and R2, so it never wakes the workspace.
    pub(super) fn load_artifacts(&mut self, cx: &mut Context<Self>) {
        let request = self.client.call::<api::ListArtifacts>(p::ListArtifactsIn {
            workspace_id: self.id(cx),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(list) => {
                        this.artifacts = Some(list);
                        this.artifacts_error = None;
                        if let Some((id, version)) = this.extra.artifact.clone()
                            && this.extra.image.is_none()
                            && this.extra.markdown.is_none()
                            && this.file.is_none()
                        {
                            this.load_artifact_content(id, version, cx);
                        }
                    }
                    Err(e) => {
                        this.artifacts_error = Some(super::super::toast::error_text(&e, None))
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn artifact_versions(&self, id: &str) -> Vec<p::Artifact> {
        self.artifacts
            .as_deref()
            .map(model::groups)
            .and_then(|groups| groups.into_iter().find(|g| g.id == id))
            .map(|g| g.versions)
            .unwrap_or_default()
    }

    fn artifact_version(&self, id: &str, version: f64) -> Option<p::Artifact> {
        self.artifact_versions(id)
            .into_iter()
            .find(|a| a.version == version)
    }

    /// Opens the Artifact tab: one per artifact, at `version` or the newest one.
    pub fn open_artifact(
        &mut self,
        artifact_id: String,
        version: Option<f64>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let version = version
            .or_else(|| {
                self.artifact_versions(&artifact_id)
                    .first()
                    .map(|a| a.version)
            })
            .unwrap_or(1.);
        let key = format!("artifact:{artifact_id}");
        self.extra = Extra {
            artifact: Some((artifact_id.clone(), version)),
            ..Extra::default()
        };
        self.active_document = Some(key.clone());
        self.selected = None;
        self.diff = None;
        self.file = None;
        self.document_open = true;
        self.document_loading = false;
        self.document_generation += 1;
        self.document_title = Some(
            self.artifact_versions(&artifact_id)
                .first()
                .map(|a| a.title.clone())
                .unwrap_or_else(|| "Artifact".into()),
        );
        let title = self.document_title.clone().unwrap_or_default();
        self.documents.retain(|d| d.key != key);
        self.documents.push(super::Document {
            key,
            path: String::new(),
            title,
            diff: None,
            file: None,
            stale: false,
            scope: None,
            content: self.extra.clone(),
        });
        cx.emit(ReviewEvent::Document);
        if self.artifacts.is_none() {
            self.load_artifacts(cx);
        } else {
            self.load_artifact_content(artifact_id, version, cx);
        }
        cx.notify();
    }

    /// Images and Markdown come as bytes from the artifact route; text goes into a read-only editor.
    fn load_artifact_content(&mut self, artifact_id: String, version: f64, cx: &mut Context<Self>) {
        let Some(artifact) = self.artifact_version(&artifact_id, version) else {
            return;
        };
        if artifact.status != p::ArtifactStatus::Ready || opens_in_browser(artifact.kind) {
            return;
        }
        let generation = self.document_generation;
        let request = self
            .client
            .get_artifact(&self.id(cx), &artifact_id, version as u32);
        let kind = artifact.kind;
        let name = artifact.name.clone();
        let mime = artifact.mime.clone();
        self.document_loading = true;
        cx.spawn(async move |this, cx| {
            let file = request.await;
            let image = match (&file, kind) {
                (Ok(file), p::ArtifactKind::Image) => {
                    let bytes = file.bytes.clone();
                    cx.background_executor()
                        .spawn(async move { decode_image(&mime, bytes) })
                        .await
                }
                _ => None,
            };
            let _ = this.update(cx, |this, cx| {
                if generation != this.document_generation {
                    return;
                }
                this.document_loading = false;
                match file {
                    Ok(file) => match kind {
                        p::ArtifactKind::Image => {
                            if image.is_none() {
                                this.error = Some("This image type cannot be shown.".into());
                            }
                            this.extra.image = image;
                        }
                        p::ArtifactKind::Markdown => {
                            this.extra.markdown =
                                Some(String::from_utf8_lossy(&file.bytes).into_owned())
                        }
                        _ => {
                            let text = String::from_utf8_lossy(&file.bytes).into_owned();
                            this.pending_text = Some((name, text));
                        }
                    },
                    Err(e) => this.error = Some(super::super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Text artifacts need a window for their editor; it is made on the next render pass.
    pub(super) fn take_pending_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((name, text)) = self.pending_text.take() {
            self.file = Some(cx.new(|cx| {
                EditorState::new(window, cx)
                    .language(super::language(&name))
                    .default_value(text)
            }));
        }
    }

    fn open_artifact_in_browser(&self, artifact_id: String, version: f64, cx: &mut Context<Self>) {
        let Ok(artifact_id) = p::OpenArtifactInArtifactId::try_from(artifact_id) else {
            return;
        };
        let request = self.client.call::<api::OpenArtifact>(p::OpenArtifactIn {
            workspace_id: self.id(cx),
            artifact_id,
            version,
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(out) => cx.open_url(&out.url),
                Err(e) => {
                    this.error = Some(super::super::toast::error_text(&e, None));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// `Download`: the version's bytes saved to the Downloads folder, then shown in Finder.
    fn download_artifact(&self, artifact: &p::Artifact, cx: &mut Context<Self>) {
        let request = self
            .client
            .get_artifact(&self.id(cx), &artifact.id, artifact.version as u32);
        let name = artifact.name.clone();
        cx.spawn(async move |this, cx| {
            let result = match request.await {
                Ok(file) => {
                    cx.background_executor()
                        .spawn(async move { save_download(&name, &file.bytes) })
                        .await
                }
                Err(e) => Err(super::super::toast::error_text(&e, None)),
            };
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(path) => cx.reveal_path(&path),
                    Err(e) => this.error = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_artifacts(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(list) = &self.artifacts else {
            return match &self.artifacts_error {
                Some(e) => div().p_4().child(e.clone()).into_any_element(),
                None => super::super::skeleton_rows(4).into_any_element(),
            };
        };
        let groups = model::groups(list);
        if groups.is_empty() {
            return div()
                .p_4()
                .text_color(color(Token::MutedForeground, cx))
                .child(NO_ARTIFACTS)
                .into_any_element();
        }
        let sessions = self.store.read(cx).state.sessions.clone();
        let muted = color(Token::MutedForeground, cx);
        v_flex()
            .id("artifact-list")
            .overflow_y_scroll()
            .size_full()
            .children(groups.into_iter().map(|group| {
                let newest = group.versions[0].clone();
                let chat = sessions
                    .get(&newest.session_id)
                    .map(super::super::chat_model::session_title)
                    .unwrap_or_else(|| "Chat".into());
                let id = group.id.clone();
                let older = group.versions.iter().skip(1).map(|v| {
                    let id = group.id.clone();
                    let version = v.version;
                    Button::new(SharedString::from(format!("artifact-{id}-v{version}")))
                        .ghost()
                        .label(format!("v{version}"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_artifact(id.clone(), Some(version), window, cx)
                        }))
                });
                h_flex()
                    .px_2()
                    .gap_1()
                    .child(
                        div()
                            .id(SharedString::from(format!("artifact-row-{id}")))
                            .flex_1()
                            .min_w_0()
                            .py_1()
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_artifact(id.clone(), None, window, cx)
                            }))
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(
                                        div()
                                            .text_color(muted)
                                            .child(model::kind_label(newest.kind)),
                                    )
                                    .child(div().flex_1().truncate().child(newest.title.clone()))
                                    .child(
                                        div()
                                            .text_color(muted)
                                            .child(format!("v{}", newest.version)),
                                    )
                                    .child(div().text_color(muted).child(chat))
                                    .child(div().text_color(muted).child(
                                        super::super::chat_model::format_relative(
                                            newest.created_at,
                                            now_ms(),
                                        ),
                                    )),
                            ),
                    )
                    .children(older)
            }))
            .into_any_element()
    }

    pub(super) fn render_artifact_document(&self, cx: &gpui_kit::App) -> AnyElement {
        let Some((id, version)) = self.extra.artifact.clone() else {
            return div().into_any_element();
        };
        let versions = self.artifact_versions(&id);
        let Some(artifact) = versions.iter().find(|a| a.version == version).cloned() else {
            return match (&self.artifacts, &self.artifacts_error) {
                (_, Some(e)) => div().p_4().child(e.clone()).into_any_element(),
                (None, None) => super::super::skeleton_rows(4).into_any_element(),
                _ => div().p_4().child("Not found.").into_any_element(),
            };
        };
        let weak = self.weak.clone();
        let muted = color(Token::MutedForeground, cx);
        let version_buttons = versions.iter().map(|v| {
            let id = id.clone();
            let version = v.version;
            let weak = weak.clone();
            let button = Button::new(SharedString::from(format!("artifact-doc-v{version}")))
                .label(format!("v{version}"))
                .on_click(move |_, window, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.open_artifact(id.clone(), Some(version), window, cx)
                    });
                });
            if version == artifact.version {
                button.primary()
            } else {
                button.ghost()
            }
        });
        let file_link = model::workspace_relative(&artifact.path).map(str::to_string);
        let name = {
            let label = div().child(artifact.name.clone());
            match file_link {
                Some(path) => {
                    let weak = weak.clone();
                    div()
                        .id("artifact-file-link")
                        .cursor_pointer()
                        .text_color(color(Token::Primary, cx))
                        .on_click(move |_, window, cx| {
                            let _ = weak
                                .update(cx, |this, cx| this.open_file(path.clone(), window, cx));
                        })
                        .child(label)
                        .into_any_element()
                }
                None => label.text_color(muted).into_any_element(),
            }
        };
        let download = {
            let weak = weak.clone();
            let artifact = artifact.clone();
            Button::new("artifact-download")
                .ghost()
                .label("Download")
                .disabled(artifact.status != p::ArtifactStatus::Ready)
                .on_click(move |_, _, cx| {
                    let _ = weak.update(cx, |this, cx| this.download_artifact(&artifact, cx));
                })
        };
        let reload = {
            let weak = weak.clone();
            let id = id.clone();
            Button::new("artifact-reload")
                .ghost()
                .label("Reload")
                .on_click(move |_, window, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.artifacts = None;
                        this.open_artifact(id.clone(), Some(version), window, cx)
                    });
                })
        };
        let header = h_flex()
            .px_3()
            .py_1()
            .gap_2()
            .border_b_1()
            .border_color(color(Token::Border, cx))
            .child(div().child(artifact.title.clone()))
            .children(version_buttons)
            .child(name)
            .child(div().flex_1())
            .child(download)
            .child(reload);
        let body: AnyElement = match artifact.status {
            p::ArtifactStatus::Uploading => div().p_4().child("Saving…").into_any_element(),
            p::ArtifactStatus::Lost => div().p_4().child(LOST_TEXT).into_any_element(),
            p::ArtifactStatus::Ready if opens_in_browser(artifact.kind) => {
                let weak = weak.clone();
                let id = id.clone();
                v_flex()
                    .p_4()
                    .gap_2()
                    .child(format!(
                        "{} · {}",
                        model::kind_label(artifact.kind),
                        super::super::format_bytes(artifact.size)
                    ))
                    .children(
                        artifact
                            .summary
                            .clone()
                            .map(|s| div().text_color(muted).child(s)),
                    )
                    .child(
                        Button::new("artifact-open-browser")
                            .label("Open in browser")
                            .on_click(move |_, _, cx| {
                                let _ = weak.update(cx, |this, cx| {
                                    this.open_artifact_in_browser(id.clone(), version, cx)
                                });
                            }),
                    )
                    .into_any_element()
            }
            p::ArtifactStatus::Ready => {
                if self.document_loading {
                    super::super::skeleton_rows(6).into_any_element()
                } else if let Some(image) = self.extra.image.clone() {
                    image_view(image, "artifact-image")
                } else if let Some(text) = &self.extra.markdown {
                    div()
                        .id("artifact-markdown")
                        .size_full()
                        .overflow_y_scroll()
                        .child(super::super::chat::markdown(
                            "artifact-markdown".into(),
                            text,
                        ))
                        .into_any_element()
                } else if let Some(file) = &self.file {
                    Editor::new(file)
                        .readonly(true)
                        .size_full()
                        .into_any_element()
                } else {
                    div()
                        .p_4()
                        .text_color(muted)
                        .child(self.error.clone().unwrap_or_default())
                        .into_any_element()
                }
            }
        };
        v_flex()
            .size_full()
            .child(header)
            .child(div().flex_1().min_h_0().child(body))
            .into_any_element()
    }

    /// A file tab for an image: the bytes from `readFile`, decoded on the background executor.
    pub(super) fn show_file_image(
        &mut self,
        mime: &'static str,
        out: &p::ReadFileOut,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let bytes = match out.encoding {
            p::ReadFileOutEncoding::Base64 => crate::inline_media::decode_base64(&out.content),
            p::ReadFileOutEncoding::Utf8 => Some(out.content.clone().into_bytes()),
        };
        let generation = self.document_generation;
        let Some(bytes) = bytes else {
            self.error = Some("Binary file.".into());
            return;
        };
        cx.spawn(async move |this, cx| {
            let image = cx
                .background_executor()
                .spawn(async move { decode_image(mime, bytes) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.document_generation {
                    return;
                }
                match image {
                    Some(image) => this.extra.image = Some(image),
                    None => this.error = Some("This image type cannot be shown.".into()),
                }
                this.cache_document();
                cx.notify();
            });
        })
        .detach();
    }

    /// 04 Diff tab: `Before` (readFileAt at baseSha or headSha) and `After` (readFile).
    pub(super) fn open_image_diff(
        &mut self,
        path: String,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_document = Some(format!("diff:{}:{path}", self.scope));
        self.selected = Some(path.clone());
        self.file = None;
        self.diff = None;
        self.document_open = true;
        self.document_title = Some(path.clone());
        self.document_generation += 1;
        self.document_loading = true;
        self.extra = Extra::default();
        let generation = self.document_generation;
        let file = self.files.iter().find(|f| f.path == path).cloned();
        let status = file
            .as_ref()
            .map(|f| super::super::artifacts_model::status_letter(&f.status))
            .unwrap_or('M');
        let old_path = file
            .and_then(|f| f.old_path)
            .unwrap_or_else(|| path.clone());
        let id = self.id(cx);
        let before = (status != 'A')
            .then(|| self.before_sha.clone())
            .flatten()
            .and_then(|sha| p::ReadFileAtInSha::try_from(sha).ok())
            .map(|sha| {
                self.client.call::<api::ReadFileAt>(p::ReadFileAtIn {
                    workspace_id: id.clone(),
                    path: old_path.clone(),
                    sha,
                })
            });
        let after = (status != 'D').then(|| {
            self.client.call::<api::ReadFile>(p::ReadFileIn {
                workspace_id: id.clone(),
                path: path.clone(),
            })
        });
        cx.emit(ReviewEvent::Document);
        let before_mime = model::image_mime_of_path(&old_path).unwrap_or("image/png");
        let after_mime = model::image_mime_of_path(&path).unwrap_or("image/png");
        cx.spawn(async move |this, cx| {
            let before = match before {
                Some(request) => Some(match request.await {
                    Ok(out) => {
                        decode_side(
                            before_mime,
                            out.content,
                            out.encoding == p::ReadFileAtOutEncoding::Base64,
                            cx,
                        )
                        .await
                    }
                    Err(_) => None,
                }),
                None => None,
            };
            let after = match after {
                Some(request) => Some(match request.await {
                    Ok(out) => {
                        decode_side(
                            after_mime,
                            out.content,
                            out.encoding == p::ReadFileOutEncoding::Base64,
                            cx,
                        )
                        .await
                    }
                    Err(_) => None,
                }),
                None => None,
            };
            let _ = this.update(cx, |this, cx| {
                if generation != this.document_generation {
                    return;
                }
                this.document_loading = false;
                this.extra.image_diff = Some((before, after));
                this.cache_document();
                cx.notify();
            });
        })
        .detach();
    }

    /// Image and Markdown file tabs and image diffs, with the Source and Preview toggle.
    pub(super) fn render_extra(&self, cx: &gpui_kit::App) -> Option<AnyElement> {
        if let Some((before, after)) = &self.extra.image_diff {
            let side = |label: &str, image: &Option<Option<Arc<Image>>>| {
                image.as_ref().map(|image| {
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap_1()
                        .child(
                            div()
                                .text_color(color(Token::MutedForeground, cx))
                                .child(label.to_string()),
                        )
                        .child(match image {
                            Some(image) => image_view(
                                image.clone(),
                                SharedString::from(format!("diff-{label}")),
                            ),
                            None => div().child("Binary file.").into_any_element(),
                        })
                })
            };
            return Some(
                h_flex()
                    .p_3()
                    .gap_3()
                    .size_full()
                    .children(side("Before", before))
                    .children(side("After", after))
                    .into_any_element(),
            );
        }
        let path = self.selected.clone().unwrap_or_default();
        let svg = model::image_mime_of_path(&path) == Some("image/svg+xml");
        let preview = if svg {
            self.svg_preview
        } else {
            self.markdown_preview
        };
        let toggleable = self.file.is_some() && (svg || self.extra.markdown.is_some());
        let content = if svg && self.file.is_some() && !preview {
            None
        } else if let Some(image) = self.extra.image.clone() {
            Some(image_view(image, "file-image"))
        } else if let (Some(text), true) = (&self.extra.markdown, preview) {
            Some(
                div()
                    .id("file-markdown")
                    .size_full()
                    .overflow_y_scroll()
                    .child(super::super::chat::markdown("file-markdown".into(), text))
                    .into_any_element(),
            )
        } else {
            None
        };
        if !toggleable {
            return content;
        }
        let weak = self.weak.clone();
        let toggle = |label: &'static str, on: bool| {
            let weak = weak.clone();
            let button = Button::new(label).label(label).on_click(move |_, _, cx| {
                let _ = weak.update(cx, |this, cx| {
                    if svg {
                        this.svg_preview = on;
                    } else {
                        this.markdown_preview = on;
                    }
                    cx.notify();
                });
            });
            if preview == on {
                button.primary()
            } else {
                button.ghost()
            }
        };
        let body = content.unwrap_or_else(|| {
            Editor::new(self.file.as_ref().expect("toggleable has a file"))
                .readonly(true)
                .size_full()
                .into_any_element()
        });
        Some(
            v_flex()
                .size_full()
                .child(
                    h_flex()
                        .p_1()
                        .gap_1()
                        .child(toggle("Source", false))
                        .child(toggle("Preview", true)),
                )
                .child(div().flex_1().min_h_0().child(body))
                .into_any_element(),
        )
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.)
}

async fn decode_side(
    mime: &'static str,
    content: String,
    base64: bool,
    cx: &mut gpui_kit::AsyncApp,
) -> Option<Arc<Image>> {
    let bytes = if base64 {
        crate::inline_media::decode_base64(&content)?
    } else {
        content.into_bytes()
    };
    cx.background_executor()
        .spawn(async move { decode_image(mime, bytes) })
        .await
}

fn image_view(image: Arc<Image>, id: impl Into<SharedString>) -> AnyElement {
    div()
        .id(id.into())
        .size_full()
        .overflow_scroll()
        .p_3()
        .child(
            gpui_kit::img(image)
                .max_w_full()
                .max_h(px(2000.))
                .object_fit(ObjectFit::Contain),
        )
        .into_any_element()
}

/// Saves into ~/Downloads under the artifact's name, with ` (2)`, ` (3)`… when it exists.
fn save_download(name: &str, bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    let dir = crate::update::downloads_dir().ok_or("The Downloads folder is unavailable.")?;
    let path = model::unique_download_path(&dir, name, |p| p.exists());
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}
