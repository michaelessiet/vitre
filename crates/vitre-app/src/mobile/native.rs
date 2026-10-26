//! FFI ownership for the native Metal view. AppKit methods run on the UI thread;
//! frame delivery/statistics are synchronized by the Objective-C bridge.
use super::Input;
use std::{
    ffi::{CStr, CString, c_char, c_void},
    sync::Arc,
};
use tokio::sync::mpsc;

unsafe extern "C" {
    fn vitre_mobile_create(
        parent: *mut c_void,
        input: extern "C" fn(*mut c_void, *const c_char),
        destroy: extern "C" fn(*mut c_void),
        context: *mut c_void,
    ) -> *mut c_void;
    fn vitre_mobile_destroy(handle: *mut c_void);
    fn vitre_mobile_bounds(handle: *mut c_void, x: f64, y: f64, w: f64, h: f64, visible: bool);
    fn vitre_mobile_stats(
        handle: *mut c_void,
        frames: *mut u64,
        draws: *mut u64,
        w: *mut u32,
        h: *mut u32,
    );
    fn vitre_mobile_ios(
        handle: *mut c_void,
        udid: *const c_char,
        developer: *const c_char,
    ) -> *mut c_char;
    fn vitre_mobile_rgba(handle: *mut c_void, data: *const u8, w: u32, h: u32) -> i32;
    fn vitre_mobile_touch(handle: *mut c_void, x: f64, y: f64, phase: i32);
    fn vitre_mobile_button(handle: *mut c_void, button: i32);
    fn vitre_mobile_snapshot(handle: *mut c_void, bytes: *mut *mut c_void, len: *mut usize) -> i32;
    fn vitre_mobile_text(handle: *mut c_void, text: *const c_char) -> bool;
    fn vitre_mobile_free(ptr: *mut c_void);
}

pub struct NativeView(*mut c_void);
// The bridge marshals destruction to AppKit, synchronizes frames/statistics,
// and serializes HID. bounds() and new() are only called from GPUI's UI thread.
unsafe impl Send for NativeView {}
unsafe impl Sync for NativeView {}
impl Drop for NativeView {
    fn drop(&mut self) {
        unsafe {
            vitre_mobile_destroy(self.0);
        }
    }
}
extern "C" fn input(context: *mut c_void, json: *const c_char) {
    let sender = unsafe { &*(context as *const mpsc::UnboundedSender<Input>) };
    if let Ok(value) = serde_json::from_slice::<Input>(unsafe { CStr::from_ptr(json) }.to_bytes()) {
        let _ = sender.send(value);
    }
}
extern "C" fn destroy(context: *mut c_void) {
    unsafe {
        drop(Box::from_raw(context as *mut mpsc::UnboundedSender<Input>));
    }
}
impl NativeView {
    pub fn new(
        window: &gpui::Window,
        sender: mpsc::UnboundedSender<Input>,
    ) -> anyhow::Result<Arc<Self>> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(window)?.as_raw()
        else {
            anyhow::bail!("Native Devices requires macOS");
        };
        let context = Box::into_raw(Box::new(sender)).cast();
        let ptr = unsafe { vitre_mobile_create(handle.ns_view.as_ptr(), input, destroy, context) };
        if ptr.is_null() {
            destroy(context);
            anyhow::bail!("Could not create the device's Metal view");
        }
        Ok(Arc::new(Self(ptr)))
    }
    pub fn bounds(&self, b: gpui::Bounds<gpui::Pixels>, visible: bool) {
        unsafe {
            vitre_mobile_bounds(
                self.0,
                f32::from(b.origin.x) as f64,
                f32::from(b.origin.y) as f64,
                f32::from(b.size.width) as f64,
                f32::from(b.size.height) as f64,
                visible,
            );
        }
    }
    pub fn stats(&self) -> (u64, u64, u32, u32) {
        let (mut a, mut b, mut w, mut h) = (0, 0, 0, 0);
        unsafe {
            vitre_mobile_stats(self.0, &mut a, &mut b, &mut w, &mut h);
        }
        (a, b, w, h)
    }
    pub fn ios(&self, id: &str, developer: &str) -> anyhow::Result<()> {
        let id = CString::new(id)?;
        let dir = CString::new(developer)?;
        let error = unsafe { vitre_mobile_ios(self.0, id.as_ptr(), dir.as_ptr()) };
        if !error.is_null() {
            let message = unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned();
            unsafe {
                vitre_mobile_free(error.cast());
            }
            anyhow::bail!(message);
        }
        Ok(())
    }
    pub fn rgba(&self, bytes: &[u8], w: u32, h: u32) -> bool {
        if w == 0 || h == 0 || w > 4096 || h > 4096 || bytes.len() != (w as usize * h as usize * 4)
        {
            return false;
        }
        unsafe { vitre_mobile_rgba(self.0, bytes.as_ptr(), w, h) != 0 }
    }
    pub fn touch(&self, x: f64, y: f64, phase: i32) {
        unsafe {
            vitre_mobile_touch(self.0, x, y, phase);
        }
    }
    pub fn button(&self, button: i32) {
        unsafe {
            vitre_mobile_button(self.0, button);
        }
    }
    pub fn text(&self, text: &str) -> anyhow::Result<()> {
        let text = CString::new(text)?;
        if !unsafe { vitre_mobile_text(self.0, text.as_ptr()) } {
            anyhow::bail!("iOS native keyboard currently supports ASCII text");
        }
        Ok(())
    }
    pub fn snapshot(&self) -> anyhow::Result<Vec<u8>> {
        let mut bytes = std::ptr::null_mut();
        let mut len = 0;
        if unsafe { vitre_mobile_snapshot(self.0, &mut bytes, &mut len) } == 0 {
            anyhow::bail!("No device frame has arrived yet");
        }
        let result = unsafe { std::slice::from_raw_parts(bytes as *const u8, len) }.to_vec();
        unsafe {
            vitre_mobile_free(bytes);
        }
        Ok(result)
    }
}
