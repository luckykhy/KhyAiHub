'use strict';

/**
 * trajectoryNarrative — 任务叙事（DESIGN-ARCH-130）。
 * 故事层 collectStory → 话语层 buildNarrative → 成稿 renderNarrative，
 * 可选模型润色 maybePolish（KHY_NARRATIVE_POLISH，默认关）。
 */

const { collectStory, KIND } = require('./storyCollect');
const { buildNarrative } = require('./discourse');
const { renderNarrative } = require('./render');
const { maybePolish } = require('./polish');

module.exports = { collectStory, KIND, buildNarrative, renderNarrative, maybePolish };
