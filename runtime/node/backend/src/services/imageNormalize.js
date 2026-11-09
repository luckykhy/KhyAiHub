'use strict';

/**
 * Vision image normalization — cap the long edge of image bytes before they are
 * base64-encoded or written into an upload manifest.
 *
 * Why: pasted screenshots routinely arrive at 3000–6000 px wide. Two separate
 * ceilings then bite:
 *   - provider-side visual token budgets are driven by pixel area, so an
 *     un-scaled screenshot can be rejected outright;
 *   - the base64 payload is ~1.37× the bytes, which inflates IPC / HTTP bodies
 *     and chat JSON by the same factor.
 *
 * This leaf reuses the platform resize dispatch that already ships with the
 * GLM vision downscaler (System.Drawing / sips / ImageMagick / ffmpeg /
 * Python+Pillow) — no new dependency. Output is always PNG.
 *
 * Design rules:
 *   - fail-soft: any missing tool / unparseable header → null (caller keeps the
 *     original bytes). Never throws.
 *   - multi-frame images (GIF / animated WebP) are passed through untouched:
 *     re-encoding a single frame would drop the animation.
 *   - only images whose long edge exceeds the cap are touched; everything else
 *     is returned as null so no needless recompression happens.
 *
 * Gates:
 *   KHY_VISION_IMAGE_NORMALIZE  default on; 0/false/off/no → off
 *   KHY_VISION_IMAGE_MAX_EDGE   default 1568, clamped to 512..4096
 */

const DEFAULT_MAX_EDGE = 1568;
const MIN_MAX_EDGE = 512;
const MAX_MAX_EDGE = 4096;

function _flagEnabled(raw, fallback) {
  if (raw == null || String(raw).trim() === '') {
    return fallback;
  }
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function normalizeEnabled(env = process.env) {
  return _flagEnabled(env && env.KHY_VISION_IMAGE_NORMALIZE, true);
}

/**
 * Long-edge cap for normalized images. Values outside 512..4096 are clamped so
 * a typo can neither disable the mechanism nor produce a 1 px wide image.
 * @param {object} [env]
 * @returns {number}
 */
function getMaxEdge(env = process.env) {
  const raw = parseInt((env && env.KHY_VISION_IMAGE_MAX_EDGE) || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MAX_EDGE;
  }
  return Math.min(MAX_MAX_EDGE, Math.max(MIN_MAX_EDGE, raw));
}

/**
 * Pure decision: does this image need scaling, and to what size?
 * Returns null when the long edge already fits (no work required).
 * @param {number} width
 * @param {number} height
 * @param {object} [env]
 * @returns {{width:number,height:number,scale:number}|null}
 */
function planImageNormalize(width, height, env = process.env) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  const longEdge = Math.max(w, h);
  const maxEdge = getMaxEdge(env);
  if (longEdge <= maxEdge) {
    return null;
  }
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

/**
 * Normalize raw image bytes. Returns null when the image is already within the
 * cap, is a GIF, is unparseable, the gate is off, or the platform resize fails.
 *
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @returns {{buf:Buffer,mimeType:string,format:string,width:number,height:number,
 *            originalWidth:number,originalHeight:number,originalBytes:number,
 *            sizeBytes:number,scaled:boolean}|null}
 */
function normalizeImageBuffer(buf, opts = {}) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 32) {
      return null;
    }
    const env = opts.env || process.env;
    if (!normalizeEnabled(env)) {
      return null;
    }

    const { probeImageMetadata } = require('./imageMetadataProbe');
    const meta = probeImageMetadata(buf);
    const format = meta && meta.format;
    // Animation is multi-frame: re-encoding a single frame silently drops it.
    if (!format || format === 'unknown' || format === 'gif' || meta.animated) {
      return null;
    }

    const plan = planImageNormalize(meta.width, meta.height, env);
    if (!plan) {
      return null;
    }

    const { _downscaleBufferViaPlatform } = require('./gateway/glmVisionImageDownscale');
    const out = _downscaleBufferViaPlatform(buf, plan.width, plan.height);
    if (!out || out.length === 0) {
      return null;
    }

    return {
      buf: out,
      mimeType: 'image/png',
      format: 'png',
      width: plan.width,
      height: plan.height,
      originalWidth: Number(meta.width),
      originalHeight: Number(meta.height),
      originalBytes: buf.length,
      sizeBytes: out.length,
      scaled: true,
    };
  } catch {
    return null;
  }
}

/**
 * Convenience wrapper for callers that already hold a bare base64 string.
 * @param {string} base64
 * @param {object} [opts]
 * @returns {{base64:string,mimeType:string,format:string,width:number,height:number,
 *            originalWidth:number,originalHeight:number,scaled:boolean}|null}
 */
function normalizeImageBase64(base64, opts = {}) {
  try {
    if (!base64 || typeof base64 !== 'string') {
      return null;
    }
    const res = normalizeImageBuffer(Buffer.from(base64, 'base64'), opts);
    if (!res) {
      return null;
    }
    return {
      base64: res.buf.toString('base64'),
      mimeType: res.mimeType,
      format: res.format,
      width: res.width,
      height: res.height,
      originalWidth: res.originalWidth,
      originalHeight: res.originalHeight,
      scaled: res.scaled,
    };
  } catch {
    return null;
  }
}

module.exports = {
  normalizeImageBuffer,
  normalizeImageBase64,
  planImageNormalize,
  normalizeEnabled,
  getMaxEdge,
  DEFAULT_MAX_EDGE,
  MIN_MAX_EDGE,
  MAX_MAX_EDGE,
};
