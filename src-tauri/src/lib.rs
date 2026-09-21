mod audio;
mod audio_meta;
mod band;
mod clock;
mod commands;
mod content;
mod error;
mod library;
mod migrate;
mod paths;
mod safe_path;
mod scoring;
mod session;
mod srs;
mod store;
mod study;
mod updates;
mod ziputil;

/// The binary ships `windows_subsystem = "windows"`: a builder failure or a
/// panic (missing WebView2 Runtime is the classic one) otherwise terminates
/// silently — the user double-clicks and nothing happens. Show the one native
/// dialog we can still afford. Only the first panic is surfaced; cascading
/// panics from dying threads must not stack dialogs.
fn fatal_dialog(title: &str, detail: &str) {
    let _ = rfd::MessageDialog::new()
        .set_title(title)
        .set_description(detail)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

fn install_panic_hook() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static SHOWN: AtomicBool = AtomicBool::new(false);
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default(info);
        if SHOWN.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            fatal_dialog("IELTS Workspace 遇到未处理的错误", &info.to_string());
        }));
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    let result = tauri::Builder::default()
        // Second launch must not get a second writer on the same data root:
        // session tmp files, bindings.json and store records are all
        // last-writer-wins. Focus the existing window and let the plugin exit
        // the duplicate before it touches anything.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::save_session,
            commands::load_session,
            commands::list_sessions,
            commands::discard_session,
            commands::archive_session,
            commands::load_exam,
            commands::import_exam,
            commands::resolve_asset,
            commands::score_exam,
            commands::save_profile,
            commands::analytics_report,
            commands::load_transcript,
            commands::audio_pick_files,
            commands::audio_pick_folders,
            commands::audio_scan_paths,
            commands::audio_confirm_import,
            commands::audio_cancel_import,
            commands::audio_playback_source,
            commands::audio_remove_binding,
            commands::audio_repair_bindings,
            commands::audio_open_guide,
            commands::open_data_dir,
            study::mistake_add,
            study::mistake_list,
            study::mistake_resolve,
            study::mistake_delete,
            study::vocab_add,
            study::vocab_list,
            study::vocab_due,
            study::vocab_review,
            study::vocab_delete,
            study::plan_get,
            study::plan_save,
            study::feedback_save,
            study::feedback_list,
            study::feedback_delete,
            updates::is_portable_update,
            updates::launch_migrated_install,
        ])
        .on_window_event(|window, event| {
            // OS-level closes (Alt+F4, taskbar menu, logoff) bypass the custom
            // X button's beforeClose save. Give the frontend one shot at a
            // final flush; if the webview is already wedged, the fallback
            // timer still lets the process exit instead of hanging forever.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::Emitter;
                api.prevent_close();
                let _ = window.emit("app-close-requested", ());
                let win = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = win.destroy();
                });
            }
        })
        .setup(|app| {
            use tauri::Manager;
            if let Ok(root) = paths::data_root() {
                let _ = app.asset_protocol_scope().allow_directory(&root, true);
            }
            if let Ok(fx) = paths::fixtures_root() {
                let _ = app.asset_protocol_scope().allow_directory(&fx, true);
            }
            if let Ok(audio) = paths::audio_files_dir() {
                let _ = app.asset_protocol_scope().allow_directory(&audio, true);
            }
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(err) = result {
        fatal_dialog(
            "IELTS Workspace 启动失败",
            &format!("{err}\n\n请确认系统已安装 Microsoft Edge WebView2 Runtime 后重试。"),
        );
    }
}
