// build.mjs — 打包 src/main.js，再内联成可离线双击运行的桌面单文件页。
//
// 为什么不用 vite：这条链路的产物只有两样（一个 esm bundle、一个 html），
// vite 的依赖图与 dev server 在这里是净负担，还多一层版本漂移要守。
//
// 四个集成模块在接线前不存在，但 build 不许因此失败——否则「页面还打不开」
// 会盖住「导演还没写」这个真正的待办。这里用一个 esbuild 插件把缺失的模块
// 换成一句运行期 throw：文件在就正常内联，不在就响亮报错，两种都不静默。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

// 所有相对路径以本脚本所在目录的上一级（本子项目根）为锚，不用 process.cwd()：
// 工作流从仓库根调这些脚本，cwd 会随调用方变。
const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = path.join(PKG_ROOT, 'src');
const DIST_DIR = path.join(PKG_ROOT, 'dist');
const OUT_DIR = path.join(PKG_ROOT, 'out');

const INTEGRATION_MODULES = ['pipeline', 'director', 'audio', 'models'];

// 12MB 是单文件页的实用上限：再大 base64 解码本身就要占满主线程几秒，
// 而单文件页的全部意义就是「双击就能放」。
const MAX_INLINE_AUDIO_BYTES = 12 * 1024 * 1024;

function integrationPlugin() {
  return {
    name: 'khyos-desktop-integration',
    setup(build) {
      build.onResolve(
        { filter: new RegExp(`^\\./(?:${INTEGRATION_MODULES.join('|')})\\.js$`) },
        (args) => {
          const abs = path.resolve(args.resolveDir, args.path);
          if (fs.existsSync(abs)) return null;
          return { path: abs, namespace: 'khyos-desktop-missing' };
        },
      );
      build.onLoad({ filter: /.*/, namespace: 'khyos-desktop-missing' }, (args) => ({
        contents:
          'throw new Error(' +
          JSON.stringify(`集成阶段未接线：src/${path.basename(args.path)} 不存在`) +
          ');',
        loader: 'js',
      }));
    },
  };
}

await esbuild.build({
  entryPoints: [path.join(SRC_DIR, 'main.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  outfile: path.join(DIST_DIR, 'bundle.js'),
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [integrationPlugin()],
});

let html = fs.readFileSync(path.join(PKG_ROOT, 'index.html'), 'utf8');
const bundle = fs.readFileSync(path.join(DIST_DIR, 'bundle.js'), 'utf8');

// bundle 里出现字面 </script> 会提前闭合内联脚本；base64 与压缩后的 JS
// 都不会含它，但这一处转义是零成本的保险。
const inlined = bundle.replace(/<\/script/gi, '<\\/script');
const scriptTag = '<script type="module" src="./dist/bundle.js"></script>';
if (!html.includes(scriptTag)) {
  throw new Error('[khyos-desktop] index.html 里找不到 bundle 引用，内联无从下手。');
}
// 必须用函数式替换：压缩后的 bundle 里遍布 `$`，而字符串替换会把 `$&`、$`
// 当成替换模式，静默产出一个坏掉的内联页。
html = html.replace(scriptTag, () => `<script type="module">\n${inlined}\n</script>`);

// 注入同样走函数式替换：base64 里没有 `$`，但这里没有理由依赖这件事。
const inject = (snippet) => {
  html = html.replace('</body>', () => `${snippet}\n</body>`);
};
let audioNote;
const scoreOgg = path.join(OUT_DIR, 'score.ogg');
if (fs.existsSync(scoreOgg)) {
  const size = fs.statSync(scoreOgg).size;
  if (size <= MAX_INLINE_AUDIO_BYTES) {
    const b64 = fs.readFileSync(scoreOgg).toString('base64');
    inject(`<script>window.__KHYOS_SCORE_SRC="data:audio/ogg;base64,${b64}";</script>`);
    audioNote = `内联 out/score.ogg（${(size / 1024 / 1024).toFixed(2)} MB）`;
  } else {
    fs.copyFileSync(scoreOgg, path.join(DIST_DIR, 'score.ogg'));
    inject('<script>window.__KHYOS_SCORE_SRC="./score.ogg";</script>');
    audioNote = `out/score.ogg 超 ${(MAX_INLINE_AUDIO_BYTES / 1024 / 1024).toFixed(0)}MB（${(size / 1024 / 1024).toFixed(2)} MB），退化为 dist/score.ogg 同目录引用`;
  }
} else {
  inject('<script>window.__KHYOS_SCORE_SRC=null;</script>');
  audioNote = '未找到 out/score.ogg，单文件页无配乐（先跑 assemble.mjs 转出 ogg）';
}

const singleFile = path.join(DIST_DIR, 'khyos-desktop.html');
fs.writeFileSync(singleFile, html, 'utf8');

console.log(`[khyos-desktop] dist/bundle.js ${(fs.statSync(path.join(DIST_DIR, 'bundle.js')).size / 1024).toFixed(1)} KB`);
console.log(`[khyos-desktop] dist/khyos-desktop.html ${(fs.statSync(singleFile).size / 1024 / 1024).toFixed(2)} MB`);
console.log(`[khyos-desktop] 配乐：${audioNote}`);
