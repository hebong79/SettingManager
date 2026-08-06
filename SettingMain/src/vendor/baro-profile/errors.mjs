// 카메라 도메인 공용 에러. 정의가 여기(@baro/profile — 의존성 0)에 있는 이유:
// fov-convert 같은 계산 함수도 입력 검증에 이 타입을 던지는데, 정의가 I/O 쪽
// (cctv-client/hucoms-camera-client)에 있으면 의존 방향이 역전된다(의존성 0 패키지가
// I/O 를 역수입). 클래스는 여기 한 곳에만 두고
// cctv-client 가 재수출한다 — instanceof 판정(server 의 502 매핑, CLI 의 에러 출력)이
// 어느 경로로 import 해도 같은 정체성을 보게 하기 위해서다.
export class HucomsCameraError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HucomsCameraError";
    this.details = details;
  }
}
