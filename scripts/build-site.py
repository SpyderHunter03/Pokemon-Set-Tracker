#!/usr/bin/env python3
# Generates the www.pkmnmasterset.com site into public/site/ — one shared
# design system, seven pages. Throwaway tool; the HTML it emits is what gets
# committed.
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'site')
os.makedirs(OUT, exist_ok=True)

APP = 'https://mstr.pkmnmasterset.com'
API = 'https://api.pkmnmasterset.com'
SUPPORT = 'support@pkmnmasterset.com'

CSS = """
  :root { --bg:#0d1020; --bg2:#12162b; --card:#181d36; --line:#272e52; --text:#e9ebf8;
          --muted:#98a1c8; --accent:#ffcb05; --accent2:#4d8fe0; --good:#4ade80; }
  * { box-sizing:border-box; margin:0; }
  html { scroll-behavior:smooth; }
  body { background:var(--bg); color:var(--text); font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  a { color:var(--accent2); text-decoration:none; }
  .wrap { max-width:1060px; margin:0 auto; padding:0 22px; }
  nav { position:sticky; top:0; z-index:10; backdrop-filter:blur(12px);
        background:rgba(13,16,32,0.82); border-bottom:1px solid var(--line); }
  nav .wrap { display:flex; align-items:center; gap:22px; height:60px; }
  .brand { font-weight:800; font-size:17px; color:var(--text); white-space:nowrap; }
  .brand span { color:var(--accent); }
  nav .links { display:flex; gap:18px; font-size:14.5px; margin-left:8px; }
  nav .links a { color:var(--muted); } nav .links a.on, nav .links a:hover { color:var(--text); }
  nav .cta { margin-left:auto; }
  .btn { display:inline-block; background:var(--accent); color:#171b30; font-weight:700;
         padding:10px 20px; border-radius:10px; border:0; cursor:pointer; font-size:15px; }
  .btn.ghost { background:transparent; color:var(--text); border:1px solid var(--line); }
  .btn.big { padding:14px 28px; font-size:16.5px; }
  .hero { text-align:center; padding:88px 0 64px; position:relative; overflow:hidden; }
  .hero::before { content:""; position:absolute; inset:-40% -20% auto; height:130%; z-index:-1;
    background:radial-gradient(600px 320px at 50% 20%, rgba(77,143,224,0.16), transparent 70%),
               radial-gradient(420px 260px at 62% 8%, rgba(255,203,5,0.10), transparent 70%); }
  h1 { font-size:clamp(32px,5.4vw,52px); line-height:1.1; letter-spacing:-1px; }
  h1 em, .glow { font-style:normal; color:var(--accent); }
  .lede { color:var(--muted); max-width:600px; margin:18px auto 30px; font-size:18.5px; }
  .row { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
  .tiny { color:var(--muted); font-size:13.5px; margin-top:14px; }
  section { padding:56px 0; }
  section.alt { background:var(--bg2); border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
  h2 { font-size:30px; letter-spacing:-0.5px; text-align:center; margin-bottom:8px; }
  .sub { text-align:center; color:var(--muted); margin:0 auto 38px; max-width:620px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px; }
  .card .ico { font-size:26px; } .card h3 { margin:8px 0 5px; font-size:17px; }
  .card p { color:var(--muted); font-size:14.5px; }
  .plans { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:16px; align-items:stretch; }
  .plan { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:26px 22px; display:flex; flex-direction:column; }
  .plan.hot { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent), 0 12px 40px -18px rgba(255,203,5,0.35); position:relative; }
  .plan .flag { position:absolute; top:-12px; left:50%; transform:translateX(-50%); background:var(--accent);
    color:#171b30; font-size:11.5px; font-weight:800; padding:2px 12px; border-radius:99px; white-space:nowrap; }
  .plan h3 { font-size:18px; }
  .price { font-size:36px; font-weight:800; margin:6px 0 2px; }
  .price small { font-size:14px; color:var(--muted); font-weight:400; }
  .plan ul { list-style:none; padding:0; margin:16px 0 22px; flex:1; }
  .plan li { padding:5px 0 5px 26px; position:relative; font-size:14.5px; }
  .plan li::before { content:"✓"; color:var(--good); position:absolute; left:4px; font-weight:700; }
  .plan li.soon::before { content:"◷"; color:var(--muted); } .plan li.soon { color:var(--muted); }
  .plan .btn { text-align:center; }
  .faq { max-width:740px; margin:0 auto; }
  .faq details { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:15px 18px; margin-bottom:10px; }
  .faq summary { cursor:pointer; font-weight:600; }
  .faq p { color:var(--muted); margin-top:8px; font-size:14.5px; }
  pre.code { background:#0b0e1c; border:1px solid var(--line); border-radius:12px; padding:18px;
             text-align:left; font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; color:#c9d4f6;
             overflow-x:auto; max-width:640px; margin:0 auto; }
  pre.code .c { color:#6b769e; } pre.code .k { color:var(--accent); } pre.code .s { color:#8ce99a; }
  .prose { max-width:760px; margin:0 auto; }
  .prose h2 { text-align:left; font-size:22px; margin:34px 0 10px; }
  .prose p, .prose li { color:var(--muted); font-size:15px; }
  .prose ul { padding-left:22px; }
  .prose strong { color:var(--text); }
  .updated { color:var(--muted); font-size:13px; text-align:center; margin-top:-26px; margin-bottom:34px; }
  footer { border-top:1px solid var(--line); padding:34px 0 46px; color:var(--muted); font-size:13px; }
  footer .cols { display:flex; gap:40px; flex-wrap:wrap; margin-bottom:20px; }
  footer .col { min-width:140px; } footer .col b { color:var(--text); display:block; margin-bottom:8px; font-size:13.5px; }
  footer .col a { display:block; color:var(--muted); padding:2px 0; }
  .frame { max-width:980px; margin:44px auto 0; border:1px solid var(--line); border-radius:16px; overflow:hidden;
           box-shadow:0 30px 80px -30px rgba(0,0,0,0.8); background:#0b0e1c; }
  .frame video, .frame img { width:100%; display:block; }
  .shot { width:100%; display:block; border:1px solid var(--line); border-radius:14px; margin-top:26px;
          box-shadow:0 24px 60px -28px rgba(0,0,0,0.75); }
  .brandmark { width:26px; height:26px; vertical-align:-7px; margin-right:2px; }
  @media (max-width:720px) { nav .links { display:none; } .hero { padding:56px 0 44px; } section { padding:42px 0; } }
"""

