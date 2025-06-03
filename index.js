const mineflayer = require('mineflayer');
const axios = require('axios');
const Vec3 = require('vec3');
const express = require('express');
const path = require('path');
const os = require('os');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const diskusage = require('diskusage');

const BOT_HOST = process.env.BOT_HOST || 'Leafsong.aternos.me';
const BOT_PORT = parseInt(process.env.BOT_PORT, 10) || 36915;
const BOT_USERNAME = process.env.BOT_USERNAME || 'Leaf';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const CHAT_WEBHOOK = process.env.CHAT_WEBHOOK;
const MESSAGE_WEBHOOK = process.env.MESSAGE_WEBHOOK;
const WEB_SERVER_PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/minecraft_dashboard';

const MOVEMENT_INTERVAL = 5000;
const LOOK_INTERVAL = 3000;
const RECONNECT_DELAY = 3000;
const SOCKET_IO_UPDATE_INTERVAL = 1000;

const ONE_HOUR = 3600 * 1000;
const FIFTEEN_SECONDS = 5 * 1000;

const DEFAULT_EMBED_COLOR = 0x3498db;
const SUCCESS_EMBED_COLOR = 0x00ff00;
const WARNING_EMBED_COLOR = 0xff9900;
const ERROR_EMBED_COLOR = 0xff0000;
const INFO_EMBED_COLOR = 0x9b59b6;

const FACES = ['steve.png', 'alex.png', 'lucy.png', 'ken.png', 'burrito.png', 'kaji.png', 'rusty.png', 'doon.png'];

const botOptions = {
  host: BOT_HOST,
  port: BOT_PORT,
  username: BOT_USERNAME,
  connectTimeout: null,
};

let bot = null;
let reconnectTimeout = null;
let movementInterval = null;
let lookInterval = null;
let rejoinActivityTimeout = null;
let botStartTime = null;
let movementCount = 0;
let isBotOnline = false;
let lastOnlineTime = null;
let currentServerHost = BOT_HOST;
let currentServerPort = BOT_PORT;
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = process.hrtime.bigint();
let nextDotFaceIndex = 0;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected ✅'))
  .catch(err => console.error('MongoDB connection error ❌:', err));

const chatSchema = new mongoose.Schema({
  username: String,
  chat: String,
  timestamp: { type: Date, default: Date.now }
});
const MinecraftChat = mongoose.model('MinecraftChat', chatSchema);

const playerFaceSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  face: String,
  isCustom: { type: Boolean, default: false },
  lastUpdated: { type: Date, default: Date.now }
});
const PlayerFace = mongoose.model('PlayerFace', playerFaceSchema);

