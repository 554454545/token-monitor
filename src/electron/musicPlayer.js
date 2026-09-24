'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, WebContentsView } = require('electron');
const { BROWSER_USER_AGENT } = require('../shared/browserUserAgent');

function favoritesMediaId() {
  const id = String(process.env.TOKEN_MONITOR_BILIBILI_FAVORITES_ID || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('请在本机 .env 中设置 B 站收藏夹 ID');
  return id;
}
const PAGE_SIZE = 40;
// UI consumes this source-neutral descriptor and normalized track ids; only this adapter knows BVIDs.
const MUSIC_SOURCE = Object.freeze({ id: 'bilibili', label: 'bilibili', collection: '收藏夹' });
let hostWindow = null;
let musicPage = null;
let playlist = [];
let activeQueue = playlist;
let searchResults = { all: [], favorites: [] };
let searchRevision = { all: 0, favorites: 0 };
let searchQueries = { all: '', favorites: '' };
let restorePaused = false;
let selectionRevision = 0;
let playbackRevision = 0;
let playbackReadPending = false;
let playlistPage = 0;
let hasMore = true;
let currentIndex = -1;
let status = '从收藏列表选择一首歌';
let playback = { paused: true, currentTime: 0, duration: 0 };
let ticker = null;
let navigationId = 0;
let handledEnd = false;
let ignorePlaybackRolloverUntil = 0;
let qualityApplied = false;
let autoplayPending = false;
let loadingPage = false;
let resetPlaybackPosition = false;
let savedBvid = '';
let parts = [];
let partIndex = 0;
let volume = 0.7;
let captions = [];
let captionRequest = 0;

function playerStatePath() { return path.join(app.getPath('userData'), 'music-player.json'); }

function readSavedTrack() {
  try {
    const value = JSON.parse(fs.readFileSync(playerStatePath(), 'utf8'));
    if (!/^BV[0-9A-Za-z]{10}$/.test(value?.bvid)) return null;
    return {
      id: value.bvid, bvid: value.bvid, sourceId: MUSIC_SOURCE.id,
      title: String(value.title || value.bvid), artist: String(value.artist || 'Bilibili'),
      cover: coverUrl(value.cover), duration: Math.max(0, Number(value.duration) || 0)
    };
  } catch (_) { return null; }
}

function saveBvid(bvid, track) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return;
  savedBvid = bvid;
  try {
    fs.writeFileSync(playerStatePath(), JSON.stringify({ bvid, title: track.title, artist: track.artist, cover: track.cover, duration: track.duration }), { mode: 0o600 });
  } catch (error) { setStatus('播放正常，但保存上次歌曲失败：' + error.message); }
}

function allowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'));
  } catch (_) { return false; }
}

