(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FollowAudit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function usernameFromHref(href) {
    const m = String(href).match(/instagram\.com\/([^/?#]+)/i);
    return m ? m[1] : null;
  }

  function extractUsernames(data) {
    const out = [];
    if (!data) return out;
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (typeof item === 'string') {
        if (item.trim()) out.push(item.trim());
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const sld = item.string_list_data || item.stringListData || item.media_list_data;
      if (Array.isArray(sld)) {
        for (const entry of sld) {
          if (typeof entry === 'string') {
            if (entry.trim()) out.push(entry.trim());
          } else if (entry && typeof entry === 'object') {
            if (entry.value && String(entry.value).trim()) out.push(String(entry.value).trim());
            else if (entry.href) {
              const u = usernameFromHref(entry.href);
              if (u) out.push(u);
            }
          }
        }
      } else if (typeof item.value === 'string' && item.value.trim()) {
        out.push(item.value.trim());
      } else if (typeof item.username === 'string' && item.username.trim()) {
        out.push(item.username.trim());
      } else if (typeof item.href === 'string') {
        const u = usernameFromHref(item.href);
        if (u) out.push(u);
      }
    }
    return [...new Set(out)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  function setDiff(a, b) {
    const bs = new Set(b);
    return a.filter((x) => !bs.has(x));
  }

  function analyze(followersRaw, followingRaw) {
    const followers = extractUsernames(followersRaw);
    const following = extractUsernames(followingRaw);
    const followerSet = new Set(followers);
    const followingSet = new Set(following);
    return {
      followers,
      following,
      mutual: followers.filter((x) => followingSet.has(x)),
      notFollowingBack: following.filter((x) => !followerSet.has(x)),
      fans: followers.filter((x) => !followingSet.has(x)),
    };
  }

  function diffSnapshots(prev, curr) {
    return {
      newFollowers: setDiff(curr.followers, prev.followers),
      lostFollowers: setDiff(prev.followers, curr.followers),
      newFollowing: setDiff(curr.following, prev.following),
      lostFollowing: setDiff(prev.following, curr.following),
    };
  }

  function detectKind(filename) {
    const lower = String(filename || '').toLowerCase();
    if (lower.includes('following')) return 'following';
    if (lower.includes('follower')) return 'followers';
    return null;
  }

  function toCsv(usernames) {
    const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    return ['username', ...usernames.map(esc)].join('\n') + '\n';
  }

  return { extractUsernames, setDiff, analyze, diffSnapshots, detectKind, toCsv };
});
