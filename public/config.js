/* Pokémon TCG Tracker — configuration.
 *
 * cdnBase: where the app loads its card database from (the folder produced
 * by scripts/build-data.js). Either a path relative to the app…
 *
 *   cdnBase: 'cdn'
 *
 * …or a full URL to wherever you host the data (any static host / CDN):
 *
 *   cdnBase: 'https://cards.example.com/cdn'
 *
 * Note: if the data lives on a different domain, that host must send
 * CORS headers (Access-Control-Allow-Origin: *). Most CDNs and static
 * hosts do, or let you configure it.
 */
self.PTCG_CONFIG = {
  /* Where the app loads its card DATABASE (data + images) from.
   * 'cdn' = local, self-contained (first visit offers the in-app download).
   * A full URL = a CDN you publish to with scripts/publish-images.js —
   * fresh installs boot instantly with no download, and the bootstrap/
   * admin-update UI hides itself (update on the master, re-publish).
   * If the remote CDN is unreachable, the app falls back to a local
   * database when one exists.
   *
   *   cdnBase: 'https://pub-xxxxxxxx.r2.dev'   (Cloudflare R2 public bucket)
   */
  cdnBase: 'cdn',
  /* Language shown on first launch (user can switch in-app if more
   * languages were downloaded with --langs). */
  defaultLanguage: 'en',
  /* Serve card images from a CDN you control instead of this app.
   * Leave null to serve images from cdnBase like everything else.
   *
   *   imageBase: 'https://pub-xxxxxxxx.r2.dev'          (Cloudflare R2 public bucket)
   *   imageBase: 'https://cards-cdn.example.com'        (any host you control)
   *
   * The CDN must mirror the same layout the downloader produces:
   *   <imageBase>/<lang>/images/<set>/<number>/<quality>.webp
   *   <imageBase>/<lang>/images/<set>/<number>/<variant>-<quality>.webp
   *   <imageBase>/<lang>/images/<set>/logo.png
   * (i.e. sync your public/cdn/<lang>/images folders up to it).
   * Card DATA (sets, indexes, custom printings) stays at cdnBase. */
  imageBase: null,
};
