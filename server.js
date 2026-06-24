// =============================================
//  HANGMAN PARTY — Multiplayer Server
//  Node.js + Socket.io
// =============================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve the game HTML
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================
//  ROOM STATE
// =============================================
const rooms = {}; // roomCode -> room object

function makeRoom(code, hostId, maxPlayers) {
  return {
    code,
    hostId,
    players: [],       // { id, username, avatar, ready, correct, wrong, total }
    phase: 'lobby',    // lobby | word-entry | game | results
    word: '',
    hint: '',
    revealedWord: [],
    incorrectGuesses: 0,
    guessedLetters: [],
    maxIncorrect: 6,
    maxPlayers,         // chosen by host at creation, 2-8
  };
}

function getRoomByPlayer(socketId) {
  return Object.values(rooms).find(r => r.players.some(p => p.id === socketId));
}

function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', sanitizeRoom(room));
}

function sanitizeRoom(room) {
  // Never send the secret word to clients during play
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    hint: room.hint,
    revealedWord: room.revealedWord,
    incorrectGuesses: room.incorrectGuesses,
    guessedLetters: room.guessedLetters,
    maxIncorrect: room.maxIncorrect,
    maxPlayers: room.maxPlayers,
    wordLength: room.word.length,
    players: room.players.map(p => ({
      id: p.id,
      username: p.username,
      avatar: p.avatar,
      ready: p.ready,
      correct: p.correct,
      wrong: p.wrong,
      total: p.total,
    })),
    // Reveal word only in results phase
    word: room.phase === 'results' ? room.word : '',
  };
}

