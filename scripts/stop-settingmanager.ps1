# SettingManager 서버 내리기. 진입점은 저장소 루트의 `stopserver.bat` 이다.
#
# 포트를 쥔 프로세스만 죽이면 부족하다. `npm start`(= startserver.bat)는 nodemon 으로
# 띄우는데, nodemon 은 자식이 죽어도 살아남아 다음 파일 저장에 서버를 되살린다.
# 그 상태로 직접 실행하면 포트를 도로 빼앗기고, 원인이 눈에 안 보인다.
# 그래서 이 저장소 경로를 물고 있는 감시자(nodemon/tsx)까지 함께 내린다.
#
# 다른 프로젝트의 node 는 건드리지 않는다 — 명령줄에 이 저장소 경로가 들어 있는 것만 고른다.

[CmdletBinding()]
param(
  [int]$Port = 13030
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "[stopserver] 대상 포트 $Port"
Write-Host "[stopserver] 대상 경로 $root"
Write-Host ''

# 포트를 듣고 있는 PID 목록. Get-NetTCPConnection 이 없는 환경을 위해 netstat 로 물러선다.
function Get-ListenerPids {
  param([int]$Port)
  try {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
             Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    return @(netstat -ano -p tcp |
             Select-String -Pattern "LISTENING" |
             Select-String -Pattern ":$Port\s" |
             ForEach-Object { ($_ -split '\s+')[-1] } |
             Where-Object { $_ -match '^\d+$' -and $_ -ne '0' } |
             Select-Object -Unique)
  }
}

# --- 1) 포트를 쥔 프로세스 종료 --------------------------------------------
$listeners = Get-ListenerPids -Port $Port
if (-not $listeners) {
  Write-Host "[stopserver] 포트 $Port 를 듣는 프로세스가 없습니다"
} else {
  foreach ($processId in $listeners) {
    Write-Host "[stopserver] 포트 점유 PID $processId 종료"
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
    } catch {
      Write-Host "[stopserver]   ! PID $processId 종료 실패: $($_.Exception.Message)"
    }
  }
}

# --- 2) 이 저장소를 물고 있는 감시자(nodemon/tsx) 정리 ----------------------
$watchers = @(
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like "*$root*" -and
      $_.CommandLine -match 'nodemon|tsx'
    }
)
if (-not $watchers) {
  Write-Host '[stopserver] 남은 감시자 없음'
} else {
  foreach ($w in $watchers) {
    Write-Host "[stopserver] 감시자 PID $($w.ProcessId) 종료"
    try {
      Stop-Process -Id $w.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Host "[stopserver]   ! PID $($w.ProcessId) 종료 실패: $($_.Exception.Message)"
    }
  }
}

# --- 3) 죽었다고 말하지 말고 실제로 확인한다 --------------------------------
Start-Sleep -Milliseconds 1500
$still = Get-ListenerPids -Port $Port

Write-Host ''
if ($still) {
  Write-Host "[stopserver] 실패 — 포트 $Port 를 아직 PID $($still -join ', ') 이 쥐고 있습니다"
  exit 1
}
Write-Host "[stopserver] 완료 — 포트 $Port 가 비었습니다"
exit 0
