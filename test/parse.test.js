'use strict';

const assert = require('node:assert/strict');
const FA = require('../lib/parse.js');
const Sample = require('../lib/sample.js');

// --- extractUsernames: Instagram export format (string_list_data) ---
const igFollowers = [
  { string_list_data: [{ href: 'https://www.instagram.com/alice', value: 'alice', timestamp: 1700000000 }] },
  { string_list_data: [{ href: 'https://www.instagram.com/bob', value: 'bob', timestamp: 1700000100 }] },
  { string_list_data: [{ href: 'https://www.instagram.com/alice', value: 'alice', timestamp: 1700000200 }] }, // dup
];
assert.deepEqual(FA.extractUsernames(igFollowers), ['alice', 'bob'], 'parses IG export, dedupes, sorts');

// href-only fallback
const hrefOnly = [{ string_list_data: [{ href: 'https://www.instagram.com/carol/?hl=en' }] }];
assert.deepEqual(FA.extractUsernames(hrefOnly), ['carol'], 'extracts username from href when value missing');

// plain string arrays and mixed shapes
assert.deepEqual(FA.extractUsernames(['dave', 'erin']), ['dave', 'erin'], 'plain strings');
assert.deepEqual(FA.extractUsernames([{ username: 'frank' }, { value: 'grace' }]), ['frank', 'grace'], 'flat objects');
assert.deepEqual(FA.extractUsernames(null), [], 'null-safe');
assert.deepEqual(FA.extractUsernames('nope'), ['nope'], 'bare string treated as one username');
assert.deepEqual(FA.extractUsernames(42), [], 'non-string/object input safe');

// --- analyze: the "not following back" question ---
const followersRaw = [{ string_list_data: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] }];
const followingRaw = [{ string_list_data: [{ value: 'b' }, { value: 'c' }, { value: 'd' }, { value: 'e' }] }];
const a = FA.analyze(followersRaw, followingRaw);
assert.deepEqual(a.followers, ['a', 'b', 'c']);
assert.deepEqual(a.following, ['b', 'c', 'd', 'e']);
assert.deepEqual(a.notFollowingBack, ['d', 'e'], 'following but not followers');
assert.deepEqual(a.fans, ['a'], 'followers but not following');
assert.deepEqual(a.mutual, ['b', 'c']);

// --- diffSnapshots: unfollowers between two exports ---
const snap1 = { followers: ['a', 'b', 'c'], following: ['b', 'x'] };
const snap2 = { followers: ['a', 'c', 'd'], following: ['b', 'y'] };
const d = FA.diffSnapshots(snap1, snap2);
assert.deepEqual(d.newFollowers, ['d'], 'new followers');
assert.deepEqual(d.lostFollowers, ['b'], 'unfollowed you');
assert.deepEqual(d.newFollowing, ['y']);
assert.deepEqual(d.lostFollowing, ['x'], 'you unfollowed');

// --- detectKind ---
assert.equal(FA.detectKind('followers_1.json'), 'followers');
assert.equal(FA.detectKind('following.json'), 'following');
assert.equal(FA.detectKind('Following_2.JSON'), 'following');
assert.equal(FA.detectKind('random.json'), null);

// --- toCsv ---
const csv = FA.toCsv(['we"ird', 'plain']);
assert.equal(csv, 'username\n"we""ird"\n"plain"\n', 'CSV escapes quotes');

// --- sample data round-trip through the real parser ---
const sample = Sample.generate(42);
const sa = FA.analyze(sample.followersRaw, sample.followingRaw);
assert.ok(sa.followers.length === 140, 'sample followers count');
assert.ok(sa.following.length === 140, 'sample following count');
assert.ok(sa.notFollowingBack.length > 0 && sa.fans.length > 0 && sa.mutual.length > 0, 'sample has all categories');
const sd = FA.diffSnapshots(
  { followers: sa.followers, following: sa.following },
  { followers: sa.followers.slice(0, -5), following: sa.following.slice(0, -3) }
);
assert.equal(sd.lostFollowers.length, 5, 'diff detects removed followers');
assert.equal(sd.lostFollowing.length, 3, 'diff detects removed following');
assert.equal(sd.newFollowers.length, 0, 'no new followers when list only shrank');

console.log('All tests passed ✓');