def nav(active):
    links = [('/', 'Home'), ('/features', 'Features'), ('/pricing', 'Pricing'),
             ('/developers', 'Developers'), ('/faq', 'FAQ')]
    parts = []
    for h, t in links:
        cls = ' class="on"' if h == active else ''
        parts.append('<a href="' + h + '"' + cls + '>' + t + '</a>')
    a = ''.join(parts)
    return f'''<nav><div class="wrap">
  <a class="brand" href="/"><img class="brandmark" src="/site/assets/mark.svg" alt=""> Pkmn <span>Master Set</span></a>
  <div class="links">{a}</div>
  <a class="btn ghost cta" href="{APP}/">Open the tracker</a>
</div></nav>'''

FOOTER = f'''<footer><div class="wrap">
  <div class="cols">
    <div class="col"><b>Product</b>
      <a href="{APP}/">Open the tracker</a><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/faq">FAQ</a></div>
    <div class="col"><b>Developers</b>
      <a href="/developers">TCG Card API</a><a href="{API}/docs">API documentation</a><a href="{API}/docs#plans">API plans</a></div>
    <div class="col"><b>Company</b>
      <a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a><a href="mailto:{SUPPORT}">{SUPPORT}</a></div>
  </div>
  <p>This is an independent, fan-built collection tool. It is not produced by, endorsed by, or affiliated with
     Nintendo, Creatures Inc., GAME FREAK inc., or The Pokémon Company International. Pokémon and Pokémon character
     names are trademarks of their respective owners; card data is used descriptively to identify cards.
     No card artwork is sold.</p>
</div></footer>'''

import hashlib, re as _re
def _asset_versions():
    d = {}
    adir = os.path.join(OUT, 'assets')
    if os.path.isdir(adir):
        for f in os.listdir(adir):
            with open(os.path.join(adir, f), 'rb') as fh:
                d[f] = hashlib.md5(fh.read()).hexdigest()[:8]
    return d
