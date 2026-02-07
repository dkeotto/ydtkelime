const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// IN-MEMORY DATABASE (SQLite yerine)
const rooms = new Map(); // roomCode -> {id, code, createdAt}
const roomUsers = new Map(); // socketId -> {roomCode, username, isHost}
const roomStats = {}; // roomCode -> {username: {known, unknown, studied}}

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// API Routes
app.post('/api/rooms', (req, res) => {
  try {
    const roomId = uuidv4();
    const roomCode = generateRoomCode();
    
    rooms.set(roomCode, {
      id: roomId,
      code: roomCode,
      createdAt: new Date(),
      isActive: true
    });
    
    res.json({ success: true, roomId, roomCode });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ success: false, error: 'Failed to create room' });
  }
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (room && room.isActive) {
    res.json({ success: true, room });
  } else {
    res.status(404).json({ success: false, error: 'Room not found' });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('create-room', ({ username }, callback) => {
    try {
      const roomId = uuidv4();
      const roomCode = generateRoomCode();
      
      rooms.set(roomCode, {
        id: roomId,
        code: roomCode,
        createdAt: new Date(),
        isActive: true
      });
      
      callback({ success: true, roomCode });
    } catch (error) {
      console.error('Error creating room:', error);
      callback({ success: false, error: 'Failed to create room' });
    }
  });
  
  socket.on('join-room', ({ roomCode, username, isHost }) => {
    try {
      const room = rooms.get(roomCode);
      
      if (!room || !room.isActive) {
        socket.emit('error', { message: 'Oda bulunamadı veya kapalı' });
        return;
      }
      
      // Check if username exists in room
      for (const [socketId, user] of roomUsers) {
        if (user.roomCode === roomCode && user.username === username) {
          socket.emit('error', { message: 'Bu kullanıcı adı odada kullanılıyor' });
          return;
        }
      }
      
      socket.join(roomCode);
      roomUsers.set(socket.id, { roomCode, username, isHost });
      
      if (!roomStats[roomCode]) {
        roomStats[roomCode] = {};
      }
      roomStats[roomCode][username] = { known: 0, unknown: 0, studied: 0 };
      
      // Get all users in room
      const users = [];
      for (const [socketId, user] of roomUsers) {
        if (user.roomCode === roomCode) {
          users.push({ username: user.username, isHost: user.isHost });
        }
      }
      
      socket.emit('room-joined', { 
        roomCode, 
        users,
        isHost
      });
      
      socket.emit('sync-stats', { stats: roomStats[roomCode] });
      socket.to(roomCode).emit('user-joined', { username, socketId: socket.id });
      socket.to(roomCode).emit('sync-stats', { stats: roomStats[roomCode] });
      
      console.log(`${username} joined room ${roomCode}`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', { message: 'Odaya katılım başarısız: ' + error.message });
    }
  });

  socket.on('update-stats', ({ roomCode, username, stats }) => {
    if (roomStats[roomCode]) {
      roomStats[roomCode][username] = stats;
      io.to(roomCode).emit('sync-stats', { stats: roomStats[roomCode] });
    }
  });

  socket.on('change-word', ({ roomCode, wordIndex }) => {
    const user = roomUsers.get(socket.id);
    if (user && user.roomCode === roomCode && user.isHost) {
      socket.to(roomCode).emit('sync-word', { wordIndex });
    }
  });

  socket.on('leave-room', ({ roomCode, username }) => {
    handleUserLeave(socket, roomCode, username);
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const user = roomUsers.get(socket.id);
    if (user) {
      handleUserLeave(socket, user.roomCode, user.username);
    }
  });
  
  function handleUserLeave(socket, roomCode, username) {
    try {
      roomUsers.delete(socket.id);
      
      if (roomStats[roomCode]) {
        delete roomStats[roomCode][username];
        
        // Check if room is empty
        let roomEmpty = true;
        for (const user of roomUsers.values()) {
          if (user.roomCode === roomCode) {
            roomEmpty = false;
            break;
          }
        }
        
        if (roomEmpty) {
          delete roomStats[roomCode];
        } else {
          io.to(roomCode).emit('user-left', { username });
          io.to(roomCode).emit('sync-stats', { stats: roomStats[roomCode] });
        }
      }
      
      socket.leave(roomCode);
      console.log(`${username} left room ${roomCode}`);
    } catch (error) {
      console.error('Error leaving room:', error);
    }
  }
});

// Static files
app.use(express.static(path.join(__dirname, 'client/dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});