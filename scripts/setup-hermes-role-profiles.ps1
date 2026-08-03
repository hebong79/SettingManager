# SettingManager Hermes 역할별 모델 프로필 생성/복구
# 실행: PowerShell에서 .\scripts\setup-hermes-role-profiles.ps1
# 기존 default 프로필의 인증·도구 설정을 복제한 뒤 역할별 기본 모델을 고정한다.

$ErrorActionPreference = 'Stop'
$roles = @(
    @{ Profile = 'settingmanager-architect';  Model = 'gpt-5.6-sol';   Role = 'architect' },
    @{ Profile = 'settingmanager-developer';  Model = 'gpt-5.6-terra'; Role = 'developer' },
    @{ Profile = 'settingmanager-qa';         Model = 'gpt-5.6-terra'; Role = 'qa-tester' },
    @{ Profile = 'settingmanager-documenter'; Model = 'gpt-5.6-luna';  Role = 'documenter' }
)

if (-not (Get-Command hermes -ErrorAction SilentlyContinue)) {
    throw 'hermes 명령을 찾지 못했습니다. Hermes Desktop/CLI가 설치된 Windows PowerShell에서 실행하세요.'
}

foreach ($entry in $roles) {
    & hermes profile show $entry.Profile *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "프로필 생성: $($entry.Profile)" -ForegroundColor Cyan
        & hermes profile create $entry.Profile --clone
        if ($LASTEXITCODE -ne 0) { throw "프로필 생성 실패: $($entry.Profile)" }
    }

    Write-Host "모델 고정: $($entry.Role) -> $($entry.Model)" -ForegroundColor Cyan
    & hermes --profile $entry.Profile config set model.default $entry.Model
    if ($LASTEXITCODE -ne 0) { throw "모델 설정 실패: $($entry.Profile)" }
}

Write-Host ''
Write-Host '완료: architect=sol, developer/qa=terra, documenter=luna' -ForegroundColor Green
Write-Host '다음: .\scripts\run-hermes-role.ps1 -Role architect -Task "..."' -ForegroundColor Green
