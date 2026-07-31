---
name: settingmanager-stack
description: SettingManager의 TypeScript(Node ESM) + vitest 스택 규약 참조서. 이 저장소에서 소스 파일을 만들거나 고치거나 테스트를 작성·실행하기 직전에 반드시 읽는다 — 디렉토리 구조, ESM import 확장자 규칙, 파일 명명, 테스트 위치, 외부 REST 모킹 관례, 실행 명령(npm run typecheck/test), 그리고 부트스트랩 파일(package.json/tsconfig.json/vitest.config.ts)의 정본 내용을 담는다. "테스트 어떻게 돌려", "tsconfig 설정", "vitest 설정", "빌드/타입 오류", "ERR_MODULE_NOT_FOUND", "import 확장자", "모킹 어떻게" 같은 직접 질문에 트리거. 단, "구현해줘"·"부트스트랩 해줘"처럼 **작업 수행**을 요청받았다면 이 스킬이 아니라 `settingmanager-dev` 오케스트레이터가 진입점이고, 그 팀이 이 문서를 읽는다. 하네스 자체(에이전트/스킬) 재구성은 harness 스킬 소관이다.
---

# SettingManager 스택 규약

TypeScript(Node ESM) + vitest. 형제 프로젝트 `AgentVLA/ParkAgent/SettingAgent`와 동일한 스택을 쓴다 — 두 프로젝트를 오가며 작업하므로 규약이 갈리면 실수가 늘어난다.

## 서비스 루트

메인 서비스는 **`SettingMain/`** 아래에 둔다(저장소에 미리 만들어져 있는 유일한 디렉토리).

> 이는 저장소 구조에서 도출한 가정이다. 첫 부트스트랩 시 설계자가 계획서에 이 가정을 명시하고, 사용자가 다른 배치를 원하면 그 결정을 따른다. 한 번 정해지면 이 문서를 갱신한다.

## 부트스트랩 (파일이 없을 때만)

`SettingMain/package.json`이 없으면 기능 구현보다 먼저 아래를 만든다. **이미 있으면 건너뛴다 — 덮어쓰지 않는다.**

### 1. `SettingMain/package.json`

```json
{
  "name": "settingmanager",
  "version": "0.1.0",
  "description": "Setting 관련 Agent 들을 관리하는 Agent",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

런타임 의존성은 **필요해질 때 추가한다.** 쓰지도 않을 fastify/zod를 미리 넣지 않는다.

### 2. `SettingMain/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### 3. `SettingMain/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```

### 4. `.gitignore` (저장소 루트, 없으면 생성)

`node_modules/`, `dist/`, `logs/`, `_workspace_prev*/`를 무시한다. `_workspace/`는 사후 감사용이므로 **커밋 대상**이다.

### 5. 검증

`npm install` → `npm run typecheck` → `npm run test` 순으로 **실제 실행**해 통과를 확인한다. 테스트가 0개면 스모크 테스트 1개를 만들어 러너가 실제로 도는지 확인한다.

## 디렉토리 구조

```
SettingMain/
├── src/
│   ├── index.ts        진입점
│   ├── domain/         도메인 타입·순수 로직 (외부 I/O 없음)
│   ├── clients/        관리 대상 에이전트로의 REST/프로세스 호출 (모킹 지점)
│   ├── config/         설정 로딩·스키마
│   └── util/
└── test/               *.test.ts
docs/                   yyyyMMdd_hhmmss_*.md 한글 문서
_workspace/             하네스 중간 산출물
```

구조를 미리 다 만들지 않는다. **쓰이는 디렉토리만** 생긴다.

## 코드 규약

- **ESM 상대 import에 `.js` 확장자를 붙인다** — `moduleResolution: NodeNext`에서 확장자 없는 상대 import는 런타임에 실패한다. TS 파일을 가리켜도 `.js`로 쓴다.
  ```ts
  import { loadConfig } from './config/loadConfig.js';   // ✅
  import { loadConfig } from './config/loadConfig';      // ❌ ERR_MODULE_NOT_FOUND
  ```
- `strict: true`를 끄지 않는다. 타입 오류는 `any`·캐스팅·`@ts-ignore`로 덮지 말고 원인을 고친다. 컴파일러를 우회한 지점은 검증자가 런타임 버그로 되찾아온다.
- 파일명은 camelCase(`loadConfig.ts`), 타입/클래스는 PascalCase, 상수는 UPPER_SNAKE.
- **외부 I/O는 `clients/`에 격리한다.** 도메인 로직이 `fetch`를 직접 부르면 테스트에서 모킹할 지점이 사라진다.
- 외부 호출에는 타임아웃을 건다. 실패를 조용히 삼키지 않는다.

## 테스트 규약

- 위치·명명: `SettingMain/test/{대상}.test.ts`. 소스 옆에 두지 않는다(`include` 패턴과 어긋난다).
- 실행: `npm run test` (= `vitest run`). watch가 아닌 **1회 실행 모드**로 결과를 확인한다.
- 외부 REST는 `vi.fn()`/`vi.stubGlobal('fetch', ...)`으로 모킹한다. **모킹 응답은 실제 스키마에 근거해 만들고, 근거 경로를 주석으로 남긴다** — 상상해서 만든 모킹은 통과해도 아무것도 증명하지 못한다.
  ```ts
  // 근거: AgentVLA/ParkAgent/SettingAgent/src/api/settingsRoutes.ts 응답 shape
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
  ```
- 테스트가 파일을 쓰면 임시 디렉토리를 쓰고 정리한다. 저장소의 실제 산출물 디렉토리를 오염시키지 않는다.
- 실행하지 않은 테스트를 통과로 보고하지 않는다.

## 형제 프로젝트 연동 시

관리 대상인 `AgentVLA/ParkAgent/SettingAgent`의 계약을 참조할 때:
- 응답 shape은 **추측하지 말고** 해당 저장소의 `src/api/*Routes.ts`와 `docs/*.md`에서 확인해 경로를 인용한다.
- cam/preset/slot 인덱스는 그쪽이 **1-based**다. 0-based로 가정하면 조용히 어긋난다.
- 계약이 문서로 확정되지 않았으면 설계자가 계획서에 `확인 필요:`로 올린다.
