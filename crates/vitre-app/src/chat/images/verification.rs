//! Disposable native pass, selected by VITRE_VERIFY_ICONS=images.
use crate::chat::*;
use base64::Engine as _;

impl ChatApp {
    pub(in crate::chat) fn verify_chat_images(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let executor = cx.background_executor().clone();
        cx.spawn_in(window, async move |app, cx| {
            let run = async {
                ui_verification::float_fixture(cx).await?;
                let urls = app.update_in(cx, |a, w, cx| {
                    w.resize(gpui::size(px(1440.), px(960.)));
                    if a.dock_open() { a.toggle_right_panel(w, cx); }
                    let mut urls = Vec::new();
                    for (i, color) in [[65, 120, 220, 255], [220, 120, 65, 255]].into_iter().enumerate() {
                        let mut bytes = std::io::Cursor::new(Vec::new());
                        image::RgbaImage::from_pixel(640, 360, image::Rgba(color)).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
                        let url: SharedString = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())).into();
                        a.attachment_urls.insert(format!("image-{i}"), url.clone());
                        urls.push((url, format!("preview-{i}.png").into()));
                    }
                    let view = Arc::make_mut(a.thread.as_mut().unwrap().state.view.as_mut().unwrap());
                    view.messages = vec![serde_json::from_value(serde_json::json!({
                        "id":"image-message", "role":"user", "text":"Chat image preview regression",
                        "createdAt":now_iso(), "updatedAt":now_iso(), "streaming":false,"turnId":null,
                        "attachments": (0..2).map(|i| serde_json::json!({"type":"image","id":format!("image-{i}"),"name":format!("preview-{i}.png"),"mimeType":"image/png","sizeBytes":100})).collect::<Vec<_>>()
                    })).unwrap()];
                    a.rebuild_timeline(cx);
                    cx.notify();
                    urls
                }).map_err(|e|e.to_string())?;
                executor.timer(Duration::from_secs(2)).await;
                for (url, _) in &urls {
                    let loaded = cx.update(|w,cx| w.use_asset::<super::ChatThumbnail>(url,cx).is_some_and(|r| r.is_ok())).map_err(|e|e.to_string())?;
                    if !loaded { return Err("Chat thumbnail asset did not load".to_string()); }
                }
                if let Err(e) = ui_verification::capture("image-thumbnails", cx).await {
                    eprintln!("[vitre-images-test] screenshot unavailable: {e}");
                }
                let lightbox = cx.update(|w,cx| {
                    let lightbox = cx.new(|cx| ImageLightbox::new(urls,0,cx));
                    let content = lightbox.clone();
                    w.open_dialog(cx, move |dialog,_,_| {
                        let content = content.clone();
                        dialog.title("Image preview").w(px(980.)).content(move |body,_,_|body.child(content.clone()))
                    });
                    lightbox
                }).map_err(|e|e.to_string())?;
                executor.timer(Duration::from_millis(700)).await;
                let _ = ui_verification::capture("image-lightbox",cx).await;
                ui_verification::key("right",cx).await?;
                if lightbox.read_with(cx,|l,_|l.index) != 1 {return Err("Right arrow did not select second image".into());}
                executor.timer(Duration::from_millis(300)).await;
                let _ = ui_verification::capture("image-lightbox-next",cx).await;
                ui_verification::key("left",cx).await?;
                if lightbox.read_with(cx,|l,_|l.index) != 0 {return Err("Left arrow did not select first image".into());}
                ui_verification::key("escape",cx).await?;
                if cx.update(|w,cx|w.has_active_dialog(cx)).map_err(|e|e.to_string())? {return Err("Escape did not dismiss preview".into());}
                Ok::<_,String>(())
            };
            let result = tokio::select! {r=run=>r,_=executor.timer(Duration::from_secs(40))=>Err("Image verification timed out".into())};
            match result {Ok(())=>eprintln!("[vitre-images-test] PASS: thumbnails, lightbox, previous/next and Escape"),Err(e)=>eprintln!("[vitre-images-test] FAIL: {e}")}
        }).detach();
    }
}
