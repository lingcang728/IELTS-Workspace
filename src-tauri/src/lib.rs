mod commands;
mod error;
mod library;
mod paths;
mod scoring;
mod session;
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
            updates::is_portable_update,
            updates::launch_migrated_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running IELTS Workspace");
}
