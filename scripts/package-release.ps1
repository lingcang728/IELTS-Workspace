param(
  [string]$OutputDirectory = 'release'
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

function Get-ReleaseNotes([string]$Version) {
  if ($env:IELTS_RELEASE_NOTES) {
    return $env:IELTS_RELEASE_NOTES.Trim()
  }
  $notesFile = Join-Path $root 'docs\release-notes.md'
  if (Test-Path -LiteralPath $notesFile) {
    $text = Get-Content -LiteralPath $notesFile -Raw -Encoding UTF8
    $heading = [regex]::Escape($Version)
    $m = [regex]::Match($text, "(?ms)^##\s+$heading\s*\r?\n(.+?)(?=^##\s|\z)")
    if ($m.Success) {
      return $m.Groups[1].Value.Trim()
    }
  }
  return "${Version}：见 GitHub Release 说明。"
}

$loadedLocalSigningKey = $false
Push-Location $root
try {
  & (Join-Path $root 'verify.ps1')
  if ($LASTEXITCODE -ne 0) { throw '完整验证失败，拒绝发布。' }

  $config = Get-Content -LiteralPath 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
  $version = [string]$config.version
  $pkgVersion = [string](Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
  if ($pkgVersion -cne $version) {
    throw "package.json ($pkgVersion) 与 Tauri ($version) 版本不一致。"
  }
  $cargoLine = Select-String -LiteralPath 'src-tauri\Cargo.toml' -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
  $cargoVersion = [string]$cargoLine.Matches.Groups[1].Value
  if ($cargoVersion -cne $version) {
    throw "Cargo.toml ($cargoVersion) 与 Tauri ($version) 版本不一致。"
  }
  $siteVersion = [string](Get-Content -LiteralPath 'site\package.json' -Raw | ConvertFrom-Json).version
  if ($siteVersion -cne $version) {
    throw "site/package.json ($siteVersion) 与 Tauri ($version) 版本不一致。"
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
  # 发布目录只放当前版本可分发产物。便携版是「exe 旁边就是 data」的设计，所以
  # 只要有人直接在这里双击它，就会当场长出一个 data\。这里把非产物目录清掉，
  # 但绝不静默删除有真实文件的 data\：那说明有人把它当安装目录在用。
  Get-ChildItem -LiteralPath $output -File -ErrorAction SilentlyContinue | Remove-Item -Force
  foreach ($stray in @(Get-ChildItem -LiteralPath $output -Directory -ErrorAction SilentlyContinue)) {
    if (Get-ChildItem -LiteralPath $stray.FullName -File -Recurse -ErrorAction SilentlyContinue) {
      throw "发布目录里有带数据的子目录：$($stray.FullName)。便携版请复制到别处再运行，确认后手动删除该目录。"
    }
    Remove-Item -LiteralPath $stray.FullName -Recurse -Force
  }
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
    notes = Get-ReleaseNotes $version
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
