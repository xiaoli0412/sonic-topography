import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 4173);
const dataDir = path.join(__dirname, 'data');
const playlistsPath = path.join(dataDir, 'playlists.json');

const neteaseHeaders = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0',
};

// 网易云音乐代理音源配置
// 主源保留原有官方接口行为；备选源使用常见的 NeteaseCloudMusicApi 风格公开镜像。
// 可通过编辑此数组增删改音源，enabled 设为 false 可临时禁用某个源。
const NETEASE_SOURCES = [
  {
    name: 'official',
    baseUrl: 'https://music.163.com',
    search: { method: 'POST', path: '/api/search/get/web', bodyType: 'form' },
    url: {
      path: '/api/song/enhance/player/url',
      params: (id) =>
        `?id=${encodeURIComponent(id)}&ids=%5B${encodeURIComponent(id)}%5D&br=320000`,
    },
    enabled: true,
  },
  {
    name: 'qijieya',
    baseUrl: 'https://163api.qijieya.cn',
    search: { method: 'GET', path: '/search' },
    url: { path: '/song/url', params: (id) => `?id=${encodeURIComponent(id)}&br=320000` },
    enabled: true,
  },
  {
    name: 'focalors',
    baseUrl: 'https://music-api.focalors.ltd',
    search: { method: 'GET', path: '/search' },
    url: { path: '/song/url', params: (id) => `?id=${encodeURIComponent(id)}&br=320000` },
    enabled: true,
  },
  {
    name: 'zm-armoe',
    baseUrl: 'https://zm.armoe.cn',
    search: { method: 'GET', path: '/search' },
    url: { path: '/song/url', params: (id) => `?id=${encodeURIComponent(id)}&br=320000` },
    enabled: true,
  },
];

const playableUrlCache = new Map();
const searchCache = new Map();
const playableUrlCacheTtl = 1000 * 60 * 10;
const searchCacheTtl = 1000 * 60 * 5;

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNeteaseSearch(source, keywords, limit) {
  const url = new URL(source.search.path, source.baseUrl);
  let response;

  if (source.search.method === 'POST' && source.search.bodyType === 'form') {
    const body = new URLSearchParams({
      s: keywords,
      type: '1',
      offset: '0',
      total: 'true',
      limit: String(limit),
    });
    response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'POST',
        headers: {
          ...neteaseHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
      15000
    );
  } else {
    url.searchParams.set('keywords', keywords);
    url.searchParams.set('type', '1');
    url.searchParams.set('offset', '0');
    url.searchParams.set('limit', String(limit));
    response = await fetchWithTimeout(url.toString(), { headers: neteaseHeaders }, 15000);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const songs = data?.result?.songs || [];
  return { success: songs.length > 0, data: songs };
}

function normalizeNeteaseSong(song) {
  const artistList = song.artists || song.ar || [];
  const albumName = song.album?.name || song.al?.name || '';
  return {
    id: song.id,
    name: song.name,
    artist: artistList
      .map((artist) => artist.name)
      .filter(Boolean)
      .join(' / '),
    album: albumName,
    duration: song.duration || song.dt || 0,
    fee: song.fee,
  };
}

async function fetchNeteaseUrl(source, id) {
  const suffix = source.url.params
    ? source.url.params(id)
    : `?id=${encodeURIComponent(id)}&br=320000`;
  const url = `${source.baseUrl}${source.url.path}${suffix}`;
  const response = await fetchWithTimeout(url, { headers: neteaseHeaders }, 8000);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const playableUrl = data?.data?.[0]?.url || null;
  return { success: Boolean(playableUrl), data: playableUrl };
}

async function trySources(requestFn, preferredSourceName = null) {
  const enabled = NETEASE_SOURCES.filter((source) => source.enabled);
  const errors = [];

  let orderedSources = enabled;
  if (preferredSourceName) {
    const preferredIndex = enabled.findIndex((source) => source.name === preferredSourceName);
    if (preferredIndex >= 0) {
      orderedSources = [
        enabled[preferredIndex],
        ...enabled.slice(0, preferredIndex),
        ...enabled.slice(preferredIndex + 1),
      ];
    }
  }

  for (const source of orderedSources) {
    try {
      const result = await requestFn(source);
      if (result && result.success) {
        return { source: source.name, data: result.data };
      }
      errors.push(`${source.name}: empty or unplayable result`);
    } catch (error) {
      errors.push(`${source.name}: ${error.message || 'unknown error'}`);
    }
  }

  throw new Error(`All Netease sources failed (${errors.join('; ')})`);
}

async function getNeteasePlayableUrl(
  id,
  { throwIfAllFail = false, preferredSourceName = null } = {}
) {
  const cached = playableUrlCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  try {
    const { data: playableUrl } = await trySources(
      (source) => fetchNeteaseUrl(source, id),
      preferredSourceName
    );
    playableUrlCache.set(id, {
      url: playableUrl,
      expiresAt: Date.now() + playableUrlCacheTtl,
    });
    return playableUrl;
  } catch (error) {
    playableUrlCache.set(id, {
      url: null,
      expiresAt: Date.now() + playableUrlCacheTtl,
    });
    if (throwIfAllFail) throw error;
    return null;
  }
}

async function filterPlayableSongs(rawSongs, resultLimit) {
  const playableSongs = [];
  const batchSize = 8;

  for (let i = 0; i < rawSongs.length && playableSongs.length < resultLimit; i += batchSize) {
    const batch = rawSongs.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (song) => ({
        song,
        playableUrl: await getNeteasePlayableUrl(String(song.id)),
      }))
    );

    for (const result of results) {
      if (result.playableUrl) playableSongs.push(result.song);
      if (playableSongs.length >= resultLimit) break;
    }
  }

  return playableSongs;
}

