import { api, reportError, toast } from './api.js';

/**
 * 캘리브레이션 화면.
 *
 * 이 화면이 지키는 것 셋:
 *   ① **시작 전에 대가를 말한다** — 20분 점유는 확인 없이 시작할 일이 아니다.
 *   ② **게이트 미달에 화면 안의 탈출구가 있다** — 우회로를 API 에만 두면 그것은 우회로가 아니다.
 *      (상류에서 20분짜리 실측이 막다른 길에 선 적이 있다. 2026-08-05)
 *   ③ **잔차의 뜻을 함께 적는다** — full 의 잔차는 "이 카메라가 가진 오차"이고
 *      verify 의 잔차는 "보정 후 살아남은 오차"다. 같은 숫자가 정반대 뜻이다.
 */

const el = (id) => document.getElementById(id);
let cameraId = '';
let timer = null;

async function loadCameras() {
  const { cameras, activeCameraId } = await api.cameras();
  el('cameraSelect').innerHTML = cameras.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
  cameraId = activeCameraId || cameras[0]?.id || '';
  el('cameraSelect').value = cameraId;
}

async function loadCapability() {
  const caps = await api.coreCapabilities(cameraId);
  const state = caps.supported.calibration;
  el('capability').textContent = state.ok ? '가능' : '불가';
  el('capability').className = `tag ${state.ok ? 'ok' : 'warn'}`;
  // 못 하는 이유를 **그대로** 보여준다. "불가"만 있으면 운영자가 손쓸 수 없다.
  el('cameraNote').textContent = state.ok
    ? `코어 구현: ${caps.provider}. 스윕은 이 카메라의 줌→화각 곡선과 센터링 게인을 만듭니다.`
    : state.reason;
  el('start').disabled = !state.ok;
}

function renderSamples(recent = []) {
  el('samples').querySelector('tbody').innerHTML = recent.map((s) => `<tr class="${s.usable ? '' : 'bad'}">
    <td>${s.zoom}</td><td>${s.dx}</td><td>${s.dy}</td>
    <td>${fmt(s.residualX)}</td><td>${fmt(s.residualY)}</td>
    <td>${fmt(s.peak)}</td><td>${fmt(s.margin)}</td>
    <td>${s.usable ? '쓸 수 있음' : `기각 (${reasonText(s.reason)})`}</td>
  </tr>`).join('');
}

/** 기각 사유마다 **처방이 다르다** — 하나는 아침에 다시 오면 되고 하나는 카메라를 돌려야 한다. */
function reasonText(reason) {
  return {
    dark: '너무 어두움 — 밝을 때 다시',
    smooth: '위치 특정 불가 — 미세 디테일 없음',
    featureless: '무늬 없음 — 차량·주차선 쪽으로',
    error: '매칭 실패',
  }[reason] ?? (reason ?? '-');
}

const fmt = (v) => (typeof v === 'number' ? v.toFixed(v >= 10 ? 1 : 3) : '-');

function renderResult(status) {
  const result = status.result;
  const box = el('result');
  if (!result) {
    box.innerHTML = '<p class="hint">아직 결과가 없습니다.</p>';
    el('mint').disabled = true;
    return;
  }

  if (result.mode === 'verify') {
    const verdictText = {
      pass: '통과 — 설치된 보정이 이 카메라에 맞습니다',
      fail: '미달 — 보정 후에도 오차가 남습니다',
      // **장면이 답하지 못한 줌은 통과가 아니다.** 통과라고 부르는 것이 이 기능이 낼 수 있는
      // 최악의 결과다 — 그 줌에서 쓸 수 있는 프레임을 한 장도 못 봤는데 "멀쩡하다"고 듣는다.
      incomplete: '미완 — 일부 줌에서 화면을 읽지 못했습니다 (통과가 아닙니다)',
      unknown: '판정 불가',
    }[result.verdict];
    box.innerHTML = `
      <p><strong>${verdictText}</strong>${result.worstPx === null ? '' : ` · 최악 잔차 ${result.worstPx}px`}</p>
      <p class="hint">이 패스의 잔차는 <strong>보정을 통과한 뒤 살아남은</strong> 오차입니다.</p>
      <table class="grid"><thead><tr><th>zoom</th><th>남은 잔차</th><th>적용된 게인</th><th>필요한 게인</th></tr></thead><tbody>
        ${result.checks.map((c) => `<tr><td>${c.zoom}</td><td>${c.residualPx}px</td><td>${c.gainApplied}</td><td>${c.gainNeeded ?? '-'}</td></tr>`).join('')}
      </tbody></table>
      ${result.unmeasured.length ? `<p class="warn">측정 못 한 줌: ${result.hint}</p>` : ''}`;
    el('mint').disabled = true;   // verify 는 발행하지 않는다 — 새 곡선을 만들지 않았다
    return;
  }

  box.innerHTML = `
    <p><strong>보정 전</strong> 조준 오차 ${result.residual.beforePx}px · 앵커 ${result.residual.anchors}개 ·
       쓸 수 있는 표본 ${result.usable}/${result.of}</p>
    <p class="hint">
      이 값은 <strong>보정 전</strong> 오차입니다 — 보정 후 남는 오차가 아닙니다.
      그것은 verify 패스만 말할 수 있습니다.
      초점 적합 중앙값 ${result.residual.fitRmsMedianPx}px (최댓값 ${result.residual.fitRmsPx}px).
    </p>
    <table class="grid"><thead><tr><th>zoom</th><th>화각(도)</th><th>게인</th></tr></thead><tbody>
      ${result.zoomHfov.map((p, i) => `<tr><td>${p.z}</td><td>${p.h}</td><td>${result.centeringGain[i]?.k ?? '-'}</td></tr>`).join('')}
    </tbody></table>
    ${result.skipped.length ? `<p class="warn">건너뛴 줌: ${result.skipped.map((s) => `${s.zoom} (${s.why})`).join(' · ')}</p>` : ''}`;
  el('mint').disabled = status.state !== 'done';
}

