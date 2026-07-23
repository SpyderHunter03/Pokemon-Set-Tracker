/* Minimal tcgcsv.com (TCGplayer mirror) mock for import-variants.js tests. */
const http = require('http');

const GROUPS = [
  { groupId: 604, name: 'Base Set', abbreviation: 'BS' },
  { groupId: 1418, name: 'SWSH03: Darkness Ablaze', abbreviation: 'DAA' },
  { groupId: 9999, name: 'Some Sealed Products Group', abbreviation: 'SSP' },
];

const PRODUCTS = {
  604: [
    { productId: 100, name: 'Charizard (4/102)', extendedData: [{ name: 'Number', value: '4/102' }] },
    // a descriptor variant that must become a custom printing
    { productId: 101, name: 'Pikachu (58/102) (Red Cheeks)', extendedData: [{ name: 'Number', value: '58/102' }] },
    // standard printing descriptors must be skipped
    { productId: 102, name: 'Pikachu (58/102) (1st Edition)', extendedData: [{ name: 'Number', value: '58/102' }] },
    // sealed product without a Number — ignored
    { productId: 103, name: 'Base Set Booster Box', extendedData: [] },
    // number that matches no local card — ignored
    { productId: 104, name: 'Ghost Card (999/102) (Misprint)', extendedData: [{ name: 'Number', value: '999/102' }] },
  ],
  1418: [
    // leading-zero number + exotic descriptor
    { productId: 200, name: 'Charizard VMAX (020/189) (Cracked Ice Holo)', extendedData: [{ name: 'Number', value: '020/189' }] },
  ],
  9999: [],
};

const PRICES = {
  604: [
    { productId: 100, subTypeName: 'Holofoil' },
    { productId: 100, subTypeName: '1st Edition Holofoil' },
    { productId: 101, subTypeName: 'Normal' },
  ],
  1418: [
    { productId: 200, subTypeName: 'Holofoil' },
  ],
  9999: [],
};

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, results: o })); };
  let m;
  if (p === '/tcgplayer/3/groups') return json(GROUPS);
  if ((m = p.match(/^\/tcgplayer\/3\/(\d+)\/products$/))) return json(PRODUCTS[m[1]] || []);
  if ((m = p.match(/^\/tcgplayer\/3\/(\d+)\/prices$/))) return json(PRICES[m[1]] || []);
  res.writeHead(404); res.end();
}).listen(3997, () => console.log('mock tcgcsv on :3997'));
