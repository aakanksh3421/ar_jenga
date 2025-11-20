// server.cjs - full drop-in replacement
// aakanksh addition: combined CORS + player id fixes + debug logs

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// --- aakanksh addition: allowed origins (add any exact origins you need) ---
const allowedOrigins = [
  "https://ar-jenga-1.onrender.com",
  "https://ar-jenga-five.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000"
];
// --- end aakanksh addition ---

// --- aakanksh addition: basic request logger for debugging origins ---
app.use((req, res, next) => {
  const origin = req.headers.origin || 'none';
  console.log(`[HTTP] ${req.method} ${req.url} - Origin: ${origin}`);
  next();
});
// --- end aakanksh addition ---

// --- aakanksh addition: middleware to add CORS headers for HTTP requests (handles polling XHR) ---
app.use(function (req, res, next) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    // for quick testing you can uncomment the next line to allow all origins
    // res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
// --- end aakanksh addition ---

// Serve static files and index (unchanged)
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- aakanksh addition: initialize Socket.IO with explicit CORS config ---
const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      // allow requests with no origin (server-to-server) or matching allowedOrigins
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        console.warn('[io] blocked socket origin:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});
// --- end aakanksh addition ---

// --- Room storage & class (unchanged with a small aakanksh addition in addPlayer) ---
let rooms = new Map();

class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = [];
    this.gameState = {};
  }
  addPlayer(socket, playerData = {}) {
    // aakanksh addition: ensure server-authoritative name/id
    playerData = Object.assign({}, playerData, { name: socket.id, ready: !!playerData.ready });
    this.players.push({ socket, playerData });
  }
  isFull() {
    return this.players.length >= 2; // keep your 2-player limit
  }
  getState() {
    return {
      roomId: this.roomId,
      players: this.players.map((p) => p.playerData),
      gameState: this.gameState,
    };
  }
  updateGameState(blockData) {
    this.gameState[blockData.id] = blockData;
  }
}
// --- end Room ---

// --- Socket handlers (create/join/set-base/update-block with server-authoritative lookups) ---
io.on('connection', (socket) => {
  console.log('[io] connected:', socket.id, 'handshake origin:', socket.handshake.headers.origin || 'none');

  // Create Room
  socket.on('createRoom', (playerData = {}) => {
    const roomId = Math.random().toString(36).substring(7);
    const room = new Room(roomId);
    // aakanksh: add creator with server-side name=socket.id
    room.addPlayer(socket, playerData);
    rooms.set(roomId, room);

    console.log('Created room:', roomId, 'by', socket.id);
    socket.join(roomId);
    socket.emit('roomCreated', roomId);
  });

  // Join Room
  socket.on('joinRoom', ({ roomId, playerData = {} }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('roomError', 'Room not found');
      return;
    }
    if (room.isFull()) {
      socket.emit('roomError', 'Room is full');
      return;
    }
    console.log(`Socket ${socket.id} joining room: ${roomId}`);
    room.addPlayer(socket, playerData);
    socket.join(roomId);
    socket.emit('joinedRoom', { roomId, state: room.getState() });
    socket.to(roomId).emit('playerJoined', { playerId: socket.id, playerData: Object.assign({}, playerData, { name: socket.id }) });
  });

  // Set Base Position - aakanksh addition: find player by socket id
  socket.on('set-base-position', ({ roomId, position }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('roomError', 'Room not found');
      return;
    }
    const player = room.players.find((p) => p.socket && p.socket.id === socket.id);
    console.log("In set-base", position, "for", socket.id);
    if (player) {
      player.playerData.basePosition = position;
      console.log(`Player ${socket.id} base position set to`, position);
    } else {
      console.warn(`set-base-position: player not found in room ${roomId} for socket ${socket.id}`);
    }
  });

  // Player Ready
  socket.on('player-ready', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('roomError', 'Room not found');
      return;
    }
    const player = room.players.find((p) => p.socket && p.socket.id === socket.id);
    if (player) {
      player.playerData.ready = true;
      console.log(`Player ${socket.id} is ready in room ${roomId}`);
    } else {
      console.warn(`Player not found in room ${roomId} for socket ${socket.id}`);
    }
    const allReady = room.players.every((p) => p.playerData.ready);
    if (allReady) {
      io.to(roomId).emit('start-game', room.getState().gameState);
      console.log(`All players ready in room ${roomId}. Starting game.`);
      const firstPlayerId = room.players[0].playerData.name;
      io.to(roomId).emit('turn-update', { currentTurn: firstPlayerId, roomId });
      console.log(`First turn: ${firstPlayerId} in room ${roomId}`);
    }
  });

  // Update block and rotate turn
  socket.on('update-block', ({ roomId, blockData }) => {
    const room = rooms.get(roomId);
    if (!room) {
      console.warn(`Room not found for roomId ${roomId}`);
      return;
    }
    const player = room.players.find((p) => p.socket && p.socket.id === socket.id);
    if (!player) {
      console.warn(`Player with socket id ${socket.id} not found in room ${roomId}`);
      return;
    }
    const playerBasePosition = player.playerData.basePosition;
    if (!playerBasePosition) {
      console.warn(`Player ${socket.id} has no base position set.`);
      return;
    }

    const relativeChange = {
      id: blockData.id,
      relativePosition: {
        x: blockData.position.x - playerBasePosition.x,
        y: blockData.position.y - playerBasePosition.y,
        z: blockData.position.z - playerBasePosition.z,
      },
      quaternion: blockData.quaternion,
    };

    // broadcast to the room only
    io.to(roomId).emit('update-block', { roomId, blockData: relativeChange });

    // rotate turn
    const currentPlayerIndex = room.players.findIndex((p) => p.socket && p.socket.id === socket.id);
    if (currentPlayerIndex !== -1) {
      const nextPlayerIndex = (currentPlayerIndex + 1) % room.players.length;
      const nextPlayerId = room.players[nextPlayerIndex].playerData.name;
      io.to(roomId).emit('turn-update', { currentTurn: nextPlayerId, roomId });
      console.log(`Turn updated: Current turn for player ${nextPlayerId} in room ${roomId}`);
    }
  });

  // Tower collapsed
  socket.on('tower-collapsed', ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('roomError', 'Room not found');
      return;
    }
    console.log(`Player ${playerId} caused tower collapse in room ${roomId}`);
    io.to(playerId).emit('game-result', {
      message: 'You lost! You caused the tower to collapse.',
      roomId,
      playerId,
    });
    room.players.forEach((p) => {
      if (p.socket.id !== playerId) {
        io.to(p.socket.id).emit('game-result', {
          message: 'You won! The other player caused the tower to collapse.',
          roomId,
        });
      }
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    let roomId;
    for (const [id, room] of rooms.entries()) {
      const index = room.players.findIndex((p) => p.socket.id === socket.id);
      if (index !== -1) {
        roomId = id;
        room.players.splice(index, 1);
        break;
      }
    }
    if (roomId) {
      console.log(`Player ${socket.id} left room ${roomId}`);
      if (rooms.get(roomId).players.length === 0) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted`);
      } else {
        socket.to(roomId).emit('playerDisconnected', socket.id);
      }
    }
  });
});
// --- end io handlers ---

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