ASSET_V = _asset_versions()

def bust(html):
    # /site/assets/<file> -> /site/assets/<file>?v=<content hash>, so caches
    # can hold assets for a day AND updates show up the moment they deploy
    def sub(m):
        f = m.group(1)
        return f'/site/assets/{f}?v={ASSET_V[f]}' if f in ASSET_V else m.group(0)
    return _re.sub(r'/site/assets/([A-Za-z0-9._-]+)', sub, html)

def page(fname, title, desc, active, body, canonical):
    html = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="icon" href="/icons/icon-192.png">
<link rel="canonical" href="https://www.pkmnmasterset.com{canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pkmn Master Set">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="https://www.pkmnmasterset.com/site/assets/og.png">
<meta property="og:url" content="https://www.pkmnmasterset.com{canonical}">
<meta name="twitter:card" content="summary_large_image">
<style>{CSS}</style>
</head>
<body>
{nav(active)}
{body}
{FOOTER}
</body>
</html>
'''
    with open(os.path.join(OUT, fname), 'w', encoding='utf-8') as f:
        f.write(bust(html))
    print('wrote', fname)

# ---------------- index ----------------
index_body = f'''
<div class="hero"><div class="wrap">
  <h1>Know <em>exactly</em> which<br>cards you own.</h1>
  <p class="lede">Pkmn Master Set tracks your Pokémon card collection set by set and printing by printing —
     holo, reverse, 1st&nbsp;Edition — synced everywhere, organised into binders that match the ones on your shelf.</p>
  <div class="row">
    <a class="btn big" href="{APP}/#/account">Start tracking — free</a>
    <a class="btn ghost big" href="{APP}/">Browse the card library</a>
  </div>
  <div class="tiny">The full card library is open to everyone — no account needed to look around.</div>
  <div class="frame">
    <video autoplay loop muted playsinline poster="/site/assets/hero-poster.png" aria-label="Ticking cards in the tracker as the set's progress bar climbs">
      <source src="/site/assets/hero.webm" type="video/webm">
      <source src="/site/assets/hero.mp4" type="video/mp4">
      <img src="/site/assets/hero-poster.png" alt="The tracker's set page">
    </video>
  </div>
</div></div>

<section><div class="wrap">
  <h2>Two products, one obsession</h2>
  <p class="sub">A tracker for collectors, and the card-data API it runs on — also yours to build with.</p>
  <div class="grid">
    <div class="card"><div class="ico">📒</div><h3>The Tracker</h3>
      <p>Per-printing collection tracking, digital binders with sharing, want-lists, multi-language data,
         and it installs on your phone. Free to use; <a href="/pricing">Master Set Premium</a> unlocks the power tools.</p></div>
    <div class="card"><div class="ico">🗃️</div><h3>The TCG Card API</h3>
      <p>Every set, card and printing as clean JSON — or the whole catalog as one SQLite file. Self-documenting,
         AI-readable, tokens minted the moment you subscribe. <a href="/developers">For developers →</a></p></div>
  </div>
</div></section>

<section class="alt"><div class="wrap">
  <h2>Built by a collector, for collectors</h2>
  <p class="sub">Everything you actually do with a collection, and nothing you don't.</p>
  <div class="grid">
    <div class="card"><div class="ico">📚</div><h3>Every set, every printing</h3>
      <p>A holo and its 1st&nbsp;Edition are different pieces of cardboard — each gets its own tick and count.</p></div>
    <div class="card"><div class="ico">🗂️</div><h3>Binders like your real ones</h3>
      <p>Pocket sizes, covers, page-by-page layout — then add the whole binder to your collection in one press.</p></div>
    <div class="card"><div class="ico">🔗</div><h3>Share your binders</h3>
      <p>Unguessable links anyone can open — trade lists, brag pages, want-lists. Free for everyone.</p></div>
  </div>
  <img class="shot" src="/site/assets/shot-wantlist.png" alt="A set as a text want-list with the Missing filter on" loading="lazy" style="max-width:980px; margin-left:auto; margin-right:auto">
  <p style="text-align:center; margin-top:26px"><a class="btn ghost" href="/features">See all features</a></p>
