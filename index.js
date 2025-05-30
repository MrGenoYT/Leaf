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
const RECONNECT_DELAY = 10000;
const PLAYER_LIST_INTERVAL = 30 * 60 * 1000;
const BOT_STATS_INTERVAL = 60 * 60 * 1000;
const SOCKET_IO_UPDATE_INTERVAL = 1000;

const ONE_HOUR = 3600 * 1000;
const THIRTY_MINUTES = 1800 * 1000;
const FIFTEEN_SECONDS = 15 * 1000;
const ONE_MINUTE = 60 * 1000;

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
let playerListInterval = null;
let botStatsInterval = null;
let botStartTime = null;
let movementCount = 0;
let isBotOnline = false;
let lastOnlineTime = null;
let currentServerHost = BOT_HOST;
let currentServerPort = BOT_PORT;
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = process.hrtime.bigint();
let isMovementPaused = false;
let movementPauseTimeout = null;
let rejoinActivityTimeout = null;

console.log('Express app initialization started ✅');
const app = express();
console.log('HTTP server creation started ✅');
const server = http.createServer(app);
console.log('Socket.IO server creation started ✅');
const io = new Server(server);

console.log('Express middleware setup started ✅');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
console.log('Express middleware setup completed ✅');

console.log('MongoDB connection attempt started ✅');
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected ✅'))
  .catch(err => console.error('MongoDB connection error ❌:', err));

console.log('Mongoose schemas defined ✅');
const chatSchema = new mongoose.Schema({
  username: String,
  chat: String,
  timestamp: { type: Date, default: Date.now }
});
const MinecraftChat = mongoose.model('MinecraftChat', chatSchema);

const playerFaceSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  face: String
});
const PlayerFace = mongoose.model('PlayerFace', playerFaceSchema);
console.log('Mongoose models created ✅');

