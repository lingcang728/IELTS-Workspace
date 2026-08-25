use std::{path::PathBuf, process::Command, thread, time::Duration};
use tauri::AppHandle;

fn install_candidates() -> Result<Vec<PathBuf>, String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "Windows LOCALAPPDATA 路径不可用".to_string())?;
    let local = PathBuf::from(local);
    Ok(vec![
        local.join("IELTS Workspace").join("IELTS Workspace.exe"),
        local
            .join("Programs")
            .join("IELTS Workspace")
            .join("IELTS Workspace.exe"),
    ])
}

#[tauri::command]
pub(crate) fn is_portable_update() -> Result<bool, String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let parent = current
        .parent()
        .ok_or_else(|| "当前程序路径无效".to_string())?;
    Ok(!parent.join("uninstall.exe").is_file())
}

#[tauri::command]
pub(crate) fn launch_migrated_install(app: AppHandle) -> Result<(), String> {
    crate::migrate::portable_to_installed().map_err(|e| e.to_string())?;
    for _ in 0..30 {
        for installed in install_candidates()? {
            let Some(parent) = installed.parent() else {
                continue;
            };
            if installed.is_file() && parent.join("uninstall.exe").is_file() {
                Command::new(&installed)
                    .spawn()
                    .map_err(|error| format!("无法启动更新后的安装版：{error}"))?;
                app.exit(0);
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("安装完成后未找到新的 IELTS Workspace 安装版".into())
}