</div></section>

<section><div class="wrap">
  <h2>Simple pricing</h2>
  <p class="sub">Browsing is free for everyone. Tracking is free with an account. Power tools are $2.99 — <strong>Master Set Premium</strong>.</p>
  <p style="text-align:center"><a class="btn" href="/pricing">See pricing</a></p>
</div></section>
'''
page('index.html', 'Pkmn Master Set — know exactly which Pokémon cards you own',
     'Track your Pokémon card collection set by set and printing by printing — binders, want-lists, sharing, and a full card library you can browse free.',
     '/', index_body, '/')

# ---------------- features ----------------
features_body = f'''
<div class="hero"><div class="wrap">
  <h1>Everything a collection<br><em>actually</em> needs.</h1>
  <p class="lede">No feature exists here because a roadmap demanded it. Each one answers a question collectors ask at a shop, at a trade table, or staring at a shelf of binders.</p>
</div></div>

<section><div class="wrap">
  <h2>Tracking</h2>
  <p class="sub">"Do I have this?" — answered precisely.</p>
  <div class="grid">
    <div class="card"><div class="ico">📚</div><h3>Per-printing everything</h3>
      <p>Normal, holo, reverse, 1st&nbsp;Edition, promo stamps — each printing is its own tick with its own count. Master-set collectors count every variant; the progress bars can too.</p></div>
    <div class="card"><div class="ico">🔍</div><h3>Three views, three speeds</h3>
      <p>Cards (the picture grid), List (rows with thumbnails), Text (pure data, three times as fast to scan). All / Owned / Missing filters on every page turn any set into a want-list.</p></div>
    <div class="card"><div class="ico">🐾</div><h3>The Pokémon view</h3>
      <p>Every printing of each Pokémon across all sets, grouped by dex number — Base Set Charizard next to Charizard VMAX.</p></div>
    <div class="card"><div class="ico">🌍</div><h3>Multi-language</h3>
      <p>Card data in English, Japanese, German and more. Your collection is keyed to the card, not the name, so it carries across languages.</p></div>
  </div>
  <img class="shot" src="/site/assets/shot-sets.png" alt="The sets page: every set with its completion progress" loading="lazy">
</div></section>

<section class="alt"><div class="wrap">
  <h2>Binders</h2>
  <p class="sub">Digital versions of the ones on your shelf.</p>
  <div class="grid">
    <div class="card"><div class="ico">🗂️</div><h3>Real layouts</h3>
      <p>Pick a pocket size (2×2 to 5×5), a cover, and place cards pocket by pocket. Move cards or whole pages; upload your own art across pockets.</p></div>
    <div class="card"><div class="ico">📥</div><h3>Add to collection</h3>
      <p>When a binder is full in real life, one press writes every ticked pocket into your collection. Counts only ever go up — pressing twice does nothing.</p></div>
    <div class="card"><div class="ico">🔗</div><h3>Sharing</h3>
      <p>Every binder is private until you say otherwise. A share link is unguessable, needs no account to open, can hide your ticks, and dies the moment you turn it off.</p></div>
  </div>
  <img class="shot" src="/site/assets/shot-binders.png" alt="The binder shelf: colored binders with page counts" loading="lazy">
</div></section>

<section><div class="wrap">
  <h2>Everywhere you are</h2>
  <div class="grid">
    <div class="card"><div class="ico">📱</div><h3>Installs like an app</h3>
      <p>Add it to your phone's home screen. Visited pages and images keep working offline — card shops with bad reception included.</p></div>
    <div class="card"><div class="ico">🔄</div><h3>Synced accounts</h3>
      <p>Your collection follows your account across every device, with export to JSON any time — your data is yours.</p></div>
    <div class="card"><div class="ico">📷</div><h3>Card scanner <span class="glow">— coming soon</span></h3>
      <p>Point your camera at a card and know on the spot whether you own it. Part of Master Set Premium when it ships.</p></div>
  </div>
  <p style="text-align:center; margin-top:26px"><a class="btn big" href="{APP}/#/account">Start tracking — free</a></p>
