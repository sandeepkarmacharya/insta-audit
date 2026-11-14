(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FollowAuditSample = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FIRST = ['ana', ' leo', 'mia', 'noah', 'zoe', 'kai', 'luna', 'omar', 'ivy', 'ethan', 'nina', 'adam', 'sara', 'liam', 'emma', 'lucas', 'ava', 'mason', 'chloe', 'logan', 'ruby', 'felix', 'ella', 'oscar', 'nora', 'diego', 'stella', 'hugo', 'mila', 'arthur'];
  const LAST = ['.photography', '_travels', 'daily', '.art', 'cooks', '_fitness', 'vibes', '.design', 'shots', '_official', 'blog', '.music', 'life', '_studio', 'gram', '.eats', 'adventures', '.code', 'world', 'fam'];

  function makeUsername(rnd) {
    const f = FIRST[Math.floor(rnd() * FIRST.length)].trim();
    const l = LAST[Math.floor(rnd() * LAST.length)];
    const n = Math.floor(rnd() * 900 + 100);
    return f + l + n;
  }

  function toInstagramExport(usernames) {
    return usernames.map((u, i) => ({
      string_list_data: [
        {
          href: 'https://www.instagram.com/' + u,
          value: u,
          timestamp: 1700000000 + i * 86400,
        },
      ],
    }));
  }

  function generate(seed) {
    const rnd = mulberry32(seed == null ? 42 : seed);
    const pool = [];
    const seen = new Set();
    while (pool.length < 220) {
      const u = makeUsername(rnd);
      if (!seen.has(u)) {
        seen.add(u);
        pool.push(u);
      }
    }
    const followers = pool.slice(0, 140).sort();
    const following = pool.slice(60, 200).sort();
    return {
      followersRaw: toInstagramExport(followers),
      followingRaw: toInstagramExport(following),
    };
  }

  return { generate, toInstagramExport };
});
