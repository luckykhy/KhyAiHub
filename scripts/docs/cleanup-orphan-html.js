#!/usr/bin/env node
/**
 * 清理没有 MD 源文件的 HTML 文件
 * 用法：node cleanup-orphan-html.js [--apply]
 */

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(__dirname, '..', '..');

function findOrphanHtml(dir) {
  let orphans = [];
  const skipDirs = new Set(['node_modules', '.git', 'build', 'dist', '19_资产']);

  fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && !skipDirs.has(d.name)) {
      orphans = orphans.concat(findOrphanHtml(p));
    } else if (d.name.endsWith('.html')) {
      const rel = path.relative(ROOT, p).split(path.sep).join('/');
      // docs/html/ 镜像树：把孪生路径映射回 md 源；docs/index.html 是无源首页，豁免
      const mdRel = rel === 'docs/index.html'
        ? null
        : rel.startsWith('docs/html/')
          ? 'docs/' + rel.slice('docs/html/'.length).replace(/\.html$/i, '.md')
          : rel.replace(/\.html$/i, '.md');
      if (mdRel === null) return;
      if (!fs.existsSync(path.join(ROOT, mdRel))) {
        orphans.push(p);
      }
    }
  });

  return orphans;
}

function main() {
  console.log('扫描没有 MD 源文件的 HTML 文件...\n');
  
  const orphans = findOrphanHtml(path.join(ROOT, 'docs'));
  
  console.log(`找到 ${orphans.length} 个孤立 HTML 文件`);
  
  if (orphans.length > 0) {
    console.log('\n孤立文件列表：');
    orphans.forEach(f => {
      console.log(`   ${path.relative(ROOT, f)}`);
    });
    
    if (APPLY) {
      console.log('\n删除孤立 HTML 文件...');
      
      let deleted = 0;
      orphans.forEach(f => {
        try {
          fs.unlinkSync(f);
          deleted++;
          console.log(`   ✓ 删除: ${path.relative(ROOT, f)}`);
        } catch (e) {
          console.log(`   ✗ 失败: ${path.relative(ROOT, f)} - ${e.message}`);
        }
      });
      
      console.log(`\n✓ 共删除 ${deleted} 个孤立 HTML 文件`);
    } else {
      console.log('\n运行 `node scripts/docs/cleanup-orphan-html.js --apply` 执行清理');
    }
  }
  
  return orphans.length;
}

const count = main();
process.exit(count > 0 ? 1 : 0);
