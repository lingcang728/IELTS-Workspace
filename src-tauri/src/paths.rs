use crate::error::AppError;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const DATA_SUBDIRS: &[&str] = &[
    "sources", "library", "assets", "sessions", "profile", "notes", "cache", "temp",
];

pub fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// Root next to the executable in release; project root in `tauri dev`.
/// Never uses process cwd.
pub fn app_root() -> Result<PathBuf, AppError> {
    if is_dev() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        Ok(manifest
            .parent()
            .ok_or_else(|| AppError::from("无法定位项目根目录"))?
            .to_path_buf())
    } else {
        let exe = std::env::current_exe().map_err(|e| {
            AppError::Message(format!("无法读取程序路径 (current_exe): {e}"))
        })?;
        Ok(exe
            .parent()
            .ok_or_else(|| AppError::from("无法定位程序所在目录"))?
            .to_path_buf())
    }
}

pub fn data_root() -> Result<PathBuf, AppError> {
    if is_dev() {
        Ok(app_root()?.join("data-dev"))
    } else {
        Ok(app_root()?.join("data"))
    }
}

pub fn fixtures_root() -> Result<PathBuf, AppError> {
    Ok(app_root()?.join("fixtures"))
}

pub fn ensure_data_layout() -> Result<PathBuf, AppError> {
    let root = data_root()?;
    for sub in DATA_SUBDIRS {
        fs::create_dir_all(root.join(sub))?;
    }
    Ok(root)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub data_root: String,
    pub app_root: String,
    pub dev: bool,
    pub warning: Option<String>,
    pub error: Option<String>,
}

pub fn probe_writable() -> ProbeResult {
    match probe_writable_inner() {
        Ok(result) => result,
        Err(err) => ProbeResult {
            ok: false,
            data_root: data_root()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            app_root: app_root()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            dev: is_dev(),
            warning: None,
            error: Some(err.to_string()),
        },
    }
}

fn probe_writable_inner() -> Result<ProbeResult, AppError> {
    let app = app_root()?;
    let root = ensure_data_layout()?;
    let probe = root.join(".write-probe");
    fs::write(&probe, b"ielts-workspace-probe")?;
    let read_back = fs::read(&probe)?;
    fs::remove_file(&probe)?;
    if read_back != b"ielts-workspace-probe" {
        return Ok(ProbeResult {
            ok: false,
            data_root: root.display().to_string(),
            app_root: app.display().to_string(),
            dev: is_dev(),
            warning: None,
            error: Some(
                "当前目录不可写，IELTS Workspace 无法安全保存考试数据。请将整个程序文件夹移动到可写目录后重新启动。"
                    .into(),
            ),
        });
    }

    let warning = onedrive_warning(&root);
    Ok(ProbeResult {
        ok: true,
        data_root: root.display().to_string(),
        app_root: app.display().to_string(),
        dev: is_dev(),
        warning,
        error: None,
    })
}

fn onedrive_warning(path: &Path) -> Option<String> {
    let text = path.to_string_lossy();
    if text.contains("OneDrive") || text.contains("onedrive") {
        Some("当前数据目录位于 OneDrive 同步路径。同步软件可能锁文件，考试过程中请留意保存警告。".into())
    } else {
        None
    }
}

pub fn sessions_dir() -> Result<PathBuf, AppError> {
    Ok(ensure_data_layout()?.join("sessions"))
}

pub fn library_dir() -> Result<PathBuf, AppError> {
    Ok(ensure_data_layout()?.join("library"))
}

pub fn assets_dir() -> Result<PathBuf, AppError> {
    Ok(ensure_data_layout()?.join("assets"))
}

pub fn profile_path() -> Result<PathBuf, AppError> {
    Ok(ensure_data_layout()?.join("profile").join("profile.json"))
}
