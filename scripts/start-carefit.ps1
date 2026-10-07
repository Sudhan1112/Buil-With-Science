
# Starts the CareFit API for Tailscale Funnel.
# Usage, after `tailscale funnel --bg 8080` has printed the https://….ts.net URL:
#
#   .\scripts\start-carefit.ps1 -PublicHost your-pc.your-tailnet.ts.net
#
# Frontend is a second window:  cd frontend; npm run dev -- --port 8080
param(
  [Parameter(Mandatory = $true)]
  [string]$PublicHost
)

$PublicHost = $PublicHost.Trim().ToLower() -replace '^https://', '' -replace '/$', ''
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
if (-not (Test-Path (Join-Path $data 'db.json'))) {
  Write-Error "No data\db.json under $root — refusing to start against the wrong folder."
  exit 1
}

$env:DATA_DIR = $data
$env:PORT = '3000'
$env:ORIGIN = "https://$PublicHost"
$env:RP_ID = $PublicHost
$env:PASSWORD_LOGIN = '1'
# Owner is already owner: true in db.json; this is belt-and-braces if that flag is missing.
$env:ADMIN_UIDS = 'kTjAIYBdiNs-smOf'

Write-Host "DATA_DIR=$env:DATA_DIR"
Write-Host "ORIGIN=$env:ORIGIN"
Write-Host "RP_ID=$env:RP_ID"
Write-Host "Open https://$PublicHost  (Funnel must already be pointing at port 8080)"
Set-Location (Join-Path $root 'api')
node server.js
