const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://arjengaupdated1.vercel.app/", "https://localhost:5173"], // Allow Vite app
    methods: ["GET", "POST"],
  },
});

let rooms = new Map(); // Store rooms

// Room class to manage players and game state in a room
class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = [];
    this.gameState = {}; // Each room maintains its own game state
  }

  addPlayer(socket, playerData) {
    this.players.push({ socket, playerData });
  }

  isFull() {
    return this.players.length >= 2; // Max 3 players per room
  }

  getState() {
    return {
      roomId: this.roomId,
      players: this.players.map((p) => p.playerData),
      gameState: this.gameState,
    };
  }

  updateGameState(blockData) {
    this.gameState[blockData.id] = blockData; // Update the room's game state
  }
}

// Handle WebSocket connections
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Create Room
    // Handle creating a new room
    socket.on('createRoom', (playerData) => {
      const roomId = Math.random().toString(36).substring(7); // Generate a random room ID
      const room = new Room(roomId);
      room.addPlayer(socket, playerData);
      rooms.set(roomId, room);
  
      console.log('Created room:', roomId);
      console.log('Active rooms:', Array.from(rooms.keys()));
  
      socket.join(roomId);
      console.log(room);
      socket.emit('roomCreated', roomId); // Send room ID back to the client
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

    // Notify other players in the room
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
    console.log("In set-base");
    console.log(position);
    if (player) {
      player.playerData.basePosition = position;
      console.log(`Player ${socket.id} base position set to, position`);
    }
  });

  // Player Ready
  socket.on('player-ready', ({ roomId }) => {
    const room = rooms.get(roomId);
  
    if (!room) {
      socket.emit('roomError', 'Room not found');
      return;
    }
  
    // Find the player by matching their name with socket.id
    const player = room.players.find((p) => p.playerData.name === socket.id);
    if (player) {
      player.playerData.ready = true;
      console.log(`Player ${socket.id} is ready in room ${roomId}`);
    } else {
      console.warn(`Player not found in room ${roomId} for socket ${socket.id}`);
    }
  
    // Check if all players in the room are ready
    const allReady = room.players.every((p) => p.playerData.ready);
    if (allReady) {
      io.to(roomId).emit('start-game', room.getState().gameState);
      console.log(`All players are ready in room ${roomId}. Starting the game.`);
  
      // Assign the first turn to the first player
      const firstPlayerId = room.players[0].playerData.name; // Use playerData.name for turn tracking
      io.emit('turn-update', { currentTurn: firstPlayerId, roomId });
      console.log(`First turn assigned to player: ${firstPlayerId} in room ${roomId}`);
    }
  });
  
  // Update for block movement and turn rotation
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
  
    // Calculate the relative movement
    const relativeChange = {
      id: blockData.id,
      relativePosition: {
        x: blockData.position.x - playerBasePosition.x,
        y: blockData.position.y - playerBasePosition.y,
        z: blockData.position.z - playerBasePosition.z,
      },
      quaternion: blockData.quaternion,
    };
  
    // Broadcast the relative change to all other clients in the same room
    io.emit('update-block', { roomId, blockData: relativeChange });
  
    // Rotate turn to the next player
    const currentPlayerIndex = room.players.findIndex((p) => p.playerData.name === socket.id);
    if (currentPlayerIndex !== -1) {
      const nextPlayerIndex = (currentPlayerIndex + 1) % room.players.length;
      const nextPlayerId = room.players[nextPlayerIndex].playerData.name;
      io.emit('turn-update', { currentTurn: nextPlayerId, roomId });
      console.log(`Turn updated: Current turn for player ${nextPlayerId} in room ${roomId}`);
    }
  });
  
  
  

  // Tower Collapsed
  socket.on('tower-collapsed', ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('roomError', 'Room not found');
      return;
    }
  
    console.log(`Player ${playerId} caused the tower to collapse in room ${roomId}`);
  
    // Notify the player who caused the collapse that they lost
    io.to(playerId).emit('game-result', {
      message: 'You lost! You caused the tower to collapse.',
      roomId,
      playerId, // Include the playerId who lost
    });
  
    // Notify all other players in the room that they won
    room.players.forEach((p) => {
      if (p.socket.id !== playerId) {
        io.emit('game-result', {
          message: 'You won! The other player caused the tower to collapse.',
          roomId,
        });
      }
    });
  });
  

  // Player Disconnection
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);

    // Find the room and remove the player
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

      // If the room is empty, delete it
      if (rooms.get(roomId).players.length === 0) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} has been deleted`);
      } else {
        // Notify remaining players in the room
        socket.to(roomId).emit('playerDisconnected', socket.id);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
