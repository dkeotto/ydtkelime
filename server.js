const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
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

const db = new Database('./database.sqlite');

// DATABASE BAŞLATMA - EKLE BUNU
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1
  );
  
  CREATE TABLE IF NOT EXISTS room_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    socket_id TEXT NOT NULL,
    username TEXT NOT NULL,
    is_host INTEGER DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
  );
`);

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const roomStats = {};

// API Routes
app.post('/api/rooms', (req, res) => {
  try {
    const roomId = uuidv4();
    const roomCode = generateRoomCode();
    
    const stmt = db.prepare('INSERT INTO rooms (id, code) VALUES (?, ?)');
    stmt.run(roomId, roomCode);
    
    res.json({ success: true, roomId, roomCode });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ success: false, error: 'Failed to create room' });
  }
});

app.get('/api/rooms/:code', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM rooms WHERE code = ? AND is_active = 1');
    const room = stmt.get(req.params.code);
    
    if (room) {
      res.json({ success: true, room });
    } else {
      res.status(404).json({ success: false, error: 'Room not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  let currentRoom = null;
  let currentUsername = null;
  
  socket.on('create-room', ({ username }, callback) => {
    try {
      const roomId = uuidv4();
      const roomCode = generateRoomCode();
      
      const stmt = db.prepare('INSERT INTO rooms (id, code) VALUES (?, ?)');
      stmt.run(roomId, roomCode);
      
      callback({ success: true, roomCode });
    } catch (error) {
      console.error('Error creating room:', error);
      callback({ success: false, error: 'Failed to create room' });
    }
  });
  
  socket.on('join-room', ({ roomCode, username, isHost }) => {
    try {
      const room = db.prepare('SELECT * FROM rooms WHERE code = ? AND is_active = 1').get(roomCode);
      
      if (!room) {
        socket.emit('error', { message: 'Oda bulunamadı veya kapalı' });
        return;
      }
      
      const existingUser = db.prepare('SELECT * FROM room_users WHERE room_id = ? AND username = ?').get(room.id, username);
      if (existingUser) {
        socket.emit('error', { message: 'Bu kullanıcı adı odada kullanılıyor' });
        return;
      }
      
      socket.join(roomCode);
      currentRoom = roomCode;
      currentUsername = username;
      
      const stmt = db.prepare('INSERT INTO room_users (room_id, socket_id, username, is_host) VALUES (?, ?, ?, ?)');
      stmt.run(room.id, socket.id, username, isHost ? 1 : 0);
      
      if (!roomStats[roomCode]) {
        roomStats[roomCode] = {};
      }
      roomStats[roomCode][username] = { known: 0, unknown: 0, studied: 0 };
      
      socket.to(roomCode).emit('user-joined', { username, socketId: socket.id });
      
      const users = db.prepare('SELECT username, socket_id, is_host FROM room_users WHERE room_id = ?').all(room.id);
      socket.emit('room-joined', { 
        roomCode, 
        users: users.map(u => ({ username: u.username, isHost: u.is_host === 1 })),
        isHost
      });
      
      socket.emit('sync-stats', { stats: roomStats[roomCode] });
      
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
    const room = db.prepare('SELECT id FROM rooms WHERE code = ?').get(roomCode);
    if (room) {
      const user = db.prepare('SELECT is_host FROM room_users WHERE socket_id = ? AND room_id = ?').get(socket.id, room.id);
      if (user && user.is_host === 1) {
        socket.to(roomCode).emit('sync-word', { wordIndex });
      }
    }
  });

  socket.on('leave-room', ({ roomCode, username }) => {
    handleUserLeave(socket, roomCode, username);
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    if (currentRoom && currentUsername) {
      handleUserLeave(socket, currentRoom, currentUsername);
    }
  });
  
  function handleUserLeave(socket, roomCode, username) {
    try {
      const room = db.prepare('SELECT id FROM rooms WHERE code = ?').get(roomCode);
      if (!room) return;
      
      const stmt = db.prepare('DELETE FROM room_users WHERE socket_id = ? AND room_id = ?');
      stmt.run(socket.id, room.id);
      
      if (roomStats[roomCode]) {
        delete roomStats[roomCode][username];
        
        const remainingUsers = db.prepare('SELECT COUNT(*) as count FROM room_users WHERE room_id = ?').get(room.id);
        if (remainingUsers.count === 0) {
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

// Static files - HER ZAMAN
app.use(express.static(path.join(__dirname, 'client/dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});