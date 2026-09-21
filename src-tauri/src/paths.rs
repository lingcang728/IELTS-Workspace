use crate::error::AppError;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const DATA_SUBDIRS: &[&str] = &[
    "sources",
    "library",
    "assets",
    "sessions",
    "profile",
    "notes",
    "cache",
    "temp",
    "mistakes",
    "vocab",
    "plans",
    "feedback",
    "audio",
    "content",
    "transcripts",
    "official-samples",
];

pub const CONTENT_VERSION: &str = env!("CARGO_PKG_VERSION");

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
        let exe = std::env::current_exe()
            .map_err(|e| AppError::Message(format!("无法读取程序路径 (current_exe): {e}")))?;
        Ok(exe
            .parent()
            .ok_or_else(|| AppError::from("无法定位程序所在目录"))?
            .to_path_buf())
    }
}

/// Installed layout is "exe next to a real uninstaller". A stray empty or
/// placeholder `uninstall.exe` dropped next to a portable exe must not flip
/// the data root to `%LOCALAPPDATA%` — the user's data would seem to vanish.
pub(crate) fn exe_dir_looks_installed(dir: &Path) -> bool {
    fs::metadata(dir.join("uninstall.exe"))
        .map(|m| m.is_file() && m.len() > 1024)
        .unwrap_or(false)
}

/// Installed layout is "exe next to uninstall.exe". Portable has no uninstaller.
pub fn is_portable_layout() -> bool {
    if is_dev() {
        return false;
    }
    match app_root() {
        Ok(root) => !exe_dir_looks_installed(&root),
        Err(_) => true,
    }
}

/// Installed data root lives OUTSIDE $INSTDIR: NSIS `currentUser` installs to
/// `%LOCALAPPDATA%\IELTS Workspace` and the uninstaller removes that directory
/// recursively. A data root inside it would wipe every session, recording and
/// imported audio file on uninstall. `migrate::run` copies the legacy
/// `$INSTDIR\data` tree here on first launch of a fixed build.
pub fn installed_data_root() -> Result<PathBuf, AppError> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| AppError::from("Windows LOCALAPPDATA 路径不可用"))?;
    Ok(PathBuf::from(local)
        .join("IELTS Workspace User Data")
        .join("data"))
}

pub fn sidecar_data_root() -> Result<PathBuf, AppError> {
    Ok(app_root()?.join("data"))
}

pub fn data_root() -> Result<PathBuf, AppError> {
    if is_dev() {
        Ok(app_root()?.join("data-dev"))
    } else if is_portable_layout() {
        sidecar_data_root()
    } else {
        installed_data_root()
    }
}

/// Exam JSON / images / transcripts. Dev reads the repo; release reads the
/// extracted content pack under the data directory.
pub fn fixtures_root() -> Result<PathBuf, AppError> {
    if is_dev() {
        Ok(app_root()?.join("fixtures"))
    } else {
        Ok(content_dir()?)
    }
}

/// A `CURRENT` marker must name one directory, never a path. The marker lives
/// in the writable data dir, so an absolute or `..` value would redirect the
/// content root anywhere on disk.
pub(crate) fn valid_version_dir(ver: &str) -> bool {
    !ver.is_empty()
        && ver.len() <= 64
        && !ver.starts_with('.')
        && !ver.ends_with('.')
        && !ver.contains("..")
        && ver
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        && !crate::safe_path::is_reserved_component(ver)
}

pub fn content_dir() -> Result<PathBuf, AppError> {
    let root = data_root()?.join("content");
    let marker = root.join("CURRENT");
    if let Ok(ver) = fs::read_to_string(&marker) {
        let ver = ver.trim();
        if valid_version_dir(ver) {
            let current = root.join(ver);
            if current.is_dir() {
                return Ok(current);
            }
        }
    }
    Ok(root.join(CONTENT_VERSION))
}

pub fn audio_dir() -> Result<PathBuf, AppError> {
    Ok(ensure_data_layout()?.join("audio"))
}

pub fn audio_files_dir() -> Result<PathBuf, AppError> {
    let dir = audio_dir()?.join("files");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn audio_bindings_path() -> Result<PathBuf, AppError> {
    Ok(audio_dir()?.join("bindings.json"))
}

pub fn ensure_data_layout() -> Result<PathBuf, AppError> {
    let root = data_root()?;
    for sub in DATA_SUBDIRS {
        fs::create_dir_all(root.join(sub))?;
    }
    fs::create_dir_all(root.join("audio").join("files"))?;
    Ok(root)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub data_root: String,
    pub app_root: String,
    pub dev: bool,
    pub portable: bool,
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
            portable: is_portable_layout(),
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
            portable: is_portable_layout(),
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
        portable: is_portable_layout(),
        warning,
        error: None,
    })
}

fn onedrive_warning(path: &Path) -> Option<String> {
    let text = path.to_string_lossy();
    if text.contains("OneDrive") || text.contains("onedrive") {
        Some(
            "当前数据目录位于 OneDrive 同步路径。同步软件可能锁文件，考试过程中请留意保存警告。"
                .into(),
        )
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

#[cfg(test)]
mod tests {
    use super::onedrive_warning;
    use std::path::Path;

    #[test]
    fn onedrive_is_only_a_warning() {
        assert!(onedrive_warning(Path::new(r"C:\Users\a\OneDrive\data")).is_some());
        assert!(onedrive_warning(Path::new(r"C:\Users\a\Documents")).is_none());
    }
}
