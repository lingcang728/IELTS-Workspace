# 发布产物 (Release Binaries)

**本目录不保留任何安装包。**

按 [`AGENTS.md`](../AGENTS.md) 第 1 条：每次打出新包并确认完成后即刻删除旧包，
`release/` 与 `output/release/` 下不得同时存在两个版本的产物。历史版本由
GitHub Releases 归档，仓库不需要再存一份。

最新签名安装包、便携版与自动更新清单：
👉 [GitHub Releases](https://github.com/lingcang728/IELTS-Workspace/releases/latest)

## 系统要求

- **操作系统**：Windows 10 / Windows 11 (64-bit)
- **运行依赖**：基于 WebView2（Windows 10/11 系统通常已自带）

## 自己打包

```powershell
.\verify.ps1              # 必须先全绿
npm run package:release   # 产出到 output/release/
```
