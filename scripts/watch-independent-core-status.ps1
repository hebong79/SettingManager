param(
  [int]$RefreshSeconds = 60,
  [int]$BlinkSeconds = 1
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$statusPath = Join-Path $root '_workspace\STATUS.md'

if (-not (Test-Path $statusPath)) {
  throw "상태 파일을 찾을 수 없습니다: $statusPath"
}

while ($true) {
  $nextRefresh = (Get-Date).AddSeconds($RefreshSeconds)
  while ((Get-Date) -lt $nextRefresh) {
    Clear-Host
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-Host "🟢 IMPLEMENTATION ACTIVE  |  $now" -ForegroundColor Green
    Write-Host "   대현자가 현재 독립 CameraCore 구현 작업을 진행 중입니다." -ForegroundColor Yellow
    Write-Host ('-' * 72) -ForegroundColor DarkGray
    Get-Content -LiteralPath $statusPath -Encoding UTF8
    Write-Host ('-' * 72) -ForegroundColor DarkGray
    Write-Host "다음 상태 새로고침: $($nextRefresh.ToString('HH:mm:ss'))  |  Ctrl+C: 종료" -ForegroundColor DarkGray
    Start-Sleep -Seconds $BlinkSeconds

    Clear-Host
    Write-Host "⚪ IMPLEMENTATION ACTIVE  |  $now" -ForegroundColor DarkGray
    Write-Host "   대현자가 현재 독립 CameraCore 구현 작업을 진행 중입니다." -ForegroundColor DarkGray
    Write-Host ('-' * 72) -ForegroundColor DarkGray
    Get-Content -LiteralPath $statusPath -Encoding UTF8
    Write-Host ('-' * 72) -ForegroundColor DarkGray
    Write-Host "다음 상태 새로고침: $($nextRefresh.ToString('HH:mm:ss'))  |  Ctrl+C: 종료" -ForegroundColor DarkGray
    Start-Sleep -Seconds $BlinkSeconds
  }
}
