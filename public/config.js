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
};