</div></section>
'''
page('features.html', 'Features — Pkmn Master Set',
     'Per-printing tracking, digital binders with sharing, want-lists, multi-language data, offline support — every feature of the Pkmn Master Set tracker.',
     '/features', features_body, '/features')

# ---------------- pricing ----------------
pricing_body = f'''
<div class="hero"><div class="wrap">
  <h1>Simple pricing.</h1>
  <p class="lede">Browsing is free for everyone. Tracking is free with an account. Power tools are $2.99 a month — and nothing you make is ever held hostage.</p>
</div></div>

<section><div class="wrap">
  <div class="plans">
    <div class="plan">
      <h3>Just browsing</h3>
      <div class="price">$0 <small>no account</small></div>
      <ul>
        <li>The full card library — every set</li>
        <li>Search with rarity &amp; type filters</li>
        <li>Cards, List and Text views</li>
        <li>Open binders people share with you</li>
      </ul>
      <a class="btn ghost" href="{APP}/">Browse the library</a>
    </div>
    <div class="plan">
      <h3>Free account</h3>
      <div class="price">$0 <small>forever</small></div>
      <ul>
        <li>Everything in Just browsing</li>
        <li>Track your whole collection, per printing</li>
        <li>Synced across all your devices</li>
        <li>One binder, with sharing</li>
        <li>Export your data any time</li>
      </ul>
      <a class="btn" href="{APP}/#/account">Create your account</a>
    </div>
    <div class="plan hot">
      <div class="flag">MOST POPULAR</div>
      <h3>Master Set Premium</h3>
      <div class="price">$2.99 <small>/ month</small></div>
      <ul>
        <li>Everything in Free account</li>
        <li>Unlimited binders</li>
        <li class="soon">Card scanner — point your camera at a card, know if you own it <em>(coming soon)</em></li>
        <li>Keeps the servers running 💛</li>
      </ul>
      <a class="btn" href="{APP}/#/account">Sign in, then upgrade from your Account page</a>
    </div>
  </div>
</div></section>

<section class="alt"><div class="wrap">
  <h2>Building something? The API has plans too.</h2>
  <p class="sub">Card data for developers — from $4.99/mo, with a free tier for trying things out. Card images never count against any plan.</p>
  <p style="text-align:center"><a class="btn" href="{API}/docs#plans">API plans &amp; docs</a></p>
</div></section>

<section><div class="wrap">
  <h2>Pricing questions</h2>
  <div class="faq">
    <details><summary>What happens to my binders if I cancel Premium?</summary>
      <p>Your data is never deleted. Your first binder stays fully usable — that one's part of the free plan. Binders beyond it lock: they stay on your shelf with their covers showing, but opening or editing them needs Premium again. Upgrade any time and every one of them comes back exactly as you left it.</p></details>
    <details><summary>How do payments work?</summary>
      <p>Subscriptions are processed by Stripe — card details never touch our servers. Cancel any time from <strong>Manage subscription</strong> on your Account page; your plan stays active through the period you've paid for.</p></details>
    <details><summary>Is my collection data mine?</summary>
      <p>Yes. Export it as JSON whenever you like, on the free plan too.</p></details>
  </div>
</div></section>
'''
page('pricing.html', 'Pricing — Pkmn Master Set',
     'Free browsing, free collection tracking, and Master Set Premium at $2.99/month for unlimited binders. API plans from $4.99/month.',
     '/pricing', pricing_body, '/pricing')

# ---------------- developers ----------------
dev_body = f'''
<div class="hero"><div class="wrap">
  <h1>The <em>TCG Card API</em>.</h1>
  <p class="lede">Every Pokémon TCG set, card and printing as clean JSON — or pull the whole catalog as one SQLite file
     and query it your way. The same data this site runs on.</p>
  <div class="row">
    <a class="btn big" href="{API}/docs">Read the docs</a>
    <a class="btn ghost big" href="{API}/docs#plans">Get a token</a>
  </div>
  <div style="margin-top:38px">
<pre class="code"><span class="c"># one card, one call</span>
curl {API}/v1/cards/base1-4?lang=en \\
  -H <span class="s">"Authorization: Bearer ptcg_live_…"</span>

