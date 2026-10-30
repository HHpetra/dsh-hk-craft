// Minimal Electron asar reader: `node asar.mjs list <prefix>` / `node asar.mjs extract <prefix> <outDir>`
import fs from 'node:fs';
import path from 'node:path';

const asarPath =
  process.env.ASAR ??
  'C:\\Users\\73632\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';

function loadIndex(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const sizeBuf = Buffer.alloc(16);
  fs.readSync(fd, sizeBuf, 0, 16, 0);
  const headerSize = sizeBuf.readUInt32LE(4);
  const jsonLen = sizeBuf.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  fs.closeSync(fd);
  return { header: JSON.parse(jsonBuf.toString('utf8')), dataOffset: 8 + headerSize };
}

function walk(node, prefix, out, base = '') {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = base ? `${base}/${name}` : name;
    if (entry.files) walk(entry, prefix, out, p);
    else out.push({ path: p, entry });
  }
}

const [cmd, prefix = '', outDir = ''] = process.argv.slice(2);
const { header, dataOffset } = loadIndex(asarPath);
const files = [];
walk(header, prefix, files);

if (cmd === 'list') {
  const matches = files.filter((f) => f.path.startsWith(prefix));
  const dirs = new Set();
  for (const f of matches) {
    const parts = f.path.split('/');
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  console.log(`dataOffset=${dataOffset} files=${files.length} matches=${matches.length}`);
  for (const d of [...dirs].sort()) console.log((matches.some((m) => m.path === d) ? 'F ' : 'D ') + d);
} else if (cmd === 'extract') {
  const matches = files.filter((f) => f.path.startsWith(prefix));
  const fd = fs.openSync(asarPath, 'r');
  for (const f of matches) {
    const dest = path.join(outDir, f.path.slice(prefix.length).replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.alloc(f.entry.size);
    fs.readSync(fd, buf, 0, f.entry.size, dataOffset + Number(f.entry.offset));
    fs.writeFileSync(dest, buf);
  }
  fs.closeSync(fd);
  console.log(`extracted ${matches.length} files to ${outDir}`);
}
