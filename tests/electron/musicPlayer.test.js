'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
process.env.TOKEN_MONITOR_BILIBILI_FAVORITES_ID = '123';
const { videoBvidFromUrl, shouldAdvanceFromPlayback, allowedUrl, coverUrl, subtitleUrl, selectMusicSubtitle, captionAt, captionWindow, loadPlaylist, searchMusic, playerScript } = require('../../src/electron/musicPlayer');

test('music titlebar back button restores the previous Token view', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(html, /<div class="music-topline">\s*<button id="musicBackButton"[^>]*aria-label="返回 Token 主界面"/);
  assert.doesNotMatch(html.match(/<div class="app-title">[\s\S]*?<\/div>/)?.[0] || '', /musicBackButton/);
  assert.match(css, /\.shell\.music-open \.title-controls \.tabs[^}]*display: none !important/);
  assert.match(renderer, /musicBackButton\.addEventListener\('click', \(\) => \{ void setMusicOpen\(false\); \}\)/);
});

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

test("Bilibili autoplay and near-end rollover advance Token own queue", () => {
  assert.equal(videoBvidFromUrl('https://www.bilibili.com/video/BV1Qp4y1R7p2?p=1'), 'BV1Qp4y1R7p2');
  assert.equal(videoBvidFromUrl('https://example.com/watch'), '');
  const previous = { duration: 227, currentTime: 224 };
  assert.equal(shouldAdvanceFromPlayback(previous, { paused: false, currentTime: 1, videoBvid: 'BV1Qp4y1R7p2' }, 'BV1Qp4y1R7p2'), true);
  assert.equal(shouldAdvanceFromPlayback(previous, { paused: false, currentTime: 225, videoBvid: 'BV1Qp4y1R7p2' }, 'BV1Qp4y1R7p2'), false);
  assert.equal(shouldAdvanceFromPlayback(previous, { paused: true, currentTime: 0, videoBvid: 'BV1Qp4y1R7p2' }, 'BV1Qp4y1R7p2'), false);
  assert.equal(shouldAdvanceFromPlayback(previous, { paused: false, currentTime: 0, videoBvid: 'BV1vo4y1M7kW' }, 'BV1Qp4y1R7p2'), true);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'musicPlayer.js'), 'utf8');
  assert.match(source, /did-navigate-in-page/);
  assert.match(source, /const commandRevision = playbackRevision;[\s\S]*?commandRevision !== playbackRevision/);
  assert.match(source, /pageIndex: Math\.max\(0,.*location\?\.search/);
  assert.match(source, /const detectedPart = Number\.isInteger\(result\.pageIndex\)/);
  assert.doesNotMatch(source, /handledEnd = false; setStatus\('正在播放'\)/);
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

test('saved song title appears on the footer at startup without opening Bilibili', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert.match(main, /music:remembered.*readSavedTrack\(\)/);
  assert.match(preload, /getRememberedMusicTrack: \(\) => ipcRenderer\.invoke\('music:remembered'\)/);
  assert.match(renderer, /getRememberedMusicTrack\(\)\.then/);
  assert.match(renderer, /track && !musicOpen && !displayedMusicId/);
  assert.doesNotMatch(renderer.match(/getRememberedMusicTrack\(\)\.then\([\s\S]*?\.catch\(\(\) => \{\}\);/)?.[0] || '', /openMusic\(\)/);
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


test('subtitle requests use the logged-in Bilibili player session when available', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'musicPlayer.js'), 'utf8');
  assert.match(source, /browserSession \? browserSession\.fetch\(url, \{ \.\.\.options, credentials: 'include' \}\)/);
  assert.match(source, /const response = await fetchMusicSubtitle\(/);
  assert.match(source, /const captionsResponse = await fetchMusicSubtitle\(url\)/);
});

test('space toggles music only when the Token window is focused and hovered', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  assert.match(app, /!musicOpen \|\| event\.code !== 'Space' \|\| event\.repeat \|\| event\.isComposing/);
  assert.match(app, /!document\.hasFocus\(\) \|\| !els\.shell\.matches\(':hover'\)/);
  assert.match(app, /event\.target\?\.closest\?\.\('input, textarea, select, \[contenteditable\], \[role="textbox"\]'\)/);
  assert.match(app, /event\.preventDefault\(\);\s*els\.musicToggle\.click\(\)/);
});

test('subtitle URL stays on the Bilibili CDN and captions follow playback time', () => {
  assert.equal(subtitleUrl('//aisubtitle.hdslb.com/bfs/subtitle/test.json'), 'https://aisubtitle.hdslb.com/bfs/subtitle/test.json');
  assert.equal(subtitleUrl('https://evil.example/test.json'), '');
  const rows = [{ from: 1, to: 3, content: '第一句' }, { from: 3, to: 5, content: '第二句' }];
  assert.equal(captionAt(rows, 2), '第一句');
  assert.equal(captionAt(rows, 3), '第二句');
  assert.equal(captionAt(rows, 7), '');
});