// =============================================
//  SOCKET EVENTS
// =============================================
io.on('connection', (socket) => {
  console.log('+ connect', socket.id);

  // ── CREATE ROOM ──────────────────────────
  socket.on('room:create', ({ username, avatar, maxPlayers }) => {
    const code = Math.random().toString(36).substr(2, 6).toUpperCase();
    const clampedMax = Math.min(8, Math.max(2, parseInt(maxPlayers, 10) || 8));
    const room = makeRoom(code, socket.id, clampedMax);
    rooms[code] = room;

    room.players.push({ id: socket.id, username, avatar, ready: true, correct: 0, wrong: 0, total: 0 });
    socket.join(code);
    socket.emit('room:joined', { code, isHost: true });
    broadcastRoom(room);
    console.log(`Room ${code} created by ${username} (max ${clampedMax} players)`);
  });

  // ── JOIN ROOM ─────────────────────────────
  socket.on('room:join', ({ code, username, avatar }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.phase !== 'lobby') { socket.emit('error', 'Game already in progress'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('error', `Room is full (max ${room.maxPlayers} players)`); return; }

    room.players.push({ id: socket.id, username, avatar, ready: false, correct: 0, wrong: 0, total: 0 });
    socket.join(code);
    socket.emit('room:joined', { code, isHost: false });
    broadcastRoom(room);

    // Notify others
    io.to(code).emit('chat:message', {
      avatar: '🎮', username: 'Game', text: `${username} joined the room!`, time: now()
    });
  });

  // ── READY TOGGLE ──────────────────────────
  socket.on('player:ready', ({ ready }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    const player = getPlayer(room, socket.id);
    if (player) { player.ready = ready; broadcastRoom(room); }
  });

  // ── START GAME (host) ─────────────────────
  socket.on('game:start', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players'); return; }
    if (!room.players.every(p => p.ready)) { socket.emit('error', 'Not all players are ready'); return; }

    room.phase = 'word-entry';
    broadcastRoom(room);
  });

  // ── SUBMIT WORD (host) ────────────────────
  socket.on('game:word', ({ word, hint }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    const clean = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (clean.length < 2) { socket.emit('error', 'Word must be at least 2 letters'); return; }

    room.word = clean;
    room.hint = hint || 'No hint';
    room.revealedWord = Array(clean.length).fill('_');
    room.incorrectGuesses = 0;
    room.guessedLetters = [];
    room.players.forEach(p => { p.correct = 0; p.wrong = 0; p.total = 0; });
    room.phase = 'game';

    broadcastRoom(room);
    io.to(room.code).emit('chat:message', {
      avatar: '🎮', username: 'Game', text: `Game started! Guess the ${clean.length}-letter word!`, time: now()
    });
  });

  // ── GUESS ─────────────────────────────────
  socket.on('game:guess', ({ letter }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room || room.phase !== 'game') return;
    const player = getPlayer(room, socket.id);
    if (!player) return;

    const L = letter.toUpperCase();
    if (room.guessedLetters.includes(L)) { socket.emit('error', `"${L}" already guessed`); return; }
    room.guessedLetters.push(L);
    player.total++;

    if (room.word.includes(L)) {
      for (let i = 0; i < room.word.length; i++) {
        if (room.word[i] === L) room.revealedWord[i] = L;
      }
      player.correct++;
      const won = !room.revealedWord.includes('_');

      io.to(room.code).emit('guess:result', {
        letter: L, correct: true, revealedWord: room.revealedWord,
        player: { id: player.id, username: player.username, avatar: player.avatar },
        won, lost: false
      });

      if (won) {
        room.phase = 'results';
        setTimeout(() => {
          broadcastRoom(room);
          io.to(room.code).emit('game:over', { won: true, word: room.word, scores: getScores(room) });
        }, 1200);
      } else {
        broadcastRoom(room);
      }
    } else {
      room.incorrectGuesses++;
      player.wrong++;
      const lost = room.incorrectGuesses >= room.maxIncorrect;

      io.to(room.code).emit('guess:result', {
        letter: L, correct: false, revealedWord: room.revealedWord,
        player: { id: player.id, username: player.username, avatar: player.avatar },
        won: false, lost
      });

      if (lost) {
        room.phase = 'results';
        room.revealedWord = room.word.split('');
        setTimeout(() => {
          broadcastRoom(room);
          io.to(room.code).emit('game:over', { won: false, word: room.word, scores: getScores(room) });
        }, 1500);
      } else {
        broadcastRoom(room);
      }
    }
  });

  // ── PLAY AGAIN (host) ─────────────────────
  socket.on('game:again', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'word-entry';
    room.word = '';
    room.hint = '';
    room.revealedWord = [];
    room.incorrectGuesses = 0;
    room.guessedLetters = [];
    room.players.forEach(p => { p.ready = true; p.correct = 0; p.wrong = 0; p.total = 0; });
    broadcastRoom(room);
  });

  // ── CHAT ──────────────────────────────────
  socket.on('chat:send', ({ text }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    const player = getPlayer(room, socket.id);
    if (!player || !text.trim()) return;
    io.to(room.code).emit('chat:message', {
      avatar: player.avatar, username: player.username,
      text: text.trim().slice(0, 200), time: now()
    });
  });

  // ── REACTION ──────────────────────────────
  socket.on('reaction:send', ({ emoji }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    const player = getPlayer(room, socket.id);
    io.to(room.code).emit('reaction:show', { emoji, username: player?.username || '?' });
  });

  // ── DISCONNECT ────────────────────────────
  socket.on('disconnect', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    const player = getPlayer(room, socket.id);
    const username = player?.username || 'Someone';
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[room.code];
      console.log(`Room ${room.code} deleted (empty)`);
      return;
    }

    // Pass host to next player if host left
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      room.players[0].ready = true;
      io.to(room.code).emit('chat:message', {
        avatar: '🎮', username: 'Game', text: `${room.players[0].username} is now the host`, time: now()
      });
    }

    io.to(room.code).emit('chat:message', {
      avatar: '🎮', username: 'Game', text: `${username} left the room`, time: now()
    });

    // If game in progress and only 1 player left, end game
    if (room.phase === 'game' && room.players.length < 2) {
      room.phase = 'results';
    }

    broadcastRoom(room);
    console.log(`- disconnect ${username} from ${room.code}`);
  });
});

function getScores(room) {
  return [...room.players]
    .map(p => ({
      ...p,
      score: p.total > 0 ? p.correct / p.total : 0,
      accuracy: p.total > 0 ? Math.round((p.correct / p.total) * 100) : 0
    }))
    .sort((a, b) => (b.correct - a.correct) || (a.wrong - b.wrong));
}

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎭 Hangman Party running on port ${PORT}`));
