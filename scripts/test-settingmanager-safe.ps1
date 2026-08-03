[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:13030'
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')

function Get-SettingManagerJson {
  param([Parameter(Mandatory = $true)][string]$Path)

  $uri = "$base$Path"
  Write-Host "GET $uri" -ForegroundColor Cyan
  Invoke-RestMethod -Uri $uri -Method GET -TimeoutSec 10
}

try {
  Write-Host 'SettingManager 안전 진단을 시작합니다. PTZ 이동 요청은 보내지 않습니다.' -ForegroundColor Yellow
  $health = Get-SettingManagerJson -Path '/api/health'
  $cameras = Get-SettingManagerJson -Path '/api/cameras'

  Write-Host "`n[health]" -ForegroundColor Green
  $health | ConvertTo-Json -Depth 5
  Write-Host "`n[cameras]" -ForegroundColor Green
  $cameras | Select-Object activeCameraId, cameras | ConvertTo-Json -Depth 5
  Write-Host "`n성공: $($cameras.cameras.Count)개 카메라를 읽었습니다. PTZ 이동은 수행하지 않았습니다." -ForegroundColor Green
} catch {
  Write-Host "실패: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
