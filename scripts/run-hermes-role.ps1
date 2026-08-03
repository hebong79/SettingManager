# SettingManager Hermes 역할 실행기
# 예: .\scripts\run-hermes-role.ps1 -Role architect -Task "카메라 목록 API를 설계해줘"
# 역할별 프로필 및 --model을 이중 지정해 모델 드리프트를 방지한다.

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('architect', 'developer', 'qa-tester', 'documenter')]
    [string]$Role,

    [Parameter(Mandatory)]
    [string]$Task
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$roles = @{
    'architect'  = @{ Profile = 'settingmanager-architect';  Model = 'gpt-5.6-sol';   Output = '_workspace/01_architect_plan.md'; Instruction = '코드를 수정하지 말고 설계만 작성한다.' }
    'developer'  = @{ Profile = 'settingmanager-developer';  Model = 'gpt-5.6-terra'; Output = '_workspace/02_developer_changes.md'; Instruction = '01 계획 범위 안에서만 구현하고 변경 기록을 남긴다.' }
    'qa-tester'  = @{ Profile = 'settingmanager-qa';         Model = 'gpt-5.6-terra'; Output = '_workspace/03_qa_report.md'; Instruction = '02 변경 사항을 실제 typecheck/test로 검증하고 결과를 남긴다.' }
    'documenter' = @{ Profile = 'settingmanager-documenter'; Model = 'gpt-5.6-luna';  Output = '_workspace/04_doc_impact.md'; Instruction = '실제 코드와 QA 결과만 근거로 한글 문서와 영향도 기록을 작성한다.' }
}

if (-not (Get-Command hermes -ErrorAction SilentlyContinue)) {
    throw 'hermes 명령을 찾지 못했습니다. Hermes Desktop/CLI가 설치된 Windows PowerShell에서 실행하세요.'
}

$entry = $roles[$Role]
& hermes profile show $entry.Profile *> $null
if ($LASTEXITCODE -ne 0) {
    throw "프로필 '$($entry.Profile)'이 없습니다. 먼저 .\scripts\setup-hermes-role-profiles.ps1 를 실행하세요."
}

$prompt = @"
당신의 고정 역할은 $Role 입니다.
$($entry.Instruction)
현재 작업 요청: $Task
프로젝트 루트: $projectRoot
반드시 이 프로젝트의 .hermes.md 및 관련 산출물을 읽고, 이번 역할의 산출물 $($entry.Output)을 실제로 생성 또는 갱신하세요. 다른 역할의 책임을 대신 수행하지 마세요.
"@

Push-Location $projectRoot
try {
    Write-Host "실행: $Role / $($entry.Profile) / $($entry.Model)" -ForegroundColor Cyan
    & hermes --profile $entry.Profile --skills settingmanager-dev chat --model $entry.Model -q $prompt
    if ($LASTEXITCODE -ne 0) { throw "Hermes 역할 실행 실패: $Role" }
}
finally {
    Pop-Location
}
