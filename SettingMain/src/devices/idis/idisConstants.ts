/**
 * IDIS WebAPI v2.20 의 사실 대장.
 *
 * 표기 규약: `[매뉴얼 §N]` = IDIS Web API Protocol v2.20 원문 · `[실측]` = 실기 측정
 * (기기·일자 표기) · `[미확인]` = 근거 없음. **매뉴얼과 실측이 충돌하면 실측이 이긴다.**
 */

/** 모든 액션이 이 CGI 하나에 `action=` 으로 분기한다. `[매뉴얼 §2]` */
export const CGI_PATH = '/cgi-bin/webSetup.cgi';

/**
 * Mode Code `[매뉴얼 §74]`.
 *
 * ⚠ **`MODE.SYSTEM_RESTART`(9000) 과 `RETURN_CODE.UNKNOWN_API`(9000) 는 다른
 * 네임스페이스다.** 숫자가 같다는 이유로 섞으면 "이 액션이 구현돼 있나" 를 물어보려다
 * **카메라를 재부팅시킨다.** 그래서 이름을 갈라 두고, 9000 이라는 숫자 리터럴은 코드
 * 어디에도 직접 적지 않는다.
 *
 * `SYSTEM_RESTART` 는 이 드라이버가 **보내지 않는다** — 위 혼동을 막기 위해 이름만 싣는다.
 */
export const MODE = {
  WRITE: 0,
  READ: 1,
  TEST: 2,
  SECURED_WRITE: 5,
  SECURED_READ: 6,
  SECURED_TEST: 7,
  /** 보내지 않는다. `RETURN_CODE.UNKNOWN_API` 와 갈라 두기 위한 자리다. */
  SYSTEM_RESTART: 9000,
} as const;

/** 이 드라이버가 실제로 부르는 액션. 나머지는 `ACTION_CATALOG` 를 보고 `raw()` 로 부른다. */
export const ACTION = {
  /** `[매뉴얼 §4]` — 프로브 첫 줄의 "정말 이 벤더인가". Method 는 원문이 **POST** 다. */
  MODEL_INFORMATION: 'modelInformation',
  /** `[매뉴얼 §47]` — 기기 자칭 역량. 자칭이라 참고만 한다. */
  PTZ_CAPABILITY: 'ptzCapability',
  /** `[매뉴얼 §48]` — 상대 이동. speed 는 1~16(Hucoms 의 1~100 과 눈금이 다르다). */
  PTZ_COMMAND: 'ptzCommand',
  /** `[매뉴얼 §50]` — 프리셋 set|moveTo|remove. */
  PTZ_PRESET: 'ptzPreset',
  /** `[매뉴얼 §55]` */
  PTZ_STATUS: 'ptzStatus',
  /** `[매뉴얼 §56]` — 절대 PTZ. **속도 파라미터가 없다.** */
  PTZ_ABSOLUTE: 'ptzAbsolute',
  /** `[매뉴얼 §58]` — 픽셀 센터링. **Write 전용이다.** */
  PTZ_MOVE_TO_POINT: 'ptzMoveToPoint',
  /** `[매뉴얼 §59]` — 박스 줌. **Write 전용이다.** */
  PTZ_MOVE_TO_AREA: 'ptzMoveToArea',
  /** `[매뉴얼 §24]` — JPEG 스냅샷(group 5,6). §25 `videoStreamSnapshot` 은 다른 액션이다. */
  VIDEO_SNAPSHOT: 'videoSnapshot',
} as const;

