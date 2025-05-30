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

// Environment variables for bot configuration and webhooks
const BOT_HOST = process.env.BOT_HOST || 'Leafsong.aternos.me';
const BOT_PORT = parseInt(process.env.BOT_PORT, 10) || 36915;
const BOT_USERNAME = process.env.BOT_USERNAME || 'LeafBOT';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK; // For general bot status updates
const CHAT_WEBHOOK = process.env.CHAT_WEBHOOK;     // For in-game chat messages
const MESSAGE_WEBHOOK = process.env.MESSAGE_WEBHOOK; // For player-to-player messages (if applicable)
const WEB_SERVER_PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/minecraft_dashboard';

// Bot behavior intervals (can be adjusted)
const MOVEMENT_INTERVAL = 5000; // Time between bot movements
const LOOK_INTERVAL = 3000;     // Time between bot looking around
const RECONNECT_DELAY = 10000;  // Delay before attempting to reconnect after disconnect/error
const PLAYER_LIST_INTERVAL = 30 * 60 * 1000; // Interval to send player list to Discord (30 minutes)
const BOT_STATS_INTERVAL = 60 * 60 * 1000;   // Interval to send bot stats to Discord (60 minutes)
const SOCKET_IO_UPDATE_INTERVAL = 1000;      // Interval for sending status updates via Socket.IO

// Discord embed colors (hexadecimal)
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
  connectTimeout: null, // No specific connection timeout
};

// Global variables for bot state and intervals
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
let lastCpuTime = process.hrtime.bigint(); // For accurate CPU usage calculation

// Express app and Socket.IO setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware to parse JSON and serve static files
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Assuming public folder for dashboard.html, steve.png, alex.png

// MongoDB connection
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Mongoose Schema for Minecraft chat messages
const chatSchema = new mongoose.Schema({
  username: String,
  chat: String,
  timestamp: { type: Date, default: Date.now },
  uuid: String // Store UUID for crafatar skin fetching
});
const MinecraftChat = mongoose.model('MinecraftChat', chatSchema);

/**
 * Clears all active bot-related intervals.
 * This is crucial for preventing multiple intervals running simultaneously
 * when the bot reconnects or is explicitly stopped.
 */
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

/**
 * Sends an embed message to a Discord webhook.
 * @param {string} title - The title of the embed.
 * @param {string} description - The description/main content of the embed.
 * @param {number} color - The color of the embed (hexadecimal, e.g., 0x3498db).
 * @param {Array} fields - An array of field objects for the embed.
 */
