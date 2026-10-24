const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// Serve frontend static files
const frontendPath = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendPath));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const rooms = {};

app.get('/api/lyrics', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
    
    // Dynamic import for node-fetch since it's an ES module in newer versions, or use native fetch if Node 18+
    // Node 18+ has native fetch. Let's assume Node 18+ for this project.
    const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
      headers: {
        'User-Agent': 'SpaceMusicApp/1.0.0 (https://github.com/SpaceMusic)'
      }
    });
    
    if (!response.ok) {
      throw new Error(`LRCLIB returned ${response.status}`);
    }
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Lyrics fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCTe4ziR_pturPtJuicCu5Fpc-CQ0wLF6Q';

// YouTube Search Proxy — avoids CORS issues & keeps API key server-side
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

    // Step 1: Search for videos in Music category
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=id&q=${encodeURIComponent(q)}&type=video&videoCategoryId=10&videoEmbeddable=true&videoSyndicated=true&maxResults=20&key=${YOUTUBE_API_KEY}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) {
      const errData = await searchRes.json().catch(() => ({}));
      return res.status(searchRes.status).json({ error: `YouTube search failed: ${searchRes.status}`, details: errData });
    }
    const searchData = await searchRes.json();

    if (!searchData.items || searchData.items.length === 0) {
      return res.json([]);
    }

    const videoIds = searchData.items.map(it => it.id?.videoId).filter(Boolean);
    if (videoIds.length === 0) return res.json([]);

    // Step 2: Fetch video details — duration + embeddable check
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,status&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`;
    const detailsRes = await fetch(detailsUrl);
    if (!detailsRes.ok) return res.status(detailsRes.status).json({ error: 'YouTube details fetch failed' });
    const detailsData = await detailsRes.json();
    if (!detailsData.items) return res.json([]);

    const shortsKeywords = ['#shorts', '#short', 'shorts', 'short', 'tiktok', 'reels', 'whatsapp status', 'status video'];

    const cleanVideos = detailsData.items
      .filter(it => {
        if (it.status && it.status.embeddable === false) return false;
        const dur = parseIsoDuration(it.contentDetails?.duration);
        if (dur < 75) return false; // Shorts are < 75s
        const titleLower = (it.snippet?.title || '').toLowerCase();
        return !shortsKeywords.some(kw => titleLower.includes(kw));
      })
      .map(it => ({
        id: { videoId: it.id },
        videoId: it.id,
        snippet: it.snippet
      }));

    res.json(cleanVideos);
  } catch (err) {
    console.error('Search proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Catch-all handler for React Router (Express 5 wildcard syntax)
app.get('{*splat}', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

function decodeHtml(html) {
  if (!html) return '';
  return html
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractKeywordsForRelated(item) {
  if (!item) return { cleanTitle: 'top hit songs', primaryArtist: '', channel: '' };
  const rawTitle = decodeHtml(item.title || '');
  const cleanTitle = rawTitle.split(/\||-|\[|\(/)[0].trim();
  const channel = (item.channel || '').replace(/- Topic/i, '').trim();

  const parts = rawTitle.split(/\||-/);
  const artists = [];
  if (channel && !/vevo|series|records|music|company|studio/i.test(channel)) {
    artists.push(channel);
  }
  for (const part of parts.slice(1)) {
    const trimmed = part.trim();
    if (trimmed.length > 2 && trimmed.length < 35 && !/official|video|4k|lyric|audio|song|full/i.test(trimmed)) {
      artists.push(trimmed);
    }
  }

  const primaryArtist = artists[0] || channel || '';
  return { cleanTitle, primaryArtist, channel };
}

function parseIsoDuration(duration) {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);
  return hours * 3600 + minutes * 60 + seconds;
}

async function fetchRelatedSongs(item) {
  try {
    const { cleanTitle, primaryArtist, channel } = extractKeywordsForRelated(item);
    const queryList = [
      `${cleanTitle} ${primaryArtist} official song`,
      `${primaryArtist} hit songs audio`,
      `${cleanTitle} original song`,
      `${channel} full song`
    ].filter(Boolean);

    const selectedQuery = queryList[Math.floor(Math.random() * queryList.length)] || `${cleanTitle} songs`;
    
    // Add videoEmbeddable=true & videoSyndicated=true to prevent unplayable videos
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=id&q=${encodeURIComponent(selectedQuery)}&type=video&videoCategoryId=10&videoEmbeddable=true&videoSyndicated=true&maxResults=20&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(searchUrl);
    if (!res.ok) {
      console.warn(`YouTube search returned status ${res.status}`);
      return [];
    }
    const data = await res.json();
    if (!data.items || data.items.length === 0) return [];

    const videoIds = data.items.map(it => it.id?.videoId).filter(Boolean);
    if (videoIds.length === 0) return [];

    // Fetch video details to verify duration (strictly exclude shorts < 75s) and check embeddable status
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,status&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`;
    const detailsRes = await fetch(detailsUrl);
    if (!detailsRes.ok) return [];
    const detailsData = await detailsRes.json();
    if (!detailsData.items) return [];

    const blacklist = [
      '#shorts', '#short', 'shorts', 'short', 'tiktok', 'reels', 'whatsapp status', 'status video',
      'jukebox', 'nonstop', 'full album', 'top 10', 'top 20', 'best of', 'mashup', 'slowed', '1 hour', '2 hour'
    ];
    
    const candidates = detailsData.items.filter(it => {
      if (!it.id || it.id === item.videoId) return false;
      if (it.status && it.status.embeddable === false) return false;

      // Filter out shorts (< 75 seconds is a Short!)
      const durationSeconds = parseIsoDuration(it.contentDetails?.duration);
      if (durationSeconds < 75) return false;

      const titleLower = (it.snippet?.title || '').toLowerCase();
      return !blacklist.some(b => titleLower.includes(b));
    }).map(it => ({
      videoId: it.id,
      title: decodeHtml(it.snippet.title),
      channel: it.snippet.channelTitle,
      thumbnail: it.snippet.thumbnails?.high?.url || it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || `https://img.youtube.com/vi/${it.id}/default.jpg`
    }));

    // Randomize/shuffle like YouTube Radio / Autoplay
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    return candidates.slice(0, 8);
  } catch (err) {
    console.error('Failed to fetch related songs:', err);
    return [];
  }
}

