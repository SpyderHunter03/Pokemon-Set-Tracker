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
  /* Where the app loads its card DATABASE — data AND images — from.
   * This is the setting you change to point at a CDN; imageBase below
   * is only for advanced split setups.
   *
   * The default is the project's hosted database (Cloudflare R2), so a
   * fresh install boots instantly with no download and the bootstrap/
   * admin-update UI hides itself. If the CDN is unreachable, the app
   * falls back to a local database when one exists.
   *
   * Set it to 'cdn' to run fully self-contained instead: the app serves
   * its own database (first visit offers the in-app download, and admins
   * can rebuild it), built by scripts/build-data.js and optionally
   * published to your own bucket with scripts/publish-images.js.
   *
   *   cdnBase: 'cdn'                            (self-hosted database)
   *   cdnBase: 'https://pub-xxxxxxxx.r2.dev'    (your own R2 bucket)
   */
  cdnBase: 'https://pub-828f8f41b9f543f88ccae1f6ff84c2c5.r2.dev',
  /* Language shown on first launch (user can switch in-app if more
   * languages were downloaded with --langs). */
  defaultLanguage: 'en',
  /* ADVANCED — usually leave this null. Images already come from
   * cdnBase along with everything else; imageBase exists only for a
   * split setup where card DATA stays at cdnBase but images are served
   * from a different host.
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
