# Nexora AI — start the local server (PowerShell)
# Usage:  powershell -File start.ps1
# Port override:  $env:NEXORA_PORT = '7811'; powershell -File start.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $env:NEXORA_PORT) { $env:NEXORA_PORT = '7810' }

Write-Host ""
Write-Host "  NEXORA AI - starting local server..." -ForegroundColor Magenta
Write-Host "  URL: http://127.0.0.1:$($env:NEXORA_PORT)" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

node (Join-Path $root 'server\server.js')