async function searchAllSources(keywords, limit, preferredSourceName = null) {
  const enabled = NETEASE_SOURCES.filter((source) => source.enabled);

  const settled = await Promise.allSettled(
    enabled.map(async (source) => {
      try {
        const result = await fetchNeteaseSearch(source, keywords, limit);
        if (!result.success || !result.data.length) return null;
        return { sourceName: source.name, songs: result.data };
      } catch (error) {
        return null;
      }
    })
  );

  const successful = settled
    .map((settledResult, index) =>
      settledResult.status === 'fulfilled' && settledResult.value
        ? { sourceName: enabled[index].name, songs: settledResult.value.songs }
        : null
    )
    .filter(Boolean);

  if (successful.length === 0) return null;

  const preferredSource = NETEASE_SOURCES.find(
    (source) => source.name === preferredSourceName && source.enabled
  );

  const songMap = new Map();
  for (const { sourceName, songs } of successful) {
    for (let position = 0; position < songs.length; position++) {
      const normalized = normalizeNeteaseSong(songs[position]);
      const existing = songMap.get(normalized.id);
      if (!existing) {
        songMap.set(normalized.id, {
          ...normalized,
          sources: [sourceName],
          positions: { [sourceName]: position },
        });
      } else {
        if (!existing.sources.includes(sourceName)) {
          existing.sources.push(sourceName);
        }
        if (
          existing.positions[sourceName] === undefined ||
          position < existing.positions[sourceName]
        ) {
          existing.positions[sourceName] = position;
        }
      }
    }
  }

  const merged = Array.from(songMap.values()).map((entry) => ({
    ...entry,
    bestPosition: Math.min(...Object.values(entry.positions)),
    hasPreferred: preferredSource ? entry.sources.includes(preferredSourceName) : false,
  }));

  merged.sort((a, b) => {
    if (a.hasPreferred && !b.hasPreferred) return -1;
    if (!a.hasPreferred && b.hasPreferred) return 1;
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return a.bestPosition - b.bestPosition;
  });

  return {
    songs: merged.map(({ positions, bestPosition, hasPreferred, ...song }) => song),
    source: 'merged',
  };
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function createDefaultPlaylists() {
  return [
    { id: 'favorites', name: 'Favorites', songs: [] },
    { id: 'visual-set', name: 'Visual Set', songs: [] },
  ];
}

function normalizePlaylists(value) {
  if (!Array.isArray(value) || value.length === 0) return createDefaultPlaylists();
  return value.map((playlist) => ({
    id: String(playlist.id || `playlist-${Date.now()}`),
    name: String(playlist.name || 'Playlist'),
    songs: Array.isArray(playlist.songs) ? playlist.songs : [],
  }));
}

async function readPlaylistsFile() {
  try {
    const raw = await fs.readFile(playlistsPath, 'utf8');
    return normalizePlaylists(JSON.parse(raw));
  } catch (error) {
    return createDefaultPlaylists();
  }
}

async function writePlaylistsFile(playlists) {
  await fs.mkdir(dataDir, { recursive: true });
  const normalized = normalizePlaylists(playlists);
  await fs.writeFile(playlistsPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

app.get('/api/playlists', async (_req, res) => {
  res.json({ playlists: await readPlaylistsFile() });
});

app.put('/api/playlists', async (req, res) => {
  try {
    const playlists = await writePlaylistsFile(req.body?.playlists);
    res.json({ playlists });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save playlists' });
  }
});

app.get('/api/netease/search', async (req, res) => {
  try {
    const keywords = String(req.query.keywords || '').trim();
    const requestedLimit = Number(req.query.limit || '12');
    const resultLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 20))
      : 12;
    const preferredSource = String(req.query.source || '').trim();

    if (!keywords) {
      res.status(400).json({ error: 'Missing keywords' });
      return;
    }

    const cacheKey = `${keywords.toLowerCase()}::${resultLimit}::${preferredSource || 'auto'}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ songs: cached.songs, source: cached.source, cached: true });
      return;
    }

    const fetchLimit = Math.min(resultLimit * 3, 60);
    const preferredSourceName =
      preferredSource && preferredSource !== 'auto' ? preferredSource : null;

    const result = await searchAllSources(keywords, fetchLimit, preferredSourceName);

    if (!result || result.songs.length === 0) {
      res.status(502).json({ error: 'Netease search failed: all sources unavailable' });
      return;
    }

    const playableSongs = await filterPlayableSongs(result.songs, resultLimit);

    if (playableSongs.length === 0) {
      res.status(502).json({ error: 'No playable songs found' });
      return;
    }

    searchCache.set(cacheKey, {
      songs: playableSongs,
      source: 'merged',
      expiresAt: Date.now() + searchCacheTtl,
    });

    res.json({ songs: playableSongs, source: 'merged' });
  } catch (error) {
    console.warn('Netease search failed:', error);
    res.status(502).json({ error: 'Netease search failed: all sources unavailable' });
  }
});

app.get('/api/netease/lyric', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    const response = await fetch(
      `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1`,
      { headers: neteaseHeaders }
    );
    const data = await response.json();
    res.json({
      lyric: data?.lrc?.lyric || '',
      translatedLyric: data?.tlyric?.lyric || '',
    });
  } catch (error) {
    res.status(500).json({ error: 'Netease lyric failed' });
  }
});

app.get('/api/netease/url', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    const preferredSource = String(req.query.source || '').trim();
    const url = await getNeteasePlayableUrl(id, {
      throwIfAllFail: true,
      preferredSourceName: preferredSource && preferredSource !== 'auto' ? preferredSource : null,
    });
    res.json({ url });
  } catch (error) {
    console.warn('Netease url failed:', error);
    res.status(502).json({ error: 'Netease url failed: all sources unavailable' });
  }
});

app.get('/api/netease/audio', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    const playableUrl = await getNeteasePlayableUrl(id);
    if (!playableUrl) {
      res.status(404).json({ error: 'No playable url for this song' });
      return;
    }

    const headers = { ...neteaseHeaders };
    if (req.headers.range) headers.Range = req.headers.range;

    const audioResponse = await fetch(playableUrl, { headers });
    res.status(audioResponse.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((header) => {
      const value = audioResponse.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'audio/mpeg');
    if (!audioResponse.body) {
      res.end();
      return;
    }

    const reader = audioResponse.body.getReader();
    let aborted = false;

    const stopPump = () => {
      if (aborted) return;
      aborted = true;
      reader.cancel().catch(() => {});
    };

    req.on('close', stopPump);
    res.on('error', stopPump);

    try {
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (aborted) break;
        const ok = res.write(Buffer.from(value));
        if (!ok) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      if (!aborted) res.end();
    } catch (error) {
      if (!aborted) {
        console.warn('Netease audio proxy stream error:', error.message || error);
      }
      try { res.destroy(); } catch {}
    }
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Netease audio proxy failed' });
    } else {
      res.destroy();
    }
  }
});

app.get('/api/netease/sources', async (_req, res) => {
  try {
    const checks = await Promise.all(
      NETEASE_SOURCES.map(async (source) => {
        if (!source.enabled) {
          return { ...source, reachable: false, error: 'disabled' };
        }
        try {
          const response = await fetchWithTimeout(source.baseUrl, { headers: neteaseHeaders }, 5000);
          return {
            name: source.name,
            baseUrl: source.baseUrl,
            enabled: source.enabled,
            reachable: response.status < 500,
            statusCode: response.status,
          };
        } catch (error) {
          return {
            name: source.name,
            baseUrl: source.baseUrl,
            enabled: source.enabled,
            reachable: false,
            error: error.message || 'unknown error',
          };
        }
      })
    );
    res.json({ sources: checks });
  } catch (error) {
    res.status(500).json({ error: 'Unable to check sources' });
  }
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Sonic Topography is running at http://127.0.0.1:${port}`);
});
