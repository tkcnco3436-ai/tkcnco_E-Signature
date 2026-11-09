<#
  Start pdf-esign with a public Cloudflare quick tunnel.

  Usage (from the repo root):
    powershell -ExecutionPolicy Bypass -File scripts/start.ps1            # production build + tunnel
    powershell -ExecutionPolicy Bypass -File scripts/start.ps1 -Dev       # dev server + tunnel
    powershell -ExecutionPolicy Bypass -File scripts/start.ps1 -NoTunnel  # local only

  The quick tunnel URL changes every run. The script passes it to the app as APP_URL,
  so links in NEW emails point to the current tunnel; links in emails sent before a restart break
  (use "알림 재발송" in the admin page, or a named tunnel with your own domain, see README).
  Process env overrides .env.local.

  The server binds to 127.0.0.1 only. With the tunnel on, TRUST_PROXY=cloudflare is set so the
  client IP is read from cf-connecting-ip (safe because nothing else can reach the port).
  Keep this window open while the other party signs. Ctrl+C stops both.
#>
param(
  [switch]$Dev,
  [switch]$NoTunnel,
  [int]$Port = 3100
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$tunnel = $null
if (-not $NoTunnel) {
  $cf = Get-Command cloudflared -ErrorAction SilentlyContinue
  if (-not $cf) {
    $guess = Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'
    if (Test-Path $guess) { $cf = Get-Item $guess } else { throw 'cloudflared not found. Install: winget install Cloudflare.cloudflared' }
  }
  $cfPath = if ($cf.Source) { $cf.Source } else { $cf.FullName }
  $log = Join-Path $env:TEMP "pdf-esign-tunnel-$Port.log"
  if (Test-Path $log) { Remove-Item $log -Force }
  Write-Host "Starting Cloudflare quick tunnel..."
  $tunnel = Start-Process -FilePath $cfPath -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$Port") `
    -RedirectStandardError $log -WindowStyle Hidden -PassThru

  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $log) {
      $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value }
    }
  }
  if (-not $url) { Stop-Process -Id $tunnel.Id -Force; throw "Tunnel URL not found. See $log" }
  $env:APP_URL = $url
  $env:TRUST_PROXY = 'cloudflare'
  Write-Host ""
  Write-Host "Public URL : $url" -ForegroundColor Green
  Write-Host "Admin      : $url/admin  (local: http://127.0.0.1:$Port/admin)" -ForegroundColor Green
  Write-Host "Note       : this quick-tunnel URL changes on every restart; links in emails sent earlier will stop working." -ForegroundColor Yellow
  Write-Host ""
}

try {
  if ($Dev) {
    npx next dev -H 127.0.0.1 -p $Port
  } else {
    if (-not (Test-Path '.next/BUILD_ID')) { npm run build }
    npx next start -H 127.0.0.1 -p $Port
  }
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
}