/**
 * 프리셋 명령 표기 `[매뉴얼 §50]`.
 *
 * **조사 기록 — 추출본 8116/8121 행의 `setPreset`/`moveToPreset` 은 매뉴얼의 복붙 오류다.**
 * 그 두 줄은 §51 "PTZ Scan Command" 의 Example 안에 있는데, §51 자신의 파라미터 표는
 * `command=set|remove|run|stop` 을 선언한다 — 즉 **§51 의 예시가 §51 의 표와도 맞지 않는다.**
 * 그 예시는 §50 의 예시와 문장이 거의 같고 `command` 값에만 `Preset` 이 덧붙어 있다.
 * 모델 그룹 차이라는 가설은 원문이 부정한다 — 이 매뉴얼은 적용 제한이 있는 절에 **제목으로**
 * 명시한다(§49 `for model group 1 & 2 only`, §24 `group 5,6`, §67~69 `Fisheye … only`).
 * §50·§51 에는 그런 제한이 없다.
 *
 * 그래서 `set|moveTo|remove` 를 정본으로 쓰고 **폴백을 두지 않는다** — `setPreset` 은 어느
 * 파라미터 표에도 없는 값이라 그것을 받는 펌웨어가 있다는 근거가 하나도 없다(`[미확인]`).
 * 정본 표기는 `[실측 DC-S6261XT]` 로도 확인됐다.
 */
export const PRESET_COMMANDS = ['set', 'moveTo', 'remove'] as const;

/** 프리셋 번호 범위 `[매뉴얼 §50]`. */
export const PRESET_ID_RANGE = { min: 1, max: 256 } as const;

/** 상대 이동 명령 22개 전부 `[매뉴얼 §48]`. 목록 밖 명령은 보내지 않는다. */
export const MOVE_COMMANDS = [
  'zoomIn', 'zoomOut', 'zoomStop',
  'focusFar', 'focusNear', 'focusStop', 'focusOnepush',
  'irisOpen', 'irisClose', 'irisStop', 'setIris',
  'moveToN', 'moveToNE', 'moveToE', 'moveToSE',
  'moveToS', 'moveToSW', 'moveToW', 'moveToNW',
  'stop', 'lensReset', 'wiperOn',
] as const;

export type MoveCommand = (typeof MOVE_COMMANDS)[number];

/** 상대 이동 속도 `[매뉴얼 §48]`. **Hucoms 의 1~100 과 눈금이 다르다.** */
export const MOVE_SPEED_RANGE = { min: 1, max: 16 } as const;

/**
 * 와이어 범위. **선언 범위와 실측 도달 범위를 따로 담는다.**
 *
 * 기기는 범위 밖 값에 `returnCode=0`(성공)으로 답하면서 **조용히 다른 데로 간다** `[실측]`:
 *   `absTilt=12000`  → 9000 에서 클램프
 *   `absTilt=−3000`  → **오토플립** — 팬을 180° 돌려 `pan=18000, tilt=3000` 으로 해결한다
 *   `absZoom=3000`   → 1200 (이 렌즈의 상한)
 *   `absPan=−18000`  → 18000 (원이라 같은 방향)
 * 그래서 **보내기 전에** 자른다. 오토플립이 특히 위험하다 — 성공 응답을 받고 정반대를 본다.
 */
export const WIRE_RANGE = {
  /** 매뉴얼이 선언한 범위 `[매뉴얼 §56]`. 줌 상한은 `<Max zoom scale>` 이라 숫자가 없다. */
  declared: {
    pan: { min: -18000, max: 18000 },
    tilt: { min: -9000, max: 9000 },
    zoom: { min: 100, max: null },
  },
  /**
   * 실측 도달 범위 `[실측 DC-S6261XT 2026-07-29]`. **클램프는 이쪽을 쓴다.**
   * tilt 하한이 0 인 것이 매뉴얼(−9000)과 다르다 — 음수를 보내면 오토플립이 발동한다.
   * zoom 상한 1200 은 이 모델의 광학 x12 이고 **모델마다 다르다**(실기 확보 시 재확인).
   */
  measured: {
    pan: { min: -18000, max: 18000 },
    tilt: { min: 0, max: 9000 },
    zoom: { min: 100, max: 1200 },
  },
} as const;

/** 센터링 좌표 단위 `[매뉴얼 §58]` — 0~100000 = 0.0~1.0(단위 0.00001). */
export const POINT_SCALE = 100_000;

