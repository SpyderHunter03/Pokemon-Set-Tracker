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
  cdnBase: 'cdn',
  /* Language shown on first launch (user can switch in-app if more
   * languages were downloaded with --langs). */
  defaultLanguage: 'en',
  /* Serve card images from a CDN you control instead of this app.
   * Leave null to serve images from cdnBase like everything else.
   *
   *   imageBase: 'https://cards-cdn.example.com'
   *
   * The CDN must mirror the same layout the downloader produces:
   *   <imageBase>/<lang>/images/<set>/<number>/<quality>.webp
   *   <imageBase>/<lang>/images/<set>/<number>/<variant>-<quality>.webp
   *   <imageBase>/<lang>/images/<set>/logo.png
   * (i.e. sync your public/cdn/<lang>/images folders up to it).
   * Card DATA (sets, indexes, custom printings) stays at cdnBase. */
  imageBase: null,
};
