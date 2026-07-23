# Publishes the card database (public/cdn -> Cloudflare R2) from this machine.
# Talks to the R2 API directly (S3-compatible, signed with your token) via
# scripts/publish-images.js — no wrangler, no dependencies, idempotent
# (re-runs only transfer new/changed files), never deletes anything remote.
#
# One-time setup:
#   1. Create a file named  r2.env  in the repo root (it is gitignored):
#
#        R2_ACCOUNT_ID=your-account-id
#        R2_ACCESS_KEY_ID=your-access-key
#        R2_SECRET_ACCESS_KEY=your-secret
#        R2_BUCKET=pokemon-cards
#
#   2. Make sure the card database exists at public\cdn (build it here with
#      "node scripts\build-data.js", or copy it from your master LXC — see
#      DEPLOYMENT.md; copying preserves custom printings/uploaded scans).
#
# Usage (from the repo root or anywhere):
#   .\scripts\publish-images.ps1 --dry-run    # preview what would upload
#   .\scripts\publish-images.ps1              # publish
#   .\scripts\publish-images.ps1 --langs en   # only one language
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo 'r2.env'

if (-not (Test-Path $envFile)) {
  Write-Host "Missing $envFile" -ForegroundColor Red
  Write-Host 'Create it with these lines (see the comment at the top of this script):'
  Write-Host '  R2_ACCOUNT_ID=...'
  Write-Host '  R2_ACCESS_KEY_ID=...'
  Write-Host '  R2_SECRET_ACCESS_KEY=...'
  Write-Host '  R2_BUCKET=pokemon-cards'
  exit 1
}

Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is required (https://nodejs.org) — node was not found on PATH.' -ForegroundColor Red
  exit 1
}

& node (Join-Path $repo 'scripts\publish-images.js') @args
exit $LASTEXITCODE
