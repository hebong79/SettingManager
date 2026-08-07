import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PROFILES_DIR } from '../paths.js';
import type { CameraIntrinsics } from '../config/types.js';
import { noisyAnchors, publishGateFailures, type GateFailure } from './publishGate.js';
import {
  PROFILE_KIND,
  PROFILE_SPEC_VERSION,
  opticsOf,
  type CameraProfile,
  type ProfileMethod,
  type ProfileOptics,
  type ProfileQuality,
} from './profileTypes.js';

/**
 * 발행본 저장소 — **캘리브레이션과 센터라이징이 만나는 유일한 자리**이며, 그 만남은 코드가
 * 아니라 **데이터**다. 이 파일은 `calibration/`·`centering/` 어느 쪽도 import 하지 않는다.
 *
 * 정본: baro_calory `docs/calibration.md` §프로파일 생명주기 정책.
 * 그 문서가 *"여기 적힌 것과 다르게 동작하는 코드가 있으면 코드가 틀린 것"* 이라 못 박았으므로
 * 정책 하나하나에 **그것을 강제하는 자리**를 주석으로 함께 적었다.
 *
 * ## 저장 위치는 둘뿐이다
 *
 * | 어디 | 무엇 | 성격 |
 * |---|---|---|
 * | `profiles/camera/<기기id>/rev-NNNN.camprof.json` | 발행본 | **불변** · 외부 소비자의 진실의 출처 |
 * | `camera_info.intrinsics` (SQLite) | 런타임 적용본 | 가변 · 이 프로세스가 실제로 물고 도는 값 |
 *
 * 상류는 두 번째가 `config.json` 이지만 이 저장소는 카메라 정본이 DB 다 — **자리가 다를 뿐
 * 규칙은 같다**(적용이 먼저, 발행이 나중).
 */

export class ProfileError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly details?: unknown) {
    super(message);
    this.name = 'ProfileError';
  }
}

/**
 * 런타임 적용본을 쓰는 곳. **저장소가 DB 를 직접 알지 않는다** — 알게 하면 이 파일을
 * 테스트하는 데 SQLite 가 필요해지고, "적용에 실패했으면 문서도 남지 않는다"를 검사하기
 * 위해 실패하는 DB 를 흉내 내야 한다.
 */
export interface IntrinsicsSink {
  apply(cameraId: string, intrinsics: CameraIntrinsics): Promise<void> | void;
}

export interface PublishInput {
  optics: ProfileOptics;
  device: CameraProfile['device'];
  provenance: CameraProfile['provenance'];
  quality: ProfileQuality;
  /**
   * 런타임에 즉시 물릴 것인가. **기본이 `true` 인 이유**: 기본이 반대였을 때
   * 상류에 *아무도 읽지 않는 발행본*이 생겼고, 증상이 없어 오래 발견되지 않았다.
   */
  apply?: boolean;
  /** 게이트 미달을 넘긴다. 사유는 `quality.forced` 에 **박힌다** — 흔적 없는 우회는 없다. */
  force?: boolean;
}

export interface PublishResult {
  profile: CameraProfile;
  path: string;
  sha256: string;
  applied: boolean;
  /** `true` 면 "문서는 나갔고 런타임은 아직 옛 값"이다. */
  restartRequired: boolean;
  /** 우회해서 통과한 경우 그 사유. 통과했으면 빈 배열. */
  forced: string[];
}

export interface ProfileStoreOptions {
  root?: string;
  sink?: IntrinsicsSink;
  now?: () => string;
  toolVersion?: string;
}

export class ProfileStore {
  private readonly root: string;
  private readonly now: () => string;
  private readonly toolVersion: string;

  constructor(private readonly options: ProfileStoreOptions = {}) {
    this.root = options.root ?? PROFILES_DIR;
    this.now = options.now ?? (() => new Date().toISOString());
    this.toolVersion = options.toolVersion ?? '0.1.0';
  }

  // --- 읽기 -----------------------------------------------------------------

