const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// CORS ve transport ayarları
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());

const rooms = new Map();
const roomUsers = new Map();
const roomStats = {}; // roomCode -> {username: {studied, known, unknown, avatar}}

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
  console.log('✅ User connected:', socket.id);
  
  socket.on('create-room', ({ username, avatar }, callback) => {
    try {
      const roomId = uuidv4();
      const roomCode = generateRoomCode();
      
      rooms.set(roomCode, {
        id: roomId,
        code: roomCode,
        createdAt: new Date(),
        isActive: true
      });
      
      console.log(`🏠 Room created: ${roomCode} by ${username}`);
      
      if (callback) {
        callback({ 
          success: true, 
          roomCode,
          avatar: avatar || '👤'
        });
      }
    } catch (error) {
      console.error('Error creating room:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });
  
  socket.on('join-room', ({ roomCode, username, isHost, avatar }, callback) => {
    try {
      console.log(`🚪 Join attempt: ${username} -> ${roomCode}`);
      
      const room = rooms.get(roomCode);
      
      if (!room || !room.isActive) {
        console.log(`❌ Room not found: ${roomCode}`);
        if (callback) callback({ success: false, error: 'Oda bulunamadı veya kapalı' });
        return;
      }
      
      // Aynı kullanıcı adı kontrolü
      for (const [socketId, user] of roomUsers) {
        if (user.roomCode === roomCode && user.username === username) {
          console.log(`❌ Username taken: ${username}`);
          if (callback) callback({ success: false, error: 'Bu kullanıcı adı odada kullanılıyor' });
          return;
        }
      }
      
      socket.join(roomCode);
      roomUsers.set(socket.id, { roomCode, username, isHost });
      
      if (!roomStats[roomCode]) {
        roomStats[roomCode] = {};
      }
      
      // Avatar ata (yoksa default)
      const userAvatar = avatar || '👤';
      
      roomStats[roomCode][username] = { 
        studied: 0, 
        known: 0, 
        unknown: 0,
        avatar: userAvatar
      };
      
      // Odadaki tüm kullanıcıları topla
      const users = [];
      for (const [socketId, user] of roomUsers) {
        if (user.roomCode === roomCode) {
          const userStat = roomStats[roomCode][user.username] || {};
          users.push({ 
            username: user.username, 
            isHost: user.isHost,
            avatar: userStat.avatar || '👤',
            studied: userStat.studied || 0,
            known: userStat.known || 0
          });
        }
      }
      
      console.log(`✅ ${username} joined ${roomCode}. Users:`, users);
      
      // CALLBACK ile yanıt ver
      if (callback) {
        callback({ 
          success: true,
          roomCode, 
          users,
          isHost,
          stats: roomStats[roomCode],
          avatar: userAvatar
        });
      }
      
      // Diğer kullanıcılara bildir (avatar ve studied ile)
      socket.to(roomCode).emit('user-joined', { 
        username, 
        socketId: socket.id,
        avatar: userAvatar,
        studied: 0,
        known: 0
      });
      socket.to(roomCode).emit('sync-stats', { stats: roomStats[roomCode] });
      
    } catch (error) {
      console.error('❌ Error joining room:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('update-stats', ({ roomCode, username, stats }) => {
    if (roomStats[roomCode] && roomStats[roomCode][username]) {
      roomStats[roomCode][username] = {
        ...roomStats[roomCode][username],
        ...stats
      };
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
    console.log('❌ User disconnected:', socket.id);
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
        
        let roomEmpty = true;
        for (const user of roomUsers.values()) {
          if (user.roomCode === roomCode) {
            roomEmpty = false;
            break;
          }
        }
        
        if (roomEmpty) {
          delete roomStats[roomCode];
          console.log(`🗑️ Room ${roomCode} is now empty, stats cleaned`);
        } else {
          io.to(roomCode).emit('user-left', { username });
          io.to(roomCode).emit('sync-stats', { stats: roomStats[roomCode] });
        }
      }
      
      socket.leave(roomCode);
      console.log(`👋 ${username} left room ${roomCode}`);
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
  console.log(`🚀 Server running on port ${PORT}`);
});