async function populateQueueWithRelated(roomId, item, overwrite = false) {
  const room = rooms[roomId];
  if (!room) return;
  const related = await fetchRelatedSongs(item);
  if (!rooms[roomId]) return;

  const existingIds = new Set([rooms[roomId].currentSong, ...rooms[roomId].queue.map(q => q.videoId)]);
  const newSongs = related.filter(s => !existingIds.has(s.videoId));

  if (newSongs.length === 0) return;

  if (overwrite) {
    rooms[roomId].queue = newSongs;
  } else {
    rooms[roomId].queue.push(...newSongs);
  }

  io.to(roomId).emit('queue_update', rooms[roomId].queue);
}

async function playNextSong(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.queue.length > 0) {
    const nextItem = room.queue.shift();
    if (room.songDetails) {
      if (!room.history) room.history = [];
      room.history.push(room.songDetails);
      if (room.history.length > 20) room.history.shift();
    }
    room.currentSong = nextItem.videoId;
    room.songDetails = nextItem;
    room.isPlaying = true;
    room.timestamp = 0;

    io.to(roomId).emit('play_new_song', { videoId: nextItem.videoId, details: nextItem, timestamp: 0 });
    io.to(roomId).emit('queue_update', room.queue);

    if (room.queue.length < 3) {
      populateQueueWithRelated(roomId, nextItem, false);
    }
  } else {
    const baseItem = room.songDetails || room.lastDetails;
    if (baseItem) {
      const related = await fetchRelatedSongs(baseItem);
      if (related.length > 0 && rooms[roomId]) {
        const nextItem = related[0];
        const rest = related.slice(1);
        room.queue = rest;
        room.currentSong = nextItem.videoId;
        room.songDetails = nextItem;
        room.isPlaying = true;
        room.timestamp = 0;

        io.to(roomId).emit('play_new_song', { videoId: nextItem.videoId, details: nextItem, timestamp: 0 });
        io.to(roomId).emit('queue_update', room.queue);
        return;
      }
    }
    room.currentSong = null;
    room.songDetails = null;
    room.isPlaying = false;
    room.timestamp = 0;
    io.to(roomId).emit('stop_song', {});
  }
}

