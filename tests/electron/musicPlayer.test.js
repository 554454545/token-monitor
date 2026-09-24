'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
process.env.TOKEN_MONITOR_BILIBILI_FAVORITES_ID = '123';
const { allowedUrl, coverUrl, subtitleUrl, captionAt, loadPlaylist, searchMusic, playerScript } = require('../../src/electron/musicPlayer');

test('music is the first action in the view menu without changing saved view order', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const menu = app.match(/function renderViewSwitcher\([\s\S]*?\n}\n/)[0];
  assert.ok(menu.indexOf('menu.append(musicItem)') < menu.indexOf('for (const id of order)'));
  assert.match(menu, /setMusicOpen\(true\)/);
  assert.match(app, /await window\.tokenMonitor\.openMusic\(\)/);
  assert.match(app, /getMusicPlaylist\(1\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="musicCover"/);
  assert.match(html, /id="musicTrackList"/);
  assert.doesNotMatch(html, /musicBrowserArea/);
  assert.doesNotMatch(menu.slice(menu.indexOf('const musicItem'), menu.indexOf('for (const id of order)')), /renderBreakdownChange/);
});

test('embedded music page accepts only secure Bilibili navigation', () => {
  assert.equal(allowedUrl('https://space.bilibili.com/123/favlist'), true);
  assert.equal(allowedUrl('https://www.bilibili.com/video/BV1example'), true);
  assert.equal(allowedUrl('http://www.bilibili.com/video/BV1example'), false);
  assert.equal(allowedUrl('https://bilibili.com.evil.example/'), false);
  assert.equal(allowedUrl('file:///etc/passwd'), false);
});

test('playback button reports actual media success and pause', async () => {
  let played = 0;
  let paused = 0;
  const media = {
    paused: true,
    play() { played += 1; this.paused = false; return Promise.resolve(); },
    pause() { paused += 1; this.paused = true; }
  };
  const document = { querySelector: () => media };
  const started = await vm.runInNewContext(playerScript('toggle'), { document });
  assert.equal(started.ok, true);
  assert.equal(started.message, '正在播放');
  assert.equal(played, 1);
  const stopped = await vm.runInNewContext(playerScript('toggle'), { document });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.message, '已暂停');
  assert.equal(paused, 1);
});

test('playback rejection is reported instead of claiming a network problem or success', async () => {
  const media = { paused: true, play() { return Promise.reject(Object.assign(new Error('source unavailable'), { name: 'NotSupportedError' })); } };
  const result = await vm.runInNewContext(playerScript('toggle'), { document: { querySelector: () => media } });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.message, /source unavailable/);
  const loading = await vm.runInNewContext(playerScript('toggle'), { document: { querySelector: () => null } });
  assert.equal(loading.retryable, true);
});

test('quality request prefers Bilibili 360p and cover URLs stay on the image CDN', () => {
  let selected = 0;
  const context = { window: { player: { setQuality(value) { selected = value; }, getQuality() { return selected; } } }, document: {} };
  assert.equal(vm.runInNewContext(playerScript('quality'), context), true);
  assert.equal(selected, 16);
  assert.equal(coverUrl('http://i0.hdslb.com/bfs/archive/example.jpg'), 'https://i0.hdslb.com/bfs/archive/example.jpg');
  assert.equal(coverUrl('https://evil.example/cover.jpg'), '');
});

test('cover images are allowed only from the Bilibili CDN', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /img-src 'self' data: https:\/\/\*\.hdslb\.com/);
  assert.doesNotMatch(main, /img-src[^\n]*https:\/\/\*\s/);
});

test('the last selected song is stored locally and restored on next open', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'musicPlayer.js'), 'utf8');
  assert.match(source, /music-player\.json/);
  assert.match(source, /const savedTrack = readSavedTrack\(\)/);
  assert.match(source, /saveBvid\(queue\[index\]\.bvid, queue\[index\]\)/);
  assert.match(source, /if \(savedTrack\) await playIndex\(0, \[savedTrack\], false\)/);
  assert.match(source, /startPlaybackWhenReady/);
});

test('public favorites list yields safe track metadata for the custom player', async () => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return { code: 0, data: { has_more: false, medias: [
        { bvid: 'BV1vo4y1M7kW', title: '六月的雨', cover: 'http://i0.hdslb.com/cover.jpg', duration: 231, upper: { name: '测试 UP' } },
        { bvid: '../not-a-video', title: 'invalid' }
      ] } };
    }
  });
  try {
    const result = await loadPlaylist(1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, '六月的雨');
    assert.equal(result.items[0].id, 'BV1vo4y1M7kW');
    assert.equal(result.items[0].sourceId, 'bilibili');
    assert.equal(result.items[0].cover, 'https://i0.hdslb.com/cover.jpg');
    assert.equal(result.hasMore, false);
  } finally {
    global.fetch = original;
  }
});


test('volume control is clamped and applied to the hidden media element', () => {
  const media = { volume: 1 };
  const document = { querySelector: () => media };
  assert.equal(vm.runInNewContext(playerScript('volume', 0.35), { document }), true);
  assert.equal(media.volume, 0.35);
  assert.equal(vm.runInNewContext(playerScript('volume', 2), { document }), true);
  assert.equal(media.volume, 1);
});

