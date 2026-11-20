/**
 * 2026-11-19 用户裁决：仓库不再使用 junction/symlink —— dataHome 的
 * khy-Trajectory 可见别名机制（_ensureVisibleAlias / _linkTargetOf）已整体拆除。
 * 这里锁新契约：
 *   - getProjectDataHome() 不在数据家父目录旁留下任何别名/链接；
 *   - 别名名字被真实文件/目录占用时原样不动（不建、不删、不抛）；
 *   - 整个过程绝不抛。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

function freshTmpRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `khy-noalias-${label}-`));
  return root;
}

describe('dataHome — 不再维护 khy-Trajectory 可见别名', () => {
  const OLD_ENV = { ...process.env };
  const created = [];

  afterEach(() => {
    process.env = { ...OLD_ENV };
    jest.resetModules();
    for (const dir of created.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('解析项目数据家时不创建 khy-Trajectory 别名', () => {
    const root = freshTmpRoot('none'); created.push(root);
    process.env.KHY_PROJECT_DATA_HOME = path.join(root, '.khy');
    jest.resetModules();
    const d = require('../../src/utils/dataHome');

    const home = d.getProjectDataHome();
    expect(fs.existsSync(home)).toBe(true);
    // 父目录里只应有真数据家本身，没有任何链接/别名。
    expect(fs.readdirSync(root)).toEqual(['.khy']);
    expect(fs.existsSync(path.join(root, 'khy-Trajectory'))).toBe(false);
  });

  test('别名名字被真实目录占用时原样不动', () => {
    const root = freshTmpRoot('real'); created.push(root);
    const occupant = path.join(root, 'khy-Trajectory');
    fs.mkdirSync(occupant, { recursive: true });
    const sentinel = path.join(occupant, 'user-file.txt');
    fs.writeFileSync(sentinel, 'keep me');

    process.env.KHY_PROJECT_DATA_HOME = path.join(root, '.khy');
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    d.getProjectDataHome();

    expect(fs.lstatSync(occupant).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  test('别名名字被普通文件占用时不抛', () => {
    const root = freshTmpRoot('throw'); created.push(root);
    fs.writeFileSync(path.join(root, 'khy-Trajectory'), 'x');
    process.env.KHY_PROJECT_DATA_HOME = path.join(root, '.khy');
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    expect(() => d.getProjectDataHome()).not.toThrow();
  });
});
