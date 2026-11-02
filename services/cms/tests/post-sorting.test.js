const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { SyncRunner } = require('../lib/sync');
const { DATA_DIR, writeJson } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite } = require('../lib/public');
const { serialize } = require('../lib/phpser');

test('post sorting uses full plain text and associated media before pagination', (t) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_DIR, 'post-sorting-test-'));
  const key = path.basename(dir);
  t.after(() => { dropSite(key); fs.rmSync(dir, { recursive: true, force: true }); });
  const posts = new Map();
  const postmeta = [];
  const addPost = (id, content, type = 'post', parent = 0, mime = '') => posts.set(id, {
    ID: id, post_type: type, post_status: type === 'attachment' ? 'inherit' : 'publish',
    post_content: content, post_title: `Post ${id}`, post_excerpt: '', post_date: '2026-01-01',
    post_author: 0, post_parent: parent, post_mime_type: mime, comment_count: 0,
  });
  addPost(1, `<p class="${'markup'.repeat(2000)}">One</p>`);
  addPost(2, '<p>Two words</p><img src="https://example.test/wp-content/uploads/2026/photo-small.jpg">');
  addPost(3, '<p>word '.repeat(1000) + 'end</p>');
  addPost(4, '<video src="https://example.test/wp-content/uploads/2026/video.mp4"></video>');
  addPost(5, '<img class="wp-image-103" src="https://example.test/wp-content/uploads/2026/photo-large-150x150.jpg">');
  for (let id = 6; id <= 30; id++) addPost(id, '');
  const media = (id, file, kind, parent, size, width, height, mime = `${kind}/${kind === 'image' ? 'jpeg' : 'mp4'}`) => {
    addPost(id, '', 'attachment', parent, mime);
    postmeta.push([id, '_wp_attached_file', file], [id, '_wp_attachment_metadata', serialize({
      file, filesize: size, width, height,
      sizes: id === 103 ? { thumbnail: { file: 'photo-large-150x150.jpg', width: 150, height: 150 } } : {},
    })]);
  };
  media(101, '2026/photo-small.jpg', 'image', 0, 100, 100, 200);
  media(102, '2026/video.mp4', 'video', 0, 2000, 1920, 1080);
  media(103, '2026/photo-large.jpg', 'image', 0, 500, 1000, 2000);
  media(104, '2026/video-small.mp4', 'video', 2, null, 640, 480);
  media(105, '2026/anim.gif', 'image', 6, null, null, null, 'image/gif');
  postmeta.push([1, '_thumbnail_id', '103']);
  writeJson(path.join(dir, 'uploads-index.json'), [
    { path: '2026/video-small.mp4', size: 1000, ext: 'mp4' },
    ...['2026/photo-small.jpg', '2026/photo-large.jpg', '2026/anim.gif'].map((p) => ({ path: p, size: 0, ext: p.split('.').pop(), image: true })),
  ]);
  const manifest = { key, site: 'Sort test', status: 'ready' };
  new SyncRunner().writeDb(path.join(dir, 'db.sqlite'), key, {
    posts, postmeta, terms: new Map(), rels: [], comments: [], users: new Map(), usermeta: [], options: {}, raw: [],
  }, { contentFormat: 'rendered', api: { siteUrl: 'https://example.test', requests: 0 }, manifest });
  writeJson(path.join(dir, 'manifest.json'), manifest);
  const site = getSite(key);
  const sorted = (sort) => site.posts({ sort, limit: 200 }).items;
  assert.equal(sorted('length')[0].id, 3);
  assert.equal(sorted('words')[0].id, 3);
  assert.equal(sorted('length_asc')[0].textLength, 0);
  assert.equal(sorted('words_asc')[0].wordCount, 0);
  const short = sorted('length').find((post) => post.id === 1);
  assert.equal(short.textLength, 3);
  assert.equal(short.wordCount, 1);
  for (const sort of ['photo_size', 'photo_pixels']) {
    assert.deepEqual(sorted(sort).slice(0, 3).map((post) => post.id), [5, 1, 2]);
    assert.equal(sorted(sort + '_asc')[0].id, 2);
    assert.equal(sorted(sort + '_asc').at(-1).photoSize, null);
  }
  for (const sort of ['video_size', 'video_pixels']) {
    assert.deepEqual(sorted(sort).slice(0, 2).map((post) => post.id), [4, 2]);
    assert.equal(sorted(sort + '_asc')[0].id, 2);
    assert.equal(sorted(sort + '_asc').at(-1).videoSize, null);
  }
  assert.equal(site.posts({ sort: 'length', limit: 1 }).items[0].id, 3);
  assert.equal(site.posts({ sort: 'length', limit: 1, page: 2 }).items[0].id, 2);
  assert.equal(site.posts({ sort: 'video_size', q: 'Post 2' }).items[0].id, 2);
  assert.equal(site.posts({ sort: 'length', status: 'draft' }).total, 0);
  assert.equal(site.posts({ sort: 'length' }).total, 30);
  const grouped = site.posts({ group_by: 'words' });
  assert.deepEqual(grouped.groups.map((group) => [group.id, group.count]), [
    ['empty', 27], ['short', 2], ['medium', 0], ['long', 1],
  ]);
  assert.deepEqual(site.posts({ group_by: 'words', group: 'long' }).items.map((post) => post.id), [3]);
  assert.equal(site.posts({ group_by: 'words', group: 'empty', limit: 1, page: 2 }).total, 27);
  assert.equal(site.posts({ group_by: 'words', group: 'empty', limit: 1, page: 2 }).items.length, 1);
  assert.equal(site.posts({ group_by: 'words', q: 'Post 3' }).groups.find((group) => group.id === 'long').count, 1);
  assert.equal(site.posts({ group_by: 'words', status: 'draft' }).groups.reduce((sum, group) => sum + group.count, 0), 0);
  assert.deepEqual([...site.exportPosts({ group_by: 'words', group: 'long' })].map((post) => post.id), [3]);
  assert.throws(() => site.posts({ group_by: 'invalid' }), /Unknown post grouping/);
  assert.throws(() => site.posts({ group: 'invalid' }), /Unknown post group/);
  assert.deepEqual(site.posts({}).imageTypes, [{ id: 'jpeg', count: 3 }, { id: 'gif', count: 1 }]);
  assert.deepEqual(site.posts({ image_type: 'gif' }).items.map((post) => post.id), [6]);
  assert.deepEqual(site.posts({ image_type: 'jpeg', sort: 'photo_size' }).items.map((post) => post.id), [5, 1, 2]);
  assert.equal(site.posts({ image_type: 'png' }).total, 0);
  assert.equal(site.posts({ group_by: 'words', image_type: 'gif' }).groups.find((group) => group.id === 'empty').count, 1);
  assert.deepEqual([...site.exportPosts({ image_type: 'gif' })].map((post) => post.id), [6]);
  const library = site.media({ source: 'library', format: 'gif' });
  assert.deepEqual(library.items.map((item) => item.id), [105]);
  assert.deepEqual(library.facets.format.find((f) => f.k === 'jpeg').n, 2);

  for (const [name, metric, low, high] of [
    ['words', 'wordCount', 300, 1000],
    ['photo_size', 'photoSize', 1048576, 5242880],
    ['video_size', 'videoSize', 10485760, 104857600],
    ['photo_pixels', 'photoPixels', 1000000, 8000000],
    ['video_pixels', 'videoPixels', 921600, 2073600],
  ]) {
    const metrics = site.postMetrics();
    const saved = [1, 2, 3, 4].map((id) => metrics.get(id)[metric]);
    [low - 1, low, high - 1, high].forEach((value, index) => { metrics.get(index + 1)[metric] = value; });
    assert.ok(site.posts({ group_by: name, group: 'short', ...(name === 'words' ? {} : { group: 'small' }) }).items.some((post) => post.id === 1));
    const middle = site.posts({ group_by: name, group: 'medium' }).items.map((post) => post.id);
    assert.ok(middle.includes(2) && middle.includes(3));
    assert.ok(site.posts({ group_by: name, group: name === 'words' ? 'long' : 'large' }).items.some((post) => post.id === 4));
    assert.equal(site.posts({ group_by: name }).groups.reduce((sum, group) => sum + group.count, 0), 30);
    saved.forEach((value, index) => { metrics.get(index + 1)[metric] = value; });
  }
  assert.equal(site.posts({ group_by: 'photo_size', group: 'unknown' }).total, 27);
  assert.equal(site.posts({ group_by: 'video_size', group: 'unknown' }).total, 28);

  const pub = new PublicSite(site, { brand: 'Public' });
  const uploads = path.join(dir, 'uploads');
  const trashDir = path.join(dir, 'trash');
  for (const f of ['2026/photo-small.jpg', '2026/photo-large.jpg', '2026/photo-large-150x150.jpg', '2026/video-small.mp4', '2026/anim.gif']) {
    fs.mkdirSync(path.dirname(path.join(uploads, f)), { recursive: true });
    fs.writeFileSync(path.join(uploads, f), 'x'.repeat(10));
  }
  const ids = (feed) => feed.items.map((x) => x.id);
  try {
    const info = pub.info();
    assert.deepEqual(info.types.map((x) => [x.id, x.total, x.remaining, x.round]), [['gif', 1, 1, 1], ['jpeg', 3, 3, 1], ['png', 0, 0, 1]]);
    const feed = pub.feed({ type: 'jpeg' });
    assert.deepEqual(feed.items.map((x) => [x.id, x.media.size]), [[1, 500], [5, 500], [2, 100]]);
    assert.match(feed.items[0].media.url, /photo-large\.jpg$/);
    assert.deepEqual(ids(pub.feed({ type: 'jpeg', order: 'asc' })), [2, 1, 5]);
    assert.deepEqual(ids(pub.feed({ type: 'jpeg', after: 1, limit: 1 })), [5]);
    assert.equal(pub.feed({ type: 'jpeg', after: 1, limit: 1 }).more, true);
    assert.equal(pub.feed({ type: 'jpeg', after: 5, limit: 1 }).more, false);
    assert.equal(pub.feed({ type: 'gif' }).items[0].id, 6);
    assert.throws(() => pub.feed({ type: 'svg' }), /Choose gif/);
    assert.throws(() => pub.vote(101, 'jpeg', 'like'), /Post not found/);
    assert.throws(() => pub.vote(2, 'jpeg', 'love'), /Invalid vote/);

    // Like keeps the post and takes it out of this round; undo puts it back.
    assert.deepEqual(pub.vote(2, 'jpeg', 'like'), { id: 2, type: 'jpeg', round: 1, vote: 'like', likes: 1, dislikes: 0, score: 1, deleted: false });
    assert.deepEqual(ids(pub.feed({ type: 'jpeg' })), [1, 5]);
    pub.vote(2, 'jpeg', 'none');
    assert.equal(pub.status('jpeg').remaining, 3);

    // Dislike deletes the post; media still used by a kept post stays in place.
    assert.equal(pub.vote(5, 'jpeg', 'dislike').deleted, true);
    assert.ok(fs.existsSync(path.join(uploads, '2026/photo-large.jpg')));
    assert.equal(pub.trashList().items[0].shared, 2);
    assert.equal(site.posts({}).total, 29);
    assert.equal(pub.text(5), null);
    assert.deepEqual(ids(pub.feed({ type: 'jpeg' })), [1, 2]);

    // Exclusively owned media moves to the trash folder and comes back on undo.
    pub.vote(2, 'jpeg', 'dislike');
    assert.ok(!fs.existsSync(path.join(uploads, '2026/photo-small.jpg')));
    assert.ok(fs.existsSync(path.join(trashDir, '2026/photo-small.jpg')));
    assert.ok(fs.existsSync(path.join(trashDir, '2026/video-small.mp4')));
    pub.vote(2, 'jpeg', 'none');
    assert.ok(fs.existsSync(path.join(uploads, '2026/photo-small.jpg')));
    assert.ok(!site.trashed.has(2));

    // Finishing a round starts the next one over the kept posts only.
    assert.throws(() => pub.nextRound('jpeg'), /still waiting/);
    pub.vote(2, 'jpeg', 'dislike');
    pub.vote(1, 'jpeg', 'like');
    assert.deepEqual(pub.status('jpeg'), { type: 'jpeg', round: 1, total: 1, remaining: 0, liked: 1, disliked: 2 });
    assert.deepEqual(pub.nextRound('jpeg'), { type: 'jpeg', round: 2, total: 1, remaining: 1, liked: 0, disliked: 0 });
    assert.deepEqual(ids(pub.feed({ type: 'jpeg' })), [1]);
    assert.deepEqual(pub.liked({}).items.map((x) => [x.id, x.likes, x.media.type]), [[1, 1, 'jpeg']]);
    assert.deepEqual(pub.importVotes([{ id: 6, vote: 'like', type: 'gif' }, { id: 999, vote: 'dislike' }, { id: 6, vote: 'dislike' }]), { liked: 1, deleted: 0 });
    assert.ok(!site.trashed.has(6));

    pub.restore(5);
    assert.ok(!site.trashed.has(5));
    assert.equal(pub.trashList().total, 1);

    const texts = pub.textList({});
    assert.equal(texts.items[0].id, 3);
    assert.equal(texts.total, 2);
    assert.equal(pub.textList({ sort: 'shortest' }).items[0].words, 1);
    assert.deepEqual(pub.textList({ q: 'Two words' }).items.map((x) => x.id), []);
    assert.equal(pub.text(3).words, 1001);
    assert.equal(pub.text(101), null);

    // Emptying the trash removes the post, its attachments and its files for good.
    assert.deepEqual(pub.emptyTrash(), { posts: 1, files: 2, bytes: 20 });
  } finally { pub.close(); }
  assert.ok(!fs.existsSync(trashDir));
  assert.ok(fs.existsSync(path.join(uploads, '2026/photo-large.jpg')));
  dropSite(key);
  const fresh = getSite(key);
  assert.equal(fresh.posts({}).total, 29);
  assert.equal(fresh.get(`SELECT COUNT(*) AS n FROM ${fresh.t('posts')} WHERE ID IN (2, 101, 104)`).n, 0);
  assert.equal(fresh.get(`SELECT COUNT(*) AS n FROM ${fresh.t('postmeta')} WHERE post_id IN (101, 104)`).n, 0);
  assert.ok(!fresh.index.some((x) => x.path === '2026/photo-small.jpg'));
  assert.equal(fresh.trashed.size, 0);
});
