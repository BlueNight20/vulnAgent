// Nest CLI 12 watches matched directories recursively; its asset exclude is not
// passed to Chokidar, so excluded descendants are copied in watchAssets mode.
// Apply only to the reviewed, locked upstream file; never patch a global CLI.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const BEFORE = '277987f629718984ef16fd57899336a23c3fe37093d3f01824f2232073dcb46c';
const AFTER = 'fca501e7c361fe36c3104a95f06feb64a1af4a1c2e62a0a7cffae6940080f5f4';
const hash = (value) => createHash('sha256').update(value).digest('hex');
function patchedSource(source) {
  if (hash(source) === AFTER) return source;
  if (hash(source) !== BEFORE) throw new Error('Nest CLI assets-manager 与已审阅补丁不匹配；拒绝改写，请重新核对上游版本');
  return source.replace("import * as chokidar from 'chokidar';", "import * as chokidar from 'chokidar';\nimport { minimatch } from 'minimatch';")
    .replace('.watch(matchedPaths)', ".watch(matchedPaths, { ignored: item.exclude ? (path) => minimatch(path.replace(/\\\\/g, '/'), item.exclude, { dot: true }) : undefined })");
}
function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = [path.join(root, 'apps/api/node_modules/@nestjs/cli/package.json'), path.join(root, 'node_modules/@nestjs/cli/package.json')].find((file) => fs.existsSync(file));
  if (!manifest) { console.log('Nest asset patch: development CLI not installed; skipped.'); return; }
  const file = fs.realpathSync(path.join(path.dirname(manifest), 'lib/compiler/assets-manager.js'));
  const relative = path.relative(fs.realpathSync(root), file);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..') || !relative.split(path.sep).includes('node_modules')) throw new Error('拒绝修补工作区之外的 Nest CLI');
  if (JSON.parse(fs.readFileSync(manifest, 'utf8')).version !== '12.0.11') throw new Error('Nest 资源补丁仅适用于 12.0.11，请先核对上游版本');
  const source = fs.readFileSync(file, 'utf8'); const patched = patchedSource(source);
  if (hash(patched) !== AFTER) throw new Error('Nest 资源补丁结果校验失败');
  if (patched !== source) fs.writeFileSync(file, patched);
  console.log('Nest asset patch: reviewed watch exclusion fix verified.');
}
module.exports = { patchedSource, main };
if (require.main === module) main();
