param(
  [string]$OutputDirectory = 'output\release'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = [System.IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
$rootPrefix = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
if (-not $output.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw '发布输出目录必须位于当前仓库内。'
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

$loadedLocalSigningKey = $false
Push-Location $root
try {
  npm run verify
  if ($LASTEXITCODE -ne 0) { throw '完整验证失败，拒绝发布。' }

  $config = Get-Content -LiteralPath 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
  $version = [string]$config.version
  if ((Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version -cne $version) {
    throw 'package.json 与 Tauri 版本不一致。'
  }

  if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY) -and
      [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
    $backup = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'IELTSWorkspace-Updater-Offline-Backup'
    $private = Join-Path $backup 'ielts-workspace-updater.key'
    $passwordFile = Join-Path $backup 'ielts-workspace-updater.key-password.dpapi'
    if (-not (Test-Path -LiteralPath $private) -or -not (Test-Path -LiteralPath $passwordFile)) {
      throw '缺少 IELTS Workspace updater 离线签名备份。'
    }
    $secure = ConvertTo-SecureString (Get-Content -LiteralPath $passwordFile -Raw)
    $credential = [System.Management.Automation.PSCredential]::new('ielts-workspace-updater', $secure)
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -LiteralPath $private -Raw).Trim()
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $credential.GetNetworkCredential().Password
    $loadedLocalSigningKey = $true
  }

  $metadata = cargo metadata --format-version 1 --no-deps --manifest-path src-tauri\Cargo.toml | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw '无法解析 Cargo target 目录。' }
  $target = [string]$metadata.target_directory
  $binary = Join-Path $target 'release\IELTS Workspace.exe'
  $bundle = Join-Path $target 'release\bundle\nsis'
  $sourceInstaller = Join-Path $bundle "IELTS Workspace_${version}_x64-setup.exe"
  Remove-Item -LiteralPath $binary -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sourceInstaller -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$sourceInstaller.sig" -Force -ErrorAction SilentlyContinue

  $startedAt = Get-Date
  npm run tauri:build
  if ($LASTEXITCODE -ne 0) { throw 'Tauri 发布构建失败。' }
  if (-not (Test-Path -LiteralPath $binary) -or
      -not (Test-Path -LiteralPath $sourceInstaller) -or
      -not (Test-Path -LiteralPath "$sourceInstaller.sig")) {
    throw '本轮构建缺少可执行文件、NSIS 安装包或 updater 签名。'
  }
  foreach ($path in @($binary, $sourceInstaller, "$sourceInstaller.sig")) {
    if ((Get-Item -LiteralPath $path).LastWriteTime -lt $startedAt) { throw "检测到旧产物：$path" }
  }

  New-Item -ItemType Directory -Force -Path $output | Out-Null
  Get-ChildItem -LiteralPath $output -File -ErrorAction SilentlyContinue | Remove-Item -Force
  $portable = Join-Path $output "IELTS_Workspace_${version}_x64.exe"
  $installer = Join-Path $output "IELTS_Workspace_${version}_x64-setup.exe"
  Copy-Item -LiteralPath $binary -Destination $portable -Force
  Copy-Item -LiteralPath $sourceInstaller -Destination $installer -Force
  if ((Get-Sha256 $binary) -cne (Get-Sha256 $portable) -or
      (Get-Sha256 $sourceInstaller) -cne (Get-Sha256 $installer)) {
    throw '发布目录复制校验失败。'
  }

  $signature = (Get-Content -LiteralPath "$sourceInstaller.sig" -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($signature)) { throw 'updater 签名为空。' }
  $latest = [ordered]@{
    version = $version
    notes = if ($env:IELTS_RELEASE_NOTES) { $env:IELTS_RELEASE_NOTES.Trim() } else { '新增 GitHub Release 自动检查、下载安装与重启更新。' }
    pub_date = (Get-Date).ToUniversalTime().ToString('o')
    size = (Get-Item -LiteralPath $installer).Length
    platforms = [ordered]@{
      'windows-x86_64' = [ordered]@{
        signature = $signature
        url = "https://github.com/lingcang728/IELTS-Workspace/releases/download/v$version/$([IO.Path]::GetFileName($installer))"
        size = (Get-Item -LiteralPath $installer).Length
      }
    }
  }
  $latestPath = Join-Path $output 'latest.json'
  Write-Utf8NoBom $latestPath ($latest | ConvertTo-Json -Depth 6)

  if ($env:GITHUB_ACTIONS -ne 'true') {
    & (Join-Path $PSScriptRoot 'package-portable.ps1') -SkipBuild
    if ($LASTEXITCODE -ne 0) { throw '本机 IELTS Workspace 同步失败。' }
  } else {
    Write-Host 'GitHub Actions 环境：跳过本机安装目录同步。'
  }

  Get-ChildItem -LiteralPath $output -File | Select-Object Name,Length,LastWriteTime,@{n='SHA256';e={Get-Sha256 $_.FullName}}
} finally {
  if ($loadedLocalSigningKey) {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  }
  Pop-Location
}