test('music UI exposes a compact footer, volume and multi-part selection', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'musicPlayer.js'), 'utf8');
  for (const id of ['musicVolume', 'musicPartsButton', 'musicPartsPage', 'musicPartsList', 'musicFooterTrack', 'musicFooterTitle']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(renderer, /musicCommand\('volume'/);
  assert.match(renderer, /musicCommand\('part'/);
  assert.match(main, /async function advancePartOrTrack\(\)/);
  assert.match(main, /if \(partIndex \+ 1 < parts.length\) return playPart\(partIndex \+ 1\)/);
  assert.match(main, /\?p=' \+ \(index \+ 1\)/);
});


test('volume popup sits beside next track and source metadata is UI data', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'musicPlayer.js'), 'utf8');
  assert.ok(html.indexOf('data-music-action="next"') < html.indexOf('id="musicVolumeButton"'));
  assert.match(html, /id="musicVolumePopover"/);
  assert.doesNotMatch(html, /music-volume-row/);
  assert.match(styles, /\.music-footer-track \{[^}]*background: transparent/);
  assert.match(main, /source: MUSIC_SOURCE/);
  assert.match(renderer, /value\.source\.label/);
  assert.match(renderer, /favoriteSearchResults \? 'select-search' : 'select'/);
});


test('multi-part picker stays inside the widget instead of using a native select', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.doesNotMatch(html, /<select id="musicParts"/);
  assert.match(html, /id="musicPartsBack"/);
  assert.match(app, /showMusicPage\('parts'\)/);
  assert.match(app, /showMusicPage\('now'\)/);
  assert.match(css, /\.music-parts-list \{[^}]*overflow: auto/);
  assert.match(css, /\.music-playback-controls \{[^}]*translateX\(22px\)/);
});


test('subtitle URL stays on the Bilibili CDN and captions follow playback time', () => {
  assert.equal(subtitleUrl('//aisubtitle.hdslb.com/bfs/subtitle/test.json'), 'https://aisubtitle.hdslb.com/bfs/subtitle/test.json');
  assert.equal(subtitleUrl('https://evil.example/test.json'), '');
  const rows = [{ from: 1, to: 3, content: '第一句' }, { from: 3, to: 5, content: '第二句' }];
  assert.equal(captionAt(rows, 2), '第一句');
  assert.equal(captionAt(rows, 3), '第二句');
  assert.equal(captionAt(rows, 7), '');
});

test('footer reserves at most two bounded lines for title and optional lyric', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(html, /id="musicFooterTitle"/);
  assert.match(html, /id="musicFooterLyricViewport"/);
  assert.match(styles, /\.music-footer-lyric-viewport \{[^}]*overflow: hidden/);
  assert.match(app, /musicFooterLyricViewport\.classList\.toggle\('hidden', !lyric\)/);
});


test('Bilibili search normalizes results without adding them to favorites', async () => {
  const original = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    return { ok: true, async json() {
      return url.includes('search/type')
        ? { code: 0, data: { result: [{ bvid: 'BV1xGBXYFEYg', title: '<em>中国好声音</em>', author: '歌手', pic: '//i1.hdslb.com/cover.jpg', duration: '2:48' }] } }
        : { code: 0, data: { medias: [{ bvid: 'BV1vo4y1M7kW', title: '六月的雨', upper: { name: 'UP' }, cover: 'https://i0.hdslb.com/cover.jpg', duration: 231 }] } };
    } };
  };
  try {
    const all = await searchMusic('all', '中国好声音');
    const favorites = await searchMusic('favorites', '六月的雨');
    assert.equal(all.items[0].title, '中国好声音');
    assert.equal(all.items[0].duration, 168);
    assert.equal(all.items[0].cover, 'https://i1.hdslb.com/cover.jpg');
    assert.equal(favorites.items[0].title, '六月的雨');
    assert.match(urls[0], /search_type=video/);
    assert.match(urls[1], /media_id=123/);
    assert.match(urls[1], /keyword=/);
  } finally { global.fetch = original; }
});

test('search controls and paused restoration are wired into the widget', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'musicPlayer.js'), 'utf8');
  for (const id of ['musicSearchButton', 'musicSearchPage', 'musicFavoriteSearchButton', 'musicFavoriteSearchInput']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /searchMusic\(scope, query\)/);
  assert.match(main, /restorePaused = !autoPlay/);
  assert.match(main, /if \(restorePaused\)/);
  assert.match(main, /if \(savedTrack\) await playIndex\(0, \[savedTrack\], false\)/);
});


test('hidden player prioritizes the actual Bilibili video and reports media error codes', () => {
  const media = { paused: true, ended: false, currentTime: 1, duration: 120, volume: 0.7, error: { code: 2 } };
  const state = vm.runInNewContext(playerScript('state'), { document: { querySelector: (selector) => selector.includes('.bpx-player-video-wrap video') ? media : null } });
  assert.equal(state.errorCode, 2);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'musicPlayer.js'), 'utf8');
  assert.match(source, /媒体网络错误/);
  assert.doesNotMatch(source, /正在尝试播放/);
});
