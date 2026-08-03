param(
  [int]$RefreshSeconds = 60
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$statusPath = Join-Path $root '_workspace\STATUS.md'

if (-not (Test-Path $statusPath)) {
  throw "상태 파일을 찾을 수 없습니다: $statusPath"
}

while ($true) {
  $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $lines = Get-Content -LiteralPath $statusPath -Encoding UTF8
  $active = @($lines | Where-Object { $_ -match '🟡' })

  Write-Host ''
  Write-Host "🟢 IMPLEMENTATION ACTIVE | $now" -ForegroundColor Green
  Write-Host "현재 진행 중인 작업만 표시합니다." -ForegroundColor Yellow
  if ($active.Count -eq 0) {
    Write-Host '🟡 상태 파일에 진행 중인 항목이 아직 없습니다.' -ForegroundColor Yellow
  } else {
    $active | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
  }
  Write-Host "다음 출력: $((Get-Date).AddSeconds($RefreshSeconds).ToString('HH:mm:ss')) | Ctrl+C: 종료" -ForegroundColor DarkGray
  Start-Sleep -Seconds $RefreshSeconds
}
