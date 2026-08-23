param(
  [string]$ListeningSource = 'C:\Users\15pro\Desktop\听力',
  [string]$BooksSource = 'C:\Users\15pro\Desktop\教材'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Write-SourceManifest {
  param(
    [Parameter(Mandatory)] [string]$Source,
    [Parameter(Mandatory)] [string]$Destination
  )

  $sourceRoot = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')
  $rows = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
      $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart('\')
      [pscustomobject]@{
        RelativePath = $relative
        Extension = $_.Extension.ToLowerInvariant()
        Bytes = $_.Length
        SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }

  $rows | Export-Csv -LiteralPath $Destination -NoTypeInformation -Encoding utf8
  Write-Host "$($rows.Count) files -> $Destination"
}

Write-SourceManifest -Source $ListeningSource -Destination (Join-Path $root '听力\manifest.csv')
Write-SourceManifest -Source $BooksSource -Destination (Join-Path $root '教材\manifest.csv')
