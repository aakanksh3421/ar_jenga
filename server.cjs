// server.cjs - full replacement (CommonJS)
// --- aakanksh addition: CORS + debug-enabled Socket.IO server ---

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// --- aakanksh addition: allowed origins (add any other exact origins you need) ---
const allowedOrigins = [
  "https://ar-jenga-frontend-2up5.vercel.app",
  "https://ar-jenga-five.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000"
];
// --- end aakanksh addition ---

// --- aakanksh addition: lightweight request logger to help debug CORS issues ---
app.use((req, res, next) => {
  const origin = req.headers.origin || 'none';
  console.log(`[req] ${req.method} ${req.url} - Origin: ${origin}`);
  next();
});
// --- end aakanksh addition ---

// --- aakanksh addition: add CORS headers for HTTP requests (handles polling XHR) ---
app.use(function (req, res, next) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    // For debugging you can allow all temporarily:
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

// Serve static files from project root (unchanged)
app.use(express.static(__dirname));

// Serve index.html at root (unchanged)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- aakanksh addition: initialize Socket.IO with explicit CORS config ---
const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      // Allow requests with no origin (e.g., server-to-server) or from our allowed list
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
  transports: ['websocket', 'polling'] // allow polling fallback but prefer websocket
});
// --- end aakanksh addition ---

let rooms = new Map(); // Store rooms

// Room class (unchanged)
class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = [];
    this.gameState = {};
  }
  addPlayer(socket, playerData) {
    this.players.push({ socket, playerData });
  }
  isFull() {
    return this.players.length >= 2;
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

// Socket.IO connection events (mostly unchanged, small io.emit -> io.to fixes)
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id, 'Origin:', socket.handshake.headers.origin);

  // Create Room
  socket.on('createRoom', (playerData) => {
    const roomId = Math.random().toString(36).substring(7);
    const room = new Room(roomId);
    room.addPlayer(socket, playerData);
    rooms.set(roomId, room);

    console.log('Created room:', roomId);
    console.log('Active rooms:', Array.from(rooms.keys()));

    socket.join(roomId);
    socket.emit('roomCreated', roomId);
  });

  // Join Room
  socket.on('joinRoom', ({ roomId, playerData }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('roomError', 'Room not found');
      return;
    }

    if (room.isFull()) {
      socket.emit('roomError', 'Room is full');
      return;
    }

    console.log('Joining room:', roomId);
    room.addPlayer(socket, playerData);
    socket.join(roomId);
    socket.emit('joinedRoom', { roomId, state: room.getState() });

    // Notify other players
    socket.to(roomId).emit('playerJoined', { playerId: socket.id, playerData });
  });

  // Set Base Position
  socket.on('set-base-position', ({ roomId, position }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('roomError', 'Room not found');
      return;
    }
    const player = room.players.find((p) => p.playerData.name === socket.id);
    console.log("In set-base", position);
    if (player) {
      player.playerData.basePosition = position;
      console.log(`Player ${socket.id} base position set`);
    }
  });

  // Player Ready
  socket.on('player-ready', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('roomError', 'Room not found');
      return;
    }
    const player = room.players.find((p) => p.playerData.name === socket.id);
    if (player) {
      player.playerData.ready = true;
      console.log(`Player ${socket.id} is ready in room ${roomId}`);
    } else {
      console.warn(`Player not found in room ${roomId} for socket ${socket.id}`);
    }
    const allReady = room.players.every((p) => p.playerData.ready);
    if (allReady) {
      io.to(roomId).emit('start-game', room.getState().gameState);
      console.log(`All players are ready in room ${roomId}. Starting the game.`);
      const firstPlayerId = room.players[0].playerData.name;
      io.to(roomId).emit('turn-update', { currentTurn: firstPlayerId, roomId });
      console.log(`First turn assigned to player: ${firstPlayerId} in room ${roomId}`);
    }
  });

  // Update block and rotate turn
  socket.on('update-block', ({ roomId, blockData }) => {
    const room = rooms.get(roomId);
    if (!room) {
      console.warn(`Room not found for roomId ${roomId}`);
      return;
    }
    const player = room.players.find((p) => p.playerData.name === socket.id);
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
    io.to(roomId).emit('update-block', { roomId, blockData: relativeChange });
    const currentPlayerIndex = room.players.findIndex((p) => p.playerData.name === socket.id);
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

  // Player disconnect
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
        console.log(`Room ${roomId} has been deleted`);
      } else {
        socket.to(roomId).emit('playerDisconnected', socket.id);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
