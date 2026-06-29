// Builds the renderable form from the real FormGear template.json + validation.json
// (parsed by src/formgear.js). Cached after first build.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildForm } from '../formgear.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..', '..');

let cached = null;

function loadJson(name) {
  return JSON.parse(readFileSync(join(APP_ROOT, name), 'utf8'));
}

export function getForm() {
  if (cached) return cached;
  const template = loadJson('template.json');
  const validation = loadJson('validation.json');
  cached = buildForm(template, validation);
  return cached;
}
