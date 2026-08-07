const el = (id) => document.getElementById(id);
const num = (id) => Number(el(id).value);
const fmt = (v, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '-');

/**
 * 거리 측정툴 — 카메라와 타겟점 사이의 거리·각도.
 *
 * ## 기하 계산은 전부 시뮬레이터가 한다
 *
 * 여기서 다시 계산하면 두 벌이 되고, 언리얼이 짐벌·바닥 판정을 바꾸는 순간 갈린다.
 * 웹은 좌표를 보내고 숫자를 받아 적을 뿐이다.
 *
 * ## `setTargetPoint` 선행이 계약이다
 *
 * 안 하고 부르면 시뮬레이터가 `-32000 타겟점 미설정 — measure.setTargetPoint 를 먼저
 * 호출하세요.` 로 거절한다(실측). 그 한글 사유를 다시 쓰지 않고 그대로 띄운다 —
 * 우리가 지어낸 문장보다 정확하다.
 */
export function createMeasurePanel(ctx) {
  let targetSet = false;

  function setTag(text, kind = '') {
    el('mTag').textContent = text;
    el('mTag').className = `tag ${kind}`;
  }

  function clearResults() {
    for (const id of ['mHorizontal', 'mDistance3d', 'mHeight', 'mVertical', 'mHorizontalAngle']) {
      el(id).textContent = '-';
    }
  }

  async function setTarget() {
    // 언리얼은 Z-up 이다 — 화면 라벨(X·Y·Z(높이))과 같은 축으로 보낸다.
    await ctx.rpc('measure.setTargetPoint', { pos: { x: num('mTx'), y: num('mTy'), z: num('mTz') } });
    targetSet = true;
    setTag('타겟 설치됨', 'ok');
    clearResults();
    ctx.toast('타겟점을 설치했습니다', 'ok');
  }

  async function measure() {
    const camId = Number(el('mCamId').value);
    if (!camId) throw new Error('카메라를 선택하세요');

    // 카메라 높이는 **타겟점과 무관**하다(바닥 레이캐스트) — 타겟이 없어도 답한다.
    // 그래서 따로 부르고, 실패해도 나머지를 막지 않는다.
    const height = await ctx.rpc('measure.cameraHeight', { camId }).catch(() => null);
    el('mHeight').textContent = fmt(height?.height);

    const [distance, angles] = await Promise.all([
      ctx.rpc('measure.distance', { camId }),
      ctx.rpc('measure.angles', { camId }),
    ]);
    el('mHorizontal').textContent = fmt(distance.horizontal);
    el('mDistance3d').textContent = fmt(distance.distance3d);
    // 수직각은 양수가 내려다봄(↓)이다. 부호만 보고 방향을 잘못 읽지 않게 화살표를 붙인다.
    el('mVertical').textContent = typeof angles.vertical === 'number'
      ? `${angles.vertical >= 0 ? '↓' : '↑'} ${fmt(Math.abs(angles.vertical), 1)}`
      : '-';
    el('mHorizontalAngle').textContent = typeof angles.horizontal === 'number'
      ? `${angles.horizontal >= 0 ? '+' : '−'}${fmt(Math.abs(angles.horizontal), 1)}`
      : '-';
    setTag('측정 완료', 'ok');
  }

  async function targetLine() {
    const result = await ctx.rpc('measure.targetLine', {
      start: { x: num('mSx'), z: num('mSz') },
      end: { x: num('mEx'), z: num('mEz') },
    });
    el('mLineOut').textContent =
      `수선의 발(0°) 기준 — 시작 ${fmt(result.angleStart, 1)}° · 끝 ${fmt(result.angleEnd, 1)}°`;
  }

  const guard = (fn) => () => void fn().catch((error) => {
    // 시뮬레이터가 준 사유를 그대로 화면에 싣는다.
    setTag('실패', 'warn');
    ctx.reportError(error);
  });

  el('mSetTarget').addEventListener('click', guard(setTarget));
  el('mMeasure').addEventListener('click', guard(measure));
  el('mTargetLine').addEventListener('click', guard(targetLine));

  return {
    onActivate() {
      setTag(targetSet ? '타겟 설치됨' : '대기', targetSet ? 'ok' : '');
    },
    onCameras() {
      // 카메라 목록은 껍데기가 채운다. 타겟은 시뮬레이터 전역이라 여기서 지우지 않는다.
    },
  };
}
