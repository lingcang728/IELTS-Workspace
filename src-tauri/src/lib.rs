mod band;
mod commands;
mod error;
mod library;
mod paths;
mod scoring;
mod session;
mod srs;
mod store;
mod study;
mod updates;

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
        .run(tauri::generate_context!())
        .expect("error while running IELTS Workspace");
}
