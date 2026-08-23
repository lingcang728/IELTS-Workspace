mod commands;
mod error;
mod library;
mod paths;
mod scoring;
mod session;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running IELTS Workspace");
}
