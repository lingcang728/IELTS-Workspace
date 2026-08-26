mod audio;
mod audio_meta;
mod band;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            commands::audio_library_status,
            commands::audio_catalog,
            commands::audio_pick_files,
            commands::audio_pick_folder,
            commands::audio_scan_paths,
            commands::audio_confirm_import,
            commands::audio_cancel_import,
            commands::audio_playback_source,
            commands::audio_remove_binding,
            commands::audio_repair_bindings,
            commands::audio_open_guide,
            commands::audio_bindings,
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
        .run(tauri::generate_context!())
        .expect("error while running IELTS Workspace");
}
