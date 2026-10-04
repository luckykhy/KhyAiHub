'use strict';
const fs = require('fs');
const src = fs.readFileSync('src/cli/tui/ink-components/App.js', 'utf8');
const lines = src.split(/\r?\n/);
lines.forEach((l, i) => {
  if (/query\.compaction|compacting:|awaitingUserChoice|PreviewLayout|_layoutProps|layout\(/.test(l)) {
    console.log(i + 1 + ': ' + l.trim().slice(0, 140));
  }
});
