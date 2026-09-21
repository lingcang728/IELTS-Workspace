use std::{fs, path::PathBuf, process::Command, thread, time::Duration};
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

/// Identity of a candidate exe at one moment. NSIS keeps the packaged
/// last-write time (`SetDateSave` defaults to on), so an installed exe's mtime
/// is its build time — "newly installed" is detected by change since the poll
/// started or by the registry version, never by comparing mtime to now.
#[derive(PartialEq)]
struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
}

fn stamp_of(path: &PathBuf) -> Option<FileStamp> {
    let meta = fs::metadata(path).ok()?;
    Some(FileStamp {
        len: meta.len(),
        modified: meta.modified().ok(),
        created: meta.created().ok(),
    })
}

/// `HKCU\...\Uninstall\IELTS Workspace\DisplayVersion`, written near the end of
/// the NSIS install. `reg query` keeps this dependency-free.
#[cfg(windows)]
fn installed_display_version() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\IELTS Workspace",
            "/v",
            "DisplayVersion",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find(|l| l.contains("DisplayVersion"))
        .and_then(|l| l.split_whitespace().last())
        .map(|s| s.to_string())
}

#[cfg(not(windows))]
fn installed_display_version() -> Option<String> {
    None
}

/// Strictly-greater semver compare on `x.y.z` (suffixes ignored).
fn semver_newer(installed: &str, current: &str) -> bool {
    fn parts(v: &str) -> [u64; 3] {
        let mut out = [0u64; 3];
        for (i, seg) in v
            .split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .take(3)
            .enumerate()
        {
            out[i] = seg.trim().parse().unwrap_or(0);
        }
        out
    }
    parts(installed) > parts(current)
}

#[tauri::command]
pub(crate) async fn is_portable_update() -> Result<bool, String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let parent = current
        .parent()
        .ok_or_else(|| "当前程序路径无效".to_string())?;
    // Same rule as `paths::is_portable_layout`: a stray stub uninstall.exe
    // next to a portable exe must not count as "installed".
    Ok(!crate::paths::exe_dir_looks_installed(parent))
}

#[tauri::command]
pub(crate) async fn launch_migrated_install(app: AppHandle) -> Result<(), String> {
    // Migration plus up to 30 s of polling is blocking work; keep it off the
    // async runtime's worker threads so other commands stay responsive.
    tauri::async_runtime::spawn_blocking(move || launch_migrated_install_sync(app))
        .await
        .map_err(|e| format!("更新交接任务失败：{e}"))?
}

fn launch_migrated_install_sync(app: AppHandle) -> Result<(), String> {
    crate::migrate::portable_to_installed().map_err(|e| e.to_string())?;
    let candidates = install_candidates()?;
    let before: Vec<Option<FileStamp>> = candidates.iter().map(stamp_of).collect();
    let current_version = env!("CARGO_PKG_VERSION");

    for _ in 0..60 {
        let registry_newer = installed_display_version()
            .map(|v| semver_newer(&v, current_version))
            .unwrap_or(false);
        for (i, installed) in candidates.iter().enumerate() {
            let Some(parent) = installed.parent() else {
                continue;
            };
            if !installed.is_file() || !crate::paths::exe_dir_looks_installed(parent) {
                continue;
            }
            // Only hand off to the install the update just produced: either the
            // exe appeared/changed since we started polling, or the registry
            // already records a version newer than this portable binary.
            let fresh = match (&before[i], stamp_of(installed)) {
                (Some(old), Some(now)) => *old != now,
                (None, Some(_)) => true,
                _ => false,
            };
            if !fresh && !registry_newer {
                continue;
            }
            if fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(installed)
                .is_ok()
            {
                Command::new(installed)
                    .spawn()
                    .map_err(|error| format!("无法启动更新后的安装版：{error}"))?;
                app.exit(0);
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("安装超时或未找到新写入的 IELTS Workspace 安装版".into())
}

#[cfg(test)]
mod tests {
    use super::semver_newer;

    #[test]
    fn semver_compare() {
        assert!(semver_newer("1.3.9", "1.3.8"));
        assert!(semver_newer("1.10.0", "1.9.9"));
        assert!(!semver_newer("1.3.8", "1.3.8"));
        assert!(!semver_newer("1.3.7", "1.3.8"));
        assert!(!semver_newer("junk", "1.3.8"));
    }
}
