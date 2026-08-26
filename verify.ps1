$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (Test-Path -LiteralPath 'fixtures\cambridge') {
  Write-Host '== Local licensed Cambridge content =='
  $audioArgs = @()
  if (-not (Test-Path -LiteralPath 'fixtures\assets\cambridge\c04-t1.mp3')) {
    $audioArgs += '--skip-audio'
    Write-Host 'audio files absent; validating JSON/images/transcripts only'
  }
  python scripts/verify_cambridge.py --baseline --health @audioArgs
  if ($LASTEXITCODE -ne 0) { throw "Cambridge verification failed with exit code $LASTEXITCODE" }
  python scripts/verify_content_pack.py
  if ($LASTEXITCODE -ne 0) { throw "Content pack verification failed with exit code $LASTEXITCODE" }
} else {
  Write-Host '== Local licensed Cambridge content: skipped (not distributed) =='
}
Write-Host '== styles (token discipline + exam domain) =='
python scripts/check_styles.py
if ($LASTEXITCODE -ne 0) { throw "Style check failed with exit code $LASTEXITCODE" }
Write-Host '== npm audit =='
npm audit --registry=https://registry.npmjs.org --audit-level=high
if ($LASTEXITCODE -ne 0) { throw "npm audit failed with exit code $LASTEXITCODE" }
npm audit --prefix site --registry=https://registry.npmjs.org --audit-level=high
if ($LASTEXITCODE -ne 0) { throw "site npm audit failed with exit code $LASTEXITCODE" }
Write-Host '== cargo audit =='
if (-not (Get-Command cargo-audit -ErrorAction SilentlyContinue)) {
  cargo install cargo-audit --locked
  if ($LASTEXITCODE -ne 0) { throw "cargo-audit install failed" }
}
cargo audit --file src-tauri/Cargo.lock
if ($LASTEXITCODE -ne 0) { throw "cargo audit failed with exit code $LASTEXITCODE" }
Write-Host '== vitest =='
npm test
if ($LASTEXITCODE -ne 0) { throw "Vitest failed with exit code $LASTEXITCODE" }
Write-Host '== cargo test =='
cargo test --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw "Cargo tests failed with exit code $LASTEXITCODE" }
Write-Host '== tsc =='
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw "TypeScript check failed with exit code $LASTEXITCODE" }
Write-Host '== production build =='
npm run build
if ($LASTEXITCODE -ne 0) { throw "Production build failed with exit code $LASTEXITCODE" }
Write-Host 'OK'
