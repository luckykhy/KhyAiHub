'use strict';

/**
 * tui/uiStdinFallbacks.js — simplified stderr/stdin dialogs for the unified UI protocol.
 *
 * Extracted verbatim out of uiAdapter.js ([RESEARCH-018] §3.1 P2 cycle cut). TUI mode cannot
 * use inquirer (it conflicts with Ink for stdin), so these raw-mode prompts are what runs when
 * no native Ink overlay (PermissionsPrompt / ModelPicker / FormFlow) is mounted. Both
 * uiAdapter.js (its own fallback path) and uiBridge.js (defensive no-app-refs path) consume
 * this leaf — and they must not consume each other, which is the cycle this split breaks.
 *
 * Leaf contract: requires no tui module, no Ink, adds no global side effect.
 */
/**
 * Show confirmation in TUI.
 * NOTE: This is a simplified fallback. Full implementation would use PermissionsPrompt.
 * @param {object} response
 * @returns {Promise<boolean>}
 */
async function showConfirm(response) {
  // TUI cannot use inquirer (conflicts with Ink). Use simple stderr prompt.
  // In production, this would integrate with PermissionsPrompt component.
  const prefix = response.danger ? '⚠ ' : '';
  process.stderr.write(`${prefix}${response.message} [y/N]: `);

  // Check if stdin is a TTY (setRawMode available)
  const stdin = process.stdin;
  if (typeof stdin.setRawMode !== 'function') {
    // Non-TTY environment: return default value
    process.stderr.write('\n');
    return response.default === true;
  }

  // Simple stdin read (non-blocking for Ink)
  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const onData = (chunk) => {
      const char = chunk.toString().toLowerCase();
      cleanup();
      if (char === 'y' || char === 'yes') {
        resolve(true);
      } else {
        resolve(false);
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (!wasRaw) stdin.setRawMode(false);
    };

    stdin.once('data', onData);
  });
}

/**
 * Show list selection in TUI.
 * NOTE: Simplified fallback. Full implementation would use ModelPicker.
 * @param {object} response
 * @returns {Promise<string>} Selected item id
 */
async function showList(response) {
  // TUI cannot use inquirer. Use simple numbered list on stderr.
  process.stderr.write(`${response.message}\n`);
  response.items.forEach((item, i) => {
    const desc = item.description ? ` (${item.description})` : '';
    process.stderr.write(`  ${i + 1}. ${item.label}${desc}\n`);
  });
  process.stderr.write('Enter number: ');

  // Check if stdin is a TTY (setRawMode available)
  const stdin = process.stdin;
  if (typeof stdin.setRawMode !== 'function') {
    // Non-TTY environment: return null (cancelled)
    process.stderr.write('\n');
    return null;
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let buf = '';
    const onData = (chunk) => {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        cleanup();
        const idx = parseInt(buf, 10) - 1;
        if (idx >= 0 && idx < response.items.length) {
          resolve(response.items[idx].id);
        } else {
          resolve(null);
        }
      } else if (char === '\x03') {
        // Ctrl+C
        cleanup();
        resolve(null);
      } else if (/\d/.test(char)) {
        buf += char;
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (!wasRaw) stdin.setRawMode(false);
    };

    stdin.on('data', onData);
  });
}

/**
 * Show form input in TUI.
 * NOTE: Simplified fallback. Full implementation would use FormFlow.
 * @param {object} response
 * @returns {Promise<object>} Form values
 */
async function showForm(response) {
  // Simple fallback for non-TTY environments
  const result = {};
  for (const field of response.fields) {
    const value = await promptField(field);
    result[field.name] = value;
  }
  return result;
}

/**
 * Prompt a single field in TUI.
 * @param {object} field - Field definition
 * @returns {Promise<string>}
 */
function promptField(field) {
  return new Promise((resolve) => {
    const label = field.label + (field.required ? ' *' : '');
    process.stderr.write(`${label}: `);

    // Check if stdin is a TTY (setRawMode available)
    const stdin = process.stdin;
    if (typeof stdin.setRawMode !== 'function') {
      // Non-TTY environment: return null
      process.stderr.write('\n');
      resolve(null);
      return;
    }

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(field.type === 'password');
    stdin.resume();

    let buf = '';
    const onData = (chunk) => {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        cleanup();
        if (!buf && field.required) {
          process.stderr.write(`${field.label} is required.\n`);
          // Re-prompt
          promptField(field).then(resolve);
        } else {
          resolve(buf);
        }
      } else if (char === '\x03') {
        // Ctrl+C
        cleanup();
        resolve(null);
      } else if (char === '\x7f') {
        // Backspace
        buf = buf.slice(0, -1);
      } else if (char >= ' ') {
        buf += char;
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (!wasRaw) stdin.setRawMode(false);
    };

    stdin.on('data', onData);
  });
}

module.exports = {
  showConfirm,
  showList,
  showForm,
  promptField,
};
