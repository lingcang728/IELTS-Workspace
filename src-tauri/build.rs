fn main() {
    println!("cargo:rerun-if-changed=windows.manifest");
    tauri_build::build();
}