async function sendDiscordEmbed(title, description, color = DEFAULT_EMBED_COLOR, fields = []) {
  if (!DISCORD_WEBHOOK) {
    console.warn('DISCORD_WEBHOOK is not configured. Skipping Discord embed.');
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

/**
 * Sends an embed message to the chat Discord webhook.
 * @param {string} title - The title of the embed.
 * @param {string} description - The description/main content of the embed.
 * @param {number} color - The color of the embed (hexadecimal, e.g., 0x00ff00).
 * @param {Array} fields - An array of field objects for the embed.
 */
async function sendChatEmbed(title, description, color = SUCCESS_EMBED_COLOR, fields = []) {
  if (!CHAT_WEBHOOK) {
    console.warn('CHAT_WEBHOOK is not configured. Skipping chat embed.');
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

/**
 * Sends a player message embed to a specific webhook (e.g., for direct messages).
 * @param {string} username - The username of the sender.
 * @param {string} message - The content of the message.
 */
async function sendPlayerMessage(username, message) {
  // Prevent bot from messaging itself or if MESSAGE_WEBHOOK is not set
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

/**
 * Retrieves a list of online players, excluding the bot itself.
 * @returns {Array} An array of player objects.
 */
function getOnlinePlayersExcludingBot() {
  if (!bot || !bot.players) {
    return [];
  }
  return Object.values(bot.players).filter(p => p.username !== botOptions.username);
}

/**
 * Sends the current list of online players to the chat webhook.
 */
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

/**
 * Sends a detailed bot status report to the chat webhook.
 */
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

    const gameModeDisplay = 'Spectator'; // Assuming bot is always in spectator mode

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

/**
 * Makes the bot perform a random movement.
 */
function performMovement() {
  if (!bot || !bot.entity) return;
  try {
    const currentPos = bot.entity.position;
    // Move within a small radius around current position
    const targetX = currentPos.x + (Math.random() * 10 - 5);
    const targetZ = currentPos.z + (Math.random() * 10 - 5);
    // Note: mineflayer's bot.entity.position is read-only.
    // For movement, you'd typically use bot.pathfinder.goto or similar.
    // For a simple "spectator" bot, just updating a counter is sufficient
    // if actual in-game movement isn't critical.
    // If actual movement is desired, a pathfinding library would be needed.
    // For now, we increment movementCount to simulate activity.
    movementCount++;
  } catch (err) {
    console.error('Movement error:', err.message);
  }
}

/**
 * Makes the bot look in a random direction.
 */
function lookAround() {
  if (!bot || !bot.entity) return;
  try {
    const yaw = Math.random() * Math.PI * 2; // Full circle
    const pitch = (Math.random() * Math.PI / 3) - (Math.PI / 6); // Up/down limited range
    bot.look(yaw, pitch, true); // true for force, to bypass smoothing
  } catch (err) {
    console.error('Look error:', err.message);
  }
}

/**
 * Sets up periodic intervals for bot activities.
 */
function setupIntervals() {
  movementInterval = setInterval(performMovement, MOVEMENT_INTERVAL);
  lookInterval = setInterval(lookAround, LOOK_INTERVAL);
  playerListInterval = setInterval(sendPlayerList, PLAYER_LIST_INTERVAL);
  botStatsInterval = setInterval(sendBotStats, BOT_STATS_INTERVAL);
  // Send initial reports shortly after setup
  setTimeout(sendPlayerList, 5000);
  setTimeout(sendBotStats, 10000);
}

/**
 * Starts the Mineflayer bot and sets up its event listeners.
 */
function startBot() {
  clearAllIntervals(); // Ensure no old intervals are running
  if (bot) {
    bot.removeAllListeners(); // Clean up old bot instance listeners
    bot = null;
  }

  botStartTime = Date.now(); // Record bot start time
  movementCount = 0;        // Reset movement count
  isBotOnline = false;      // Set initial online status to false, will be true on 'spawn'

  bot = mineflayer.createBot(botOptions); // Create new bot instance

  // Event: Bot successfully spawned in the game
  bot.once('spawn', () => {
    sendDiscordEmbed('Bot Connected', `${botOptions.username} has joined the server.`, SUCCESS_EMBED_COLOR);
    isBotOnline = true;
    lastOnlineTime = Date.now(); // Update last online time

    // Keep the socket alive to prevent premature disconnects
    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        // Log if socket closes with an error
        if (hadError) console.error('Bot socket closed with error.');
      });
    }
    // Set up intervals after a short delay to ensure bot is fully ready
    setTimeout(() => {
      setupIntervals();
    }, 1000);
  });

  // Event: Game mode changes
  bot.on('game', () => {
    if (bot.gameMode === 3) { // Spectator mode
      sendDiscordEmbed('Mode Change', `${botOptions.username} entered spectator mode.`, INFO_EMBED_COLOR);
    } else {
      sendDiscordEmbed('Mode Change', `${botOptions.username} entered an unknown game mode (${bot.gameMode}).`, WARNING_EMBED_COLOR);
    }
  });

  // Event: Bot disconnects from the server
  bot.on('end', (reason) => {
    sendDiscordEmbed('Bot Disconnect', `${botOptions.username} was disconnected. Reason: ${reason}.`, ERROR_EMBED_COLOR);
    isBotOnline = false;
    clearAllIntervals();
    reconnectBot(); // Attempt to reconnect
  });

  // Event: Bot is kicked from the server
  bot.on('kicked', (reason) => {
    sendDiscordEmbed('Bot Kicked', `${botOptions.username} was kicked. Reason: ${reason}.`, ERROR_EMBED_COLOR);
    isBotOnline = false;
    clearAllIntervals();
    reconnectBot(); // Attempt to reconnect
  });

  // Event: General bot error
  bot.on('error', (err) => {
    sendDiscordEmbed('Bot Error', `Error: ${err.message}`, ERROR_EMBED_COLOR);

    // Specific error handling for common connection issues
    if (err.message.includes("timed out") ||
      err.message.includes("ECONNRESET") ||
      err.name === 'PartialReadError' ||
      err.message.includes("Unexpected buffer end")) {
      clearAllIntervals();
      reconnectBot(); // Attempt to reconnect
    }
  });

  // Event: In-game chat message
  bot.on('chat', async (username, message) => {
    if (username !== botOptions.username) { // Ignore messages from the bot itself
      sendPlayerMessage(username, message); // Send to message webhook
      try {
        // Get UUID for skin fetching, fallback if player object not available
        const playerUuid = bot.players[username] ? bot.players[username].uuid : null;
        const chatMessage = new MinecraftChat({ username, chat: message, uuid: playerUuid });
        await chatMessage.save(); // Save message to MongoDB
        // Emit message to connected dashboard clients via Socket.IO
        io.emit('chatMessage', { username, chat: message, timestamp: chatMessage.timestamp, uuid: playerUuid });
      } catch (err) {
        console.error('Error saving chat message to MongoDB:', err.message);
      }
    }
  });

  // Event: Player joins the game
  bot.on('playerJoined', (player) => {
    if (player.username !== botOptions.username) {
      // Assign a random skin type (steve/alex) if username starts with '.' or UUID is not available
      if (!player.uuid || player.username.startsWith('.')) {
        player.skinType = Math.random() > 0.5 ? 'alex' : 'steve';
      }
      const onlinePlayersCount = getOnlinePlayersExcludingBot().length;
      sendChatEmbed('Player Joined', `**${player.username}** joined the game.`, SUCCESS_EMBED_COLOR, [
        { name: 'Current Players', value: `${onlinePlayersCount} (excluding bot)`, inline: true }
      ]);
      // Re-emit status to update player list on dashboard
      emitBotStatusUpdate();
    }
  });

  // Event: Player leaves the game
  bot.on('playerLeft', (player) => {
    if (player.username !== botOptions.username) {
      const onlinePlayersCount = getOnlinePlayersExcludingBot().length;
      sendChatEmbed('Player Left', `**${player.username}** left the game.`, 0xff4500, [
        { name: 'Current Players', value: `${Math.max(0, onlinePlayersCount)} (excluding bot)`, inline: true }
      ]);
      // Re-emit status to update player list on dashboard
      emitBotStatusUpdate();
    }
  });
}

/**
 * Attempts to reconnect the bot after a delay.
 */
function reconnectBot() {
  clearAllIntervals();
  reconnectTimeout = setTimeout(() => {
    startBot();
  }, RECONNECT_DELAY);
}

/**
 * Calculates current CPU usage percentage.
 * @returns {number} CPU usage as a percentage.
 */
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

  // Calculate difference since last check
  const idleDifference = totalIdle - lastCpuUsage.idle;
  const totalDifference = totalTick - lastCpuUsage.total;

  // Update last CPU usage for next calculation
  lastCpuUsage = { idle: totalIdle, total: totalTick };

  // Prevent division by zero
  if (totalDifference === 0) return 0;

  return 100 - (100 * idleDifference / totalDifference);
}

/**
 * Fetches and emits the bot's current status to all connected Socket.IO clients.
 */
async function emitBotStatusUpdate() {
  try {
    const playersExcludingBot = getOnlinePlayersExcludingBot();
    const onlinePlayersCount = playersExcludingBot.length;
    const playerDetails = playersExcludingBot.map(p => {
      let skinUrl;
      // Use crafatar for UUID-based skins, fallback to steve/alex for others (e.g., cracked clients)
      if (p.uuid) {
        skinUrl = `https://crafatar.com/avatars/${p.uuid}?size=24&overlay`;
      } else {
        // Simple heuristic for steve/alex based on username's first char code
        skinUrl = `./${p.username.charCodeAt(0) % 2 === 0 ? 'steve.png' : 'alex.png'}`;
      }
      return {
        username: p.username,
        uuid: p.uuid,
        skinUrl: skinUrl,
        ping: p.ping || 'N/A'
      };
    });

    const gameModeApiDisplay = "Spectator"; // Assuming bot is always in spectator mode

    let diskInfo = { free: 0, total: 0 };
    try {
      diskInfo = await diskusage.check('/'); // Check disk usage of root partition
    } catch (err) {
      console.error('Disk usage error:', err.message);
    }

    // Construct the bot status object
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
      serverLoad: os.loadavg()[0].toFixed(2), // 1-minute load average
      cpuUsage: getCpuUsage().toFixed(2),
      diskFree: `${(diskInfo.free / (1024 ** 3)).toFixed(2)} GB`,
      diskTotal: `${(diskInfo.total / (1024 ** 3)).toFixed(2)} GB`,
      minecraftDay: bot?.time?.day !== undefined ? bot.time.day : 'N/A',
      minecraftTime: bot?.time?.timeOfDay !== undefined ? bot.time.timeOfDay : 'N/A',
      serverDifficulty: bot?.game?.difficulty !== undefined ? bot.game.difficulty : 'N/A',
    };
    io.emit('botStatusUpdate', botStatus); // Emit status to all connected clients
  } catch (err) {
    console.error('Error emitting status update via Socket.IO:', err.message);
  }
}

