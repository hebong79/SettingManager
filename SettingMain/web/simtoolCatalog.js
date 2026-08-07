/**
 * 차량 타입·색상 열거형 — **마스터가 제공한 정본**(2026-08-07).
 *
 * ## 차량 프리팹 목록은 여기 없다
 *
 * 그쪽 정본은 `SettingMain/config/car_catalog.json` 이고 서버가 `/api/sim/car-catalog` 로
 * 읽어 준다. **배열 순서가 곧 `prefabId`(1부터)** 이므로 화면에 복사해 두면 파일을 고쳤을 때
 * 한쪽만 바뀌고, 그러면 저장된 `CarPos_*.json` 이 다른 차종으로 해석된다.
 *
 * 열거형 둘은 파일이 아니라 언리얼 C++ 소스에 있는 값이라 여기 둔다 — 서버가 읽을 파일이 없다.
 */

/**
 * `ECarType`. **`None = 0` 이 있다** — 0 을 "소형"으로 읽으면 한 칸씩 밀린다.
 * 주석의 치수는 마스터 제공 원문 그대로다.
 */
export const CAR_TYPES = [
  { id: 0, name: 'None', note: '미지정' },
  { id: 1, name: '소형', note: '폭 1.595 · 길이 3.595 · 높이 1.485 (모닝)' },
  { id: 2, name: '중형', note: '폭 1.835 · 길이 4.82 · 높이 1.470 (소나타·K5·K3·아반떼)' },
  { id: 3, name: '대형', note: '폭 1.905 · 길이 5.05 · 높이 1.465 (그랜저·제네시스)' },
  { id: 4, name: 'SUV', note: '폭 1.90 · 길이 4.91 · 높이 1.74 (쏘렌토·산타페·투싼)' },
  { id: 5, name: '승합/봉고', note: '폭 1.985 · 길이 5.115 · 높이 1.74 (카니발·펠리세이드·스타렉스)' },
  { id: 6, name: '트럭(탑차)', note: '폭 1.80 · 길이 5.05 · 높이 2.305 (르노마스터 밴·우편트럭)' },
  { id: 7, name: '버스', note: '폭 2.5 · 길이 11.99 · 높이 3.75 (시내·고속버스)' },
];

/** `ECarColor` — 인덱스가 곧 값이다. */
export const CAR_COLORS = [
  'White', 'Black', 'Silver', 'Gray', 'Red', 'Blue', 'Green', 'Yellow', 'Orange', 'Purple',
];

/** `prefabId` → 표시 이름. **모르는 번호는 지어내지 않고 숫자를 그대로** 보여 준다. */
export function prefabName(cars, id) {
  return cars?.find((entry) => entry.prefabId === Number(id))?.name ?? `#${id ?? '-'}`;
}