/** 계약 프레임 `[본체 cameraDriver.ts CenterPoint]` — 1920×1080 절대 픽셀. */
export const CONTRACT_FRAME = { width: 1920, height: 1080 } as const;

/**
 * Return Code `[매뉴얼 §75]` 중 **분류에 쓰는 것**만 이름을 붙인다.
 * 전표 전문은 아래 `RETURN_CODE_DESCRIPTIONS` 에 있다.
 */
export const RETURN_CODE = {
  SUCCESS: 0,
  /** 범위 밖 파라미터. **기기가 액션을 알아들었다는 뜻**이므로 프로브에서는 '있음'이다. */
  INVALID_PARAMETER: 301,
  /** 읽기 전용에 쓰기를 시도했거나 쓴 값이 원본과 다르다. */
  READ_ONLY_OR_MISMATCH: 302,
  /** 필수 파라미터 부족. 301 과 같은 이유로 프로브에서는 '있음'이다. */
  NOT_ENOUGH_PARAMETERS: 304,
  NOT_HAS_PERMISSION: 306,
  NOT_FOUND_SESSION_INFO: 307,
  NOT_SUPPORT_CMD_THIS_VERSION: 308,
  FUNCTION_NOT_SUPPORTED: 310,
  PASSWORD_AUTHENTICATION_FAILED: 900,
  PASSWORD_POLICY_VIOLATION: 901,
  NO_MATCHING_USER: 903,
  /**
   * **Unknown API** `[매뉴얼 §75]`. 실측기의 rc=9000 응답은 펌웨어가 정직하게 "그런 API
   * 없다"고 답한 것이다 `[실측 DC-S6261XT]`. ⚠ `MODE.SYSTEM_RESTART` 와 **다른 축**이다.
   */
  UNKNOWN_API: 9000,
} as const;

/** §75 전표 전문 `[매뉴얼 §75]`. 오류 문구에 사람이 읽을 사유를 붙이는 데 쓴다. */
export const RETURN_CODE_DESCRIPTIONS: Readonly<Record<number, string>> = Object.freeze({
  0: 'Success',
  100: 'File does not exist.',
  101: 'Firmware upgrade fail',
  102: 'Failed to create the system data',
  107: 'Failed to send email',
  108: 'System wizard failed',
  109: 'Network wizard failed',
  110: 'DDNS failed',
  111: 'camera name already exist in DDNS server',
  200: 'Failed to mount SD card',
  201: 'Failed to unmount SD card',
  202: 'Failed to format SD card',
  203: 'Failed to check SD card',
  204: 'Failed to mount SD card (already mounted)',
  205: 'Failed to format SD card (unmounted SD Card)',
  301: 'Invalid parameter(s) (out of the range of valid values)',
  302: 'Either attempting to write a read-only data or written data is different from the original data.',
  303: 'Over the camera compression capability. Reduce the resolution or frame rates.',
  304: 'Not enough parameters (need the mandatory parameters)',
  305: 'INVALID_SETUP_FILE',
  306: 'NOT_HAS_PERMISSION',
  307: 'NOT_FOUND_SESSION_INFO',
  308: 'NOT_SUPPORT_CMD_THIS_VERSION',
  309: 'DATA_DECRYPT_FAILED',
  310: 'FUNCTION_NOT_SUPPORTED',
  400: 'UPNP NAT not exist',
  401: 'UPNP error',
  402: 'UPNP invalid port range',
  500: 'FTP upload test failed',
  600: 'SMTP_TEST_FAIL_UNKNOWN',
  601: 'SMTP_TEST_FAIL_INVALID_DNS',
  602: 'SMTP_TEST_FAIL_TO_CONNECT_SMTP',
  603: 'SMTP_TEST_FAIL_TO_CONNECT_SSL',
  604: 'SMTP_TEST_FAIL_NO_SUCH_USER',
  605: 'SMTP_TEST_FAIL_TO_AUTHENTICATE',
  606: 'SMTP_TEST_FAIL_NEED_TLS',
  607: 'SMTP_TEST_FAIL_TO_SEND_MESSAGE',
  608: 'SMTP_TEST_FAIL_TO_SEND_CMD_FROM',
  609: 'SMTP_TEST_FAIL_TO_SEND_CMD_RCPT',
  610: 'SMTP_TEST_FAIL_TO_CMD_DATA',
  611: 'SMTP_TEST_FAIL_TO_CMD_DATA_END',
  612: 'SMTP_TEST_FAIL_TO_CMD_QUIT',
  900: 'Password authentication failed (wrong password)',
  901: 'Password policy violation',
  902: 'Exceed the maximum number of element',
  903: 'No matching user found',
  904: 'There is already same element',
  9000: 'Unknown API',
  9999: 'Unknown error',
});