  /** 이 기기의 리비전 번호 오름차순. 폴더가 없으면 빈 배열이다(오류가 아니다). */
  async listRevisions(cameraId: string): Promise<number[]> {
    // **경로 검증을 try 밖에서 한다.** 안에 두면 아래 catch 가 그 예외까지 삼켜, 저장소 밖을
    // 가리키는 id 가 "리비전 없음"으로 조용히 성공한다 — 거절이 사실상 사라진다.
    const dir = this.dirOf(cameraId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    return entries
      .map((name) => /^rev-(\d{4})\.camprof\.json$/.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  async latestRevision(cameraId: string): Promise<number | null> {
    const revisions = await this.listRevisions(cameraId);
    return revisions.length ? revisions[revisions.length - 1]! : null;
  }

  /**
   * 리비전 하나. 생략하면 최신이다.
   *
   * **`@N` 고정 조회는 영원히 유효해야 한다** — 그래야 "어제 읽은 값이 오늘 그대로"라는
   * 계약이 성립한다. 그래서 폐기가 없고, 삭제는 파기가 아니라 퇴역이다(`retire`).
   */
  async read(cameraId: string, revision?: number): Promise<CameraProfile | null> {
    const target = revision ?? (await this.latestRevision(cameraId));
    if (target === null) return null;
    try {
      const text = await readFile(this.fileOf(cameraId, target), 'utf8');
      return JSON.parse(text) as CameraProfile;
    } catch {
      return null;
    }
  }

  // --- 발행 -----------------------------------------------------------------

  /**
   * 새 리비전을 낸다. **`max(rev)+1` 로만 쓰고 기존 파일을 열지 않는다** — 그래서 덮어쓰기가
   * 구조적으로 불가능하다(`PUT` 라우트를 두지 않은 것과 같은 이유다).
   *
   * ## 순서가 안전장치다: 게이트 → **적용** → 발행
   *
   * 리비전은 발행하는 순간 불변이라 되돌릴 수 없는 반면 적용은 실패할 수 있다. 그래서 적용이
   * 먼저다 — 실패하면 **문서도 남지 않는다.** 반대로 하면 아무도 읽지 않는 발행본이 쌓인다.
   */
  async publish(cameraId: string, input: PublishInput): Promise<PublishResult> {
    const failures = publishGateFailures(input.quality);
    if (failures.length > 0 && !input.force) {
      throw new ProfileError(gateMessage(failures), 422, {
        failures: failures.map((f) => ({ metric: f.metric, reason: f.reason })),
        noisyAnchors: noisyAnchors(input.quality),
        // 화면이 「그래도 발행」을 그릴 수 있어야 한다 — 우회로를 API 에만 두면 그것은 우회로가 아니다.
        bypass: { force: true },
      });
    }
    const forced = failures.map((f) => f.reason);

    const previous = await this.latestRevision(cameraId);
    const revision = (previous ?? 0) + 1;
    const profile: CameraProfile = {
      specVersion: PROFILE_SPEC_VERSION,
      kind: PROFILE_KIND,
      profileId: cameraId,
      revision,
      supersedes: previous,
      issuedAt: this.now(),
      issuer: { tool: 'settingmanager', version: this.toolVersion },
      // `project`(월드 투영)는 넣지 않는다 — 설치 측량이 없으므로 할 수 없는 일이다.
      capabilities: input.optics.centeringGain ? ['display', 'aim', 'reproject'] : ['display', 'reproject'],
      device: input.device,
      provenance: input.provenance,
      optics: input.optics,
      extrinsic: {
        status: 'unsurveyed',
        mount: null,
        note: '설치 측량 미완 — capabilities 에 project 가 없습니다. 측량되면 새 리비전으로 발행합니다.',
      },
      quality: { ...input.quality, ...(forced.length ? { forced } : {}) },
    };

    // ① 적용 먼저. 여기서 던지면 아래 파일 쓰기에 **도달하지 않는다**.
    const wantApply = input.apply !== false;
    if (wantApply) await this.applyIntrinsics(cameraId, opticsOf(profile));

    // ② 발행. tmp + rename 이라 반쪽 문서가 남지 않는다.
    const bytes = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = this.fileOf(cameraId, revision);
    await mkdir(this.dirOf(cameraId), { recursive: true });
    await writeAtomic(path, bytes);
    await writeAtomic(`${path}.sha256`, Buffer.from(`${sha256}  rev-${pad(revision)}.camprof.json\n`, 'utf8'));
    await writeAtomic(join(this.dirOf(cameraId), 'latest.json'), Buffer.from(`${JSON.stringify({ revision }, null, 2)}\n`, 'utf8'));

    return { profile, path, sha256, applied: wantApply, restartRequired: !wantApply, forced };
  }

  /**
   * 이미 발행된 리비전을 런타임에 물린다. **되돌리는 길도 이것 하나다** —
   * 옛 리비전 번호를 주면 그 값으로 돌아간다.
   */
  async apply(cameraId: string, revision?: number): Promise<{ profile: CameraProfile; applied: true }> {
    const profile = await this.read(cameraId, revision);
    if (!profile) {
      throw new ProfileError(
        revision === undefined
          ? `기기 ${cameraId} 에 발행된 프로파일이 없습니다`
          : `기기 ${cameraId} 의 리비전 ${revision} 을(를) 찾을 수 없습니다`,
        404,
      );
    }
    await this.applyIntrinsics(cameraId, opticsOf(profile));
    return { profile, applied: true };
  }

  /**
   * **파기가 아니라 퇴역이다.** 폴더를 `.trash/<id>.<시각>` 으로 옮긴다 — 잘못 등록한 기기를
   * 치우는 관리 동작은 필요하지만, 그 대가로 남의 `@N` 고정 조회를 조용히 깨뜨릴 수는 없다.
   *
   * **런타임 적용본은 건드리지 않는다.** 문서를 치웠다고 돌고 있는 카메라의 조준이 말없이
   * 바뀌면 그게 더 나쁘다.
   */
  async retire(cameraId: string): Promise<{ movedTo: string }> {
    const from = this.dirOf(cameraId);
    if ((await this.listRevisions(cameraId)).length === 0) {
      throw new ProfileError(`기기 ${cameraId} 에 발행된 프로파일이 없습니다`, 404);
    }
    const trash = join(this.root, 'camera', '.trash');
    await mkdir(trash, { recursive: true });
    const movedTo = join(trash, `${cameraId}.${this.now().replace(/[:.]/g, '-')}`);
    await rename(from, movedTo);
    return { movedTo };
  }

  // --- 내부 -----------------------------------------------------------------

  private async applyIntrinsics(cameraId: string, intrinsics: CameraIntrinsics): Promise<void> {
    const sink = this.options.sink;
    if (!sink) {
      throw new ProfileError(
        '런타임 적용 대상이 배선되지 않았습니다 — 적용 없이 발행만 하려면 apply:false 를 명시하십시오',
        501,
      );
    }
    await sink.apply(cameraId, intrinsics);
  }

  private dirOf(cameraId: string): string {
    return join(this.root, 'camera', safeId(cameraId));
  }

  private fileOf(cameraId: string, revision: number): string {
    return join(this.dirOf(cameraId), `rev-${pad(revision)}.camprof.json`);
  }
}

/** 기기 id 가 경로가 된다 — 구분자와 상위 이동을 허용하면 저장소 밖에 쓰게 된다. */
function safeId(cameraId: string): string {
  const id = String(cameraId).trim();
  if (!id || id === '.' || id === '..' || /[/\\]/.test(id)) {
    throw new ProfileError(`프로파일 기기 id 로 쓸 수 없는 값입니다: ${JSON.stringify(cameraId)}`, 400);
  }
  return id;
}

const pad = (revision: number): string => String(revision).padStart(4, '0');

/** 임시 파일에 쓰고 옮긴다. 중간에 죽어도 **반쪽 문서가 남지 않는다.** */
async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, resolve(path));
}

function gateMessage(failures: GateFailure[]): string {
  return [
    '발행 게이트에 걸렸습니다 — 이 측정은 그대로 쓰면 조준을 악화시킬 수 있습니다.',
    ...failures.map((f) => `· ${f.reason}`),
    '다시 재거나, 사유를 남기고 넘기려면 force:true 로 발행하십시오.',
  ].join('\n');
}