function clearAllIntervals() {
  if (movementInterval) {
    clearInterval(movementInterval);
    movementInterval = null;
  }
  if (lookInterval) {
    clearInterval(lookInterval);
    lookInterval = null;
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (rejoinActivityTimeout) {
    clearTimeout(rejoinActivityTimeout);
    rejoinActivityTimeout = null;
  }
}

async function sendDiscordEmbed(title, description, color = DEFAULT_EMBED_COLOR, fields = []) {
  if (!DISCORD_WEBHOOK) {
    return;
  }
  try {
    await axios.post(DISCORD_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('Discord Webhook Error ❌:', err.message);
  }
}

async function sendChatEmbed(title, description, color = SUCCESS_EMBED_COLOR, fields = []) {
  if (!CHAT_WEBHOOK) {
    return;
  }
  try {
    await axios.post(CHAT_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('Chat Webhook Error ❌:', err.message);
  }
}

async function sendPlayerMessage(username, message) {
  if (username === botOptions.username || !MESSAGE_WEBHOOK) {
    return;
  }
  try {
    await axios.post(MESSAGE_WEBHOOK, {
      embeds: [{ author: { name: username }, description: message, color: SUCCESS_EMBED_COLOR, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('Message Webhook Error ❌:', err.message);
  }
}

function getOnlinePlayersExcludingBot() {
  if (!bot || !bot.players) {
    return [];
  }
  return Object.values(bot.players).filter(p => p.username !== botOptions.username);
}

function sendPlayerList() {
  if (!bot || !bot.players) {
    return;
  }
  try {
    const playersExcludingBot = getOnlinePlayersExcludingBot();

    if (playersExcludingBot.length === 0) {
      return;
    }

    const fields = playersExcludingBot.map(player => ({
      name: player.username,
      value: `In Range: ${player.entity ? 'Yes' : 'No'}`,
      inline: true
    }));
  } catch (err) {
    console.error('Error sending player list ❌:', err.message);
  }
}

function sendBotStats() {
  if (!bot || !bot.entity) {
    return;
  }
  try {
    const uptime = botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0;
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;
    const position = bot.entity.position;
    const posStr = `X: ${Math.floor(position.x)}, Y: ${Math.floor(position.y)}, Z: ${Math.floor(position.z)}`;
    const memoryUsage = process.memoryUsage();
    const memoryStr = `${Math.round(memoryUsage.rss / 1024 / 1024 * 100) / 100} MB`;
    
    const gameModeDisplay = bot?.game?.gameMode || 'N/A';

    const onlinePlayersCount = getOnlinePlayersExcludingBot().length;

    sendDiscordEmbed('Bot Status Report', `Status report for ${botOptions.username}`, INFO_EMBED_COLOR, [
      { name: 'Uptime', value: uptimeStr, inline: true },
      { name: 'Position', value: posStr, inline: true },
      { name: 'Game Mode', value: gameModeDisplay, inline: true },
      { name: 'Memory Usage', value: memoryStr, inline: true },
      { name: 'Movement Count', value: `${movementCount} moves`, inline: true },
      { name: 'Players Online', value: `${onlinePlayersCount} (excluding bot)`, inline: true },
      { name: 'Server Load', value: `${os.loadavg()[0].toFixed(2)}`, inline: true }
    ]);
  } catch (err) {
    console.error('Error sending bot stats ❌:', err.message);
  }
}

function performMovement() {
  if (!bot || !bot.entity) {
    return;
  }
  try {
    const currentPos = bot.entity.position;
    const targetX = currentPos.x + (Math.random() * 10 - 5);
    const targetZ = currentPos.z + (Math.random() * 10 - 5);
    bot.entity.position.set(targetX, currentPos.y, targetZ);
    movementCount++;
  } catch (err) {
    console.error('Movement error ❌:', err.message);
  }
}

function lookAround() {
  if (!bot || !bot.entity) {
    return;
  }
  try {
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() * Math.PI / 3) - (Math.PI / 6);
    bot.look(yaw, pitch, true);
  } catch (err) {
    console.error('Look error ❌:', err.message);
  }
}

function setupIntervals() {
  movementInterval = setInterval(performMovement, MOVEMENT_INTERVAL);
  lookInterval = setInterval(lookAround, LOOK_INTERVAL);
  rejoinActivityTimeout = setInterval(checkBotActivity, 5000);
  setTimeout(sendPlayerList, 5000);
  setTimeout(sendBotStats, 10000);
}

function checkBotActivity() {
  if (!botStartTime || !isBotOnline) {
    return;
  }

  const uptime = Date.now() - botStartTime;

  if (uptime >= ONE_HOUR) {
    sendDiscordEmbed('Bot Activity', 'Bot active for over 1 hour. Rejoining to prevent AFK detection.', WARNING_EMBED_COLOR);
    forceRejoinBot();
    botStartTime = null;
    return;
  }
}

async function getOrCreatePlayerFace(username, uuid) {
  let playerFace = await PlayerFace.findOne({ username: username });
  let skinUrl;

  if (!playerFace) {
    if (username.startsWith('.')) {
      const assignedFaces = await PlayerFace.find({ username: { $regex: '^\.' } }, 'face');
      const availableFaces = FACES.filter(face => !assignedFaces.some(pf => pf.face === face));

      let selectedFace;
      if (availableFaces.length > 0 && nextDotFaceIndex < FACES.length) {
        selectedFace = FACES[nextDotFaceIndex];
        nextDotFaceIndex = (nextDotFaceIndex + 1) % FACES.length;
      } else {
        selectedFace = FACES[Math.floor(Math.random() * FACES.length)];
      }
      playerFace = new PlayerFace({ username: username, face: selectedFace, isCustom: false });
      skinUrl = `./${selectedFace}`;
    } else {
      try {
        const crafatarResponse = await axios.get(`https://crafatar.com/avatars/${uuid}?size=32&overlay`, { responseType: 'arraybuffer' });
        if (crafatarResponse.status === 200) {
          skinUrl = `https://crafatar.com/avatars/${uuid}?size=32&overlay`;
          playerFace = new PlayerFace({ username: username, face: skinUrl, isCustom: true });
        } else {
          const selectedFace = FACES[Math.floor(Math.random() * FACES.length)];
          skinUrl = `./${selectedFace}`;
          playerFace = new PlayerFace({ username: username, face: selectedFace, isCustom: false });
        }
      } catch (crafatarError) {
        const selectedFace = FACES[Math.floor(Math.random() * FACES.length)];
        skinUrl = `./${selectedFace}`;
        playerFace = new PlayerFace({ username: username, face: selectedFace, isCustom: false });
      }
    }
    await playerFace.save();
  } else {
    if (!playerFace.isCustom && !username.startsWith('.')) {
      try {
        const crafatarResponse = await axios.get(`https://crafatar.com/avatars/${uuid}?size=32&overlay`, { responseType: 'arraybuffer' });
        if (crafatarResponse.status === 200) {
          skinUrl = `https://crafatar.com/avatars/${uuid}?size=32&overlay`;
          playerFace.face = skinUrl;
          playerFace.isCustom = true;
          playerFace.lastUpdated = Date.now();
          await playerFace.save();
        } else {
          skinUrl = `./${playerFace.face}`;
        }
      } catch (crafatarError) {
        skinUrl = `./${playerFace.face}`;
      }
    } else {
      skinUrl = playerFace.isCustom ? playerFace.face : `./${playerFace.face}`;
    }
  }
  return skinUrl;
}

function startBot() {
  clearAllIntervals();
  if (bot) {
    bot.removeAllListeners();
    bot = null;
  }

  botStartTime = null;
  movementCount = 0;
  isBotOnline = false;

  bot = mineflayer.createBot(botOptions);

  bot.once('spawn', () => {
    sendDiscordEmbed('Bot Connected', `${botOptions.username} has joined the server.`, SUCCESS_EMBED_COLOR);
    isBotOnline = true;
    botStartTime = Date.now();
    lastOnlineTime = Date.now();

    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
      });
    }
    setTimeout(() => {
      setupIntervals();
    }, 1000);
  });

  bot.on('error', (err) => {
    sendDiscordEmbed('Bot Error', `Error: ${err.message}`, ERROR_EMBED_COLOR);

    if (err.message.includes("timed out") ||
      err.message.includes("ECONNRESET") ||
      err.name === 'PartialReadError' ||
      err.message.includes("Unexpected buffer end")) {
      clearAllIntervals();
      reconnectBot();
    }
  });

  bot.on('end', (reason) => {
    isBotOnline = false;
    clearAllIntervals();
    reconnectBot();
  });

  bot.on('chat', async (username, message) => {
  if (username !== botOptions.username) {
    const player = Object.values(bot.players).find(p =>
      p.username.replace(/^\./, '') === username.replace(/^\./, '')
    );
    const trueUsername = player?.username || username;
    const uuid = player?.uuid || null;

    sendPlayerMessage(trueUsername, message);

    try {
      const skinUrl = await getOrCreatePlayerFace(trueUsername, uuid);
      const chatMessage = new MinecraftChat({ username: trueUsername, chat: message });
      await chatMessage.save();
      io.emit('chatMessage', {
        username: trueUsername,
        chat: message,
        timestamp: chatMessage.timestamp,
        skinUrl,
      });
    } catch (err) {
      console.error('Error saving chat message to MongoDB ❌:', err.message);
    }
  }
});

  bot.on('playerJoined', async (player) => {
    if (player.username !== botOptions.username) {
      const skinUrl = await getOrCreatePlayerFace(player.username, player.uuid);
      player.skinUrl = skinUrl;

      const onlinePlayersCount = getOnlinePlayersExcludingBot().length;
      sendChatEmbed('Player Joined', `**${player.username}** joined the game.`, SUCCESS_EMBED_COLOR, [
        { name: 'Current Players', value: `${onlinePlayersCount} (excluding bot)`, inline: true }
      ]);
      sendPlayerList();
    }
  });

  bot.on('playerLeft', (player) => {
    if (player.username !== botOptions.username) {
      const onlinePlayersCount = getOnlinePlayersExcludingBot().length;
      sendChatEmbed('Player Left', `**${player.username}** left the game.`, 0xff4500, [
        { name: 'Current Players', value: `${Math.max(0, onlinePlayersCount)} (excluding bot)`, inline: true }
      ]);
      sendPlayerList();
    }
  });

  bot._client.on('player_info', (packet) => {
    packet.data.forEach((player) => {
      if (player.uuid === bot.uuid) {
        const gamemodeMap = {
          0: 'Survival',
          1: 'Creative',
          2: 'Adventure',
          3: 'Spectator',
        };
        const currentGamemode = gamemodeMap[player.gamemode] || 'Unknown';
        bot.game = bot.game || {};
        bot.game.gameMode = currentGamemode;
      }
    });
  });

  bot.on('health', () => {
  });
}

function reconnectBot() {
  clearAllIntervals();
  reconnectTimeout = setTimeout(() => {
    startBot();
  }, RECONNECT_DELAY);
}

function forceRejoinBot() {
  clearAllIntervals();
  rejoinActivityTimeout = setTimeout(() => {
    startBot();
  }, FIFTEEN_SECONDS);
}

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;

  for (let i = 0; i < cpus.length; i++) {
    const cpu = cpus[i];
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }

  const idleDifference = totalIdle - lastCpuUsage.idle;
  const totalDifference = totalTick - lastCpuUsage.total;

  lastCpuUsage = { idle: totalIdle, total: totalTick };

  return 100 - (100 * idleDifference / totalDifference);
}

app.get('/api/status', async (req, res) => {
  try {
    const playersExcludingBot = getOnlinePlayersExcludingBot();
    const onlinePlayersCount = playersExcludingBot.length;
    const playerDetails = await Promise.all(playersExcludingBot.map(async p => {
      const skinUrl = await getOrCreatePlayerFace(p.username, p.uuid);
      return {
        username: p.username,
        uuid: p.uuid,
        skinUrl: skinUrl,
      };
    }));

    const botStatus = {
      message: isBotOnline ? "Bot is running!" : "Bot is offline",
      onlinePlayersCount: onlinePlayersCount,
      playerDetails,
      gameMode: isBotOnline && bot?.game?.gameMode !== undefined ? bot.game.gameMode : 'N/A',
      position: isBotOnline && bot?.entity?.position ?
        {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z)
        } : 'N/A',
      uptime: botStartTime && isBotOnline ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
      movements: movementCount,
      memoryUsage: `${Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100} MB`,
      lastOnline: lastOnlineTime,
      serverHost: currentServerHost,
      serverPort: currentServerPort,
      botName: BOT_USERNAME,
      botHealth: isBotOnline && bot?.health !== undefined ? `${bot.health}/20` : 'N/A',
      botFood: isBotOnline && bot?.food !== undefined ? `${bot.food}/20` : 'N/A',
      botLatency: isBotOnline && bot?.player?.ping !== undefined ? `${bot.player.ping}ms` : 'N/A',
      serverLoad: os.loadavg()[0].toFixed(2),
      cpuUsage: getCpuUsage().toFixed(2),
      diskFree: `${(diskusage.checkSync('/').free / (1024 ** 3)).toFixed(2)} GB`,
      diskTotal: `${(diskusage.checkSync('/').total / (1024 ** 3)).toFixed(2)} GB`,
      minecraftDay: isBotOnline && bot?.time?.day !== undefined ? bot.time.day : 'N/A',
      minecraftTime: isBotOnline && bot?.time?.timeOfDay !== undefined ? bot.time.timeOfDay : 'N/A',
      serverDifficulty: isBotOnline && bot?.game?.difficulty !== undefined ? bot.game.difficulty : 'N/A',
    };
    res.json(botStatus);
  } catch (err) {
    console.error('Error in /api/status ❌:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get('/api/chat', async (req, res) => {
  try {
    const { username, date, search } = req.query;
    let query = {};
    if (username) {
      query.username = username;
    }
    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      query.timestamp = { $gte: startOfDay, $lte: endOfDay };
    }
    if (search) {
      query.chat = { $regex: search, $options: 'i' };
    }
    const skip = parseInt(req.query.skip) || 0;
    const limit = parseInt(req.query.limit) || 100;
    const messages = await MinecraftChat.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit);

    const messagesWithFaces = await Promise.all(messages.map(async (msg) => {
      const skinUrl = await getOrCreatePlayerFace(msg.username, null);
      return { ...msg.toObject(), skinUrl };
    }));

    res.json(messagesWithFaces);
  } catch (err) {
    console.error('Error fetching chat history ❌:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/chat/usernames', async (req, res) => {
  try {
    const usernames = await MinecraftChat.distinct('username');
    res.json(usernames);
  } catch (err) {
    console.error('Error fetching distinct usernames ❌:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

io.on('connection', (socket) => {
});

setInterval(async () => {
  try {
    const playersExcludingBot = getOnlinePlayersExcludingBot();
    const onlinePlayersCount = playersExcludingBot.length;
    const playerDetails = await Promise.all(playersExcludingBot.map(async p => {
      const skinUrl = await getOrCreatePlayerFace(p.username, p.uuid);
      return {
        username: p.username,
        uuid: p.uuid,
        skinUrl: skinUrl,
      };
    }));

    let diskInfo = { free: 0, total: 0 };
    try {
      diskInfo = await diskusage.check('/');
    } catch (err) {
      console.error('Disk usage check in socket.io interval error ❌:', err.message);
    }

    const botStatus = {
      message: isBotOnline ? "Bot is running!" : "Bot is offline",
      onlinePlayersCount: onlinePlayersCount,
      playerDetails,
      gameMode: isBotOnline && bot?.game?.gameMode !== undefined ? bot.game.gameMode : 'N/A',
      position: isBotOnline && bot?.entity?.position ?
        {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z)
        } : 'N/A',
      uptime: botStartTime && isBotOnline ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
      movements: movementCount,
      memoryUsage: `${Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100} MB`,
      lastOnline: lastOnlineTime,
      serverHost: currentServerHost,
      serverPort: currentServerPort,
      botName: BOT_USERNAME,
      botHealth: isBotOnline && bot?.health !== undefined ? `${bot.health}/20` : 'N/A',
      botFood: isBotOnline && bot?.food !== undefined ? `${bot.food}/20` : 'N/A',
      botLatency: isBotOnline && bot?.player?.ping !== undefined ? `${bot.player.ping}ms` : 'N/A',
      serverLoad: os.loadavg()[0].toFixed(2),
      cpuUsage: getCpuUsage().toFixed(2),
      diskFree: `${(diskInfo.free / (1024 ** 3)).toFixed(2)} GB`,
      diskTotal: `${(diskInfo.total / (1024 ** 3)).toFixed(2)} GB`,
      minecraftDay: isBotOnline && bot?.time?.day !== undefined ? bot.time.day : 'N/A',
      minecraftTime: isBotOnline && bot?.time?.timeOfDay !== undefined ? bot.time.timeOfDay : 'N/A',
      serverDifficulty: isBotOnline && bot?.game?.difficulty !== undefined ? bot.game.difficulty : 'N/A',
    };
    io.emit('botStatusUpdate', botStatus);
  } catch (err) {
    console.error('Error emitting status update via Socket.IO ❌:', err.message);
  }
}, SOCKET_IO_UPDATE_INTERVAL);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

server.listen(WEB_SERVER_PORT, () => {
  sendDiscordEmbed('Web Server', `Web monitoring server started on port ${WEB_SERVER_PORT}`, DEFAULT_EMBED_COLOR);
});

startBot();
