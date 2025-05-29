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

// Environment variables for configuration
const BOT_HOST = process.env.BOT_HOST || 'Leafsong.aternos.me';
const BOT_PORT = parseInt(process.env.BOT_PORT, 10) || 36915;
const BOT_USERNAME = process.env.BOT_USERNAME || 'LeafBOT';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const CHAT_WEBHOOK = process.env.CHAT_WEBHOOK;
const MESSAGE_WEBHOOK = process.env.MESSAGE_WEBHOOK;
const WEB_SERVER_PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/minecraft_dashboard';

// Bot intervals and delays
const MOVEMENT_INTERVAL = 5000;
const LOOK_INTERVAL = 3000;
const RECONNECT_DELAY = 10000;
const PLAYER_LIST_INTERVAL = 30 * 60 * 1000;
const BOT_STATS_INTERVAL = 60 * 60 * 1000;
const SOCKET_IO_UPDATE_INTERVAL = 1000; // 1 second for real-time updates

// Discord embed colors
const DEFAULT_EMBED_COLOR = 0x3498db;
const SUCCESS_EMBED_COLOR = 0x00ff00;
const WARNING_EMBED_COLOR = 0xff9900;
const ERROR_EMBED_COLOR = 0xff0000;
const INFO_EMBED_COLOR = 0x9b59b6;

// Mineflayer bot options
const botOptions = {
  host: BOT_HOST,
  port: BOT_PORT,
  username: BOT_USERNAME,
  connectTimeout: null,
};

// Global bot state variables
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

// Express app setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB connection
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// MongoDB schema for chat messages
const chatSchema = new mongoose.Schema({
  username: String,
  chat: String,
  timestamp: { type: Date, default: Date.now }
});
const MinecraftChat = mongoose.model('MinecraftChat', chatSchema);

// Function to clear all bot-related intervals
function clearAllIntervals() {
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
}

