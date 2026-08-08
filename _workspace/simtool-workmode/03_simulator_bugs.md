# 03 — 검증 중 발견한 **언리얼 시뮬레이터 버그 3건** (`preset.*`)

2026-08-08 20:40 · 라이브 실측 `192.168.0.125:13510` · 웹에서 못 고치는 것들

작업모드 검증(지시 3)을 하다가 나왔다. **셋 다 `preset.*` 이고 셋 다 조용하다** —
오류를 주지 않아서 부른 쪽은 성공한 줄 안다.

---

## B1. `preset.move {delta}` 가 성공을 주고 아무것도 안 한다

```
요청  preset.move {idx:1, delta:{x:0, y:5}}
응답  {ok:true, idx:1, x:-16.20220375061035, y:17.792741775512695, z:0}
이후  preset.get {idx:1} → offsetPos {x:-16.20220375061035, y:17.792741775512695, z:0}   ← 그대로
```

같은 프리셋에 `to` 로 보내면 정상이다.

```
요청  preset.move {idx:1, to:{x:-16.2, y:25.0}}
응답  {ok:true, idx:1, x:-16.2, y:25, z:0}
이후  preset.get → {x:-16.2, y:25, z:0}   ← 반영됨
```

**왜 나쁜가**: 응답이 `ok:true` 라 **호출한 쪽이 실패를 감지할 방법이 없다.** 오류로 뜨지
않고 그냥 안 움직인다. 이 저장소의 **방향 패드(◀▶▲▼)가 처음부터 이것에 걸려 있었다** —
프리셋 이동 버튼이 눌러도 아무 일이 없었다(회전은 `preset.rotate` 라 정상).

**웹 대응**: `preset.get` 으로 지금 자리를 읽어 `to` 로 보내도록 우회했다
(`simtoolPreset.js` 의 `movePreset`). 키보드와 방향 패드가 같은 자리를 쓴다.

**언리얼이 해야 할 것**: `delta` 를 구현하거나, 못 할 것이면 **에러를 반환**할 것.
성공을 주면서 아무것도 안 하는 것이 가장 나쁘다.

---

## B2. `preset.create` 가 **전부 idx 1** 로 만든다 ⚠ 지시 3 을 막고 있다

파일(6건)을 「시뮬로 보내기」 한 결과:

```
preset.list → 6건, 그런데 전부 "idx": 1
preset.get {idx:1} → OK
preset.get {idx:2} … {idx:7} → -32000 "프리셋 없음: idx=N"
```

화면의 보내기 보고도 그것을 그대로 비췄다: `번호 변경 5건: 2→1, 3→1, 4→1, 5→1, 7→1`
(`preset.create` 가 매번 `idx:1` 을 돌려준다).

**왜 나쁜가**: `preset.move`·`preset.rotate`·`preset.select`·`preset.delete` 가 전부 `idx`
로 대상을 지목한다. idx 가 유일하지 않으면 **첫 번째 말고는 지목할 수 없다.**

**결과**: 마스터 지시 3(Ctrl+클릭으로 프리셋 이동)은 지금 **프리셋 1개에서만** 된다.
6건을 넣어도 2번째 이후는 손댈 수 없다. **웹에서 우회할 방법이 없다** — 서버가 준 idx 가
전부 같으면 어느 것을 고르든 같은 것을 지목한다.

**언리얼이 해야 할 것**: `preset.create` 가 **고유한 idx** 를 매기고 그것을 반환할 것.

---

## B3. `preset.create` 가 `presetName` 을 무시한다

```
보낸 이름   Preset 1, Preset 2, Preset 3, Preset 4, Preset 5, Preset 6
저장된 이름 Preset 6, Preset 1, Preset 1, Preset 1, Preset 1, Preset 1
```

`faceCount`·`offset`·`xSize`·`zSize` 는 **정확히 반영된다**(실측 대조 완료) — 이름만 버린다.

**왜 나쁜가**: B2 로 idx 도 같은데 이름까지 같으면 목록에서 **구별할 단서가 없다.**

**언리얼이 해야 할 것**: 받은 `presetName` 을 그대로 쓸 것.

---

## 확인된 것 (정상 동작)

| 항목 | 결과 |
|---|---|
| `preset.move {to}` | ✅ 정확 — 클릭 지점 (−16.202, 17.793) ↔ 실측 (−16.20220, 17.79274) |
| `preset.rotate {deltaGroupRot}` | ✅ groupRot 0 → 0.5 |
| `preset.select {idx}` | ✅ `{ok:true, idx}` |
| `preset.create` 의 좌표·면수·크기 | ✅ 파일 값과 정확히 일치 |
| `cam.setPosition` | ✅ **폴대를 함께 옮긴다** (카메라와 x 0.02m · y 0.05m 이내) |
| `car.setPosition` · `car.setRotationY` | ✅ 정확 |
