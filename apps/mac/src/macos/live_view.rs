use gpui_kit::component::WindowExt as _;
use gpui_kit::{
    AnyElement, App, Bounds, Div, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, Styled as _, Window, div,
};
use objc2::{
    MainThreadMarker, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_app_kit::NSApplication;
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use std::rc::Rc;

#[link(name = "WebKit", kind = "framework")]
unsafe extern "C" {}

struct NativeView {
    view: Retained<AnyObject>,
}
impl Drop for NativeView {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![&*self.view, stopLoading];
            let _: () = msg_send![&*self.view, removeFromSuperview];
        }
    }
}
trait Surface: 'static {
    fn hide(&self);
    fn show(&self, bounds: Bounds<Pixels>);
}
impl Surface for NativeView {
    fn hide(&self) {
        unsafe {
            let _: () = msg_send![&*self.view, setHidden: true];
            let _: () = msg_send![&*self.view, removeFromSuperview];
        }
    }
    fn show(&self, bounds: Bounds<Pixels>) {
        show(&self.view, bounds);
    }
}
pub struct LiveView {
    native: Rc<NativeView>,
}
impl LiveView {
    pub fn new(url: &str) -> Option<Self> {
        let _mtm = MainThreadMarker::new()?;
        if !url.starts_with("https://") {
            return None;
        }
        unsafe {
            let config: Retained<AnyObject> =
                msg_send![AnyClass::get(c"WKWebViewConfiguration")?, new];
            let store: Retained<AnyObject> = msg_send![
                AnyClass::get(c"WKWebsiteDataStore")?,
                nonPersistentDataStore
            ];
            let _: () = msg_send![&*config, setWebsiteDataStore: &*store];
            let allocated: Allocated<AnyObject> = msg_send![AnyClass::get(c"WKWebView")?, alloc];
            let view: Retained<AnyObject> = msg_send![allocated, initWithFrame: NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.)), configuration: &*config];
            let text = NSString::from_str(url);
            let url: Retained<AnyObject> =
                msg_send![AnyClass::get(c"NSURL")?, URLWithString: &*text];
            let request: Retained<AnyObject> =
                msg_send![AnyClass::get(c"NSURLRequest")?, requestWithURL: &*url];
            let _: Option<Retained<AnyObject>> = msg_send![&*view, loadRequest: &*request];
            Some(Self {
                native: Rc::new(NativeView { view }),
            })
        }
    }
    pub fn hide(&self) {
        self.native.hide();
    }
    pub fn element(&self) -> AnyElement {
        surface_element(self.native.clone())
    }
}
fn surface_element<S: Surface>(native: Rc<S>) -> AnyElement {
    LiveElement {
        native,
        inner: div().size_full(),
    }
    .into_any_element()
}

struct LiveElement<S: Surface> {
    native: Rc<S>,
    inner: Div,
}
impl<S: Surface> IntoElement for LiveElement<S> {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl<S: Surface> Element for LiveElement<S> {
    type RequestLayoutState = <Div as Element>::RequestLayoutState;
    type PrepaintState = <Div as Element>::PrepaintState;
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        self.inner.request_layout(id, inspector, window, cx)
    }
    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.inner
            .prepaint(id, inspector, bounds, layout, window, cx)
    }
    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        layout: &mut Self::RequestLayoutState,
        state: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.inner
            .paint(id, inspector, bounds, layout, state, window, cx);
        let hidden = window.has_active_dialog(cx)
            || window.has_active_sheet(cx)
            || gpui_kit::base::GlobalState::is_in_deferred_context(cx);
        if hidden {
            self.native.hide();
        } else {
            self.native.show(bounds);
        }
    }
}

fn show(view: &AnyObject, bounds: Bounds<Pixels>) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    unsafe {
        let app = NSApplication::sharedApplication(mtm);
        let window: Option<Retained<AnyObject>> = msg_send![&*app, mainWindow];
        let Some(window) = window else {
            return;
        };
        let content: Retained<AnyObject> = msg_send![&*window, contentView];
        let flipped: bool = msg_send![&*content, isFlipped];
        let content_bounds: NSRect = msg_send![&*content, bounds];
        let x = f64::from(f32::from(bounds.origin.x));
        let y = f64::from(f32::from(bounds.origin.y));
        let width = f64::from(f32::from(bounds.size.width));
        let height = f64::from(f32::from(bounds.size.height));
        let y = if flipped {
            y
        } else {
            content_bounds.size.height - y - height
        };
        let _: () =
            msg_send![view, setFrame: NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))];
        let _: () = msg_send![&*content, addSubview: view];
        let _: () = msg_send![view, setHidden: false];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::component::Root;
    use gpui_kit::{AppContext as _, Context, Entity, ParentElement as _, Render, TestAppContext};
    use std::cell::Cell;
    struct TestSurface {
        visible: Cell<bool>,
        paints: Cell<u64>,
    }
    impl Surface for TestSurface {
        fn hide(&self) {
            self.visible.set(false);
        }
        fn show(&self, _: Bounds<Pixels>) {
            self.visible.set(true);
            self.paints.set(self.paints.get() + 1);
        }
    }
    struct Host {
        surface: Rc<TestSurface>,
        visible: bool,
    }
    impl Render for Host {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            if !self.visible {
                self.surface.hide();
            }
            div()
                .size_full()
                .children(self.visible.then(|| surface_element(self.surface.clone())))
        }
    }
    fn mount(
        cx: &mut TestAppContext,
    ) -> (gpui_kit::AnyWindowHandle, Entity<Host>, Rc<TestSurface>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            let surface = Rc::new(TestSurface {
                visible: Cell::new(false),
                paints: Cell::new(0),
            });
            let host = cx.new(|_| Host {
                surface: surface.clone(),
                visible: true,
            });
            let view = host.clone();
            let window = gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| Root::new(view, window, cx))
            })
            .unwrap();
            (window.0, host, surface)
        })
    }
    #[gpui_kit::test]
    fn native_surface_stays_visible_after_paint_and_hides_with_its_pane(cx: &mut TestAppContext) {
        let (window, host, surface) = mount(cx);
        cx.run_until_parked();
        assert!(
            surface.visible.get(),
            "paint count {}",
            surface.paints.get()
        );
        host.update(cx, |host, cx| {
            host.visible = false;
            cx.notify();
        });
        cx.run_until_parked();
        assert!(!surface.visible.get());
        host.update(cx, |host, cx| {
            host.visible = true;
            cx.notify();
        });
        cx.run_until_parked();
        assert!(
            surface.visible.get(),
            "paint count {}",
            surface.paints.get()
        );
        cx.update_window(window, |_, window, _| window.remove_window())
            .unwrap();
        cx.run_until_parked();
    }
    #[gpui_kit::test]
    fn popup_context_hides_the_native_surface_then_restores_it(cx: &mut TestAppContext) {
        let (window, _, surface) = mount(cx);
        cx.run_until_parked();
        assert!(
            surface.visible.get(),
            "paint count {}",
            surface.paints.get()
        );
        let popup = cx.update(gpui_kit::base::GlobalState::register_deferred_popover);
        cx.update_window(window, |_, window, _| window.refresh())
            .unwrap();
        cx.run_until_parked();
        assert!(!surface.visible.get());
        drop(popup);
        cx.update_window(window, |_, window, _| window.refresh())
            .unwrap();
        cx.run_until_parked();
        assert!(
            surface.visible.get(),
            "paint count {}",
            surface.paints.get()
        );
        cx.update_window(window, |_, window, _| window.remove_window())
            .unwrap();
    }
}
