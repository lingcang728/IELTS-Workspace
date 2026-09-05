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