/**
 * 매뉴얼 목차 §0~§79 의 절 이름 `[매뉴얼 목차]`. **인덱스가 절 번호다.**
 *
 * 감싸지 않고 이름만 싣는다 — 쓰지 않을 액션까지 래퍼를 만들면 거대 SDK 가 되지만, 목록조차
 * 없으면 다음 사람이 매뉴얼을 처음부터 다시 읽는다. 여기 있는 절은 `IdisCameraClient.raw()`
 * 로 래퍼 없이 부를 수 있다.
 */
export const ACTION_CATALOG: readonly string[] = Object.freeze([
  'Introductions',
  'How to Read',
  'System Information',
  'Date/Time',
  'System Management',
  'User Management',
  'Group Management',
  'Network – IP Address',
  'Network – IPv6 Address',
  'Network – DDNS',
  'Network – Port',
  'Network – Bandwidth',
  'Network – Security',
  'Network – IEEE 802.1X',
  'Network – SIP',
  'Video – Easy Video Setting(Self adjust video mode)',
  'Video – Image',
  'Video – White Balance',
  'Video – Exposure',
  'Video – Day&Night',
  'Video – Miscellaneous',
  'Video – Streaming (except model group 4)',
  'Video – MAT',
  'Video – Privacy Mask',
  'Video – Snapshot (group 5,6)',
  'Video stream snapshot',
  'Video – OSD Text',
  'Video – OSD DateTime',
  'Http MJPEG streaming',
  'Audio',
  'Event Action – Alarm out',
  'Event Action – Email',
  'Event Action – Remote Callback',
  'Event Action – Audio Alarm',
  'Event Action – FTP',
  'Event Action – SD Recording',
  'Event – Alarm In',
  'Event – PIR Detection',
  'Event – Motion Detection',
  'Event – Trip Zone',
  'Event – Audio Detection',
  'Event – Tampering',
  'Event – Auto Tracking',
  'Event – Face Detection',
  'Event – System Event',
  'Lens Reset (for MFZ lens)',
  'Pan/Tilt Driver',
  'PTZ Capability',
  'PTZ Command',
  'PTZ Command – TCP ( for model group 1 & model group 2 only )',
  'PTZ Preset Command',
  'PTZ Scan Command',
  'PTZ Pattern Command',
  'PTZ Tour Command',
  'PTZ miscellaneous',
  'PTZ Status',
  'PTZ Absolute Move',
  'PTZ Absolute Move Ex (Focus Position Extended)',
  'PTZ Move to Point',
  'PTZ Move to Area',
  'Lens List',
  'Lens Driver',
  'System Status',
  'Event Notification',
  'Event Log',
  'System Log',
  'Debug Log',
  'Fisheye ( for model group 4 only )',
  'Fisheye ( for model group 6 only )',
  'Fisheye Command ( for model group 4 & 6 only )',
  'Preparing File Upload',
  'File Upload',
  'Motion Block Information',
  'Schedule Information',
  'Mode Code',
  'Return Code',
  'Time Zone',
  'Pan/Tilt Driver model name',
  'Strong Password',
  'TCP Event Type',
]);