{{ <span class="k">"id"</span>: <span class="s">"base1-4"</span>, <span class="k">"name"</span>: <span class="s">"Charizard"</span>, <span class="k">"rarity"</span>: <span class="s">"Rare Holo"</span>,
  <span class="k">"variants"</span>: [<span class="s">"holo"</span>, <span class="s">"firstEdition"</span>], <span class="k">"images"</span>: {{ … }} }}</pre>
  </div>
</div></div>

<section><div class="wrap">
  <h2>Made for builders</h2>
  <div class="grid">
    <div class="card"><div class="ico">🤖</div><h3>Docs humans and AIs can read</h3>
      <p>A full OpenAPI 3.1 spec served by the API itself at <code>/v1/openapi.json</code> — point a code generator,
         an API client, or your AI assistant at one URL. The human docs are rendered from the same definition, so they can't drift.</p></div>
    <div class="card"><div class="ico">📦</div><h3>Bulk, the cheap way</h3>
      <p>Pull <code>catalog.db</code> once, serve lookups from your own copy, and poll the free manifest for version changes.
         An unchanged catalog answers 304 — and 304s cost nothing.</p></div>
    <div class="card"><div class="ico">⚡</div><h3>Tokens on the spot</h3>
      <p>Subscribe and your token is minted immediately — shown once, only its fingerprint stored. Cancel any time; the token stops when the subscription does.</p></div>
    <div class="card"><div class="ico">🖼️</div><h3>Images never count</h3>
      <p>Card images are served by address and cost 0 against every plan, forever — a standing policy, not a promo.</p></div>
    <div class="card"><div class="ico">📊</div><h3>Honest quotas</h3>
      <p>Weighted requests (a lookup is 1, the bulk file 100), monthly allowances, and <code>X-Quota-*</code> headers on every
         response so you see the wall before you hit it. <code>/v1/me</code> shows your usage any time.</p></div>
    <div class="card"><div class="ico">🌐</div><h3>Boring reliability</h3>
      <p>Served from small fast SQLite behind Cloudflare, health-checked, metric-monitored, deployed with verify-or-rollback.</p></div>
  </div>
  <p style="text-align:center; margin-top:26px"><a class="btn big" href="{API}/docs#plans">Plans from $4.99/mo — free tier available</a></p>
</div></section>
'''
page('developers.html', 'TCG Card API — Pkmn Master Set for developers',
     'Pokémon TCG card data as clean JSON or bulk SQLite. OpenAPI-documented, AI-readable, instant tokens, images never metered. Plans from $4.99/month.',
     '/developers', dev_body, '/developers')

# ---------------- faq ----------------
faq_body = f'''
<div class="hero"><div class="wrap">
  <h1>FAQ</h1>
  <p class="lede">Straight answers. If yours isn't here, <a href="mailto:{SUPPORT}">{SUPPORT}</a> reaches a human.</p>
</div></div>