// API Endpoint: Get bot status (for initial page load)
app.get('/api/status', async (req, res) => {
  // Re-use the emitBotStatusUpdate logic to construct the response
    // Note: This is simplified; in a real app, you might have a separate
  // function that just *gets* the status data without emitting.
  // For now, we'll call emitBotStatusUpdate and then send the same data.
  try {
    const playersExcludingBot = getOnlinePlayersExcludingBot();
    const onlinePlayersCount = playersExcludingBot.length;
    const playerDetails = playersExcludingBot.map(p => {
      let skinUrl;
      if (p.uuid) {
        skinUrl = `https://crafatar.com/avatars/${p.uuid}?size=24&overlay`;
      } else {
        skinUrl = `./${p.username.charCodeAt(0) % 2 === 0 ? 'steve.png' : 'alex.png'}`;
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
      console.error('Disk usage error:', err.message);
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
    res.json(botStatus);
  } catch (err) {
    console.error('Error in /api/status:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// REMOVED: app.post('/api/command', ...) as admin panel is removed

// API Endpoint: Get chat history based on filters
app.get('/api/chat', async (req, res) => {
  try {
    const { username, date, search } = req.query;
    let query = {};

    // Apply username filter if provided
    if (username) {
      query.username = username;
    }

    // Apply date filter if provided
    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setUTCHours(0, 0, 0, 0); // Start of the day in UTC
      const endOfDay = new Date(date);
      endOfDay.setUTCHours(23, 59, 59, 999); // End of the day in UTC
      query.timestamp = { $gte: startOfDay, $lte: endOfDay };
    }

    // Apply search filter if provided (case-insensitive regex)
    if (search) {
      query.chat = { $regex: search, $options: 'i' };
    }

    // Fetch messages, sort by timestamp descending, and limit to 10 for initial display
    const messages = await MinecraftChat.find(query).sort({ timestamp: -1 }).limit(10);
    res.json(messages);
  } catch (err) {
    console.error('Error fetching chat history:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API Endpoint: Get unique usernames for filtering
app.get('/api/chat/users', async (req, res) => {
  try {
    // Use distinct to get all unique usernames from the MinecraftChat collection
    const usernames = await MinecraftChat.distinct('username');
    res.json(usernames);
  } catch (err) {
    console.error('Error fetching unique usernames:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('A user connected via Socket.IO');
  socket.on('disconnect', () => {
    console.log('A user disconnected from Socket.IO');
  });
});

// Periodically emit bot status updates to connected clients via Socket.IO
setInterval(emitBotStatusUpdate, SOCKET_IO_UPDATE_INTERVAL);

// Serve the dashboard HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Start the web server
server.listen(WEB_SERVER_PORT, () => {
  sendDiscordEmbed('Web Server', `Web monitoring server started on port ${WEB_SERVER_PORT}`, DEFAULT_EMBED_COLOR);
});

// Start the Minecraft bot
startBot();
