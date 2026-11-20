// Hand-drawn animation beat: "on twos" means one drawing is held for 2 frames,
// "on threes" for 3. Sampling must fold continuous time onto the start frame of
// the current hold before poses are read; recomputing poses every frame at 24fps
// is sub-frame crawl — visible jitter, exactly the kind of "liveliness" hand-drawn
// animation least wants. fps defaults to 24: the desktop's audio clock and the
// capture clock both run at 24fps, so quantized time stays in step with the beat.

const DEFAULT_FPS = 24;

function quantizeToHold(t, fps, hold) {
  // A non-positive fps turns frame into NaN and poisons the whole timeline;
  // converge to the default instead of letting NaN reach a shader uniform.
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  const frame = Math.floor(t * safeFps);
  return Math.floor(frame / hold) * hold / safeFps;
}

/** Quantize to "on twos": returns the time this drawing should hold from (seconds). */
export function quantizeOnTwos(t, fps = DEFAULT_FPS) {
  return quantizeToHold(t, fps, 2);
}

/** Quantize to "on threes": returns the time this drawing should hold from (seconds). */
export function quantizeOnThrees(t, fps = DEFAULT_FPS) {
  return quantizeToHold(t, fps, 3);
}
