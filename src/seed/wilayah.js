import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WILAYAH_JSON = join(__dirname, '..', '..', 'wilayah.json');

const PROV = { code: '97', name: 'PAPUA PEGUNUNGAN' };

// Nama kabupaten berdasarkan kdkab di wilayah.json.
const KAB_NAMES = {
  '02': 'JAYAWIJAYA',
  '05': 'MAMBERAMO TENGAH',
};

function regionIdFor(fullcode) {
  return `region-${fullcode}`;
}

function addRegion(map, { level, code, fullcode, name, parentFullcode = null }) {
  if (map.has(fullcode)) return;
  map.set(fullcode, {
    id: regionIdFor(fullcode),
    level,
    code,
    fullcode,
    name,
    parentFullcode,
    parent_id: parentFullcode ? regionIdFor(parentFullcode) : null,
  });
}

export function loadWilayahRows() {
  return JSON.parse(readFileSync(WILAYAH_JSON, 'utf8'));
}

export function buildRegionsFromWilayahRows(rows = loadWilayahRows()) {
  const map = new Map();

  addRegion(map, {
    level: 'prov',
    code: PROV.code,
    fullcode: PROV.code,
    name: PROV.name,
  });

  for (const row of rows) {
    const kabCode     = row.kdkab;
    const kabFullcode = `${PROV.code}${kabCode}`;
    const kabName     = KAB_NAMES[kabCode] || `KAB ${kabCode}`;

    addRegion(map, {
      level: 'kab',
      code: kabCode,
      fullcode: kabFullcode,
      name: kabName,
      parentFullcode: PROV.code,
    });

    const kecFullcode = `${kabFullcode}${row.kdkec}`;
    addRegion(map, {
      level: 'kec',
      code: row.kdkec,
      fullcode: kecFullcode,
      name: row.nmkec,
      parentFullcode: kabFullcode,
    });

    const desaFullcode = `${kecFullcode}${row.kddesa}`;
    addRegion(map, {
      level: 'desa',
      code: row.kddesa,
      fullcode: desaFullcode,
      name: row.nmdesa,
      parentFullcode: kecFullcode,
    });

    const slsFullcode = `${desaFullcode}${row.kdsls}`;
    addRegion(map, {
      level: 'sls',
      code: row.kdsls,
      fullcode: slsFullcode,
      name: row.nmsls,
      parentFullcode: desaFullcode,
    });

    const subslsFullcode = `${slsFullcode}${row.kdsubsls}`;
    addRegion(map, {
      level: 'subsls',
      code: row.kdsubsls,
      fullcode: subslsFullcode,
      name: row.nmsls,
      parentFullcode: slsFullcode,
    });
  }

  return map;
}

export function firstDemoRegion(map) {
  return map.get('9702050008400100')
    || [...map.values()].find((r) => r.level === 'subsls')
    || [...map.values()].find((r) => r.level === 'sls')
    || [...map.values()].find((r) => r.level === 'desa')
    || [...map.values()][0]
    || null;
}
