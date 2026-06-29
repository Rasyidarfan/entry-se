import { spawnSync } from 'node:child_process';

const cache = new Map();

export function generateQrDataUrl(text) {
  const input = String(text || '');
  if (!input) return '';
  if (cache.has(input)) return cache.get(input);

  const script = `
import qrcode
import qrcode.image.svg
from io import BytesIO
img = qrcode.make(${JSON.stringify(input)}, image_factory=qrcode.image.svg.SvgImage, box_size=8, border=2)
buf = BytesIO()
img.save(buf)
print(buf.getvalue().decode('utf-8'))
`.trim();

  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(result.stderr || 'Gagal membuat QR code.');
  }
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(result.stdout, 'utf8').toString('base64');
  cache.set(input, dataUrl);
  return dataUrl;
}