<section style="padding-top:10px"><div class="wrap">
  <div class="faq">
    <h2 style="text-align:left; font-size:20px; margin:18px 0 12px">The tracker</h2>
    <details><summary>Do I need an account just to look at cards?</summary>
      <p>No — the whole library is browsable without one. An account is what lets the app remember which cards are <em>yours</em>.</p></details>
    <details><summary>Is my collection data mine?</summary>
      <p>Yes. Export it as JSON whenever you like, on the free plan too. Your collection is keyed to card IDs, so it stays meaningful anywhere.</p></details>
    <details><summary>Does it work on my phone?</summary>
      <p>Yes — it installs from the browser like an app, and visited pages keep working offline.</p></details>
    <details><summary>Can I track 1st Editions, holos and stamps separately?</summary>
      <p>That's the whole point: every printing is its own tick with its own count, and custom printings can be added for the oddballs.</p></details>

    <h2 style="text-align:left; font-size:20px; margin:26px 0 12px">Premium &amp; payments</h2>
    <details><summary>What does Master Set Premium cost, and what's in it?</summary>
      <p>$2.99/month: unlimited binders now, the card scanner when it ships. The free account keeps full collection tracking and one binder, forever.</p></details>
    <details><summary>What happens to my binders if I cancel?</summary>
      <p>Your data is never deleted. Your first binder stays fully usable; binders beyond it lock — covers visible, contents kept — until you're Premium again. Everything comes back exactly as you left it.</p></details>
    <details><summary>How do payments work?</summary>
      <p>Through Stripe — card details never touch our servers. Cancel any time from <strong>Manage subscription</strong> on your Account page; your plan stays active through the period you've paid for.</p></details>

    <h2 style="text-align:left; font-size:20px; margin:26px 0 12px">The API</h2>
    <details><summary>How do I get an API token?</summary>
      <p>Pick a plan on the <a href="{API}/docs#plans">API docs page</a> — your token is minted the moment you subscribe, shown once. For the free tier (1,000 requests/mo), email <a href="mailto:{SUPPORT}">{SUPPORT}</a>.</p></details>
    <details><summary>Do card images cost API requests?</summary>
      <p>No. Images cost 0 against every plan, permanently — that's a standing policy of this project.</p></details>
    <details><summary>I lost my token.</summary>
      <p>Tokens are shown once and only their fingerprint is stored, so it can't be re-displayed. Email support: the old one gets revoked, a new one minted.</p></details>

    <h2 style="text-align:left; font-size:20px; margin:26px 0 12px">The project</h2>
    <details><summary>Is this affiliated with The Pokémon Company?</summary>
      <p>No. This is an independent fan-built tool. Card names and data are used descriptively to identify cards; no card artwork is sold, ever.</p></details>
    <details><summary>Who runs this?</summary>
      <p>A collector who wanted a proper master-set tracker and ended up building the whole thing — tracker, API, and all. Small by design; email actually gets read.</p></details>
  </div>
</div></section>
'''
page('faq.html', 'FAQ — Pkmn Master Set',
     'Answers about the Pkmn Master Set tracker, Master Set Premium, payments, cancellation, and the TCG Card API.',
     '/faq', faq_body, '/faq')

# ---------------- terms ----------------
terms_body = f'''
<div class="hero" style="padding-bottom:20px"><div class="wrap">
  <h1>Terms of Service</h1>
</div></div>
<p class="updated">Last updated: August 13, 2026</p>
<section style="padding-top:0"><div class="wrap"><div class="prose">
  <p>These terms are written in plain language on purpose. By using Pkmn Master Set (the tracker at mstr.pkmnmasterset.com)
     or the TCG Card API (api.pkmnmasterset.com) — together, "the Services" — you agree to them.</p>

  <h2>1. Who we are</h2>
  <p>The Services are operated by an individual proprietor based in South Carolina, USA ("we", "us").
     Contact: <a href="mailto:{SUPPORT}">{SUPPORT}</a>.</p>

  <h2>2. Your account</h2>
  <ul>
    <li>You're responsible for your account and keeping its password safe. Two-factor authentication is available and recommended.</li>
    <li>One person per account. Don't share accounts or use the Services to harm others or break the law.</li>
    <li>You must be at least 13 to create an account.</li>
  </ul>

  <h2>3. Your data</h2>
  <ul>
    <li><strong>Your collection is yours.</strong> You can export it as JSON at any time, on any plan.</li>
    <li>We never delete your data over money. If a subscription lapses, features lock — data stays.</li>
    <li>You can delete your account and its data by contacting support.</li>
  </ul>

  <h2>4. Subscriptions</h2>
  <ul>
    <li>Paid plans (Master Set Premium; API plans) bill monthly through Stripe, our payment processor and merchant of record. We never see or store card numbers.</li>
    <li>Cancel any time from <strong>Manage subscription</strong> on your Account page (tracker) or via your Stripe receipt (API). Paid features stay active through the period you've paid for.</li>
    <li>When Premium ends: your first binder stays usable; additional binders lock until you resubscribe. When an API subscription ends, its token stops working.</li>
    <li>Prices may change; existing subscribers get notice before any change affects them.</li>
  </ul>

  <h2>5. The API</h2>
  <ul>
    <li>Tokens are personal to the subscriber. Don't publish them; if one leaks, tell us and we'll replace it.</li>
    <li>Plans are metered by weighted requests with per-minute burst caps, as described in the <a href="{API}/docs">API documentation</a>. We may throttle abuse that threatens the service for others.</li>
    <li>Card <em>images</em> are never sold and never metered. The API serves factual card data.</li>
  </ul>

  <h2>6. Intellectual property</h2>
  <p>Pokémon and Pokémon character names are trademarks of their respective owners. The Services are an independent
     fan project, not affiliated with or endorsed by Nintendo, Creatures Inc., GAME FREAK inc., or The Pokémon Company
     International. Card data is used descriptively to identify cards. If you are a rights holder with a concern,
     email <a href="mailto:{SUPPORT}">{SUPPORT}</a> — we respond quickly.</p>

  <h2>7. The honest disclaimers</h2>
  <ul>
    <li>The Services are provided "as is". We run them carefully (backups, monitoring, security hardening) but can't promise perfection or uninterrupted availability.</li>
    <li>To the maximum extent permitted by law, our total liability for any claim is limited to the amount you paid us in the twelve months before the claim.</li>
    <li>We may update these terms; material changes will be announced on this page with a new date. Continuing to use the Services after a change means you accept it.</li>
  </ul>

  <h2>8. Governing law</h2>
  <p>These terms are governed by the laws of the State of South Carolina, USA.</p>