function getOrCreateRoom(roomId) {
  const cleanRoomId = (roomId || '').trim().toUpperCase();
  if (!cleanRoomId) return null;
  if (!rooms[cleanRoomId]) {
    rooms[cleanRoomId] = {
      currentSong: null,
      songDetails: null,
      isPlaying: false,
      timestamp: 0,
      hostId: null,
      users: [],
      queue: [],
      history: []
    };
  }
  return rooms[cleanRoomId];
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join_room', ({ roomId, username }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    if (!cleanRoomId) return;
    socket.join(cleanRoomId);
    
    const room = getOrCreateRoom(cleanRoomId);
    
    // Check if user already exists (reconnect case)
    const existingUser = room.users.find(u => u.id === socket.id);
    if (!existingUser) {
      room.users.push({ id: socket.id, username: username || 'Guest' });
    }

    // First user becomes host
    if (!room.hostId) {
      room.hostId = socket.id;
    }
    
    // Send current room state including hostSocketId to the newly joined user
    socket.emit('room_state', { ...room, hostSocketId: room.hostId });
    socket.to(cleanRoomId).emit('user_joined', { users: room.users });
  });

  // Adding multiple songs to the queue
  socket.on('append_multiple_to_queue', ({ roomId, items }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    const room = getOrCreateRoom(cleanRoomId);
    if (room && Array.isArray(items)) {
      room.queue.push(...items);
      io.to(cleanRoomId).emit('queue_update', room.queue);
    }
  });

  // Adding a single song to the queue
  socket.on('add_to_queue', ({ roomId, item }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    if (!cleanRoomId || !item) return;
    socket.join(cleanRoomId);
    const room = getOrCreateRoom(cleanRoomId);
    if (room.hostId && socket.id !== room.hostId) return; // host only

    if (!room.currentSong) {
      room.currentSong = item.videoId;
      room.songDetails = item;
      room.isPlaying = true;
      room.timestamp = 0;
      io.to(cleanRoomId).emit('play_new_song', { videoId: item.videoId, details: item, timestamp: 0 });
      populateQueueWithRelated(cleanRoomId, item, true);
    } else {
      room.queue.push(item);
      io.to(cleanRoomId).emit('queue_update', room.queue);
    }
  });

  // Playing a song immediately across all users
  socket.on('play_now', ({ roomId, item }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    if (!cleanRoomId || !item) return;
    socket.join(cleanRoomId);
    const room = getOrCreateRoom(cleanRoomId);
    if (room.hostId && socket.id !== room.hostId) return; // host only

    if (room.songDetails) {
      if (!room.history) room.history = [];
      room.history.push(room.songDetails);
      if (room.history.length > 20) room.history.shift();
    }
    room.currentSong = item.videoId;
    room.songDetails = item;
    room.isPlaying = true;
    room.timestamp = 0;

    console.log(`[play_now] Room ${cleanRoomId} playing: ${item.title} (${item.videoId})`);
    io.to(cleanRoomId).emit('play_new_song', { videoId: item.videoId, details: item, timestamp: 0 });

    // Automatically generate and attach random related songs to queue like YouTube
    populateQueueWithRelated(cleanRoomId, item, true);
  });

  // Skip to next song
  socket.on('skip_song', ({ roomId }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    if (cleanRoomId) {
      socket.join(cleanRoomId);
      const room = getOrCreateRoom(cleanRoomId);
      if (room.hostId && socket.id !== room.hostId) return; // host only
      const now = Date.now();
      if (room.lastEndTrigger && (now - room.lastEndTrigger < 2000)) return; // debounce rapid clicks
      room.lastEndTrigger = now;
      playNextSong(cleanRoomId);
    }
  });

  // Play previous song from history
  socket.on('prev_song', ({ roomId }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    const room = rooms[cleanRoomId];
    if (room && room.hostId && socket.id !== room.hostId) return; // host only
    if (room && room.history && room.history.length > 0) {
      const prevItem = room.history.pop();
      if (room.songDetails) {
        room.queue.unshift(room.songDetails);
      }
      room.currentSong = prevItem.videoId;
      room.songDetails = prevItem;
      room.isPlaying = true;
      room.timestamp = 0;

      io.to(cleanRoomId).emit('play_new_song', { videoId: prevItem.videoId, details: prevItem, timestamp: 0 });
      io.to(cleanRoomId).emit('queue_update', room.queue);
    } else if (room && room.currentSong) {
      room.timestamp = 0;
      io.to(cleanRoomId).emit('sync_play', { timestamp: 0 });
    }
  });

  // When a song naturally ends
  socket.on('song_ended', ({ roomId, lastVideoId }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    const room = rooms[cleanRoomId];
    if (!room) return;
    if (room.hostId && socket.id !== room.hostId) return; // host only
    if (room.currentSong !== lastVideoId) return; // current song already moved
    if (room.lastEndedSongId === lastVideoId) return; // already processed end for this video

    const now = Date.now();
    if (room.lastEndTrigger && (now - room.lastEndTrigger < 4000)) {
      return;
    }
    room.lastEndTrigger = now;
    room.lastEndedSongId = lastVideoId;
    playNextSong(cleanRoomId);
  });

  // Play a specific item from the queue
  socket.on('play_queue_item', ({ roomId, videoId, index }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    const room = getOrCreateRoom(cleanRoomId);
    if (!room || !room.queue) return;
    if (room.hostId && socket.id !== room.hostId) return; // host only

    let itemIndex = -1;
    if (videoId) {
      itemIndex = room.queue.findIndex(q => q.videoId === videoId);
    }
    if (itemIndex === -1 && typeof index === 'number' && room.queue[index]) {
      itemIndex = index;
    }

    if (itemIndex !== -1) {
      const itemToPlay = room.queue.splice(itemIndex, 1)[0];
      if (room.songDetails) {
        if (!room.history) room.history = [];
        room.history.push(room.songDetails);
        if (room.history.length > 20) room.history.shift();
      }
      room.currentSong = itemToPlay.videoId;
      room.songDetails = itemToPlay;
      room.isPlaying = true;
      room.timestamp = 0;
      
      io.to(cleanRoomId).emit('play_new_song', { videoId: itemToPlay.videoId, details: itemToPlay, timestamp: 0 });
      io.to(cleanRoomId).emit('queue_update', room.queue);

      if (room.queue.length < 3) {
        populateQueueWithRelated(cleanRoomId, itemToPlay, false);
      }
    }
  });

  // Sync controls (Play/Pause for the SAME song)
  socket.on('sync_play', ({ roomId, timestamp }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    const room = getOrCreateRoom(cleanRoomId);
    if (room.hostId && socket.id !== room.hostId) return; // host only
    if (room) {
      room.isPlaying = true;
      room.timestamp = timestamp;
      socket.to(cleanRoomId).emit('sync_play', { timestamp });
    }
  });

  socket.on('sync_pause', ({ roomId, timestamp }) => {
    const cleanRoomId = (roomId || '').trim().toUpperCase();
    const room = getOrCreateRoom(cleanRoomId);
    if (room.hostId && socket.id !== room.hostId) return; // host only
    if (room) {
      room.isPlaying = false;
      room.timestamp = timestamp;
      socket.to(cleanRoomId).emit('sync_pause', { timestamp });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    for (const rId in rooms) {
      const room = rooms[rId];
      const userIndex = room.users.findIndex(u => u.id === socket.id);
      if (userIndex !== -1) {
        room.users.splice(userIndex, 1);
        // If host left, transfer host to next user
        if (room.hostId === socket.id) {
          room.hostId = room.users.length > 0 ? room.users[0].id : null;
          io.to(rId).emit('host_changed', { hostSocketId: room.hostId });
        }
        socket.to(rId).emit('user_left', { users: room.users });
        if (room.users.length === 0) {
          delete rooms[rId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
