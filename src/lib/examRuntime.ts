/** 10:00 / 5:00 警告：过线后常驻变红，仅在刚跨过阈值的窗口内闪。 */
export const TIMER_FLASH_MS = 15_000;

export function timerWarningState(
  ms: number,
  warningsMs: number[],
  flashWindowMs = TIMER_FLASH_MS,
): { warn: boolean; flash: boolean } {
  const warn = warningsMs.some((w) => ms <= w);
  const flash = warn && warningsMs.some((w) => ms <= w && ms > w - flashWindowMs);
  return { warn, flash };
}

/** 模考听力：自然播放推进锁，快进/快退超过容差则拉回。 */
export function clampPlaybackTime(
  currentSec: number,
  lockSec: number,
  seekAllowed: boolean,
  rewindSlack = 0.4,
  // Forward slack must absorb main-thread stalls — timeupdate arriving late
  // reads an advanced currentTime that is not a seek. 1s keeps real seek
  // jumps (typically many seconds) snapping while sparing audible glitches.
  forwardSlack = 1.0,
): { time: number; lock: number; snapped: boolean } {
  if (seekAllowed) return { time: currentSec, lock: currentSec, snapped: false };
  if (currentSec + rewindSlack < lockSec || currentSec > lockSec + forwardSlack) {
    return { time: lockSec, lock: lockSec, snapped: true };
  }
  return { time: currentSec, lock: Math.max(lockSec, currentSec), snapped: false };
}
