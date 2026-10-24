import { useEffect, useState, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import YouTube from 'react-youtube';
import { Users, Search, Play, Pause, SkipForward, SkipBack, ListVideo, Copy, UserPlus, Heart, MoreHorizontal, Volume2, Volume1, VolumeX, Repeat, Shuffle, GripVertical, Mic2 } from 'lucide-react';
import { getCachedSearch, setCachedSearch } from '../utils/searchCache';

const SOCKET_SERVER_URL = import.meta.env.VITE_BACKEND_URL || (typeof window !== 'undefined' ? `http://${window.location.hostname}:5001` : '');

const PLAYER_OPTS = {
  width: '100%',
  height: '100%',
  playerVars: {
    autoplay: 1,
    controls: 0,
    modestbranding: 1,
    disablekb: 1,
    fs: 0,
    rel: 0,
    iv_load_policy: 3,
    origin: typeof window !== 'undefined' ? window.location.origin : undefined
  }
};

const getCleanTitle = (title) => {
  if (!title) return '...';
  // Remove everything after |, -, [, or (
  return title.split(/\||-|\[|\(/)[0].trim();
};

const parseSyncedLyrics = (lrcString) => {
  if (!lrcString) return null;
  const lines = lrcString.split('\n');
  const parsed = [];

  for (const line of lines) {
    // Make decimals optional: [01:23] or [01:23.45]
    const match = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseFloat(match[2]);
      const text = match[3].trim();
      if (text) {
        parsed.push({
          time: min * 60 + sec,
          text: text
        });
      }
    }
  }

  return parsed.length > 0 ? parsed : null;
};

const parseIsoDuration = (duration) => {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);
  return hours * 3600 + minutes * 60 + seconds;
};

const isShortsItem = (item) => {
  if (!item) return false;
  const title = (item.snippet?.title || item.title || '').toLowerCase();
  const desc = (item.snippet?.description || item.description || '').toLowerCase();
  const blacklist = ['#shorts', '#short', 'shorts', 'short', 'tiktok', 'reels', 'whatsapp status', 'status video'];
  return blacklist.some(b => title.includes(b) || desc.includes(b));
};

export default function Room() {
  const { roomId } = useParams();
  const cleanRoomId = (roomId || '').trim().toUpperCase();
  const location = useLocation();
  const navigate = useNavigate();
  const effectiveUsername = location.state?.username || sessionStorage.getItem('space_music_username') || `Astronaut_${Math.floor(Math.random() * 899 + 100)}`;

  useEffect(() => {
    if (location.state?.username) {
      sessionStorage.setItem('space_music_username', location.state.username);
    }
  }, [location.state?.username]);

  const [socket, setSocket] = useState(null);
  const [users, setUsers] = useState([]);
  const [hostSocketId, setHostSocketId] = useState(null);
  const [mySocketId, setMySocketId] = useState(null);

  const [currentSong, setCurrentSong] = useState(null);
  const [songDetails, setSongDetails] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [queue, setQueue] = useState([]);
  const [volume, setVolume] = useState(80);
  const [isMuted, setIsMuted] = useState(false);
  const prevVolumeRef = useRef(80);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const [rightTab, setRightTab] = useState('queue'); // 'queue' or 'lyrics'
  const [lyrics, setLyrics] = useState({ loading: false, plain: null, synced: null });

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isCachedSearch, setIsCachedSearch] = useState(false);

  const isHost = mySocketId && hostSocketId ? mySocketId === hostSocketId : true;
  const isHostRef = useRef(true);
  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  const playerRef = useRef(null);
  const socketRef = useRef(null);
  const currentSongRef = useRef(null);
  const isPlayingRef = useRef(false);
  const currentTimeRef = useRef(0);
  const ignoreEventsUntil = useRef(0);
  const lastErrorSkipRef = useRef(0);
  const hasEndedEmittedForSong = useRef(null);
  const initialMountedSongId = useRef(currentSong || '');

  useEffect(() => {
    currentSongRef.current = currentSong;
  }, [currentSong]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    const newSocket = io(SOCKET_SERVER_URL, {
      reconnection: true,
      reconnectionAttempts: 15,
      reconnectionDelay: 1000
    });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Socket connected/reconnected:', newSocket.id);
      setMySocketId(newSocket.id);
      newSocket.emit('join_room', { roomId: cleanRoomId, username: effectiveUsername });
    });

    newSocket.on('room_state', (state) => {
      setUsers(state.users || []);
      setQueue(state.queue || []);
      if (state.hostSocketId) {
        setHostSocketId(state.hostSocketId);
      }
      if (state.currentSong) {
        setCurrentSong(state.currentSong);
        currentSongRef.current = state.currentSong;
        setSongDetails(state.songDetails);
        setIsPlaying(state.isPlaying);
        isPlayingRef.current = state.isPlaying;
        setCurrentTime(state.timestamp || 0);
        currentTimeRef.current = state.timestamp || 0;
        if (playerRef.current && state.currentSong) {
          try {
            if (playerRef.current.loadVideoById) {
              playerRef.current.loadVideoById(state.currentSong, state.timestamp || 0);
            }
            if (state.isPlaying && playerRef.current.playVideo) {
              playerRef.current.playVideo();
            }
          } catch (e) {
            console.error('Error applying initial room state to player:', e);
          }
        }
      }
    });

    newSocket.on('user_joined', ({ users }) => setUsers(users || []));
    newSocket.on('user_left', ({ users }) => setUsers(users || []));
    newSocket.on('queue_update', (newQueue) => setQueue(newQueue || []));
    newSocket.on('host_changed', ({ hostSocketId: newHostId }) => {
      setHostSocketId(newHostId);
    });

    newSocket.on('play_new_song', ({ videoId, details, timestamp }) => {
      ignoreEventsUntil.current = Date.now() + 4000;
      hasEndedEmittedForSong.current = null;
      setCurrentSong(videoId);
      currentSongRef.current = videoId;
      setSongDetails(details);
      setIsPlaying(true);
      isPlayingRef.current = true;
      setCurrentTime(timestamp || 0);
      currentTimeRef.current = timestamp || 0;
      setDuration(0);

      if (playerRef.current) {
        try {
          if (playerRef.current.loadVideoById) {
            playerRef.current.loadVideoById(videoId, timestamp || 0);
          }
          if (playerRef.current.playVideo) {
            playerRef.current.playVideo();
          }
        } catch (e) {
          console.error('Error loading video on play_new_song:', e);
        }
      }
    });

    newSocket.on('stop_song', () => {
      setCurrentSong(null);
      currentSongRef.current = null;
      setSongDetails(null);
      setIsPlaying(false);
      isPlayingRef.current = false;
      if (playerRef.current && playerRef.current.stopVideo) {
        try {
          playerRef.current.stopVideo();
        } catch (e) {}
      }
    });

    newSocket.on('sync_play', ({ timestamp }) => {
      ignoreEventsUntil.current = Date.now() + 1500;
      setIsPlaying(true);
      isPlayingRef.current = true;
      setCurrentTime(timestamp);
      currentTimeRef.current = timestamp;
      if (playerRef.current) {
        try {
          if (playerRef.current.seekTo) playerRef.current.seekTo(timestamp, true);
          if (playerRef.current.playVideo) playerRef.current.playVideo();
        } catch (e) {}
      }
    });

    newSocket.on('sync_pause', ({ timestamp }) => {
      ignoreEventsUntil.current = Date.now() + 1500;
      setIsPlaying(false);
      isPlayingRef.current = false;
      setCurrentTime(timestamp);
      currentTimeRef.current = timestamp;
      if (playerRef.current) {
        try {
          if (playerRef.current.seekTo) playerRef.current.seekTo(timestamp, true);
          if (playerRef.current.pauseVideo) playerRef.current.pauseVideo();
        } catch (e) {}
      }
    });

    return () => newSocket.disconnect();
  }, [cleanRoomId, effectiveUsername]);

  // Update current time continuously with a robust polling mechanism
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!playerRef.current) return;
      try {
        let state = -1;
        if (typeof playerRef.current.getPlayerState === 'function') {
          const res = playerRef.current.getPlayerState();
          state = res && typeof res.then === 'function' ? await res : res;
        }
        if (state === 1) {
          let time = 0;
          if (typeof playerRef.current.getCurrentTime === 'function') {
            const timeRes = playerRef.current.getCurrentTime();
            time = timeRes && typeof timeRes.then === 'function' ? await timeRes : timeRes;
          }
          if (typeof time === 'number' && !isNaN(time)) {
            setCurrentTime(time);
            currentTimeRef.current = time;
          }
          if (typeof playerRef.current.getDuration === 'function') {
            const durRes = playerRef.current.getDuration();
            const dur = durRes && typeof durRes.then === 'function' ? await durRes : durRes;
            if (typeof dur === 'number' && dur > 0) {
              setDuration(dur);
            }
          }
        }
      } catch (e) {}
    }, 200);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll to active lyric line
  useEffect(() => {
    if (rightTab === 'lyrics' && lyrics.synced) {
      const activeEl = document.getElementById('active-lyric-line');
      if (activeEl && activeEl.scrollIntoView) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [currentTime, rightTab, lyrics.synced]);

  // Fetch lyrics whenever the song changes
  useEffect(() => {
    if (!songDetails) {
      setLyrics({ loading: false, plain: null, synced: null });
      return;
    }

    const fetchLyrics = async () => {
      setLyrics({ loading: true, plain: null, synced: null });
      try {
        const cleanTitle = getCleanTitle(songDetails.title);
        // Using our backend proxy to avoid CORS/User-Agent restrictions from the browser
        const res = await fetch(`${SOCKET_SERVER_URL}/api/lyrics?q=${encodeURIComponent(cleanTitle)}`);
        const data = await res.json();

        if (data && data.length > 0 && (data[0].plainLyrics || data[0].syncedLyrics)) {
          setLyrics({
            loading: false,
            plain: data[0].plainLyrics,
            synced: parseSyncedLyrics(data[0].syncedLyrics)
          });
        } else {
          setLyrics({ loading: false, plain: "Lyrics not found for this song in the database.", synced: null });
        }
      } catch (err) {
        console.error("Lyrics fetch failed", err);
        setLyrics({ loading: false, plain: "Failed to load lyrics.", synced: null });
      }
    };

    fetchLyrics();
  }, [songDetails?.title]);

  const onPlayerReady = (event) => {
    playerRef.current = event.target;
    const dur = event.target.getDuration ? event.target.getDuration() : 0;
    setDuration(dur || 0);
    try {
      if (event.target.setVolume) {
        event.target.setVolume(isMuted ? 0 : volume);
      }
      if (isMuted && event.target.mute) {
        event.target.mute();
      }
    } catch (e) {
      console.error('Error applying initial volume in onPlayerReady:', e);
    }
    if (currentSongRef.current) {
      try {
        if (event.target.loadVideoById) {
          event.target.loadVideoById(currentSongRef.current, currentTimeRef.current || 0);
        }
        if (isPlayingRef.current && event.target.playVideo) {
          event.target.playVideo();
        }
      } catch (e) {
        console.error('Error loading video in onPlayerReady:', e);
      }
    }
  };

  const onStateChange = async (event) => {
    const liveSocket = socketRef.current;
    if (!liveSocket || Date.now() < ignoreEventsUntil.current) {
      return;
    }

    let timestamp = 0;
    let dur = 0;
    try {
      if (playerRef.current?.getCurrentTime) {
        const t = playerRef.current.getCurrentTime();
        timestamp = t && typeof t.then === 'function' ? await t : t;
      }
      if (playerRef.current?.getDuration) {
        const d = playerRef.current.getDuration();
        dur = d && typeof d.then === 'function' ? await d : d;
      }
    } catch (e) {}

    if (typeof dur === 'number' && dur > 0) {
      setDuration(dur);
    }

    if (event.data === 1) {
      setIsPlaying(true);
      isPlayingRef.current = true;
      if (isHostRef.current) {
        liveSocket.emit('sync_play', { roomId: cleanRoomId, timestamp: timestamp || 0 });
      }
    } else if (event.data === 2) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      if (isHostRef.current) {
        liveSocket.emit('sync_pause', { roomId: cleanRoomId, timestamp: timestamp || 0 });
      }
    } else if (event.data === 0) {
      // 0 = YT.PlayerState.ENDED
      // Only host triggers next song on natural end, and only if video actually reached near the end
      if (isHostRef.current && dur > 10 && timestamp >= (dur - 4) && currentSongRef.current) {
        if (hasEndedEmittedForSong.current !== currentSongRef.current) {
          hasEndedEmittedForSong.current = currentSongRef.current;
          liveSocket.emit('song_ended', { roomId: cleanRoomId, lastVideoId: currentSongRef.current });
        }
      }
    }
  };

  // OS Media Session (Notification Controls)
  useEffect(() => {
    if ('mediaSession' in navigator && songDetails) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: getCleanTitle(songDetails.title),
        artist: songDetails.channel,
        album: 'SpaceMusic',
        artwork: [
          { src: songDetails.thumbnail, sizes: '512x512', type: 'image/jpeg' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', () => {
        if (!isPlaying) togglePlay();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (isPlaying) togglePlay();
      });
      navigator.mediaSession.setActionHandler('nexttrack', skipNext);
      navigator.mediaSession.setActionHandler('previoustrack', skipPrevious);
    }
  }, [songDetails, isPlaying, currentSong]);

  const handleSearch = async (e) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    // Check if it is a direct YouTube URL
    const urlMatch = query.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
    if (urlMatch) {
      const videoId = urlMatch[1];
      handleAddToQueue(videoId);
      return;
    }

    // 1. Check IndexedDB cache first to save quota tokens
    try {
      const cachedItems = await getCachedSearch(query);
      if (cachedItems && cachedItems.length > 0) {
        // Exclude legacy shorts from cache if any
        const cleanCached = cachedItems.filter(it => !isShortsItem(it));
        if (cleanCached.length > 0) {
          setSearchResults(cleanCached);
          setIsCachedSearch(true);
          return; // Zero quota used!
        }
      }
    } catch (cacheErr) {
      console.warn('Error checking IndexedDB search cache:', cacheErr);
    }

    // 2. Fetch from backend search proxy (keeps API key server-side, avoids CORS + 429)
    try {
      const proxyRes = await fetch(`${SOCKET_SERVER_URL}/api/search?q=${encodeURIComponent(query)}`);
      if (!proxyRes.ok) {
        const errData = await proxyRes.json().catch(() => ({}));
        console.error('Search proxy error:', proxyRes.status, errData);
        return;
      }
      const cleanVideos = await proxyRes.json();

      if (Array.isArray(cleanVideos) && cleanVideos.length > 0) {
        setSearchResults(cleanVideos);
        setIsCachedSearch(false);
        // 3. Persist in IndexedDB for subsequent same-query searches
        await setCachedSearch(query, cleanVideos);
      } else {
        setSearchResults([]);
      }
    } catch (err) {
      console.error('Search failed', err);
    }
  };

  const handleAddToQueue = (item) => {
    const isDirectId = typeof item === 'string';
    const videoId = isDirectId ? item : (item.videoId || item.id?.videoId || (typeof item.id === 'string' ? item.id : null));
    if (!videoId) {
      console.error('Cannot add to queue: missing videoId', item);
      return;
    }
    const details = isDirectId ? { videoId, title: 'Unknown Song (via ID)', channel: '', thumbnail: `https://img.youtube.com/vi/${videoId}/default.jpg` } : {
      videoId,
      title: item.snippet?.title || item.title || 'Unknown Song',
      channel: item.snippet?.channelTitle || item.channel || '',
      thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || item.thumbnail || `https://img.youtube.com/vi/${videoId}/default.jpg`
    };

    // Optimistic local play
    ignoreEventsUntil.current = Date.now() + 4000;
    hasEndedEmittedForSong.current = null;
    setCurrentSong(videoId);
    currentSongRef.current = videoId;
    setSongDetails(details);
    setIsPlaying(true);
    isPlayingRef.current = true;
    setCurrentTime(0);
    currentTimeRef.current = 0;

    if (playerRef.current) {
      try {
        if (playerRef.current.loadVideoById) {
          playerRef.current.loadVideoById(videoId, 0);
        }
        if (playerRef.current.playVideo) {
          playerRef.current.playVideo();
        }
      } catch (e) {
        console.error('Error starting video playback locally:', e);
      }
    }

    // Play the newly searched song across room members
    if (socket) {
      socket.emit('play_now', { roomId: cleanRoomId, item: details });
    }

    setSearchResults([]);
    setSearchQuery('');
  };

  const togglePlay = () => {
    if (!playerRef.current || !currentSongRef.current) return;
    const timestamp = playerRef.current?.getCurrentTime ? playerRef.current.getCurrentTime() : 0;
    if (isPlaying) {
      if (playerRef.current.pauseVideo) playerRef.current.pauseVideo();
      socket.emit('sync_pause', { roomId: cleanRoomId, timestamp });
      setIsPlaying(false);
      isPlayingRef.current = false;
    } else {
      if (playerRef.current.playVideo) playerRef.current.playVideo();
      socket.emit('sync_play', { roomId: cleanRoomId, timestamp });
      setIsPlaying(true);
      isPlayingRef.current = true;
    }
  };

  const skipNext = () => {
    if (socket) {
      socket.emit('skip_song', { roomId: cleanRoomId });
    }
  };

  const skipPrevious = () => {
    if (currentTime > 3 && playerRef.current?.seekTo) {
      playerRef.current.seekTo(0, true);
      setCurrentTime(0);
      currentTimeRef.current = 0;
      if (socket) {
        socket.emit('sync_play', { roomId: cleanRoomId, timestamp: 0 });
      }
    } else if (socket) {
      socket.emit('prev_song', { roomId: cleanRoomId });
    }
  };

  const handlePlayQueueItem = (item, index) => {
    if (socket && item) {
      const videoId = item.videoId || item.id?.videoId || item.id;
      socket.emit('play_queue_item', { roomId: cleanRoomId, videoId, index });
    }
  };

  const handleSeek = (e) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    currentTimeRef.current = newTime;
    if (playerRef.current?.seekTo) {
      playerRef.current.seekTo(newTime, true);
      if (socket) {
        socket.emit('sync_play', { roomId: cleanRoomId, timestamp: newTime });
      }
    }
  };

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Generate dynamic progress bar gradient string
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const progressStyle = {
    background: `linear-gradient(to right, #a855f7 ${progressPercent}%, rgba(255, 255, 255, 0.1) ${progressPercent}%)`
  };

  const handleVolumeChange = (e) => {
    const newVol = parseInt(e.target.value, 10);
    setVolume(newVol);
    if (newVol > 0 && isMuted) {
      setIsMuted(false);
      if (playerRef.current?.unMute) {
        playerRef.current.unMute();
      }
    }
    if (newVol === 0) {
      setIsMuted(true);
    }
    if (playerRef.current?.setVolume) {
      playerRef.current.setVolume(newVol);
    }
  };

  const toggleMute = () => {
    if (isMuted) {
      const targetVol = prevVolumeRef.current > 0 ? prevVolumeRef.current : 80;
      setIsMuted(false);
      setVolume(targetVol);
      if (playerRef.current?.unMute) playerRef.current.unMute();
      if (playerRef.current?.setVolume) playerRef.current.setVolume(targetVol);
    } else {
      prevVolumeRef.current = volume > 0 ? volume : 80;
      setIsMuted(true);
      setVolume(0);
      if (playerRef.current?.mute) playerRef.current.mute();
    }
  };

  const renderVolumeIcon = () => {
    if (isMuted || volume === 0) {
      return <VolumeX size={18} className="volume-icon volume-muted-icon" />;
    }
    if (volume < 50) {
      return <Volume1 size={18} className="volume-icon volume-low-icon" />;
    }
    return <Volume2 size={18} className="volume-icon volume-high-icon" />;
  };

  const currentVolume = isMuted ? 0 : volume;
  const volumeStyle = {
    background: `linear-gradient(to right, #a855f7 ${currentVolume}%, rgba(255, 255, 255, 0.15) ${currentVolume}%)`
  };

  return (
    <div className="app-container">

      {/* YouTube Audio Engine - Always mounted offscreen to prevent iframe re-init on song select */}
      <div
        className="youtube-offscreen-player-container"
        style={{
          position: 'fixed',
          top: '-9999px',
          left: '-9999px',
          width: '400px',
          height: '300px',
          opacity: 0.001,
          pointerEvents: 'none',
          zIndex: -1
        }}
      >
        <YouTube
          videoId={initialMountedSongId.current || ''}
          opts={PLAYER_OPTS}
          onReady={onPlayerReady}
          onStateChange={onStateChange}
          onError={(err) => {
            console.error('YouTube Player Error:', err);
            if (!isHostRef.current) return;
            const now = Date.now();
            if (now - lastErrorSkipRef.current > 4000) {
              lastErrorSkipRef.current = now;
              skipNext();
            }
          }}
          className="youtube-offscreen-iframe"
          style={{ width: '400px', height: '300px', pointerEvents: 'none' }}
        />
      </div>

      <div className="main-content">

        {/* Left Sidebar */}
        <div className="sidebar glass-panel">
          <div className="logo-container">
            <div style={{ width: '32px', height: '32px', borderRadius: '50%', border: '2px solid #a855f7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: '20px', height: '2px', background: '#06b6d4', transform: 'rotate(-45deg)' }}></div>
            </div>
            <h1 className="logo-text">Space<span>Music</span></h1>
          </div>
          <p style={{ fontSize: '0.8rem', color: '#a1a1aa', marginTop: '-16px', marginLeft: '44px' }}>Listen Together • Beyond Boundaries</p>

          <div className="room-card">
            <div>
              <div style={{ fontSize: '0.7rem', color: '#a1a1aa', marginBottom: '4px', fontWeight: 'bold', letterSpacing: '1px' }}>ROOM ID</div>
              <div style={{ fontSize: '1.2rem', fontWeight: '800', letterSpacing: '2px' }}>{cleanRoomId}</div>
            </div>
            <button className="control-btn" onClick={() => navigator.clipboard.writeText(cleanRoomId)} title="Copy Room ID">
              <Copy size={18} />
            </button>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ fontSize: '0.9rem', color: '#e4e4e7', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Users size={16} /> Listeners ({users.length})
            </h3>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {users.map((u, i) => (
                <div key={i} className="listener-item">
                  <div className="avatar">
                    <span style={{ fontWeight: 'bold', color: '#fff', fontSize: '1rem' }}>{u.username.charAt(0).toUpperCase()}</span>
                    <div className="status-dot"></div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: '600', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span className="text-truncate">{u.username} {u.username === effectiveUsername ? '(You)' : ''}</span>
                      {i === 0 && <span style={{ color: '#fbbf24', fontSize: '0.8rem' }}>👑</span>}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#a1a1aa' }}>
                      {i === 0 ? 'Listening now' : 'Online'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <button className="btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
            <UserPlus size={18} /> Invite Friends
          </button>
        </div>

        {/* Center Main View */}
        <div className="center-view glass-panel">

          <div className="search-container">
            {isHost ? (
              <form onSubmit={handleSearch} className="search-form-host">
                <Search className="search-icon" size={20} />
                <input
                  type="text"
                  className="input-field"
                  placeholder="Search a song to add to queue..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </form>
            ) : (
              <div className="search-form-viewer-locked" style={{ position: 'relative' }}>
                <Search className="search-icon" size={20} style={{ opacity: 0.4 }} />
                <input
                  type="text"
                  className="input-field"
                  placeholder="Only the host can search songs..."
                  disabled
                  style={{ opacity: 0.45, cursor: 'not-allowed' }}
                />
              </div>
            )}
          </div>

          <div className="center-scroll">
            {searchResults.length > 0 ? (
              <div className="search-results-container" style={{ width: '100%', maxWidth: '700px' }}>
                <div className="search-results-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                  <h3 className="search-results-title" style={{ margin: 0, color: '#e4e4e7' }}>Search Results</h3>
                  {isCachedSearch && (
                    <span
                      className="search-cache-badge"
                      style={{
                        fontSize: '0.75rem',
                        color: '#22c55e',
                        background: 'rgba(34, 197, 94, 0.12)',
                        border: '1px solid rgba(34, 197, 94, 0.3)',
                        padding: '3px 10px',
                        borderRadius: '12px',
                        fontWeight: '600'
                      }}
                    >
                      ⚡ Loaded from IndexedDB (0 Quota Used)
                    </span>
                  )}
                </div>
                {searchResults.map(item => (
                  <div
                    key={item.id.videoId}
                    className="queue-item search-result-item"
                    onClick={() => isHost && handleAddToQueue(item)}
                    style={{ background: 'rgba(255,255,255,0.03)', marginBottom: '12px', cursor: isHost ? 'pointer' : 'default', opacity: isHost ? 1 : 0.6 }}
                  >
                    <img className="search-result-thumb" src={item.snippet.thumbnails.default.url} alt="thumbnail" />
                    <div className="search-result-meta" style={{ flex: 1, minWidth: 0 }}>
                      <div className="search-result-title text-truncate" style={{ fontWeight: '600', color: '#fff', fontSize: '1rem', marginBottom: '4px' }}>
                        {item.snippet.title}
                      </div>
                      <div className="search-result-channel text-truncate" style={{ fontSize: '0.85rem', color: '#a1a1aa' }}>
                        {item.snippet.channelTitle}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, width: '100%' }}>
                {/* Active song card - always keep player mounted in DOM */}
                <div className="active-song-card" style={{ display: currentSong ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                  <div className="artwork-container album-artwork-container">
                    {/* Album Art Image - Always visible */}
                    <img
                      src={songDetails ? songDetails.thumbnail : (currentSong ? `https://img.youtube.com/vi/${currentSong}/maxresdefault.jpg` : null)}
                      alt="Album Art"
                      className="artwork-image album-art-cover"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        zIndex: 1,
                        borderRadius: '16px'
                      }}
                    />
                  </div>

                  <div className="active-song-meta-container" style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div className="active-song-title-wrapper" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', marginTop: '8px', position: 'relative' }}>
                      <div className="active-song-text-box" style={{ flex: 1, textAlign: 'center', minWidth: 0 }}>
                        <h2 className="active-song-title text-truncate" style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: '600' }}>
                          {songDetails ? getCleanTitle(songDetails.title) : 'Playing Song...'}
                        </h2>
                      </div>
                      <div className="active-song-heart-wrapper" style={{ position: 'absolute', right: '0' }}>
                        <Heart className="active-song-heart-icon" size={24} color="#ec4899" fill="#ec4899" style={{ cursor: 'pointer', filter: 'drop-shadow(0 0 10px rgba(236, 72, 153, 0.5))' }} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Empty State placeholder - displayed when no song is playing */}
                <div className="empty-player-placeholder" style={{ display: currentSong ? 'none' : 'flex', color: '#a1a1aa', textAlign: 'center', opacity: 0.6, flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px' }}>
                    <Search size={40} color="#a855f7" />
                  </div>
                  <h2 style={{ color: '#fff', marginBottom: '8px' }}>Search for a song to start listening</h2>
                  <p style={{ fontSize: '0.9rem' }}>Find your next track and listen together with your room.</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Queue / Lyrics Sidebar */}
        <div className="queue-sidebar glass-panel">

          <div style={{ display: 'flex', marginBottom: '24px', background: 'rgba(255,255,255,0.05)', borderRadius: '50px', padding: '4px' }}>
            <button
              style={{ flex: 1, padding: '8px 16px', borderRadius: '50px', border: 'none', background: rightTab === 'queue' ? 'rgba(168, 85, 247, 0.3)' : 'transparent', color: rightTab === 'queue' ? '#fff' : '#a1a1aa', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.3s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              onClick={() => setRightTab('queue')}
            >
              <ListVideo size={16} /> Up Next
            </button>
            <button
              style={{ flex: 1, padding: '8px 16px', borderRadius: '50px', border: 'none', background: rightTab === 'lyrics' ? 'rgba(168, 85, 247, 0.3)' : 'transparent', color: rightTab === 'lyrics' ? '#fff' : '#a1a1aa', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.3s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              onClick={() => setRightTab('lyrics')}
            >
              <Mic2 size={16} /> Lyrics
            </button>
          </div>

          {rightTab === 'queue' ? (
            <div className="queue-list" style={{ display: 'flex', flexDirection: 'column' }}>
              {queue.length === 0 ? (
                <div style={{ color: '#a1a1aa', fontSize: '0.9rem', textAlign: 'center', marginTop: '3rem' }}>
                  Queue is empty.<br /><br />Search and add songs!
                </div>
              ) : (
                queue.map((item, index) => (
                  <div
                    key={item.videoId || index}
                    className="queue-item"
                    onClick={() => isHost && handlePlayQueueItem(item, index)}
                    style={{ cursor: isHost ? 'pointer' : 'default' }}
                  >
                    <div style={{ width: '24px', fontSize: '0.9rem', color: '#a1a1aa', fontWeight: 'bold' }}>
                      {(index + 1).toString().padStart(2, '0')}
                    </div>
                    <img src={item.thumbnail || `https://img.youtube.com/vi/${item.videoId}/default.jpg`} alt="thumb" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="text-truncate" style={{ fontSize: '0.95rem', fontWeight: '600', color: '#fff', marginBottom: '4px' }}>
                        {getCleanTitle(item.title)}
                      </div>
                      <div className="text-truncate" style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>
                        {item.channel}
                      </div>
                    </div>
                    <GripVertical size={16} color="#555" />
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="queue-list" style={{ padding: '0 12px', whiteSpace: 'pre-wrap', lineHeight: '1.8', color: '#e4e4e7', fontSize: '0.95rem' }}>
              {lyrics.loading ? (
                <div style={{ textAlign: 'center', color: '#a1a1aa', marginTop: '3rem' }}>Searching the universe for lyrics...</div>
              ) : lyrics.synced ? (
                <div style={{ paddingBottom: '2rem' }}>
                  {lyrics.synced.map((line, idx) => {
                    const nextLine = lyrics.synced[idx + 1];
                    // Line is active if the current time is past this line's time, AND before the next line's time.
                    // Or if it's the first line and we are still in the intro.
                    const isActive = (currentTime >= line.time && (!nextLine || currentTime < nextLine.time)) || (idx === 0 && currentTime < line.time);

                    return (
                      <div
                        key={idx}
                        id={isActive ? "active-lyric-line" : ""}
                        style={{
                          color: isActive ? '#fff' : 'rgba(255,255,255,0.3)',
                          fontSize: isActive ? '1.15rem' : '0.95rem',
                          fontWeight: isActive ? 'bold' : 'normal',
                          textShadow: isActive ? '0 0 15px rgba(168, 85, 247, 0.8)' : 'none',
                          transition: 'all 0.3s ease',
                          padding: '6px 0',
                          transform: isActive ? 'scale(1.02)' : 'scale(1)'
                        }}
                      >
                        {line.text}
                      </div>
                    );
                  })}
                </div>
              ) : lyrics.plain ? (
                <div style={{ paddingBottom: '2rem' }}>{lyrics.plain}</div>
              ) : (
                <div style={{ textAlign: 'center', color: '#a1a1aa', marginTop: '3rem' }}>Play a song to see lyrics.</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Music Player */}
      <div className="bottom-player glass-panel">
        <div className="player-left">
          {currentSong ? (
            <>
              <img src={songDetails ? songDetails.thumbnail : `https://img.youtube.com/vi/${currentSong}/default.jpg`} alt="Now Playing" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-truncate" style={{ fontSize: '1rem', fontWeight: '700', color: '#fff' }}>{songDetails ? getCleanTitle(songDetails.title) : '...'}</div>
                <div className="text-truncate" style={{ fontSize: '0.85rem', color: '#a1a1aa' }}>{songDetails ? songDetails.channel : '...'}</div>
              </div>
              <Heart size={18} color="#a1a1aa" style={{ cursor: 'pointer', marginLeft: '8px' }} />
              <MoreHorizontal size={18} color="#a1a1aa" style={{ cursor: 'pointer', marginLeft: '4px' }} />
            </>
          ) : (
            <div style={{ color: '#a1a1aa', fontSize: '0.9rem' }}>No track playing</div>
          )}
        </div>

        <div className="player-center">
          <div className="player-controls">
            <button className="control-btn player-control-btn control-btn-shuffle" title="Shuffle" disabled={!isHost} style={{ opacity: isHost ? 1 : 0.35, cursor: isHost ? 'pointer' : 'not-allowed' }}><Shuffle size={18} /></button>
            <button className="control-btn player-control-btn control-btn-prev" onClick={isHost ? skipPrevious : undefined} title="Previous track" disabled={!isHost} style={{ opacity: isHost ? 1 : 0.35, cursor: isHost ? 'pointer' : 'not-allowed' }}><SkipBack size={22} fill="currentColor" /></button>
            <button className="control-btn player-control-btn control-btn-play play-circle-btn" onClick={isHost ? togglePlay : undefined} title={isPlaying ? "Pause" : "Play"} disabled={!isHost} style={{ opacity: isHost ? 1 : 0.35, cursor: isHost ? 'pointer' : 'not-allowed' }}>
              {isPlaying ? <Pause size={20} fill="#fff" /> : <Play size={20} fill="#fff" style={{ marginLeft: '4px' }} />}
            </button>
            <button className="control-btn player-control-btn control-btn-next" onClick={isHost ? skipNext : undefined} title="Next track" disabled={!isHost} style={{ opacity: isHost ? 1 : 0.35, cursor: isHost ? 'pointer' : 'not-allowed' }}><SkipForward size={22} fill="currentColor" /></button>
            <button className="control-btn player-control-btn control-btn-repeat" title="Repeat" disabled={!isHost} style={{ opacity: isHost ? 1 : 0.35, cursor: isHost ? 'pointer' : 'not-allowed' }}><Repeat size={18} /></button>
          </div>

          <div className="progress-container">
            <span>{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 100}
              value={currentTime}
              onChange={isHost ? handleSeek : undefined}
              className="progress-bar"
              style={{ ...progressStyle, cursor: isHost ? 'pointer' : 'not-allowed' }}
              disabled={!isHost}
            />
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="player-right volume-player-container">
          <button
            className="control-btn volume-mute-btn"
            onClick={toggleMute}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {renderVolumeIcon()}
          </button>
          <div className="volume-slider-wrapper">
            <input
              type="range"
              min={0}
              max={100}
              value={currentVolume}
              onChange={handleVolumeChange}
              className="volume-slider player-volume-slider"
              style={volumeStyle}
              title={`Volume: ${currentVolume}%`}
            />
          </div>
          <span className="volume-percent-label">
            {currentVolume}%
          </span>
        </div>
      </div>
    </div>
  );
}
