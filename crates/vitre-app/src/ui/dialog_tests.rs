use std::{cell::RefCell, rc::Rc};

use gpui::{Context, MouseButton, Window, div, point, prelude::*, px};
use gpui_base::{Dialog, DialogChangeReason, DialogHandle};

struct BackdropHarness {
    handle: DialogHandle,
    events: Rc<RefCell<Vec<&'static str>>>,
    closable: bool,
    topmost: bool,
    allow_cancel: bool,
}

impl Render for BackdropHarness {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let cancel_events = self.events.clone();
        let change_events = self.events.clone();
        let request_events = self.events.clone();
        let close_events = self.events.clone();
        let allow_cancel = self.allow_cancel;
        Dialog::new(cx)
            .handle(self.handle.clone())
            .layer(0, self.topmost)
            .close_on_backdrop_press(self.closable)
            .dismiss_below_y(px(32.))
            // An absolute child must not leave the event owner's hitbox empty.
            .backdrop(div().absolute().size_full())
            .popup(
                div()
                    .absolute()
                    .left(px(80.))
                    .top(px(80.))
                    .size(px(100.))
                    .occlude(),
            )
            .on_cancel(move |_, _, _| {
                cancel_events.borrow_mut().push("cancel");
                allow_cancel
            })
            .on_open_change(move |open, reason, _, _| {
                assert!(!open);
                assert_eq!(reason, DialogChangeReason::BackdropPress);
                change_events.borrow_mut().push("change");
            })
            .request_close(move |confirmed, _, _| {
                assert!(!confirmed);
                request_events.borrow_mut().push("request");
            })
            .on_close(move |_, _, _| close_events.borrow_mut().push("close"))
    }
}

#[gpui::test]
fn backdrop_press_dismisses_once_and_preserves_callback_order(cx: &mut gpui::TestAppContext) {
    cx.update(gpui_component::init);
    let handle = DialogHandle::new(true);
    let events = Rc::new(RefCell::new(Vec::new()));
    let (_, cx) = cx.add_window_view({
        let handle = handle.clone();
        let events = events.clone();
        move |_, _| BackdropHarness {
            handle,
            events,
            closable: true,
            topmost: true,
            allow_cancel: true,
        }
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));

    cx.simulate_click(point(px(110.), px(110.)), Default::default());
    assert!(
        handle.is_open(),
        "clicks inside the popup do not dismiss it"
    );
    assert!(events.borrow().is_empty());
    cx.simulate_click(point(px(300.), px(300.)), Default::default());

    assert!(!handle.is_open());
    assert_eq!(&*events.borrow(), &["cancel", "change", "request", "close"]);
}

#[gpui::test]
fn backdrop_press_respects_dismissal_guards(cx: &mut gpui::TestAppContext) {
    cx.update(gpui_component::init);
    let handle = DialogHandle::new(true);
    let events = Rc::new(RefCell::new(Vec::new()));
    let (view, cx) = cx.add_window_view({
        let handle = handle.clone();
        let events = events.clone();
        move |_, _| BackdropHarness {
            handle,
            events,
            closable: true,
            topmost: true,
            allow_cancel: true,
        }
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));

    cx.simulate_click(point(px(300.), px(16.)), Default::default());
    cx.simulate_mouse_down(
        point(px(300.), px(300.)),
        MouseButton::Right,
        Default::default(),
    );
    assert!(handle.is_open());
    assert!(events.borrow().is_empty());

    for (closable, topmost, allow_cancel) in [
        (false, true, true),
        (true, false, true),
        (true, true, false),
    ] {
        view.update(cx, |view, cx| {
            view.closable = closable;
            view.topmost = topmost;
            view.allow_cancel = allow_cancel;
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.simulate_click(point(px(300.), px(300.)), Default::default());
        assert!(handle.is_open());
    }
    assert_eq!(&*events.borrow(), &["cancel"]);
}