function coverUrl(value) {
  try {
    const url = new URL(String(value || '').replace(/^http:/, 'https:').replace(/^\/\//, 'https://'));
    return url.protocol === 'https:' && (url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com')) ? url.href : '';
  } catch (_) { return ''; }
}

function subtitleUrl(value) {
  try {
    const url = new URL(String(value || '').startsWith('//') ? 'https:' + value : value);
    return url.protocol === 'https:' && (url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com')) ? url.href : '';
  } catch (_) { return ''; }
}

function videoBvidFromUrl(value) {
  try { return new URL(value).pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/)?.[1] || ''; }
  catch (_) { return ''; }
}

function shouldAdvanceFromPlayback(previous, current, expectedBvid) {
  if (current.videoBvid && current.videoBvid !== expectedBvid) return true;
  return Date.now() >= ignorePlaybackRolloverUntil && !current.paused && previous.duration >= 20 &&
    previous.currentTime >= previous.duration - 8 && current.currentTime < 6 &&
    current.currentTime + 8 < previous.currentTime;
}

function captionAt(rows, seconds) {
  const time = Number(seconds) || 0;
  return rows.find((row) => row.from <= time && time < row.to)?.content || '';
}

function captionWindow(rows, seconds) {
  const time = Number(seconds) || 0;
  const index = rows.findLastIndex((row) => row.from <= time);
  if (index < 0 || time >= rows[index].to + 2) return null;
  return { index, previous: rows[index - 1]?.content || '', current: rows[index].content,
    next: rows[index + 1]?.content || '', future: rows[index + 2]?.content || '' };
}

function fetchMusicSubtitle(url) {
  const options = { headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': BROWSER_USER_AGENT }, signal: AbortSignal.timeout(10000) };
  const browserSession = musicPage?.webContents?.session;
  return browserSession ? browserSession.fetch(url, { ...options, credentials: 'include' }) : fetch(url, options);
}

function selectMusicSubtitle(subtitles) {
  if (!Array.isArray(subtitles)) return null;
  const available = subtitles.filter((entry) => subtitleUrl(entry?.subtitle_url));
  return available.find((entry) => /^zh(?:[-_]|$)/i.test(entry.lan || '') && !/自动|ai/i.test(entry.lan_doc || '')) ||
    available.find((entry) => /^ai[-_]zh(?:[-_]|$)/i.test(entry.lan || '')) ||
    available.find((entry) => /^zh(?:[-_]|$)/i.test(entry.lan || '')) || null;
}

async function loadCaptions(index) {
  const request = ++captionRequest;
  captions = [];
  emitState();
  const bvid = activeQueue[currentIndex]?.bvid;
  const cid = parts[index]?.cid;
  if (!bvid || !Number.isSafeInteger(cid)) return;
  for (const endpoint of ['wbi/v2', 'v2']) {
    try {
      const response = await fetchMusicSubtitle(`https://api.bilibili.com/x/player/${endpoint}?bvid=${encodeURIComponent(bvid)}&cid=${cid}`);
      if (!response.ok) continue;
      const body = await response.json();
      if (request !== captionRequest) return;
      const selected = selectMusicSubtitle(body.code === 0 ? body.data?.subtitle?.subtitles : null);
      const url = subtitleUrl(selected?.subtitle_url);
      if (!url) continue;
      const captionsResponse = await fetchMusicSubtitle(url);
      if (!captionsResponse.ok) continue;
      const document = await captionsResponse.json();
      if (request !== captionRequest) return;
      const rows = Array.isArray(document.body) ? document.body.slice(0, 10000).flatMap((row) => {
        const from = Number(row.from);
        const to = Number(row.to);
        const content = String(row.content || '').trim();
        return Number.isFinite(from) && Number.isFinite(to) && to > from && content ? [{ from, to, content }] : [];
      }) : [];
      if (!rows.length) continue;
      captions = rows;
      emitState();
      return;
    } catch (_) { /* Try the other Bilibili subtitle endpoint; playback is independent. */ }
  }
}

function playerScript(action, value) {
  if (action === 'state') return '(() => { const m = document.querySelector(".bpx-player-video-wrap video, video, audio"); return m ? { paused: m.paused, ended: m.ended, currentTime: m.currentTime || 0, duration: Number.isFinite(m.duration) ? m.duration : 0, volume: m.volume, errorCode: m.error?.code || 0, videoBvid: globalThis.location?.pathname?.match(new RegExp("/video/(BV[0-9A-Za-z]{10})"))?.[1] || "", pageIndex: Math.max(0, (Number(globalThis.location?.search?.match(/[?&]p=(\\d+)/)?.[1]) || 1) - 1) } : { paused: true, ended: false, currentTime: 0, duration: 0, errorCode: 0 }; })()';
  if (action === 'volume') return '(() => { const m = document.querySelector(".bpx-player-video-wrap video, video, audio"); if (!m) return false; m.volume = ' + Math.max(0, Math.min(1, Number(value) || 0)) + '; return true; })()';
  if (action === 'toggle' || action === 'play') {
    return '(async () => { const m = document.querySelector(".bpx-player-video-wrap video, video, audio"); if (!m) return { ok: false, retryable: true, message: "播放器还在加载" }; if (' + (action === 'play' ? 'true' : 'm.paused') + ') { try { await m.play(); return { ok: !m.paused, message: m.paused ? "播放器未开始播放" : "正在播放" }; } catch (error) { return { ok: false, retryable: error?.name === "AbortError", message: "播放失败：" + (error?.message || error?.name || "未知错误") }; } } m.pause(); return { ok: true, message: "已暂停" }; })()';
  }
  if (action === 'pause') return '(() => { const m = document.querySelector(".bpx-player-video-wrap video, video, audio"); if (!m) return false; m.pause(); return true; })()';
  if (action === 'seek') return '(() => { const m = document.querySelector(".bpx-player-video-wrap video, video, audio"); if (!m || !Number.isFinite(m.duration)) return false; m.currentTime = Math.max(0, Math.min(m.duration, ' + (Number(value) || 0) + ')); return true; })()';
  if (action === 'restart') return '(() => { const m = document.querySelector(".bpx-player-video-wrap video, video, audio"); if (!m || m.readyState < 1) return false; m.currentTime = 0; return true; })()';
  if (action === 'quality') return '(() => { const p = window.player || window.__BILI_PLAYER__; if (typeof p?.setQuality === "function") { p.setQuality(16); return p.getQuality?.() === 16; } const a = [...document.querySelectorAll(".bpx-player-ctrl-quality-menu-item, [data-quality], [data-qn]")]; const low = a.find(x => /360[Pp]/.test(x.textContent || "") || x.dataset.quality === "16" || x.dataset.qn === "16"); if (low) { low.click(); return false; } return false; })()';
  return '';
}

function emitState() {
  if (!hostWindow || hostWindow.isDestroyed()) return;
  hostWindow.webContents.send('music:state', {
    track: activeQueue[currentIndex] || null, index: currentIndex, count: playlist.length,
    source: MUSIC_SOURCE, hasMore, status, qualityApplied, parts, partIndex, volume, ...playback, lyric: captionAt(captions, playback.currentTime), lyricWindow: captionWindow(captions, playback.currentTime), hasCaptions: captions.length > 0
  });
}

function emitPlaylist() {
  if (!hostWindow || hostWindow.isDestroyed()) return;
  hostWindow.webContents.send('music:playlist', { source: MUSIC_SOURCE, items: playlist, hasMore, index: activeQueue === playlist ? currentIndex : -1 });
}

function setStatus(value) { status = value; emitState(); }

async function loadPlaylist(page = 1) {
  const target = Math.max(1, Math.floor(Number(page) || 1));
  if (target <= playlistPage || (!hasMore && playlistPage)) return { items: playlist, hasMore, index: activeQueue === playlist ? currentIndex : -1 };
  const url = 'https://api.bilibili.com/x/v3/fav/resource/list?media_id=' + favoritesMediaId() + '&pn=' + target + '&ps=' + PAGE_SIZE + '&platform=web';
  const response = await fetch(url, {
    headers: { Referer: 'https://space.bilibili.com/', 'User-Agent': BROWSER_USER_AGENT },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('收藏列表请求失败：HTTP ' + response.status);
  const body = await response.json();
  if (body?.code !== 0 || !Array.isArray(body?.data?.medias)) throw new Error(body?.message || '收藏列表不可用');
  const incoming = body.data.medias.flatMap((media) => {
    if (!/^BV[0-9A-Za-z]{10}$/.test(String(media?.bvid || ''))) return [];
    return [{
      id: media.bvid, bvid: media.bvid, sourceId: MUSIC_SOURCE.id, title: String(media.title || '未命名视频'),
      artist: String(media.upper?.name || 'Bilibili'), cover: coverUrl(media.cover),
      duration: Math.max(0, Number(media.duration) || 0)
    }];
  });
  const seen = new Set(playlist.map((item) => item.bvid));
  playlist.push(...incoming.filter((item) => !seen.has(item.bvid) && seen.add(item.bvid)));
  playlistPage = target;
  hasMore = body.data.has_more === true;
  emitPlaylist();
  return { items: playlist, hasMore, index: activeQueue === playlist ? currentIndex : -1 };
}

function searchDuration(value) {
  const parts = String(value || '').split(':').map(Number);
  return parts.length >= 2 && parts.every(Number.isFinite) ? parts.reduce((total, part) => total * 60 + part, 0) : 0;
}

function searchTitle(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function searchMusic(scope, rawQuery, page = 1) {
  if (scope !== 'all' && scope !== 'favorites') return { items: [], hasMore: false };
  const query = String(rawQuery || '').trim().slice(0, 80);
  const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
  if (!query) {
    searchQueries[scope] = '';
    searchResults[scope] = [];
    return { items: [], hasMore: false };
  }
  if (requestedPage > 1 && searchQueries[scope] !== query) return { items: [], hasMore: false };
  if (requestedPage === 1) {
    searchQueries[scope] = query;
    searchResults[scope] = [];
  }
  const revision = ++searchRevision[scope];
  const url = scope === 'favorites'
    ? `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${favoritesMediaId()}&pn=${requestedPage}&ps=40&platform=web&keyword=${encodeURIComponent(query)}`
    : `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}&page=${requestedPage}`;
  const options = { credentials: 'include', headers: { Referer: scope === 'favorites' ? 'https://space.bilibili.com/' : 'https://www.bilibili.com/', 'User-Agent': BROWSER_USER_AGENT }, signal: AbortSignal.timeout(10000) };
  const browserSession = musicPage?.webContents?.session;
  const response = browserSession ? await browserSession.fetch(url, options) : await fetch(url, options);
  if (!response.ok) throw new Error(response.status === 412 ? 'B 站暂时限制搜索，请稍后重试' : '搜索失败：HTTP ' + response.status);
  const body = await response.json();
  if (body.code !== 0) throw new Error(body.message || '搜索不可用');
  const records = scope === 'favorites' ? body.data?.medias : body.data?.result;
  if (!Array.isArray(records)) return { items: [], hasMore: false };
  const incoming = records.flatMap((record) => {
    const bvid = String(record.bvid || '');
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return [];
    return [{ id: bvid, bvid, sourceId: MUSIC_SOURCE.id,
      title: searchTitle(record.title), artist: String(scope === 'favorites' ? record.upper?.name || 'Bilibili' : record.author || 'Bilibili'),
      cover: coverUrl(scope === 'favorites' ? record.cover : record.pic),
      duration: scope === 'favorites' ? Math.max(0, Number(record.duration) || 0) : searchDuration(record.duration) }];
  });
  const previous = requestedPage === 1 ? [] : searchResults[scope];
  const seen = new Set(previous.map((item) => item.bvid));
  const items = [...previous, ...incoming.filter((item) => !seen.has(item.bvid) && seen.add(item.bvid))];
  const pageCount = Number(body.data?.numPages);
  const hasMore = scope === 'favorites'
    ? body.data?.has_more === true
    : Number.isFinite(pageCount) && pageCount > 0 ? requestedPage < pageCount : records.length > 0;
  if (revision === searchRevision[scope] && query === searchQueries[scope]) searchResults[scope] = items;
  return { items, hasMore };
}

async function setQuality(page, id) {
  for (const delay of [0, 900, 2500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (id !== navigationId || page.isDestroyed()) return;
    try {
      if (await page.executeJavaScript(playerScript('quality'), true)) {
        qualityApplied = true;
        emitState();
        return;
      }
    } catch (_) { /* The player may not exist yet. */ }
  }
}

async function startPlaybackWhenReady(page, id) {
  for (let attempt = 0; attempt < 12 && autoplayPending; attempt += 1) {
    if (id !== navigationId || page.isDestroyed()) return;
    try {
      await page.executeJavaScript(playerScript('volume', volume), true);
      if (resetPlaybackPosition) {
        const reset = await page.executeJavaScript(playerScript('restart'), true);
        if (!reset) throw new Error('视频尚未就绪');
        resetPlaybackPosition = false;
      }
      const result = await page.executeJavaScript(playerScript('play'), true);
      if (result?.ok) { autoplayPending = false; setStatus('正在播放'); return; }
      if (result && !result.retryable) { autoplayPending = false; setStatus(result.message); return; }
    } catch (_) { /* Video element may still be loading. */ }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  if (autoplayPending && id === navigationId) setStatus('播放器未就绪，请点播放重试');
}

async function readPlayback() {
  if (playbackReadPending || !musicPage || musicPage.webContents.isDestroyed() || currentIndex < 0 || loadingPage) return;
  playbackReadPending = true;
  const revision = selectionRevision;
  const commandRevision = playbackRevision;
  try {
    const result = await musicPage.webContents.executeJavaScript(playerScript('state'), true);
    if (revision !== selectionRevision || commandRevision !== playbackRevision || loadingPage) return;
    if (!handledEnd && (result.ended || shouldAdvanceFromPlayback(playback, result, activeQueue[currentIndex]?.bvid))) {
      void finishCurrentPlayback();
      return;
    }
    if (resetPlaybackPosition && result.duration > 0 && (restorePaused || !autoplayPending)) {
      const reset = await musicPage.webContents.executeJavaScript(playerScript('restart'), true);
      if (reset) { resetPlaybackPosition = false; result.currentTime = 0; }
    }
    if (restorePaused && result.currentTime > 0.4) {
      await musicPage.webContents.executeJavaScript(playerScript('restart'), true);
      result.currentTime = 0;
    }
    if (restorePaused && !result.paused) {
      await musicPage.webContents.executeJavaScript(playerScript('pause'), true);
      return;
    }
    if (revision !== selectionRevision || commandRevision !== playbackRevision || loadingPage) return;
    const detectedPart = Number.isInteger(result.pageIndex) && result.pageIndex >= 0 && result.pageIndex < parts.length ? result.pageIndex : partIndex;
    if (detectedPart !== partIndex) {
      partIndex = detectedPart;
      captions = [];
      captionRequest += 1;
      emitState();
      void loadCaptions(detectedPart);
    }
    playback = result;
    if (result.errorCode) {
      const reason = { 1: '播放被中断', 2: '媒体网络错误', 3: '媒体解码失败', 4: '媒体格式不支持' }[result.errorCode] || '媒体错误';
      if (status !== '播放失败：' + reason) setStatus('播放失败：' + reason);
    } else emitState();
  } catch (_) { /* Navigation can replace the page during a poll. */ }
  finally { playbackReadPending = false; }
}

function attachMusicPlayerWindow(window) {
  if (!musicPage || hostWindow === window) return;
  if (hostWindow && !hostWindow.isDestroyed()) hostWindow.contentView.removeChildView(musicPage);
  hostWindow = window;
  window.contentView.addChildView(musicPage);
  musicPage.setVisible(false);
  emitPlaylist();
  emitState();
}

async function openMusicPlayer(window) {
  if (!window || window.isDestroyed()) return false;
  if (!musicPage) {
    const savedTrack = readSavedTrack();
    savedBvid = savedTrack?.bvid || '';
    const view = new WebContentsView({
      webPreferences: { partition: 'persist:bilibili-player', contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    musicPage = view;
    view.webContents.once('destroyed', () => {
      if (musicPage !== view) return;
      musicPage = null;
      loadingPage = false;
      hostWindow = null;
      if (ticker) clearInterval(ticker);
      ticker = null;
    });
    view.webContents.on('will-navigate', (event, url) => {
      if (!allowedUrl(url)) { event.preventDefault(); return; }
      const nextBvid = videoBvidFromUrl(url);
      if (!loadingPage && nextBvid && nextBvid !== activeQueue[currentIndex]?.bvid) {
        event.preventDefault();
        void finishCurrentPlayback();
      }
    });
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      const nextBvid = videoBvidFromUrl(url);
      if (!loadingPage && nextBvid && nextBvid !== activeQueue[currentIndex]?.bvid) void finishCurrentPlayback();
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('did-finish-load', () => {
      const id = ++navigationId;
      qualityApplied = false;
      void setQuality(view.webContents, id);
      if (autoplayPending && currentIndex >= 0 && view.webContents.getURL().includes('/video/')) {
        setStatus('正在准备播放');
        void startPlaybackWhenReady(view.webContents, id);
      }
    });
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) setStatus('页面加载失败：' + description);
    });
    view.webContents.on('media-started-playing', () => {
      if (restorePaused) { void view.webContents.executeJavaScript(playerScript('pause'), true).catch(() => {}); return; }
      if (loadingPage) return;
      setStatus('正在播放');
    });
    view.webContents.on('media-paused', () => { if (!loadingPage && !status.startsWith('播放失败：')) setStatus('已暂停'); });
    attachMusicPlayerWindow(window);
    view.setVisible(false);
    ticker = setInterval(() => { void readPlayback(); }, 400);
    void (async () => {
      try {
        if (savedTrack) await playIndex(0, [savedTrack], false);
        const restoredRevision = selectionRevision;
        await loadPlaylist(1);
        while (savedBvid && !playlist.some((item) => item.bvid === savedBvid) && hasMore && restoredRevision === selectionRevision) {
          await loadPlaylist(playlistPage + 1);
        }
        const savedIndex = playlist.findIndex((item) => item.bvid === savedBvid);
        if (savedTrack && restoredRevision === selectionRevision && savedIndex >= 0) {
          activeQueue = playlist;
          currentIndex = savedIndex;
          emitPlaylist();
          emitState();
        }
      } catch (error) { setStatus('恢复音乐失败：' + error.message); }
    })();
  } else {
    attachMusicPlayerWindow(window);
  }
  emitPlaylist();
  emitState();
  return true;
}

async function playIndex(index, queue = playlist, autoPlay = true) {
  if (!musicPage || !queue[index]) return false;
  const revision = ++selectionRevision;
  loadingPage = true;
  activeQueue = queue;
  currentIndex = index;
  restorePaused = !autoPlay;
  parts = [];
  partIndex = 0;
  captions = [];
  captionRequest += 1;
  autoplayPending = autoPlay;
  resetPlaybackPosition = true;
  saveBvid(queue[index].bvid, queue[index]);
  handledEnd = false;
  playback = { paused: true, currentTime: 0, duration: queue[index].duration, ended: false };
  setStatus('正在加载');
  emitPlaylist();
  const bvid = queue[index].bvid;
  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const body = await response.json();
      if (body.code === 0 && Array.isArray(body.data?.pages) && revision === selectionRevision) {
        parts = body.data.pages.map((part, i) => ({ number: i + 1, title: String(part.part || 'P' + (i + 1)), duration: Number(part.duration) || 0, cid: Number(part.cid) }));
      }
    }
  } catch (_) { /* Playback still works when part metadata is unavailable. */ }
  if (revision !== selectionRevision || !musicPage || musicPage.webContents.isDestroyed()) return false;
  emitState();
  void loadCaptions(0);
  try {
    await musicPage.webContents.loadURL('https://www.bilibili.com/video/' + bvid + '?p=1&qn=16');
    if (revision === selectionRevision && !autoPlay) setStatus('已暂停');
    return true;
  } finally { if (revision === selectionRevision) loadingPage = false; }
}

async function playPart(index) {
  if (currentIndex < 0 || index < 0 || index >= parts.length || !musicPage) return false;
  const revision = ++selectionRevision;
  loadingPage = true;
  partIndex = index;
  void loadCaptions(index);
  autoplayPending = true;
  resetPlaybackPosition = true;
  handledEnd = false;
  playback = { paused: true, currentTime: 0, duration: parts[index].duration, ended: false };
  setStatus('正在加载分段');
  try {
    await musicPage.webContents.loadURL('https://www.bilibili.com/video/' + activeQueue[currentIndex].bvid + '?p=' + (index + 1) + '&qn=16');
    return true;
  } finally { if (revision === selectionRevision) loadingPage = false; }
}

async function finishCurrentPlayback() {
  if (handledEnd || loadingPage) return;
  handledEnd = true;
  try {
    if (await advancePartOrTrack()) return;
    if (musicPage && !musicPage.webContents.isDestroyed()) {
      await musicPage.webContents.executeJavaScript(playerScript('pause'), true);
      playback.paused = true;
    }
    setStatus('已播放完当前列表');
  } catch (error) { setStatus('切换下一首失败：' + error.message); }
}

async function advancePartOrTrack() {
  if (partIndex + 1 < parts.length) return playPart(partIndex + 1);
  return advance(1);
}

async function advance(direction) {
  if (currentIndex < 0) return false;
  if (activeQueue === playlist && direction > 0 && currentIndex === playlist.length - 1 && hasMore) await loadPlaylist(playlistPage + 1);
  return playIndex(currentIndex + direction, activeQueue);
}

async function musicPlayerCommand(event, action, value) {
  if (!hostWindow || event.sender !== hostWindow.webContents || !musicPage || musicPage.webContents.isDestroyed()) return false;
  const page = musicPage.webContents;
  try {
    if (action === 'select') return playIndex(playlist.findIndex((item) => item.id === value), playlist);
    if (action === 'select-search') {
      const scope = value?.scope;
      const queue = searchResults[scope];
      return Array.isArray(queue) ? playIndex(queue.findIndex((item) => item.id === value.id), queue) : false;
    }
    if (action === 'part') return playPart(Number(value));
    if (action === 'volume') {
      volume = Math.max(0, Math.min(1, Number(value) || 0));
      const applied = await page.executeJavaScript(playerScript('volume', volume), true);
      emitState();
      return applied;
    }
    if (action === 'next' || action === 'previous') return advance(action === 'next' ? 1 : -1);
    if (action === 'seek') {
      playbackRevision += 1;
      ignorePlaybackRolloverUntil = Date.now() + 3000;
      resetPlaybackPosition = false;
      const applied = await page.executeJavaScript(playerScript('seek', value), true);
      if (applied) { playback.currentTime = Math.max(0, Math.min(playback.duration || 0, Number(value) || 0)); emitState(); }
      return applied;
    }
    if (action === 'toggle') {
      if (currentIndex < 0) return false;
      restorePaused = false;
      autoplayPending = false;
      if (resetPlaybackPosition) {
        const reset = await page.executeJavaScript(playerScript('restart'), true);
        if (reset) resetPlaybackPosition = false;
      }
      const result = await page.executeJavaScript(playerScript('toggle'), true);
      if (!result.ok && result.retryable) {
        autoplayPending = true;
        void startPlaybackWhenReady(page, navigationId);
      }
      if (result.ok) playback.paused = result.message === '已暂停';
      setStatus(result.message);
      return result.ok === true;
    }
  } catch (error) { setStatus('播放失败：' + error.message); }
  return false;
}

module.exports = {
  readSavedTrack, videoBvidFromUrl, shouldAdvanceFromPlayback, allowedUrl, coverUrl, subtitleUrl, selectMusicSubtitle, captionAt, captionWindow, loadPlaylist, searchMusic, playerScript, attachMusicPlayerWindow,
  musicPlayerCommand, openMusicPlayer
};