test('subtitle track selection prefers manual Chinese and rejects unrelated languages', () => {
  const ai = { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/ai.json' };
  const manual = { lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/manual.json' };
  assert.equal(selectMusicSubtitle([ai, manual]), manual);
  assert.equal(selectMusicSubtitle([ai]), ai);
  assert.equal(selectMusicSubtitle([{ ...manual, lan_doc: '中文（自动生成）' }])?.lan, 'zh-CN');
  assert.equal(selectMusicSubtitle([{ lan: 'en-US', subtitle_url: manual.subtitle_url }]), null);
  assert.equal(selectMusicSubtitle([{ ...manual, subtitle_url: 'https://evil.example/subtitle.json' }]), null);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'musicPlayer.js'), 'utf8');
  assert.match(source, /for \(const endpoint of \['wbi\/v2', 'v2'\]\)/);
  assert.match(source, /credentials: 'include'/);
});

test('lyric window holds its line through short subtitle gaps', () => {
  const rows = [
    { from: 1, to: 2, content: '第一句' },
    { from: 3, to: 4, content: '第二句' },
    { from: 5, to: 6, content: '第三句' }
  ];
  assert.equal(captionWindow(rows, 2.5)?.current, '第一句');
  assert.deepEqual(captionWindow(rows, 3), {
    index: 1, previous: '第一句', current: '第二句', next: '第三句', future: ''
  });
  assert.equal(captionWindow(rows, 0), null);
  assert.equal(captionWindow([{ from: 1, to: 2, content: '第一句' }, { from: 10, to: 11, content: '第二句' }], 5), null);
  assert.equal(captionWindow(rows, 8), null);
});

test('timed lyric scrolls a fixed-height track without shifting the timeline', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(html, /musicPartsButton[\s\S]*?id="musicLyricTrack"[\s\S]*?id="musicLyricPrevious"[\s\S]*?id="musicNowLyricText"[\s\S]*?id="musicLyricNext"[\s\S]*?id="musicLyricFuture"[\s\S]*?id="musicSeek"/);
  assert.match(app, /musicNowLyric\.classList\.toggle\('hidden', !track \|\| !value\.hasCaptions\)/);
  assert.match(css, /\.music-now-lyric \{[^}]*height: 54px/);
  assert.match(css, /\.music-now-lyric\.is-advancing \.music-lyric-track \{[^}]*translateY\(-18px\)[^}]*transition: transform 380ms/);
  assert.match(app, /setTimeout\(finishMusicLyricTransition, 400\)/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(html, /id="musicSeek"[^>]*step="0.01"/);
  assert.match(app, /musicPendingSeek = pending/);
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'musicPlayer.js'), 'utf8');
  assert.match(main, /hasCaptions: captions\.length > 0/);
});

test('footer title and lyric scroll only while music is playing, including short titles', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(app, /title\.dataset\.playing !== 'true'/);
  assert.match(app, /musicFooterTitle\.dataset\.playing !== 'true'/);
  assert.match(app, /dataset\.playing = String\(value\.paused === false\)/);
  assert.doesNotMatch(app, /if \(width <= viewport \+ 2\) return/);
  assert.match(css, /#musicFooterTitle\.is-scrolling \{[^}]*animation: music-title-scroll/);
  assert.doesNotMatch(css, /hover #musicFooterTitle\.is-scrolling/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?#musicFooterTitle\.is-scrolling \{[^}]*animation: none/);
});


test('footer shows only the current track while the parts list locates the current part', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(html, /id="musicFooterTitle"/);
  assert.match(styles, /\.music-footer-lyric-viewport \{ display: none !important/);
  assert.match(app, /musicFooterLyricViewport\.classList\.add\('hidden'\)/);
  assert.match(app, /function scrollMusicPartsToCurrent\(\)/);
  assert.match(app, /musicPartsNeedsCurrentScroll/);
  assert.match(app, /musicCurrentPart\.textContent = parts\[partIndex\]/);
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

test('search loads later pages, deduplicates results and retains the complete playback queue', async () => {
  const original = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page') || 1);
    const records = page === 1
      ? [{ bvid: 'BV1xGBXYFEYg', title: '第一首', author: '歌手', duration: '3:00' }]
      : [{ bvid: 'BV1xGBXYFEYg', title: '重复', author: '歌手' }, { bvid: 'BV1vo4y1M7kW', title: '第二首', author: '歌手' }];
    return { ok: true, async json() { return { code: 0, data: { result: records, numPages: 2 } }; } };
  };
  try {
    const first = await searchMusic('all', '陈奕迅', 1);
    assert.equal(first.items.length, 1);
    assert.equal(first.hasMore, true);
    const second = await searchMusic('all', '陈奕迅', 2);
    assert.equal(second.items.length, 2);
    assert.equal(second.hasMore, false);
    assert.match(urls[1], /page=2/);
    const reset = await searchMusic('all', '另一首', 1);
    assert.equal(reset.items.length, 1);
  } finally { global.fetch = original; }
});

test('new tracks restart at zero while the saved track is restored paused', () => {
  const media = { readyState: 4, currentTime: 77 };
  assert.equal(vm.runInNewContext(playerScript('restart'), { document: { querySelector: () => media } }), true);
  assert.equal(media.currentTime, 0);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'musicPlayer.js'), 'utf8');
  assert.match(source, /resetPlaybackPosition = true;/);
  assert.match(source, /if \(savedTrack\) await playIndex\(0, \[savedTrack\], false\)/);
});

