// PWAアイコンPNG書き出しスクリプト
// 使い方（プロジェクトルートで）:
//   npm exec --yes --package=sharp -- node scripts/export-icons.mjs
// または sharp をインストール済みなら:
//   node scripts/export-icons.mjs
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons', 'png');
await mkdir(outDir, { recursive: true });

// [入力SVG, 出力サイズpx, 出力ファイル名]
const jobs = [
  ['icon-master.svg', 1024, 'icon-1024.png'],
  ['icon-master.svg', 512, 'icon-512.png'],
  ['icon-master.svg', 192, 'icon-192.png'],
  ['icon-master.svg', 180, 'apple-touch-icon.png'], // iOS: 角丸はシステム側でマスク
  ['icon-master.svg', 512, 'maskable-512.png'],     // maskable: 主要素は中央66%内に配置済み
  ['icon-foreground.svg', 432, 'android-foreground-432.png'], // 適応アイコン 108dp@xxxhdpi
  ['icon-background.svg', 432, 'android-background-432.png'],
];

for (const [src, size, out] of jobs) {
  const input = join(root, 'icons', src);
  await sharp(input, { density: 300 })
    .resize(size, size)
    .png()
    .toFile(join(outDir, out));
  console.log(`${out} (${size}x${size}) <- ${src}`);
}
console.log('done.');
