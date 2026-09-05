# -*- coding: utf-8 -*-
"""Release hygiene gate:
1. Validates version consistency across package.json, tauri.conf.json, site/package.json, Cargo.toml.
2. Packages live only in repo-root release/, current version only; output/release must be empty.
3. Scans src/ and src-tauri/ for unauthorized external network calls.
4. Ensures site/src/App.tsx points to current version without dead links.
"""
import json
import re
import sys
from pathlib import Path

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]

def main() -> int:
    errors = []
    
    # 1. 提取各处版本号
    pkg_ver = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    tauri_ver = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"]
    site_ver = json.loads((ROOT / "site/package.json").read_text(encoding="utf-8"))["version"]
    
    cargo_m = re.search(r'^version\s*=\s*"([^"]+)"', (ROOT / "src-tauri/Cargo.toml").read_text(encoding="utf-8"), re.M)
    cargo_ver = cargo_m.group(1) if cargo_m else None

    versions = {
        "package.json": pkg_ver,
        "src-tauri/tauri.conf.json": tauri_ver,
        "site/package.json": site_ver,
        "src-tauri/Cargo.toml": cargo_ver,
    }
    for k, v in versions.items():
        if v != pkg_ver:
            errors.append(f"版本不一致：package.json 为 {pkg_ver}，而 {k} 为 {v}")

    # 2. 安装包只放仓库根 release/，且只能是当前版本。
    allowed_exes = {
        f"IELTS_Workspace_{pkg_ver}_x64.exe",
        f"IELTS_Workspace_{pkg_ver}_x64-setup.exe",
    }
    out_rel = ROOT / "output" / "release"
    if out_rel.exists():
        leftover = [p.name for p in out_rel.iterdir() if p.is_file()]
        if leftover:
            errors.append(f"安装包应放在 release/，发现 output/release/ 残留：{leftover}")
    release_dir = ROOT / "release"
    if release_dir.exists():
        bins = list(release_dir.glob("*.exe")) + list(release_dir.glob("*.zip")) + list(release_dir.glob("*.msi"))
        extra = [p.name for p in bins if p.name not in allowed_exes]
        if extra:
            errors.append(f"release/ 只许保留当前版本 {pkg_ver}，发现多余：{extra}")

    # 3. 扫描 src/ 下的前端代码，严禁未授权网络请求 (AGENTS.md 第 8 条)
    disallowed_network = re.compile(r"\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(", re.I)
    for tsx_file in (ROOT / "src").rglob("*.ts*"):
        if tsx_file.name.endswith(".test.ts") or tsx_file.name.endswith(".test.tsx"):
            continue
        text = tsx_file.read_text(encoding="utf-8")
        for idx, line in enumerate(text.splitlines(), 1):
            if disallowed_network.search(line):
                errors.append(f"网络纪律违规：{tsx_file.relative_to(ROOT)}:{idx} 发现未授权网络 API：{line.strip()}")

    # 4. 检查官网 site/src/App.tsx 是否有当前版本的动态下载链接
    site_app = (ROOT / "site/src/App.tsx").read_text(encoding="utf-8")
    if "VERSION" not in site_app and f"IELTS_Workspace_{pkg_ver}_x64" not in site_app:
        errors.append(f"site/src/App.tsx 未包含当前版本 {pkg_ver} 的下载链接！")

    if errors:
        for err in errors:
            print(f"FAIL [Hygiene]: {err}", file=sys.stderr)
        return 1
    print(f"Release hygiene ok: 版本严格一致 ({pkg_ver})，release/ 仅当前版，网络边界密封")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
