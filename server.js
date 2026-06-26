const express = require('express');
const app = express();
const http = require('http').createServer(app);

// Используем переменную окружения PORT для Render, если она есть, иначе 3001 для локальной разработки
const PORT = process.env.PORT || 3001;

// Увеличиваем лимиты на размер передаваемых данных
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e8 // ~100 MB
});

app.use(express.static(__dirname));

// Хранилище комнат
let gameRooms = {};

io.on('connection', (socket) => {
    let currentRoom = null;
    let currentUserId = null;

    socket.on('join_room', (data) => {
        const roomName = data.room ? data.room.trim() : null;
        const name = data.name ? data.name.trim() : 'Герой';
        const userId = data.userId || data.id;
        
        if (!roomName || !userId) return;

        currentRoom = roomName;
        currentUserId = userId;

        socket.join(roomName);

        if (!gameRooms[roomName]) {
            gameRooms[roomName] = {
                currentImage: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200',
                currentAudio: '',
                players: {}
            };
        }

        socket.emit('init', gameRooms[roomName]);

        if (data.role === 'player') {
            gameRooms[roomName].players[userId] = {
                id: userId,
                socketId: socket.id,
                name: name,
                role: data.role,
                hp: data.hp || '20/20',
                mp: data.mp || '10/10',
                sp: data.sp || '0/10',
                gold: data.gold || '0',
                str: data.str || '10',
                disabledSlots: data.disabledSlots || 0,
                dex: data.dex || '10',
                int: data.int || '10',
                cha: data.cha || '10',
                will: data.will || '10',
                effects: data.effects || '',
                skills: data.skills || [],
                inventory: data.inventory || []
            };
        }

        io.to(roomName).emit('players_visible', gameRooms[roomName].players);
    });

    socket.on('player_update', (data) => {
        if (!currentRoom || !gameRooms[currentRoom] || data.role === 'dm') return;
        
        const userId = data.userId || data.id;
        if (!userId) return;
        
        gameRooms[currentRoom].players[userId] = data;
        gameRooms[currentRoom].players[userId].id = userId; 
        gameRooms[currentRoom].players[userId].socketId = socket.id;

        io.to(currentRoom).emit('players_visible', gameRooms[currentRoom].players);
    });

    socket.on('dm_give_item', (data) => {
        if (!currentRoom || !gameRooms[currentRoom]) return;

        const targetId = data.targetId;
        const targetPlayer = gameRooms[currentRoom].players[targetId];

        if (targetPlayer) {
            if (data.statsUpdate !== undefined) {
                const s = data.statsUpdate;
                targetPlayer.hp = s.hpCur + '/' + s.hpMax;
                targetPlayer.mp = s.mpCur + '/' + s.mpMax;
                targetPlayer.sp = s.spCur + '/' + s.spMax;
                targetPlayer.gold = s.gold;
                targetPlayer.str = s.str;
                targetPlayer.dex = s.dex;
                targetPlayer.int = s.int;
                targetPlayer.cha = s.cha;
                targetPlayer.will = s.will;
                targetPlayer.effects = s.effects;

                io.to(targetPlayer.socketId).emit('receive_item', { statsUpdate: s });
            } 
            else if (data.item !== undefined) {
                const newItem = data.item;
                if (!targetPlayer.inventory) targetPlayer.inventory = [];

                const existingIndex = targetPlayer.inventory.findIndex(i => i.slot === newItem.slot);
                if (existingIndex !== -1) {
                    targetPlayer.inventory[existingIndex] = newItem;
                } else {
                    targetPlayer.inventory.push(newItem);
                }

                io.to(targetPlayer.socketId).emit('receive_item', { item: newItem });
            }

            io.to(currentRoom).emit('players_visible', gameRooms[currentRoom].players);
        }
    });

    socket.on('roll_dice', (data) => {
        if (!currentRoom) return;
        
        let rolls = [];
        let total = 0;
        for (let i = 0; i < data.count; i++) {
            let r = Math.floor(Math.random() * data.diceType) + 1;
            rolls.push(r);
            total += r;
        }

        io.to(currentRoom).emit('dice_result', {
            nickname: data.nickname,
            diceType: data.diceType,
            count: data.count,
            rolls: rolls,
            total: total
        });
    });

    socket.on('change_scene', (data) => {
        if (!currentRoom || !gameRooms[currentRoom]) return;

        if (data.image) gameRooms[currentRoom].currentImage = data.image;
        if (data.audio) gameRooms[currentRoom].currentAudio = data.audio;

        io.to(currentRoom).emit('scene_changed', gameRooms[currentRoom]);
    });

    socket.on('dm_stop_audio', () => {
        if (!currentRoom || !gameRooms[currentRoom]) return;
        gameRooms[currentRoom].currentAudio = '';
        io.to(currentRoom).emit('stop_audio');
    });

    socket.on('disconnect', () => {});
});

// Запуск сервера на динамическом порту
http.listen(PORT, () => {
    console.log(`=== СЕРВЕР ЗАПУЩЕН НА ПОРТУ ${PORT} ===`);
});