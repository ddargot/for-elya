const express = require('express');
const app = express();
const http = require('http').createServer(app);
// Увеличиваем лимиты на размер передаваемых данных (Base64 файлы картинок/музыки могут быть тяжелыми)
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e8 // ~100 MB
});

app.use(express.static(__dirname));

// Хранилище комнат. Структура: { "Имя_Комнаты": { currentImage: '', currentAudio: '', players: { "userId": {...} } } }
let gameRooms = {};

io.on('connection', (socket) => {
    let currentRoom = null;
    let currentUserId = null;

    // Игрок или Мастер запрашивает вход в комнату
    socket.on('join_room', (data) => {
        const roomName = data.room ? data.room.trim() : null;
        const name = data.name ? data.name.trim() : 'Герой';
        const userId = data.userId || data.id; // Получаем сгенерированный уникальный ID
        
        if (!roomName || !userId) return;

        currentRoom = roomName;
        currentUserId = userId;

        // Подключаем сокет к комнате Socket.io
        socket.join(roomName);

        // Если такой комнаты еще нет в памяти сервера — создаем её
        if (!gameRooms[roomName]) {
            gameRooms[roomName] = {
                currentImage: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200',
                currentAudio: '',
                players: {}
            };
        }

        // Отправляем подключившемуся текущие настройки этой конкретной комнаты
        socket.emit('init', gameRooms[roomName]);

        // Если зашел Игрок (а не Мастер), добавляем или обновляем его в списке по userId
        if (data.role === 'player') {
            gameRooms[roomName].players[userId] = {
                id: userId,          // Уникальный ID игрока (навсегда)
                socketId: socket.id,  // ID текущего соединения сокета (меняется при перезагрузке)
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

        // Обновляем список игроков для всей комнаты
        io.to(roomName).emit('players_visible', gameRooms[roomName].players);
    });

    // Игрок обновляет свой чарлист/инвентарь внутри комнаты
    socket.on('player_update', (data) => {
        if (!currentRoom || !gameRooms[currentRoom] || data.role === 'dm') return;
        
        const userId = data.userId || data.id;
        if (!userId) return;
        
        // Перезаписываем данные по ключу userId, сохраняя актуальный ID сокета соединения
        gameRooms[currentRoom].players[userId] = data;
        gameRooms[currentRoom].players[userId].id = userId; 
        gameRooms[currentRoom].players[userId].socketId = socket.id;

        // Рассылаем изменения участникам комнаты
        io.to(currentRoom).emit('players_visible', gameRooms[currentRoom].players);
    });

    // Мастер изменяет характеристики или передает предмет конкретному игроку
    socket.on('dm_give_item', (data) => {
        if (!currentRoom || !gameRooms[currentRoom]) return;

        const targetId = data.targetId; // Это наш userId игрока
        const targetPlayer = gameRooms[currentRoom].players[targetId];

        if (targetPlayer) {
            // Если мастер обновляет характеристики (кнопка "Применить характеристики")
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

                // Отправляем изменения в сокет конкретного игрока, используя его текущий socketId
                io.to(targetPlayer.socketId).emit('receive_item', { statsUpdate: s });
            } 
            // Если мастер передает или изменяет предмет в инвентаре (кнопка "Обновить ячейку игрока")
            else if (data.item !== undefined) {
                const newItem = data.item;
                if (!targetPlayer.inventory) targetPlayer.inventory = [];

                // Ищем, есть ли уже предмет в этом слоте
                const existingIndex = targetPlayer.inventory.findIndex(i => i.slot === newItem.slot);
                if (existingIndex !== -1) {
                    targetPlayer.inventory[existingIndex] = newItem;
                } else {
                    targetPlayer.inventory.push(newItem);
                }

                // Заворачиваем в { item: newItem } для стопроцентного совпадения со структурой на фронтенде
                io.to(targetPlayer.socketId).emit('receive_item', { item: newItem });
            }

            // Обновляем монитор игроков у мастера и других участников
            io.to(currentRoom).emit('players_visible', gameRooms[currentRoom].players);
        }
    });

    // Бросок кубиков
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

    // Изменение сцены Мастером (загрузка карты/музыки в Base64 с ПК)
    socket.on('change_scene', (data) => {
        if (!currentRoom || !gameRooms[currentRoom]) return;

        // Если мастер загрузил карту, обновляем её. Если нет — оставляем старую.
        if (data.image) gameRooms[currentRoom].currentImage = data.image;
        // Если мастер загрузил аудио, обновляем.
        if (data.audio) gameRooms[currentRoom].currentAudio = data.audio;

        io.to(currentRoom).emit('scene_changed', gameRooms[currentRoom]);
    });

    // ДОБАВЛЕНО: Выключение музыки Мастером для всей комнаты
    socket.on('dm_stop_audio', () => {
        if (!currentRoom || !gameRooms[currentRoom]) return;
        
        // Стираем аудиотрек из памяти текущей комнаты
        gameRooms[currentRoom].currentAudio = '';
        
        // Сигнализируем всем клиентам в комнате, что пора остановить музыку
        io.to(currentRoom).emit('stop_audio');
    });

    // Игрок вышел или обновил страницу
    socket.on('disconnect', () => {
        // Данные сохраняются во избежание потерь при F5
    });
});

http.listen(3001, () => {
    console.log('=== СЕРВЕР КОМНАТ ЗАПУЩЕН НА ПОРТУ 3001 ===');
});