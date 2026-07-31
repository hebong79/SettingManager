---
name: settingmanager-stack
description: SettingManager의 TypeScript(Node ESM)와 Vitest 스택 규약을 적용한다. 소스·테스트 작성 또는 수정 직전, 부트스트랩, tsconfig·Vitest 설정, ESM import 오류, REST 모킹, typecheck·test 실행 요청에 사용한다. 기능 구현 요청은 먼저 settingmanager-dev 하네스로 진입한다.
---

# SettingManager 스택 규약

메인 서비스는 `SettingMain/`에 둔다. 이 배치는 현재 저장소 구조에서 도출한 가정이므로, 첫 설계에서 명시하고 사용자가 다른 배치를 정하면 이 규약을 갱신한다.

## 부트스트랩

`SettingMain/package.json`이 없을 때만 다음을 만든다. 기존 파일은 덮어쓰지 않는다.

`package.json`은 Node 20 이상, `type: "module"`, `tsx`, TypeScript, Vitest를 개발 의존성으로 두고 `dev`, `build`, `typecheck`, `test`, `test:watch` 스크립트를 제공한다. 런타임 의존성은 실제 필요가 생길 때만 추가한다.

`tsconfig.json`은 `target: ES2022`, `module`·`moduleResolution: NodeNext`, `strict: true`, `rootDir: "."`, `outDir: "dist"`를 사용하고 `src/**/*.ts`, `test/**/*.ts`를 포함한다. `vitest.config.ts`는 Node 환경에서 `test/**/*.test.ts`만 포함한다.

루트 `.gitignore`에는 `node_modules/`, `dist/`, `logs/`, `_workspace_prev*/`를 둔다. `_workspace/`는 감사 산출물이므로 무시하지 않는다.

부트스트랩 뒤에는 `npm install`, `npm run typecheck`, `npm run test`를 실제 순서대로 실행한다. 테스트가 없다면 스모크 테스트를 하나 만들어 러너 실행을 확인한다.

## 구조와 코드 규약

```
SettingMain/
  src/       # index.ts, domain/, clients/, config/, util/ — 쓰이는 것만 생성
  test/      # *.test.ts
docs/        # yyyyMMdd_hhmmss_*.md
_workspace/  # 하네스 중간 산출물
```

- NodeNext 상대 import에는 TypeScript 파일을 가리켜도 `.js` 확장자를 쓴다.
- `strict`를 끄거나 `any`, 캐스팅, `@ts-ignore`로 타입 오류를 덮지 않는다.
- 파일은 camelCase, 타입·클래스는 PascalCase, 상수는 UPPER_SNAKE를 쓴다.
- 외부 I/O는 `clients/`에 격리하고, 도메인 로직에서 `fetch`를 직접 호출하지 않는다.
- 외부 호출에는 타임아웃을 두고 오류를 조용히 삼키지 않는다.

## 테스트 규약

- 테스트는 `SettingMain/test/{대상}.test.ts`에 둔다.
- 실행 결과 확인은 watch가 아닌 `npm run test`로 한다.
- REST 호출은 `vi.fn()` 또는 `vi.stubGlobal('fetch', ...)`으로 모킹한다. 모킹 응답은 실제 응답 스키마·예시를 근거로 하고 해당 경로를 주석에 남긴다.
- 파일 I/O 테스트는 임시 디렉터리를 사용해 실제 산출물을 오염시키지 않는다.
- 형제 `AgentVLA/ParkAgent/SettingAgent` 연동 시 응답은 실제 `src/api/*Routes.ts` 또는 문서에서 확인한다. cam/preset/slot 인덱스는 1-based이며 계약이 불명확하면 추측하지 않는다.
