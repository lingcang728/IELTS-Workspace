param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$tauri = Join-Path (Get-Location) 'node_modules\.bin\tauri.cmd'
if (-not (Test-Path -LiteralPath $tauri)) { throw "local Tauri CLI missing: $tauri" }
if (-not $SkipBuild) {
  & $tauri build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }
}
$exeName = 'IELTS Workspace.exe'
$candidates = @(
  'G:\build_cache\cargo-target\release\IELTS Workspace.exe',
  'src-tauri\target\release\IELTS Workspace.exe'
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw 'release exe not found' }
$dest = Join-Path $env:LOCALAPPDATA 'Programs\IELTS Workspace'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force $exe (Join-Path $dest $exeName)
# 题库由 content-pack 嵌入 exe，安装后解压到 data\content。不要再镜像整个 fixtures/docs。
foreach ($sub in @('sources','library','assets','sessions','profile','notes','cache','temp','official-samples')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $dest "data\$sub") | Out-Null
}
if (Test-Path 'data-dev\official-samples') {
  robocopy 'data-dev\official-samples' (Join-Path $dest 'data\official-samples') /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed for official samples with exit code $LASTEXITCODE" }
}
$shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\IELTS Workspace.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $dest $exeName
$shortcut.WorkingDirectory = $dest
$shortcut.IconLocation = "$(Join-Path $dest $exeName),0"
$shortcut.Description = 'IELTS Workspace'
$shortcut.Save()
Write-Host "portable exe: $dest\$exeName"
Get-Item (Join-Path $dest $exeName) | Select-Object FullName, Length, LastWriteTime
