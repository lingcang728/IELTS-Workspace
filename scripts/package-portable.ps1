param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not $SkipBuild) {
  $tauri = Join-Path $root 'node_modules\.bin\tauri.cmd'
  if (-not (Test-Path -LiteralPath $tauri)) { throw "local Tauri CLI missing: $tauri" }
  & $tauri build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }

  $metadata = cargo metadata --format-version 1 --no-deps --manifest-path (Join-Path $root 'src-tauri\Cargo.toml') | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw '无法解析 Cargo target 目录。' }
  $target = [string]$metadata.target_directory
  $binary = Join-Path $target 'release\IELTS Workspace.exe'
  if (-not (Test-Path -LiteralPath $binary)) { throw "找不到编译出的 exe: $binary" }

  $relDir = Join-Path $root 'release'
  New-Item -ItemType Directory -Force -Path $relDir | Out-Null
  $version = [string](Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
  Copy-Item -LiteralPath $binary -Destination (Join-Path $relDir "IELTS_Workspace_${version}_x64.exe") -Force
}

$version = [string](Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$exe = Join-Path $root "release\IELTS_Workspace_${version}_x64.exe"
if (-not (Test-Path -LiteralPath $exe)) {
  throw "release/ 里没有当前版本便携包：$exe"
}

# 本机若已装同版本的 NSIS 安装版，快捷方式改指安装版而不是 release/ 里的便携
# exe：便携版把数据写在 exe 旁的 data\，安装版写在 %LOCALAPPDATA%\IELTS
# Workspace User Data\data，两个入口并存=两个数据根，便携版一旦应用内更新
# 迁到安装版后旧快捷方式还会继续拉起便携 exe（数据看起来"丢了"）。
# 安装版版本不同（比如还没装上刚打的这版）时保持指便携，保证快捷方式总是
# 打开刚构建的这版。与 paths.rs 同规则：uninstall.exe 必须是 >1KB 的真卸载器，
# 同名空文件不算安装版。
$installCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'IELTS Workspace\IELTS Workspace.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\IELTS Workspace\IELTS Workspace.exe')
)
foreach ($candidate in $installCandidates) {
  $uninstaller = Join-Path (Split-Path $candidate -Parent) 'uninstall.exe'
  $looksInstalled = (Test-Path -LiteralPath $candidate) -and
    (Test-Path -LiteralPath $uninstaller) -and
    ((Get-Item -LiteralPath $uninstaller).Length -gt 1024)
  if (-not $looksInstalled) { continue }
  $installedVersion = [string](Get-Item -LiteralPath $candidate).VersionInfo.ProductVersion
  $installedVersion = ($installedVersion -split '-')[0] -replace '(\d+\.\d+\.\d+).*', '$1'
  if ($installedVersion -eq $version) {
    Write-Host "检测到同版本安装版，快捷方式指向安装版：$candidate"
    $exe = $candidate
    break
  }
}
$workDir = Split-Path $exe -Parent

function Set-IeltsShortcut([string]$Path, [string]$Target, [string]$WorkDir) {
  $parent = Split-Path $Path -Parent
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.WorkingDirectory = $WorkDir
  $shortcut.IconLocation = "$Target,0"
  $shortcut.Description = 'IELTS Workspace'
  $shortcut.Save()
}

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\IELTS Workspace.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'IELTS Workspace.lnk'
Set-IeltsShortcut -Path $startMenu -Target $exe -WorkDir $workDir
Set-IeltsShortcut -Path $desktop -Target $exe -WorkDir $workDir

Write-Host "shortcuts -> $exe"
Get-Item -LiteralPath $startMenu, $desktop, $exe | Select-Object FullName, Length, LastWriteTime
