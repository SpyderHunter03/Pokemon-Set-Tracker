/* Pokémon TCG Tracker — configuration. */
self.PTCG_CONFIG = {
  /* The published master card database (the bucket the maintainer workspace
   * publishes to). The server reads this as its fallback catalog source when
   * PTCG_API_BASE is not set, and the service worker caches images from it. */
  cdnBase: 'https://pub-828f8f41b9f543f88ccae1f6ff84c2c5.r2.dev',
  /* Where brand-new visitors are sent to learn what this is (the marketing
   * site). null/absent = the app's own /home page. */
  homeUrl: 'https://www.pkmnmasterset.com',
  /* Language shown on first launch (the user can switch in-app when the
   * catalog holds more than one). */
  defaultLanguage: 'en',
  /* ADVANCED — usually leave this null: a split setup where card DATA stays
   * at cdnBase but images are served from a different host with the same
   * <lang>/images/<set>/<number>/<quality>.webp layout. */
  imageBase: null,
};
