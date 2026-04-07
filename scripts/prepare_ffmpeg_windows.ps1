$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$targetDir = Join-Path $repoRoot "vendor\ffmpeg\win"
$targetExe = Join-Path $targetDir "ffmpeg.exe"
$zipPath = Join-Path $env:TEMP "qsys-ffmpeg-release-essentials.zip"
$extractDir = Join-Path $env:TEMP ("qsys-ffmpeg-" + [guid]::NewGuid().ToString("N"))
$downloadUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

if (Test-Path $targetExe) {
  Write-Host "FFmpeg already present: $targetExe"
  exit 0
}

Write-Host "Downloading FFmpeg..."
Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath

Write-Host "Extracting FFmpeg..."
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

$ffmpeg = Get-ChildItem -Path $extractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $ffmpeg) {
  throw "ffmpeg.exe was not found in the downloaded archive."
}

Copy-Item -Path $ffmpeg.FullName -Destination $targetExe -Force

$license = Get-ChildItem -Path $extractDir -Recurse -Filter "LICENSE*" | Select-Object -First 1
if ($license) {
  Copy-Item -Path $license.FullName -Destination (Join-Path $targetDir $license.Name) -Force
}

Remove-Item -Path $extractDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "FFmpeg ready: $targetExe"
