'use strict';
/**
 * The card fingerprint, in one place.
 *
 * A box-average + dHash (horizontal + vertical, 128 bits) over full-resolution
 * pixels. Three things compute it: this file (used by scripts/build-hashes.js
 * when building the whole index, and by server.js when a single new card image
 * is uploaded) and `computeCardHash` in public/app.js, which has to be its own
 * copy because it runs in the browser.
 *
 * IMPORTANT: this implementation and the one in public/app.js must stay
 * byte-identical in behavior — no library resizing anywhere in the hash path,
 * exact area averages over the full-resolution pixels — or a photo hashed in
 * the browser will not match an index hashed on the server.
 */

const ALGO = 'boxdhash2-9x8';

function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16);
  }
  return hex;
}

function boxGrid(rgba, W, H, gw, gh) {
  const g = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const y0 = Math.floor((j * H) / gh), y1 = Math.floor(((j + 1) * H) / gh);
    for (let i = 0; i < gw; i++) {
      const x0 = Math.floor((i * W) / gw), x1 = Math.floor(((i + 1) * W) / gw);
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * W + x) * 4;
          sum += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
          n++;
        }
      }
      g[j * gw + i] = n ? sum / n : 0;
    }
  }
  return g;
}

function hashFromPixels(rgba, W, H) {
  const gx = boxGrid(rgba, W, H, 9, 8);
  const bx = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bx.push(gx[y * 9 + x] < gx[y * 9 + x + 1] ? 1 : 0);
  const gy = boxGrid(rgba, W, H, 8, 9);
  const by = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) by.push(gy[y * 8 + x] < gy[(y + 1) * 8 + x] ? 1 : 0);
  return bitsToHex(bx) + bitsToHex(by);
}

/** Fingerprint an image file. Needs sharp; throws if it is not installed. */
async function hashImageFile(file) {
  const sharp = require('sharp');
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return hashFromPixels(data, info.width, info.height);
}

module.exports = { ALGO, bitsToHex, boxGrid, hashFromPixels, hashImageFile };