</div></div></section>
'''
page('terms.html', 'Terms of Service — Pkmn Master Set',
     'The plain-language terms for the Pkmn Master Set tracker and the TCG Card API.',
     None, terms_body, '/terms')

# ---------------- privacy ----------------
privacy_body = f'''
<div class="hero" style="padding-bottom:20px"><div class="wrap">
  <h1>Privacy Policy</h1>
</div></div>
<p class="updated">Last updated: August 13, 2026</p>
<section style="padding-top:0"><div class="wrap"><div class="prose">
  <p>Short version: we collect the minimum needed to run a collection tracker and an API, we don't run ads,
     we don't sell data, and payments are handled by Stripe so card numbers never touch our servers.</p>

  <h2>What we collect</h2>
  <ul>
    <li><strong>Account data:</strong> a username, a password (stored only as a modern salted hash), and — optionally — an
        email address used for verification and password resets.</li>
    <li><strong>Your collection:</strong> the cards, counts and binders you track. That's the product.</li>
    <li><strong>Payment data:</strong> handled entirely by Stripe, our merchant of record. We store only your Stripe customer
        reference and your plan — never card numbers.</li>
    <li><strong>API usage:</strong> per-token request counts, for quotas and billing.</li>
    <li><strong>Server logs &amp; metrics:</strong> standard technical logs and aggregate counters (requests, signups) for
        keeping the service healthy. No advertising trackers, no third-party analytics scripts, no fingerprinting.</li>
  </ul>

  <h2>What we do with it</h2>
  <ul>
    <li>Run the Services. That's it.</li>
    <li>We don't sell or share personal data with third parties, except Stripe (payments) and our infrastructure
        providers (hosting, DNS/CDN) as needed to operate.</li>
    <li>Emails are used for account security (verification, resets) — not marketing, unless you explicitly opt in to
        something later, which doesn't exist today.</li>
  </ul>

  <h2>Cookies</h2>
  <p>One httpOnly session cookie keeps you signed in. No advertising or cross-site cookies.</p>

  <h2>Your choices</h2>
  <ul>
    <li>Export your collection as JSON at any time.</li>
    <li>Use the tracker without an email address at all (you lose password recovery, but it's your call).</li>
    <li>Delete your account and its data by emailing <a href="mailto:{SUPPORT}">{SUPPORT}</a>.</li>
  </ul>

  <h2>Where data lives</h2>
  <p>On servers in the United States, encrypted in transit (HTTPS everywhere), with regular backups.
     Shared binder links are public to whoever holds the link — that's their purpose — and can be revoked by you at any time.</p>

  <h2>Changes</h2>
  <p>Material changes to this policy will be announced on this page with a new date.
     Questions: <a href="mailto:{SUPPORT}">{SUPPORT}</a>.</p>
</div></div></section>
'''
page('privacy.html', 'Privacy Policy — Pkmn Master Set',
     'What Pkmn Master Set collects (little), what it does with it (run the service), and what it never does (ads, tracking, selling data).',
     None, privacy_body, '/privacy')

print('done')