async function poll() {
  try {
    const status = await api.calibrationStatus(cameraId);
    el('state').textContent = status.state;
    el('state').className = `badge ${status.state}`;
    el('message').textContent = status.message ?? '';
    el('progress').value = status.progress?.percent ?? 0;
    el('progressText').textContent = status.progress ? `${status.progress.done}/${status.progress.total}` : '-';
    renderSamples(status.recent);
    renderResult(status);

    const running = status.state === 'running';
    el('start').disabled = running;
    el('stop').disabled = !running;
    if (!running && timer) { clearInterval(timer); timer = null; }
  } catch (error) {
    reportError(error);
    if (timer) { clearInterval(timer); timer = null; }
  }
}

async function start() {
  const mode = el('mode').value;
  if (mode === 'full' && !confirm(
    '이 카메라를 20분가량 점유하고 고배율로 돌립니다.\n그 동안 이 카메라는 자기 자리를 보지 않습니다.\n\n시작할까요?',
  )) return;
  try {
    await api.calibrationStart(cameraId, mode);
    toast('스윕을 시작했습니다', 'ok');
    if (!timer) timer = setInterval(poll, 2000);
    await poll();
  } catch (error) {
    reportError(error);
  }
}

async function mint(force = false) {
  try {
    const result = await api.calibrationMint(cameraId, { apply: el('apply').checked, force });
    el('gate').hidden = true;
    toast(`rev-${result.profile.revision} 발행${result.applied ? ' · 런타임 적용됨' : ' (런타임은 아직 옛 값)'}`, 'ok');
    await loadProfile();
  } catch (error) {
    // ★ 게이트 미달은 막다른 길이 아니다 — 사유와 함께 화면 안에 탈출구를 낸다.
    if (String(error.message).includes('발행 게이트')) {
      el('gate').hidden = false;
      el('gate').innerHTML = `<p class="warn">${escape(error.message).replace(/\n/g, '<br>')}</p>`;
      const button = document.createElement('button');
      button.className = 'danger';
      button.textContent = '그래도 발행 (사유가 문서에 기록됩니다)';
      button.onclick = () => mint(true);
      el('gate').append(button);
      return;
    }
    reportError(error);
  }
}

async function loadProfile() {
  try {
    const data = await api.profile(cameraId);
    el('revisions').innerHTML = data.revisions.map((r) => `<option value="${r}">rev-${String(r).padStart(4, '0')}</option>`).join('')
      || '<option value="">없음</option>';
    if (data.latest) el('revisions').value = String(data.latest);
    // 일치하거나 발행본이 없으면 조용하다 — 늘 떠 있는 경고는 아무도 읽지 않는다.
    el('drift').innerHTML = data.drift ? `<p class="warn">${escape(data.drift.message)}</p>` : '';
    el('profile').textContent = data.published ? JSON.stringify(data.published.optics, null, 2) : '발행된 프로파일이 없습니다.';
  } catch (error) {
    reportError(error);
  }
}

const escape = (text) => String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function selectCamera() {
  cameraId = el('cameraSelect').value;
  if (timer) { clearInterval(timer); timer = null; }
  await Promise.all([loadCapability(), poll(), loadProfile()]);
}

el('cameraSelect').addEventListener('change', () => selectCamera().catch(reportError));
el('start').addEventListener('click', start);
el('stop').addEventListener('click', () => api.calibrationStop(cameraId).then(poll).catch(reportError));
el('mint').addEventListener('click', () => mint(false));
el('applyRevision').addEventListener('click', () => {
  const revision = Number(el('revisions').value);
  if (!revision) return;
  api.profileApply(cameraId, revision).then(() => { toast(`rev-${revision} 을 적용했습니다`, 'ok'); return loadProfile(); }).catch(reportError);
});

loadCameras().then(selectCamera).catch(reportError);
