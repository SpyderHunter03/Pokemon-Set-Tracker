/* Mock TCGdex API (multi-language) for testing the downloader in the sandbox */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ASSET = (p) => `http://localhost:3999/assets/${p}`;

function makeLang(lang) {
  const tr = (en, fr) => (lang === 'fr' ? fr : en);
  const SETS = [
    { id: 'base1', name: tr('Base Set', 'Set de Base'), logo: ASSET('base1/logo'), cardCount: { total: 102, official: 102 } },
    { id: 'swsh3', name: tr('Darkness Ablaze', 'Ténèbres Embrasées'), cardCount: { total: 201, official: 189 } },
    // TCG Pocket (mobile game) set — must be EXCLUDED by the downloader
    { id: 'A1', name: 'Genetic Apex', cardCount: { total: 286, official: 226 } },
  ];
  const SET_DETAILS = {
    base1: {
      id: 'base1', name: tr('Base Set', 'Set de Base'), releaseDate: '1999-01-09',
      cardCount: { total: 102, official: 102 }, logo: ASSET('base1/logo'),
      cards: [
        { id: 'base1-4', localId: '4', name: tr('Charizard', 'Dracaufeu'), image: ASSET('base1/4') },
        { id: 'base1-58', localId: '58', name: 'Pikachu', image: ASSET('base1/58') },
        { id: 'base1-102', localId: '102', name: tr('No Image Card', 'Carte Sans Image') },
        { id: 'base1-97', localId: '97', name: 'HighOnly', image: ASSET('base1/97') },
        { id: 'base1-98', localId: '98', name: 'BrokenArt', image: ASSET('base1/98') },
      ],
    },
    swsh3: {
      id: 'swsh3', name: tr('Darkness Ablaze', 'Ténèbres Embrasées'), releaseDate: '2020-08-14',
      cardCount: { total: 201, official: 189 },
      cards: [
        { id: 'swsh3-136', localId: '136', name: tr('Furret', 'Fouinar'), image: ASSET('swsh3/136') },
        { id: 'swsh3-20', localId: '20', name: tr('Charizard VMAX', 'Dracaufeu VMAX'), image: ASSET('swsh3/20') },
      ],
    },
    A1: {
      id: 'A1', name: 'Genetic Apex', releaseDate: '2024-10-30',
      cardCount: { total: 286, official: 226 },
      cards: [{ id: 'A1-1', localId: '1', name: 'Bulbasaur', image: ASSET('A1/1') }],
    },
  };
  const SERIES = {
    tcgp: { id: 'tcgp', name: 'Pokémon TCG Pocket', sets: [{ id: 'A1', name: 'Genetic Apex' }] },
  };
  const CARDS = {
    'base1-4': { id: 'base1-4', localId: '4', name: tr('Charizard', 'Dracaufeu'), rarity: 'Rare Holo', category: 'Pokemon', dexId: [6], types: ['Fire'], hp: 120, illustrator: 'Mitsuhiro Arita', variants: { normal: false, reverse: false, holo: true, firstEdition: true }, image: ASSET('base1/4') },
    'base1-58': { id: 'base1-58', localId: '58', name: 'Pikachu', rarity: 'Common', category: 'Pokemon', dexId: [25], types: ['Lightning'], hp: 40, illustrator: 'Mitsuhiro Arita', variants: { normal: true, reverse: false, holo: false, firstEdition: true }, image: ASSET('base1/58') },
    'base1-102': { id: 'base1-102', localId: '102', name: tr('No Image Card', 'Carte Sans Image'), rarity: 'Rare', category: 'Trainer', variants: { normal: true } },
    'base1-97': { id: 'base1-97', localId: '97', name: 'HighOnly', rarity: 'Common', category: 'Trainer', variants: { normal: true }, image: ASSET('base1/97') },
    'base1-98': { id: 'base1-98', localId: '98', name: 'BrokenArt', rarity: 'Common', category: 'Trainer', variants: { normal: true }, image: ASSET('base1/98') },
    'swsh3-136': { id: 'swsh3-136', localId: '136', name: tr('Furret', 'Fouinar'), rarity: 'Uncommon', category: 'Pokemon', dexId: [162], types: ['Colorless'], hp: 110, illustrator: 'Kagemaru Himeno', variants: { normal: true, reverse: true, holo: false }, image: ASSET('swsh3/136') },
    'swsh3-20': { id: 'swsh3-20', localId: '20', name: tr('Charizard VMAX', 'Dracaufeu VMAX'), rarity: 'Ultra Rare', category: 'Pokemon', dexId: [6], types: ['Fire'], hp: 330, variants: { normal: false, holo: true }, image: ASSET('swsh3/20') },
  };
  return { SETS, SET_DETAILS, CARDS, SERIES };
}

const LANGS = { en: makeLang('en'), fr: makeLang('fr') };

const PNG_LOGO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const m = p.match(/^\/v2\/(en|fr)(\/.*)$/);
  if (m) {
    const L = LANGS[m[1]], sub = m[2];
    if (sub === '/sets') return json(L.SETS);
    const serieM = sub.match(/^\/series\/(.+)$/);
    if (serieM) return L.SERIES[serieM[1]] ? json(L.SERIES[serieM[1]]) : (res.writeHead(404), res.end());
    const setM = sub.match(/^\/sets\/(.+)$/);
    if (setM) return L.SET_DETAILS[setM[1]] ? json(L.SET_DETAILS[setM[1]]) : (res.writeHead(404), res.end());
    const cardM = sub.match(/^\/cards\/(.+)$/);
    if (cardM) return L.CARDS[cardM[1]] ? json(L.CARDS[cardM[1]]) : (res.writeHead(404), res.end());
  }
  // simulate an external image CDN (config.imageBase) mirroring public/cdn/<lang>/images
  if (p.startsWith('/imgcdn/')) {
    const rel = p.slice('/imgcdn/'.length);
    if (!rel.includes('..')) {
      const file = path.join(__dirname, '..', 'public', 'cdn', rel);
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': rel.endsWith('.png') ? 'image/png' : 'image/webp', 'Access-Control-Allow-Origin': '*' });
        return res.end(fs.readFileSync(file));
      }
    }
    res.writeHead(404); return res.end();
  }
  if (p.startsWith('/assets/')) {
    // /assets/base1/4/low.webp -> fixture base1-4.png ; logo.png -> tiny png
    const am = p.match(/^\/assets\/([^/]+)\/([^/]+)\/(low|high)\.webp$/);
    if (am) {
      if (am[2] === '97' && am[3] === 'low') { res.writeHead(404); return res.end(); } // high-only card
      if (am[2] === '98') { res.writeHead(404); return res.end(); } // image listed but missing at source
      const file = path.join(__dirname, 'fixtures', `${am[1]}-${am[2]}.png`);
      if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'image/webp' }); return res.end(fs.readFileSync(file)); }
    }
    if (p.endsWith('logo.png')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG_LOGO); }
  }
  res.writeHead(404); res.end();
}).listen(3999, () => console.log('mock tcgdex on :3999'));
