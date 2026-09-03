use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use zip::write::FileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

fn main() {
    println!("cargo:rerun-if-changed=windows.manifest");
    println!("cargo:rerun-if-changed=../fixtures/cambridge");
    println!("cargo:rerun-if-changed=../fixtures/assets/cambridge");
    println!("cargo:rerun-if-changed=../fixtures/transcripts");
    pack_content();
    tauri_build::build();
}

fn pack_content() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let zip_path = out_dir.join("content-pack.zip");
    let manifest_path = out_dir.join("content-pack-manifest.json");
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let repo = manifest_dir.parent().expect("src-tauri parent");

    let pkg_version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_string());

    if profile != "release" {
        write_empty_zip(&zip_path);
        let empty_manifest = format!("{{\"contentVersion\":\"{pkg_version}\",\"embedded\":false,\"files\":[]}}\n");
        fs::write(&manifest_path, empty_manifest.as_bytes())
            .expect("write debug content manifest");
        return;
    }

    let mut files = collect_pack_files(repo);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut zip = ZipWriter::new(File::create(&zip_path).expect("create content-pack.zip"));
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(DateTime::from_date_and_time(2001, 1, 1, 0, 0, 0).unwrap())
        .unix_permissions(0o644);
    let mut listing = Vec::new();
    let mut total: u64 = 0;
    for (rel, abs) in &files {
        let bytes = fs::read(abs).unwrap_or_else(|e| panic!("read {}: {e}", abs.display()));
        let digest = hex::encode(Sha256::digest(&bytes));
        total += bytes.len() as u64;
        zip.start_file(rel, options)
            .unwrap_or_else(|e| panic!("zip start {rel}: {e}"));
        zip.write_all(&bytes)
            .unwrap_or_else(|e| panic!("zip write {rel}: {e}"));
        listing.push(serde_like(rel, bytes.len() as u64, &digest));
    }
    let manifest_json = format!(
        "{{\n  \"contentVersion\": \"{}\",\n  \"fileCount\": {},\n  \"totalBytes\": {},\n  \"generatedAtUnix\": {},\n  \"files\": [\n{}\n  ]\n}}\n",
        pkg_version,
        listing.len(),
        total,
        unix_now(),
        listing.join(",\n")
    );
    zip.start_file("manifest.json", options).expect("zip manifest");
    zip.write_all(manifest_json.as_bytes()).expect("zip manifest body");
    zip.finish().expect("finish content-pack.zip");
    fs::write(&manifest_path, manifest_json.as_bytes()).expect("write content-pack-manifest.json");
}

fn collect_pack_files(repo: &Path) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    push_dir(
        &mut files,
        &repo.join("fixtures/cambridge"),
        "cambridge",
        &["json"],
        true,
    );
    push_dir(
        &mut files,
        &repo.join("fixtures/transcripts"),
        "transcripts",
        &["json"],
        false,
    );
    push_dir(
        &mut files,
        &repo.join("fixtures/assets/cambridge"),
        "assets/cambridge",
        &["jpg", "png"],
        false,
    );
    if files.len() < 212 {
        panic!(
            "content pack is incomplete: {} files (need 212 exams + images + transcripts)",
            files.len()
        );
    }
    files
}

fn push_dir(
    files: &mut Vec<(String, PathBuf)>,
    dir: &Path,
    prefix: &str,
    exts: &[&str],
    skip_bak: bool,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if skip_bak && name.ends_with(".bak") {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !exts.contains(&ext.as_str()) {
            continue;
        }
        files.push((format!("{prefix}/{name}"), path));
    }
}

fn serde_like(path: &str, size: u64, sha256: &str) -> String {
    format!(
        "    {{\"path\": {}, \"bytes\": {}, \"sha256\": {}}}",
        json_str(path),
        size,
        json_str(sha256)
    )
}

fn json_str(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_empty_zip(path: &Path) {
    let mut zip = ZipWriter::new(File::create(path).expect("debug zip"));
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(DateTime::from_date_and_time(2001, 1, 1, 0, 0, 0).unwrap());
    zip.start_file("README.txt", options).unwrap();
    zip.write_all(b"debug build: content pack is not embedded\n")
        .unwrap();
    zip.finish().unwrap();
}

#[allow(dead_code)]
fn _read_len(path: &Path) -> usize {
    let mut f = File::open(path).unwrap();
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).unwrap();
    buf.len()
}