test('search controls and paused restoration are wired into the widget', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'musicPlayer.js'), 'utf8');
  for (const id of ['musicSearchButton', 'musicSearchPage', 'musicFavoriteSearchButton', 'musicFavoriteSearchInput']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /searchMusic\(scope, query, page\)/);
  assert.match(main, /restorePaused = !autoPlay/);
  assert.match(main, /if \(restorePaused\)/);
  assert.match(main, /if \(savedTrack\) await playIndex\(0, \[savedTrack\], false\)/);
});


test('hidden player prioritizes the actual Bilibili video and reports media error codes', () => {
  const media = { paused: true, ended: false, currentTime: 1, duration: 120, volume: 0.7, error: { code: 2 } };
  const state = vm.runInNewContext(playerScript('state'), { document: { querySelector: (selector) => selector.includes('.bpx-player-video-wrap video') ? media : null } });
  assert.equal(state.errorCode, 2);
  const locationState = vm.runInNewContext(playerScript('state'), { document: { querySelector: () => media }, location: { pathname: '/video/BV1Qp4y1R7p2' } });
  assert.equal(locationState.videoBvid, 'BV1Qp4y1R7p2');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'musicPlayer.js'), 'utf8');
  assert.match(source, /媒体网络错误/);
  assert.doesNotMatch(source, /正在尝试播放/);
});


test("search reports Bilibili 412 without exposing a raw IPC failure", async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 412 });
  try {
    await assert.rejects(searchMusic("all", "test"), /B 站暂时限制搜索/);
  } finally { global.fetch = original; }
});

test("music surface keeps the configured background visible and supports IME composition", () => {
  const root = path.join(__dirname, "..", "..", "src", "electron", "renderer");
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(css, /\.music-panel \{[^}]*background: rgba\(var\(--glass-rgb\), \.16\)/);
  assert.match(html, /id="musicSearchInput" type="text" inputmode="search"/);
  assert.match(renderer, /musicSearchInput\.addEventListener\(\x27compositionend\x27/);
  assert.match(renderer, /musicFavoriteSearchInput\.addEventListener\(\x27compositionend\x27/);
});


test("music search focuses inline inputs without opening a native dialog", () => {
  const root = path.join(__dirname, "..", "..", "src", "electron");
  const app = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
  assert.match(app, /musicSearchButton\.addEventListener\('click', \(\) => \{\s*showMusicPage\('search'\);\s*els\.musicSearchInput\.focus\(\)/);
  assert.match(app, /if \(open\) els\.musicFavoriteSearchInput\.focus\(\)/);
  assert.doesNotMatch(app + main + preload, /WindowsMusicInput|music:input|musicNativeInput/);
});

test('music header uses lowercase bilibili and four larger playback icons', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'musicPlayer.js'), 'utf8');
  assert.match(html, /id="musicSourceLabel">bilibili · 收藏夹/);
  assert.match(source, /label: 'bilibili'/);
  assert.match(css, /\.music-playback-controls button svg \{ width: 22px; height: 22px/);
  assert.match(css, /\.music-playback-controls \.music-play-button svg \{ width: 24px; height: 24px/);
});

test('play and pause use consistent SVG icons instead of font glyphs', () => {
  const root = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(html, /class="music-icon-play"/);
  assert.match(html, /class="music-icon-pause hidden"/);
  assert.match(app, /music-icon-play'\)\.classList\.toggle\('hidden', playing\)/);
  assert.match(css, /\.music-playback-controls \.music-play-button svg \{/);
  assert.match(css, /\.music-playback-controls button \{[^}]*padding: 0/);
  assert.doesNotMatch(css, /\.music-icon-play \{[^}]*translateX/);
});

test('opening favorites scrolls to the current track without stealing later manual scrolls', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  assert.match(app, /function showMusicQueue\(open\) \{[\s\S]*?musicQueueNeedsCurrentScroll = open/);
  assert.match(app, /list\.scrollTop \+= current\.getBoundingClientRect\(\)\.top - list\.getBoundingClientRect\(\)\.top/);
  assert.match(app, /musicPlaylist\[index\]\?\.id \|\| displayedMusicId/);
  assert.match(app, /if \(musicQueueOpen && musicQueueNeedsCurrentScroll && scrollMusicQueueToCurrent\(\)\)/);
});
