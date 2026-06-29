import QRCode from 'qrcode';

const cache = new Map();

export async function generateQrDataUrl(text) {
  const input = String(text || '');
  if (!input) return '';
  if (cache.has(input)) return cache.get(input);

  const svg = await QRCode.toString(input, { type: 'svg', margin: 2, width: 200 });
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  cache.set(input, dataUrl);
  return dataUrl;
}
