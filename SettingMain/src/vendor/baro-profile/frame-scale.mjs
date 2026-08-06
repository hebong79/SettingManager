import { HucomsCameraError } from "./errors.mjs";

export const HUCOMS_FRAME = { width: 1920, height: 1080 };

export function scalePointToHucomsFrame({
  x,
  y,
  frameWidth = HUCOMS_FRAME.width,
  frameHeight = HUCOMS_FRAME.height,
} = {}) {
  assertFinite("x", x);
  assertFinite("y", y);
  assertPositiveInteger("frameWidth", frameWidth);
  assertPositiveInteger("frameHeight", frameHeight);

  if (x < 0 || x > frameWidth) {
    throw new HucomsCameraError(`x must be within 0..${frameWidth}.`, { x, frameWidth });
  }
  if (y < 0 || y > frameHeight) {
    throw new HucomsCameraError(`y must be within 0..${frameHeight}.`, { y, frameHeight });
  }

  return {
    x: Math.round((x / frameWidth) * HUCOMS_FRAME.width),
    y: Math.round((y / frameHeight) * HUCOMS_FRAME.height),
  };
}

function assertFinite(name, value) {
  if (!Number.isFinite(value)) {
    throw new HucomsCameraError(`${name} must be a finite number.`, { [name]: value });
  }
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HucomsCameraError(`${name} must be a positive integer.`, { [name]: value });
  }
}