function clearAllIntervals() {
  console.log('Clearing all intervals...');
  if (movementInterval) {
    clearInterval(movementInterval);
    movementInterval = null;
  }
  if (lookInterval) {
    clearInterval(lookInterval);
    lookInterval = null;
  }
  if (playerListInterval) {
    clearInterval(playerListInterval);
    playerListInterval = null;
  }
  if (botStatsInterval) {
    clearInterval(botStatsInterval);
    botStatsInterval = null;
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (movementPauseTimeout) {
    clearTimeout(movementPauseTimeout);
    movementPauseTimeout = null;
  }
  if (rejoinActivityTimeout) {
    clearTimeout(rejoinActivityTimeout);
    rejoinActivityTimeout = null;
  }
  console.log('All intervals cleared ✅');
}

async function sendDiscordEmbed(title, description, color = DEFAULT_EMBED_COLOR, fields = []) {
  if (!DISCORD_WEBHOOK) {
    return;
  }
  try {
    console.log(`Sending Discord embed: ${title}`);
    await axios.post(DISCORD_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
    console.log('Discord embed sent ✅');
  } catch (err) {
    console.error('Discord Webhook Error ❌:', err.message);
  }
}

async function sendChatEmbed(title, description, color = SUCCESS_EMBED_COLOR, fields = []) {
  if (!CHAT_WEBHOOK) {
    return;
  }
  try {
    console.log(`Sending chat embed: ${title}`);
    await axios.post(CHAT_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
    console.log('Chat embed sent ✅');
  } catch (err) {
    console.error('Chat Webhook Error ❌:', err.message);
  }
}

async function sendPlayerMessage(username, message) {
  if (username === botOptions.username || !MESSAGE_WEBHOOK) {
    return;
  }
  try {
    console.log(`Sending player message to ${username}`);
    await axios.post(MESSAGE_WEBHOOK, {
      embeds: [{ author: { name: username }, description: message, color: SUCCESS_EMBED_COLOR, timestamp: new Date().toISOString() }],
    });
    console.log('Player message sent ✅');
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
    console.log('Sending player list...');
    const playersExcludingBot = getOnlinePlayersExcludingBot();

    if (playersExcludingBot.length === 0) {
      sendChatEmbed('Player List', 'No other players online', DEFAULT_EMBED_COLOR);
      return;
    }

    const fields = playersExcludingBot.map(player => ({
      name: player.username,
      value: `Ping: ${player.ping || 'N/A'}ms | In Range: ${player.entity ? 'Yes' : 'No'}`,
      inline: true
    }));
    sendChatEmbed('Player List', `${playersExcludingBot.length} player(s) online (excluding bot)`, DEFAULT_EMBED_COLOR, fields);
    console.log('Player list sent ✅');
  } catch (err) {
    console.error('Error sending player list ❌:', err.message);
  }
}

function sendBotStats() {
  if (!bot || !bot.entity) {
    return;
  }
  try {
    console.log('Sending bot stats...');
    const uptime = botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0;
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;
    const position = bot.entity.position;
    const posStr = `X: ${Math.floor(position.x)}, Y: ${Math.floor(position.y)}, Z: ${Math.floor(position.z)}`;
    const memoryUsage = process.memoryUsage();
    const memoryStr = `${Math.round(memoryUsage.rss / 1024 / 1024 * 100) / 100} MB`;
    const ping = bot.player ? bot.player.ping : 'Unknown';

    const gameModeDisplay = "Spectator";

    const onlinePlayersCount = getOnlinePlayersExcludingBot().length;

    sendChatEmbed('Bot Status Report', `Status report for ${botOptions.username}`, INFO_EMBED_COLOR, [
      { name: 'Uptime', value: uptimeStr, inline: true },
      { name: 'Position', value: posStr, inline: true },
      { name: 'Game Mode', value: gameModeDisplay, inline: true },
      { name: 'Memory Usage', value: memoryStr, inline: true },
      { name: 'Ping', value: `${ping}ms`, inline: true },
      { name: 'Movement Count', value: `${movementCount} moves`, inline: true },
      { name: 'Players Online', value: `${onlinePlayersCount} (excluding bot)`, inline: true },
      { name: 'Server Load', value: `${os.loadavg()[0].toFixed(2)}`, inline: true }
    ]);
    console.log('Bot stats sent ✅');
  } catch (err) {
    console.error('Error sending bot stats ❌:', err.message);
  }
}

function performMovement() {
  if (!bot || !bot.entity || isMovementPaused) {
    console.log('Movement skipped: bot not ready or movements paused.');
    return;
  }
  try {
    console.log('Performing movement...');
    const currentPos = bot.entity.position;
    const targetX = currentPos.x + (Math.random() * 10 - 5);
    const targetZ = currentPos.z + (Math.random() * 10 - 5);
    bot.entity.position.set(targetX, currentPos.y, targetZ);
    movementCount++;
    console.log('Movement performed ✅');
  } catch (err) {
    console.error('Movement error ❌:', err.message);
  }
}

function lookAround() {
  if (!bot || !bot.entity) {
    return;
  }
  try {
    console.log('Looking around...');
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() * Math.PI / 3) - (Math.PI / 6);
    bot.look(yaw, pitch, true);
    console.log('Look performed ✅');
  } catch (err) {
    console.error('Look error ❌:', err.message);
  }
}

function setupIntervals() {
  console.log('Setting up intervals...');
  movementInterval = setInterval(performMovement, MOVEMENT_INTERVAL);
  lookInterval = setInterval(lookAround, LOOK_INTERVAL);
  playerListInterval = setInterval(sendPlayerList, PLAYER_LIST_INTERVAL);
  botStatsInterval = setInterval(sendBotStats, BOT_STATS_INTERVAL);
  rejoinActivityTimeout = setInterval(checkBotActivity, 5000); // Check every 5 seconds
  setTimeout(sendPlayerList, 5000);
  setTimeout(sendBotStats, 10000);
  console.log('Intervals set up ✅');
}

function checkBotActivity() {
  if (!botStartTime || !isBotOnline) {
    return;
  }

  const uptime = Date.now() - botStartTime;

  if (uptime >= ONE_HOUR) {
    console.log('Bot active for over 1 hour. Rejoining in 15 seconds... ⏳');
    sendDiscordEmbed('Bot Activity', 'Bot active for over 1 hour. Rejoining to prevent AFK detection.', WARNING_EMBED_COLOR);
    forceRejoinBot();
    botStartTime = null;
    return;
  }

  if (uptime >= THIRTY_MINUTES && !isMovementPaused) {
    console.log('Bot active for over 30 minutes. Pausing movements for 1 minute... ⏸️');
    sendDiscordEmbed('Bot Activity', 'Bot active for over 30 minutes. Pausing movements for 1 minute to prevent AFK detection.', INFO_EMBED_COLOR);
    isMovementPaused = true;
    if (movementInterval) {
      clearInterval(movementInterval);
      movementInterval = null;
    }
    movementPauseTimeout = setTimeout(() => {
      console.log('Resuming movements... ▶️');
      sendDiscordEmbed('Bot Activity', 'Resuming movements after 1 minute pause.', INFO_EMBED_COLOR);
      isMovementPaused = false;
      movementInterval = setInterval(performMovement, MOVEMENT_INTERVAL);
    }, ONE_MINUTE);
  }
}

function startBot() {
  console.log('Bot initialization started ✅');
  clearAllIntervals();
  if (bot) {
    bot.removeAllListeners();
    bot = null;
  }

  botStartTime = Date.now();
  movementCount = 0;
  isBotOnline = false;
  isMovementPaused = false;

  bot = mineflayer.createBot(botOptions);
  console.log('Mineflayer bot created ✅');

  bot.once('spawn', () => {
    console.log('Bot joined the server ✅');
    sendDiscordEmbed('Bot Connected', `${botOptions.username} has joined the server.`, SUCCESS_EMBED_COLOR);
    isBotOnline = true;
    lastOnlineTime = Date.now();

    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        console.log('Bot client socket closed.');
      });
    }
    setTimeout(() => {
      setupIntervals();
    }, 1000);
  });

  bot.on('game', () => {
    console.log(`Game mode changed to: ${bot.gameMode}`);
    if (bot.gameMode === 3) {
      sendDiscordEmbed('Mode Change', `${botOptions.username} entered spectator mode.`, INFO_EMBED_COLOR);
    } else {
      sendDiscordEmbed('Mode Change', `${botOptions.username} entered an unknown game mode (${bot.gameMode}).`, WARNING_EMBED_COLOR);
    }
  });

  bot.on('end', (reason) => {
    console.log(`Bot disconnected ❌. Reason: ${reason}`);
    sendDiscordEmbed('Bot Disconnect', `${botOptions.username} was disconnected. Reason: ${reason}.`, ERROR_EMBED_COLOR);
    isBotOnline = false;
    clearAllIntervals();
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log(`Bot kicked ❌. Reason: ${reason}`);
    sendDiscordEmbed('Bot Kicked', `${botOptions.username} was kicked. Reason: ${reason}.`, ERROR_EMBED_COLOR);
    isBotOnline = false;
    clearAllIntervals();
    reconnectBot();
  });

  bot.on('error', (err) => {
    console.error('Bot error ❌:', err.message);
    sendDiscordEmbed('Bot Error', `Error: ${err.message}`, ERROR_EMBED_COLOR);

    if (err.message.includes("timed out") ||
      err.message.includes("ECONNRESET") ||
      err.name === 'PartialReadError' ||
      err.message.includes("Unexpected buffer end")) {
      clearAllIntervals();
      reconnectBot();
    }
  });

  bot.on('chat', async (username, message) => {
    console.log(`Chat received from ${username}: ${message}`);
    if (username !== botOptions.username) {
      sendPlayerMessage(username, message);
      try {
        const chatMessage = new MinecraftChat({ username, chat: message });
        await chatMessage.save();
        io.emit('chatMessage', { username, chat: message, timestamp: chatMessage.timestamp });
        console.log('Chat message saved to MongoDB and emitted via Socket.IO ✅');
      } catch (err) {
        console.error('Error saving chat message to MongoDB ❌:', err.message);
      }
    }
  });

  bot.on('playerJoined', async (player) => {
    console.log(`Player joined: ${player.username}`);
    if (player.username !== botOptions.username) {
      if (player.username.startsWith('.')) {
        let playerFace = await PlayerFace.findOne({ username: player.username });
        if (!playerFace) {
          const assignedFaces = await PlayerFace.find({}, 'face');
          const availableFaces = FACES.filter(face => !assignedFaces.some(pf => pf.face === face));

          let selectedFace;
          if (availableFaces.length > 0) {
            selectedFace = availableFaces[0];
          } else {
            selectedFace = FACES[Math.floor(Math.random() * FACES.length)];
          }
          playerFace = new PlayerFace({ username: player.username, face: selectedFace });
          await playerFace.save();
          console.log(`Assigned new face to ${player.username} ✅`);
        }
        player.skinType = playerFace.face.replace('.png', '');
      }
      const onlinePlayersCount = getOnlinePlayersExcludingBot().length;
      sendChatEmbed('Player Joined', `**${player.username}** joined the game.`, SUCCESS_EMBED_COLOR, [
        { name: 'Current Players', value: `${onlinePlayersCount} (excluding bot)`, inline: true }
      ]);
    }
  });

  bot.on('playerLeft', (player) => {
    console.log(`Player left: ${player.username}`);
    if (player.username !== botOptions.username) {
      const onlinePlayersCount = getOnlinePlayersExcludingBot().length;
      sendChatEmbed('Player Left', `**${player.username}** left the game.`, 0xff4500, [
        { name: 'Current Players', value: `${Math.max(0, onlinePlayersCount)} (excluding bot)`, inline: true }
      ]);
    }
  });
}

