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

// Veri yapıları
const rooms = new Map();        // roomCode -> room bilgileri
const roomUsers = new Map();    // socket.id -> { roomCode, username, isHost }
const roomStats = new Map();    // roomCode -> { username: { studied, known, unknown, avatar } }
const roomHosts = new Map();    // roomCode -> hostUsername (güvenlik için)

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
  
  // ODA OLUŞTURMA - Host burada belirlenir!
socket.on('create-room', async ({ username, avatar }, callback) => {
  try {
    if (!username || username.trim().length < 2) {
      callback?.({ success: false, error: 'Geçerli kullanıcı adı girin' });
      return;
    }

    const roomId = uuidv4();
    const roomCode = generateRoomCode();
    const userAvatar = avatar || '👤';
    
    rooms.set(roomCode, {
      id: roomId,
      code: roomCode,
      createdAt: new Date(),
      isActive: true
    });
    
    roomHosts.set(roomCode, username);
    
    // Stats'a host'u ekle
    const initialStats = {
      [username]: { 
        studied: 0, 
        known: 0, 
        unknown: 0,
        avatar: userAvatar
      }
    };
    roomStats.set(roomCode, initialStats);
    
    console.log(`🏠 Room created: ${roomCode} by ${username}`);
    
    // BAŞARILI - users listesi ve stats ile birlikte dön
callback({ 
  success: true, 
  roomCode,
  avatar: userAvatar,
  isHost: true,
  users: [{  // ← BU EKLENDİ
    username,
    isHost: true,
    avatar: userAvatar,
    studied: 0,
    known: 0
  }],
  stats: initialStats  // ← BU EKLENDİ
});
  } catch (error) {
    console.error('Error creating room:', error);
    callback?.({ success: false, error: error.message });
  }
});
  
  // ODAYA KATILMA
  socket.on('join-room', ({ roomCode, username, avatar }, callback) => {
    try {
      console.log(`🚪 Join attempt: ${username} -> ${roomCode}`);
      
      // Validasyonlar
      if (!username || username.trim().length < 2) {
        if (callback) callback({ success: false, error: 'Geçerli kullanıcı adı girin' });
        return;
      }

      if (!roomCode || roomCode.length !== 6) {
        if (callback) callback({ success: false, error: 'Geçerli oda kodu girin (6 haneli)' });
        return;
      }
      
      const room = rooms.get(roomCode);
      
      if (!room || !room.isActive) {
        console.log(`❌ Room not found: ${roomCode}`);
        if (callback) callback({ success: false, error: 'Oda bulunamadı veya kapalı' });
        return;
      }
      
      // Aynı kullanıcı adı kontrolü (odada aktif olanlar arasında)
      const currentRoomStats = roomStats.get(roomCode) || {};
      if (currentRoomStats[username]) {
        console.log(`❌ Username taken: ${username}`);
        if (callback) callback({ success: false, error: 'Bu kullanıcı adı odada kullanılıyor' });
        return;
      }
      
      // Socket odaya katıl
      socket.join(roomCode);
      
      // Host mu kontrol et (server tarafında güvenlik!)
      const isHost = roomHosts.get(roomCode) === username;
      
      // Kullanıcıyı kaydet
      roomUsers.set(socket.id, { 
        roomCode, 
        username, 
        isHost,
        joinedAt: new Date()
      });
      
      // Avatar ata
      const userAvatar = avatar || '👤';
      
      // Stats'a ekle
      if (!roomStats.has(roomCode)) {
        roomStats.set(roomCode, {});
      }
      const stats = roomStats.get(roomCode);
      stats[username] = { 
        studied: 0, 
        known: 0, 
        unknown: 0,
        avatar: userAvatar
      };
      
      // Odadaki tüm kullanıcıları topla (güncel stats ile)
      const users = Object.entries(stats).map(([name, userStat]) => ({
        username: name,
        isHost: roomHosts.get(roomCode) === name,
        avatar: userStat.avatar || '👤',
        studied: userStat.studied || 0,
        known: userStat.known || 0
      }));
      
      console.log(`✅ ${username} joined ${roomCode}. Total users: ${users.length}`);
      
      // CALLBACK ile yanıt ver
      if (callback) {
        callback({ 
          success: true,
          roomCode, 
          users,
          isHost,  // Server tarafında belirlenen değer!
          stats: stats,
          avatar: userAvatar
        });
      }
      
      // Diğer kullanıcılara bildir
      socket.to(roomCode).emit('user-joined', { 
        username, 
        socketId: socket.id,
        isHost,
        avatar: userAvatar,
        studied: 0,
        known: 0
      });
      
      // Tüm odadakilere güncel stats gönder
      io.to(roomCode).emit('sync-stats', { stats });
      
    } catch (error) {
      console.error('❌ Error joining room:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // STATS GÜNCELLEME
  socket.on('update-stats', ({ roomCode, username, stats: newStats }) => {
    try {
      const roomStat = roomStats.get(roomCode);
      if (roomStat && roomStat[username]) {
        // Sadece sayısal değerleri güncelle (güvenlik)
        roomStat[username] = {
          ...roomStat[username],
          studied: Math.max(0, parseInt(newStats.studied) || 0),
          known: Math.max(0, parseInt(newStats.known) || 0),
          unknown: Math.max(0, parseInt(newStats.unknown) || 0)
        };
        
        // Tüm odadakilere gönder
        io.to(roomCode).emit('sync-stats', { stats: roomStat });
        
        console.log(`📊 Stats updated: ${username} in ${roomCode}`, roomStat[username]);
      }
    } catch (error) {
      console.error('Error updating stats:', error);
    }
  });

  // KELİME DEĞİŞTİRME (sadece host)
  socket.on('change-word', ({ roomCode, wordIndex }) => {
    try {
      const user = roomUsers.get(socket.id);
      const hostName = roomHosts.get(roomCode);
      
      // Güvenlik kontrolü: Sadece gerçek host değiştirebilir
      if (user && user.roomCode === roomCode && user.username === hostName) {
        socket.to(roomCode).emit('sync-word', { wordIndex });
        console.log(`📖 Word changed to ${wordIndex} by host ${user.username}`);
      } else {
        console.log(`⚠️ Unauthorized word change attempt by ${user?.username}`);
      }
    } catch (error) {
      console.error('Error changing word:', error);
    }
  });

  // AYRILMA
  socket.on('leave-room', ({ roomCode, username }) => {
    handleUserLeave(socket, roomCode, username);
  });
  
  // BAĞLANTI KOPMA
  socket.on('disconnect', (reason) => {
    console.log('❌ User disconnected:', socket.id, 'Reason:', reason);
    const user = roomUsers.get(socket.id);
    if (user) {
      handleUserLeave(socket, user.roomCode, user.username);
    }
  });
  
  // AYRILMA İŞLEYİCİSİ
  function handleUserLeave(socket, roomCode, username) {
    try {
      if (!roomCode || !username) return;
      
      roomUsers.delete(socket.id);
      
      const stats = roomStats.get(roomCode);
      if (stats && stats[username]) {
        delete stats[username];
        
        // Oda boş mu kontrol et
        const roomEmpty = !Array.from(roomUsers.values()).some(u => u.roomCode === roomCode);
        
        if (roomEmpty) {
          // Odayı temizle
          roomStats.delete(roomCode);
          roomHosts.delete(roomCode);
          const room = rooms.get(roomCode);
          if (room) {
            room.isActive = false;
          }
          console.log(`🗑️ Room ${roomCode} is now empty, cleaned up`);
        } else {
          // Host ayrıldıysa yeni host ata (en eski üye)
          const hostName = roomHosts.get(roomCode);
          if (hostName === username) {
            const remainingUsers = Array.from(roomUsers.values())
              .filter(u => u.roomCode === roomCode)
              .sort((a, b) => a.joinedAt - b.joinedAt);
            
            if (remainingUsers.length > 0) {
              const newHost = remainingUsers[0].username;
              roomHosts.set(roomCode, newHost);
              console.log(`👑 New host assigned: ${newHost}`);
            }
          }
          
          // Diğerlerine bildir
          io.to(roomCode).emit('user-left', { username, socketId: socket.id });
          io.to(roomCode).emit('sync-stats', { stats });
        }
      }
      
      socket.leave(roomCode);
      console.log(`👋 ${username} left room ${roomCode}`);
    } catch (error) {
      console.error('Error leaving room:', error);
    }
  }
});

// Static files (production için)
const clientPath = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(clientPath, 'index.html'));
});

// Hata yakalama
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Client path: ${clientPath}`);
});