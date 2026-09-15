// 临时验证脚本（Node 侧跑一遍转换核心，检查产物质量）
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const libDir = path.join(root, 'js');
for (const f of ['mime.js', 'decode.js', 'rewrite.js', 'convert.js', 'zip.js']) {
  const code = fs.readFileSync(path.join(libDir, f), 'utf8');
  (0, eval)(code);
}

const sample = process.argv[2];
const opts = {
  inlineStyle: process.argv.includes('--link') ? false : true,
  disableJs: process.argv.includes('--nojs'),
  bom: true,
  stripMissing: process.argv.includes('--strip')
};

const bytes = new Uint8Array(fs.readFileSync(sample));
console.log('源文件:', path.basename(sample), (bytes.length / 1048576).toFixed(2) + 'MB');
console.log('选项:', JSON.stringify(opts));

const t0 = Date.now();
const res = globalThis.MhtConvert.convert(bytes, opts);
const s = res.stats;
console.log('耗时:', Date.now() - t0, 'ms');
console.log('主文档编码:', s.rootCharset, '坏字符:', s.rootBadChars);
console.log('部件:', s.partCount, '已内联引用:', s.resourcesInlined, '未归档引用:', s.missTotal);
console.log('资源构成:', JSON.stringify(s.counts));
console.log('输出:', (s.outputSize / 1048576).toFixed(2) + 'MB', 'base:', s.baseUrl);

const html = res.html;

// --- 质量检查 ---
const checks = [];
const remainCid = (html.match(/cid:/g) || []).length;
checks.push(['残留 cid: 引用', remainCid, remainCid === 0]);

const extSrc = (html.match(/(?:src|poster)\s*=\s*["']https?:/gi) || []).length;
checks.push(['未内联的 src=http(s)', extSrc, extSrc === 0]);

const cssUrl = (html.match(/url\(\s*["']?https?:/gi) || []).length;
checks.push(['未内联的 css url(http)', cssUrl, cssUrl === 0]);

const dataUris = (html.match(/data:[a-z/+.-]+[;,]/gi) || []).length;
checks.push(['data: URI 数量', dataUris, dataUris > 100]);

const styleCount = (html.match(/<style\b/gi) || []).length;
checks.push(['内联 <style> 数量', styleCount, styleCount > 0]);

// ascii 乱码检查：quoted-printable 是否已解码
checks.push(['残留 =3D（QP 未解码）', (html.match(/=3D/g) || []).length, (html.match(/=3D/g) || []).length === 0]);

// 图片有效性抽样
let imgOk = 0, imgBad = 0;
for (const m of html.matchAll(/data:image\/(png|gif|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]{32,})/g)) {
  const buf = Buffer.from(m[2], 'base64');
  const sig = buf.subarray(0, 4).toString('hex');
  const ok = (m[1] === 'png' && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') ||
    (m[1] === 'gif' && (buf.subarray(0, 3).toString('latin1') === 'GIF')) ||
    (/jpe?g/.test(m[1]) && sig.startsWith('ffd8ff')) ||
    (m[1] === 'webp' && buf.subarray(0, 4).toString('latin1') === 'RIFF');
  if (ok) imgOk++; else imgBad++;
}
checks.push(['图片签名抽样 (ok/bad)', `${imgOk}/${imgBad}`, imgBad === 0 && imgOk > 0]);

console.log('\n--- 检查项 ---');
let failed = 0;
for (const [name, val, pass] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${val}`);
}

if (s.misses.length) {
  console.log('\n--- 未归档引用 TOP 10 ---');
  for (const m of s.misses.slice(0, 10)) console.log(`  ×${m.count}  ${m.url}`);
}

const outFile = path.join(root, 'tools', 'out-' + path.basename(sample).replace(/\.[^.]+$/, '') + '.html');
fs.writeFileSync(outFile, res.bytes);
console.log('\n已写出:', outFile, (res.bytes.length / 1048576).toFixed(2) + 'MB');

// ZIP 自检
const zip = globalThis.MhtZip.create([{ name: 'a.html', bytes: res.bytes }]);
const zipFile = path.join(root, 'tools', 'out-test.zip');
fs.writeFileSync(zipFile, zip);
console.log('ZIP 输出:', zipFile, zip.length, 'bytes');

console.log(failed ? `\n${failed} 项检查未通过` : '\n全部检查通过');