function reconnectBot() {
  console.log('Attempting to reconnect bot... 🔄');
  clearAllIntervals();
  reconnectTimeout = setTimeout(() => {
    startBot();
  }, RECONNECT_DELAY);
}

function forceRejoinBot() {
  console.log('Force rejoining bot... 🔄');
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
    console.log('API status request received ✅');
    const playersExcludingBot = getOnlinePlayersExcludingBot();
    const onlinePlayersCount = playersExcludingBot.length;
    const playerDetails = await Promise.all(playersExcludingBot.map(async p => {
      let skinUrl;
      if (p.username.startsWith('.')) {
        const playerFace = await PlayerFace.findOne({ username: p.username });
        skinUrl = `./${playerFace ? playerFace.face : FACES[Math.floor(Math.random() * FACES.length)]}`;
      } else {
        skinUrl = `https://crafatar.com/avatars/${p.uuid}?size=24&overlay`;
      }
      return {
        username: p.username,
        uuid: p.uuid,
        skinUrl: skinUrl,
        ping: p.ping || 'N/A'
      };
    }));

    const gameModeApiDisplay = "Spectator";

    let diskInfo = { free: 0, total: 0 };
    try {
      console.log('Checking disk usage...');
      diskInfo = await diskusage.check('/');
      console.log('Disk usage checked ✅');
    } catch (err) {
      console.error('Disk usage error ❌:', err.message);
    }

    const botStatus = {
      message: isBotOnline ? "Bot is running!" : "Bot is offline",
      onlinePlayersCount: onlinePlayersCount,
      playerDetails,
      gameMode: gameModeApiDisplay,
      position: bot?.entity?.position ?
        {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z)
        } : null,
      uptime: botStartTime && isBotOnline ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
      movements: movementCount,
      memoryUsage: `${Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100} MB`,
      lastOnline: lastOnlineTime,
      serverHost: currentServerHost,
      serverPort: currentServerPort,
      botName: BOT_USERNAME,
      botHealth: bot?.health !== undefined ? `${bot.health}/20` : 'N/A',
      botFood: bot?.food !== undefined ? `${bot.food}/20` : 'N/A',
      botLatency: bot?.player?.ping !== undefined ? `${bot.player.ping}ms` : 'N/A',
      serverLoad: os.loadavg()[0].toFixed(2),
      cpuUsage: getCpuUsage().toFixed(2),
      diskFree: `${(diskInfo.free / (1024 ** 3)).toFixed(2)} GB`,
      diskTotal: `${(diskInfo.total / (1024 ** 3)).toFixed(2)} GB`,
      minecraftDay: bot?.time?.day !== undefined ? bot.time.day : 'N/A',
      minecraftTime: bot?.time?.timeOfDay !== undefined ? bot.time.timeOfDay : 'N/A',
      serverDifficulty: bot?.game?.difficulty !== undefined ? bot.game.difficulty : 'N/A',
    };
    res.json(botStatus);
    console.log('API status response sent ✅');
  } catch (err) {
    console.error('Error in /api/status ❌:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get('/api/chat', async (req, res) => {
  try {
    console.log('API chat history request received ✅');
    const { username, date, search } = req.query;
    let query = {};
    if (username) {
      query.username = username;
    }
    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setUTCHours(23, 59, 59, 999);
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
    res.json(messages);
    console.log('Chat history fetched and sent ✅');
  } catch (err) {
    console.error('Error fetching chat history ❌:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/chat/usernames', async (req, res) => {
  try {
    console.log('API chat usernames request received ✅');
    const usernames = await MinecraftChat.distinct('username');
    res.json(usernames);
    console.log('Distinct usernames fetched and sent ✅');
  } catch (err) {
    console.error('Error fetching distinct usernames ❌:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

io.on('connection', (socket) => {
  console.log('A user connected via Socket.IO ✅');
  socket.on('disconnect', () => {
    console.log('A user disconnected from Socket.IO ❌');
  });
});

setInterval(async () => {
  try {
    const playersExcludingBot = getOnlinePlayersExcludingBot();
    const onlinePlayersCount = playersExcludingBot.length;
    const playerDetails = await Promise.all(playersExcludingBot.map(async p => {
      let skinUrl;
      if (p.username.startsWith('.')) {
        const playerFace = await PlayerFace.findOne({ username: p.username });
        skinUrl = `./${playerFace ? playerFace.face : FACES[Math.floor(Math.random() * FACES.length)]}`;
      } else {
        skinUrl = `https://crafatar.com/avatars/${p.uuid}?size=24&overlay`;
      }
      return {
        username: p.username,
        uuid: p.uuid,
        skinUrl: skinUrl,
        ping: p.ping || 'N/A'
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
      gameMode: "Spectator",
      position: bot?.entity?.position ?
        {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z)
        } : null,
      uptime: botStartTime && isBotOnline ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
      movements: movementCount,
      memoryUsage: `${Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100} MB`,
      lastOnline: lastOnlineTime,
      serverHost: currentServerHost,
      serverPort: currentServerPort,
      botName: BOT_USERNAME,
      botHealth: bot?.health !== undefined ? `${bot.health}/20` : 'N/A',
      botFood: bot?.food !== undefined ? `${bot.food}/20` : 'N/A',
      botLatency: bot?.player?.ping !== undefined ? `${bot.player.ping}ms` : 'N/A',
      serverLoad: os.loadavg()[0].toFixed(2),
      cpuUsage: getCpuUsage().toFixed(2),
      diskFree: `${(diskInfo.free / (1024 ** 3)).toFixed(2)} GB`,
      diskTotal: `${(diskInfo.total / (1024 ** 3)).toFixed(2)} GB`,
      minecraftDay: bot?.time?.day !== undefined ? bot.time.day : 'N/A',
      minecraftTime: bot?.time?.timeOfDay !== undefined ? bot.time.timeOfDay : 'N/A',
      serverDifficulty: bot?.game?.difficulty !== undefined ? bot.game.difficulty : 'N/A',
    };
    io.emit('botStatusUpdate', botStatus);
  } catch (err) {
    console.error('Error emitting status update via Socket.IO ❌:', err.message);
  }
}, SOCKET_IO_UPDATE_INTERVAL);

app.get('/', (req, res) => {
  console.log('Serving dashboard.html ✅');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

server.listen(WEB_SERVER_PORT, () => {
  console.log(`Web server started on port ${WEB_SERVER_PORT} ✅`);
  sendDiscordEmbed('Web Server', `Web monitoring server started on port ${WEB_SERVER_PORT}`, DEFAULT_EMBED_COLOR);
});

startBot(); 