// Function to send Discord embeds
async function sendDiscordEmbed(title, description, color = DEFAULT_EMBED_COLOR, fields = []) {
  if (!DISCORD_WEBHOOK) {
    return;
  }
  try {
    await axios.post(DISCORD_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('Discord Webhook Error:', err.message);
  }
}

// Function to send chat embeds
async function sendChatEmbed(title, description, color = SUCCESS_EMBED_COLOR, fields = []) {
  if (!CHAT_WEBHOOK) {
    return;
  }
  try {
    await axios.post(CHAT_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('Chat Webhook Error:', err.message);
  }
}

// Function to send player messages
async function sendPlayerMessage(username, message) {
  if (username === botOptions.username || !MESSAGE_WEBHOOK) {
    return;
  }
  try {
    await axios.post(MESSAGE_WEBHOOK, {
      embeds: [{ author: { name: username }, description: message, color: SUCCESS_EMBED_COLOR, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('Message Webhook Error:', err.message);
  }
}

// Helper to get online players excluding the bot
function getOnlinePlayersExcludingBot() {
  if (!bot || !bot.players) {
    return [];
  }
  return Object.values(bot.players).filter(p => p.username !== botOptions.username);
}

// Function to send player list to Discord
function sendPlayerList() {
  if (!bot || !bot.players) {
    return;
  }
  try {
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
  } catch (err) {
    console.error('Error sending player list:', err.message);
  }
}

// Function to send bot stats to Discord
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
    const ping = bot.player ? bot.player.ping : 'Unknown';

    const gameModeDisplay = (bot?.gameMode === 3 || (bot?.gameMode === undefined && isBotOnline)) ?
      'Spectator' : 'Unknown';

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
  } catch (err) {
    console.error('Error sending bot stats:', err.message);
  }
}

// Bot movement logic (simplified for spectator mode)
function performMovement() {
  if (!bot || !bot.entity) return;
  try {
    const currentPos = bot.entity.position;
    const targetX = currentPos.x + (Math.random() * 10 - 5);
    const targetZ = currentPos.z + (Math.random() * 10 - 5);
    bot.entity.position.set(targetX, currentPos.y, targetZ);
    movementCount++;
  } catch (err) {
    console.error('Movement error:', err.message);
  }
}

// Bot look around logic
function lookAround() {
  if (!bot || !bot.entity) return;
  try {
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() * Math.PI / 3) - (Math.PI / 6);
    bot.look(yaw, pitch, true);
  } catch (err) {
    console.error('Look error:', err.message);
  }
}

// Setup bot intervals
function setupIntervals() {
  movementInterval = setInterval(performMovement, MOVEMENT_INTERVAL);
  lookInterval = setInterval(lookAround, LOOK_INTERVAL);
  playerListInterval = setInterval(sendPlayerList, PLAYER_LIST_INTERVAL);
  botStatsInterval = setInterval(sendBotStats, BOT_STATS_INTERVAL);
  setTimeout(sendPlayerList, 5000);
  setTimeout(sendBotStats, 10000);
}

// Function to start the Mineflayer bot
function startBot() {
  clearAllIntervals();
  if (bot) {
    bot.removeAllListeners();
    bot = null;
  }

  botStartTime = Date.now();
  movementCount = 0;
  isBotOnline = false;

  bot = mineflayer.createBot(botOptions);

  bot.once('spawn', () => {
    sendDiscordEmbed('Bot Connected', `${botOptions.username} has joined the server.`, SUCCESS_EMBED_COLOR);
    isBotOnline = true;
    lastOnlineTime = Date.now();

    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        // Log socket close events if needed for debugging
      });
    }
    setTimeout(() => {
      setupIntervals();
    }, 1000);
  });

  bot.on('game', () => {
    if (bot.gameMode === 3) {
      sendDiscordEmbed('Mode Change', `${botOptions.username} entered spectator mode.`, INFO_EMBED_COLOR);
    } else {
      sendDiscordEmbed('Mode Change', `${botOptions.username} entered an unknown game mode (${bot.gameMode}).`, WARNING_EMBED_COLOR);
    }
  });

  bot.on('end', (reason) => {
    sendDiscordEmbed('Bot Disconnect', `${botOptions.username} was disconnected. Reason: ${reason}.`, ERROR_EMBED_COLOR);
    isBotOnline = false;
    clearAllIntervals();
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    sendDiscordEmbed('Bot Kicked', `${botOptions.username} was kicked. Reason: ${reason}.`, ERROR_EMBED_COLOR);
    isBotOnline = false;
    clearAllIntervals();
    reconnectBot();
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

  bot.on('chat', async (username, message) => {
    if (username !== botOptions.username) {
      sendPlayerMessage(username, message);
      try {
        const chatMessage = new MinecraftChat({ username, chat: message });
        await chatMessage.save();
        io.emit('chatMessage', { username, chat: message, timestamp: chatMessage.timestamp });
      } catch (err) {
        console.error('Error saving chat message to MongoDB:', err.message);
      }
    }
  });

  bot.on('playerJoined', (player) => {
    if (player.username !== botOptions.username) {
      if (player.username.startsWith('.')) {
        player.skinType = Math.random() > 0.5 ? 'alex' : 'steve';
      }
      const onlinePlayersCount = getOnlinePlayersExcludingBot().length;
      sendChatEmbed('Player Joined', `**${player.username}** joined the game.`, SUCCESS_EMBED_COLOR, [
        { name: 'Current Players', value: `${onlinePlayersCount} (excluding bot)`, inline: true }
      ]);
    }
  });

  bot.on('playerLeft', (player) => {
    if (player.username !== botOptions.username) {
      const onlinePlayersCount = getOnlinePlayersExcludingBot().length;
      sendChatEmbed('Player Left', `**${player.username}** left the game.`, 0xff4500, [
        { name: 'Current Players', value: `${Math.max(0, onlinePlayersCount)} (excluding bot)`, inline: true }
      ]);
    }
  });
}

// Function to reconnect the bot
function reconnectBot() {
  clearAllIntervals();
  reconnectTimeout = setTimeout(() => {
    startBot();
  }, RECONNECT_DELAY);
}

// Function to calculate CPU usage
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

// API endpoint for bot status
app.get('/api/status', async (req, res) => {
  try {
    const playersExcludingBot = getOnlinePlayersExcludingBot();
    const onlinePlayersCount = playersExcludingBot.length;
    const playerDetails = playersExcludingBot.map(p => {
      let skinUrl;
      if (p.username.startsWith('.')) {
        skinUrl = `./${p.skinType || (Math.random() > 0.5 ? 'steve' : 'alex')}.png`;
      } else {
        skinUrl = `https://crafatar.com/avatars/${p.uuid}?size=24&overlay`;
      }
      return {
        username: p.username,
        uuid: p.uuid,
        skinUrl: skinUrl,
        ping: p.ping || 'N/A'
      };
    });

    const gameModeApiDisplay = (bot?.gameMode === 3 ||
      (bot?.gameMode === undefined && isBotOnline)) ? "Spectator" : "Unknown";

    let diskInfo = { free: 0, total: 0 };
    try {
      diskInfo = await diskusage.check('/');
    } catch (err) {
      console.error('Disk usage error:', err.message);
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
      botHealth: bot?.health !== undefined ? `${(bot.health / 20 * 10).toFixed(1)}/10` : 'N/A',
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
  } catch (err) {
    console.error('Error in /api/status:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// API endpoint for bot commands
app.post('/api/command', async (req, res) => {
  const { command } = req.body;
  try {
    switch (command) {
      case 'join':
        if (!isBotOnline) {
          startBot();
          res.json({ success: true, message: 'Bot is attempting to join.' });
        } else {
          res.status(400).json({ success: false, message: 'Bot is already online.' });
        }
        break;
      case 'leave':
        if (bot && isBotOnline) {
          bot.quit();
          clearAllIntervals();
          isBotOnline = false;
          lastOnlineTime = Date.now();
          res.json({ success: true, message: 'Bot has left the server.' });
        } else {
          res.status(400).json({ success: false, message: 'Bot is already offline.' });
        }
        break;
      case 'rejoin':
        if (bot && isBotOnline) {
          bot.quit();
          clearAllIntervals();
          isBotOnline = false;
          setTimeout(() => {
            startBot();
          }, 3000); // Wait 3 seconds before rejoining
          res.json({ success: true, message: 'Bot is rejoining the server.' });
        } else {
          startBot(); // If offline, just join
          res.json({ success: true, message: 'Bot is attempting to join.' });
        }
        break;
      default:
        res.status(400).json({ success: false, message: 'Unknown command.' });
    }
  } catch (err) {
    console.error('Error processing command:', err.message);
    res.status(500).json({ success: false, message: 'Error processing command.' });
  }
});

// API endpoint to get chat history
app.get('/api/chat', async (req, res) => {
  try {
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
    const messages = await MinecraftChat.find(query).sort({ timestamp: -1 }).limit(100); // Limit to 100 recent messages
    res.json(messages);
  } catch (err) {
    console.error('Error fetching chat history:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Socket.IO real-time status updates
io.on('connection', (socket) => {
  console.log('A user connected via Socket.IO');
  socket.on('disconnect', () => {
    console.log('A user disconnected from Socket.IO');
  });
});

// Emit bot status every second
setInterval(async () => {
  try {
    const playersExcludingBot = getOnlinePlayersExcludingBot();
    const onlinePlayersCount = playersExcludingBot.length;
    const playerDetails = playersExcludingBot.map(p => {
      let skinUrl;
      if (p.username.startsWith('.')) {
        skinUrl = `./${p.skinType || (Math.random() > 0.5 ? 'steve' : 'alex')}.png`;
      } else {
        skinUrl = `https://crafatar.com/avatars/${p.uuid}?size=24&overlay`;
      }
      return {
        username: p.username,
        uuid: p.uuid,
        skinUrl: skinUrl,
        ping: p.ping || 'N/A'
      };
    });

    let diskInfo = { free: 0, total: 0 };
    try {
      diskInfo = await diskusage.check('/');
    } catch (err) {
      // Disk usage error, use default values
    }

    const botStatus = {
      message: isBotOnline ? "Bot is running!" : "Bot is offline",
      onlinePlayersCount: onlinePlayersCount,
      playerDetails,
      gameMode: bot?.gameMode === 3 ? "Spectator" : (bot?.gameMode !== undefined ? bot.gameMode : 'Unknown'),
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
      botHealth: bot?.health !== undefined ? `${(bot.health / 20 * 10).toFixed(1)}/10` : 'N/A',
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
    console.error('Error emitting status update via Socket.IO:', err.message);
  }
}, SOCKET_IO_UPDATE_INTERVAL);

//  Serve dashboard.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Start the HTTP server
server.listen(WEB_SERVER_PORT, () => {
  sendDiscordEmbed('Web Server', `Web monitoring server started on port ${WEB_SERVER_PORT}`, DEFAULT_EMBED_COLOR);
});

// Start the Mineflayer bot
startBot();
