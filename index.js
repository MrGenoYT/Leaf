const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const express = require('express');
const path = require('path');
const os = require('os');

const BOT_HOST = process.env.BOT_HOST || 'Leafsong.aternos.me';
const BOT_PORT = parseInt(process.env.BOT_PORT, 10) || 36915;
const BOT_USERNAME = process.env.BOT_USERNAME || 'LeafBOT';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const CHAT_WEBHOOK = process.env.CHAT_WEBHOOK;
const MESSAGE_WEBHOOK = process.env.MESSAGE_WEBHOOK;
const WEB_SERVER_PORT = process.env.PORT || 3000;

// Simplified constants
const MOVEMENT_INTERVAL = 5000; // Move every 5 seconds
const LOOK_INTERVAL = 3000; // Look around every 3 seconds
const RECONNECT_DELAY = 10000;
const PLAYER_LIST_INTERVAL = 30 * 60 * 1000;
const BOT_STATS_INTERVAL = 60 * 60 * 1000;

const DEFAULT_EMBED_COLOR = 0x3498db;
const SUCCESS_EMBED_COLOR = 0x00ff00;
const WARNING_EMBED_COLOR = 0xff9900;
const ERROR_EMBED_COLOR = 0xff0000;
const INFO_EMBED_COLOR = 0x9b59b6;

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
let currentGameMode = 'Unknown'; // Track game mode separately

// Clear all intervals
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

async function sendDiscordEmbed(title, description, color = DEFAULT_EMBED_COLOR, fields = []) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await axios.post(DISCORD_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('Discord Webhook Error:', err.message);
  }
}

async function sendChatEmbed(title, description, color = SUCCESS_EMBED_COLOR, fields = []) {
  if (!CHAT_WEBHOOK) return;
  try {
    await axios.post(CHAT_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('Chat Webhook Error:', err.message);
  }
}

async function sendPlayerMessage(username, message) {
  if (username === botOptions.username || !MESSAGE_WEBHOOK) return;
  try {
    await axios.post(MESSAGE_WEBHOOK, {
      embeds: [{ author: { name: username }, description: message, color: SUCCESS_EMBED_COLOR, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('Message Webhook Error:', err.message);
  }
}

function sendPlayerList() {
  if (!bot || !bot.players) return;
  try {
    const playerList = Object.keys(bot.players)
      .filter(name => name !== botOptions.username)
      .map(name => ({ 
        name: name, 
        ping: bot.players[name].ping || 'N/A', 
        entity: bot.players[name].entity ? 'Yes' : 'No' 
      }));

    if (playerList.length === 0) {
      sendChatEmbed('Player List', 'No players online', DEFAULT_EMBED_COLOR);
      return;
    }
    
    const fields = playerList.map(player => ({ 
      name: player.name, 
      value: `Ping: ${player.ping}ms | In Range: ${player.entity}`, 
      inline: true 
    }));
    
    sendChatEmbed('Player List', `${playerList.length} player(s) online`, DEFAULT_EMBED_COLOR, fields);
  } catch (err) {
    console.error('Error sending player list:', err.message);
  }
}

function getGameModeString(gameMode) {
  switch(gameMode) {
    case 0: return 'Survival';
    case 1: return 'Creative';
    case 2: return 'Adventure';
    case 3: return 'Spectator';
    default: return 'Unknown';
  }
}

function sendBotStats() {
  if (!bot || !bot.entity) return;
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

    sendChatEmbed('Bot Status Report', `Status report for ${botOptions.username}`, INFO_EMBED_COLOR, [
      { name: 'Uptime', value: uptimeStr, inline: true },
      { name: 'Position', value: posStr, inline: true },
      { name: 'Game Mode', value: currentGameMode, inline: true },
      { name: 'Memory Usage', value: memoryStr, inline: true },
      { name: 'Ping', value: `${ping}ms`, inline: true },
      { name: 'Movement Count', value: `${movementCount} moves`, inline: true },
      { name: 'Server Load', value: `${os.loadavg()[0].toFixed(2)}`, inline: true }
    ]);
  } catch (err) {
    console.error('Error sending bot stats:', err.message);
  }
}

// Setup or remove pathfinder based on game mode
function setupPathfinder() {
  if (!bot) return;
  
  if (currentGameMode === 'Spectator') {
    // Don't set up pathfinder for spectator mode
    console.log('Spectator mode detected - skipping pathfinder setup');
    return;
  }
  
  // Setup pathfinder for non-spectator modes
  try {
    const defaultMove = new Movements(bot);
    bot.pathfinder.setMovements(defaultMove);
    console.log(`Pathfinder configured for ${currentGameMode} mode`);
  } catch (err) {
    console.error('Error setting up pathfinder:', err.message);
  }
}

// Simple movement function
function performMovement() {
  if (!bot || !bot.entity) return;
  
  try {
    if (currentGameMode === 'Spectator') {
      // Spectator mode - simple flying (no pathfinding)
      spectatorMovement();
    } else {
      // Survival/Creative mode - use pathfinding
      survivalMovement();
    }
    movementCount++;
  } catch (err) {
    console.error('Movement error:', err.message);
  }
}

function spectatorMovement() {
  const currentPos = bot.entity.position;
  const action = Math.random();
  
  if (action < 0.5) {
    // Fly to a nearby position
    const x = currentPos.x + (Math.random() * 20 - 10);
    const y = currentPos.y + (Math.random() * 10 - 5);
    const z = currentPos.z + (Math.random() * 20 - 10);
    
    // Ensure Y is within reasonable bounds
    const safeY = Math.max(5, Math.min(250, y));
    
    bot.entity.position.x = x;
    bot.entity.position.y = safeY;
    bot.entity.position.z = z;
    
    console.log(`Spectator fly to: ${Math.floor(x)}, ${Math.floor(safeY)}, ${Math.floor(z)}`);
  } else {
    // Just change altitude
    const newY = Math.max(5, Math.min(250, currentPos.y + (Math.random() * 20 - 10)));
    bot.entity.position.y = newY;
    console.log(`Spectator altitude change to: ${Math.floor(newY)}`);
  }
}

function survivalMovement() {
  const currentPos = bot.entity.position;
  const action = Math.random();
  
  if (action < 0.4) {
    // Walk to nearby position using pathfinder
    const x = Math.floor(currentPos.x + (Math.random() * 10 - 5));
    const z = Math.floor(currentPos.z + (Math.random() * 10 - 5));
    const goal = new goals.GoalBlock(x, Math.floor(currentPos.y), z);
    
    // Only use pathfinder if it's properly set up
    if (bot.pathfinder && currentGameMode !== 'Spectator') {
      bot.pathfinder.setGoal(goal);
      console.log(`Walking to: ${x}, ${Math.floor(currentPos.y)}, ${z}`);
    }
  } else if (action < 0.7) {
    // Jump
    bot.setControlState('jump', true);
    setTimeout(() => {
      if (bot) bot.setControlState('jump', false);
    }, 500);
    console.log('Jumping');
  } else {
    // Sneak for a moment
    bot.setControlState('sneak', true);
    setTimeout(() => {
      if (bot) bot.setControlState('sneak', false);
    }, 2000);
    console.log('Sneaking');
  }
}

// Simple look around function
function lookAround() {
  if (!bot || !bot.entity) return;
  
  try {
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() * Math.PI / 3) - (Math.PI / 6); // -30 to 30 degrees
    bot.look(yaw, pitch, true);
    console.log('Looking around');
  } catch (err) {
    console.error('Look error:', err.message);
  }
}

// Setup intervals after bot spawns
function setupIntervals() {
  console.log('Setting up intervals...');
  
  // Movement interval
  movementInterval = setInterval(performMovement, MOVEMENT_INTERVAL);
  
  // Look around interval
  lookInterval = setInterval(lookAround, LOOK_INTERVAL);
  
  // Player list interval
  playerListInterval = setInterval(sendPlayerList, PLAYER_LIST_INTERVAL);
  
  // Bot stats interval
  botStatsInterval = setInterval(sendBotStats, BOT_STATS_INTERVAL);
  
  // Send initial stats
  setTimeout(sendPlayerList, 5000);
  setTimeout(sendBotStats, 10000);
}

function startBot() {
  console.log('Starting bot...');
  
  // Clear everything first
  clearAllIntervals();
  
  if (bot) {
    bot.removeAllListeners();
    bot = null;
  }
  
  botStartTime = Date.now();
  movementCount = 0;
  isBotOnline = false;
  currentGameMode = 'Unknown'; // Reset game mode

  bot = mineflayer.createBot(botOptions);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('Bot spawned successfully');
    sendDiscordEmbed('Bot Connected', `${botOptions.username} has joined the server.`, SUCCESS_EMBED_COLOR);
    isBotOnline = true;
    lastOnlineTime = Date.now();

    // Update game mode and setup pathfinder accordingly
    currentGameMode = getGameModeString(bot.gameMode);
    console.log(`Current game mode: ${currentGameMode}`);
    setupPathfinder();

    // Setup socket keep alive
    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        console.log("Socket closed", hadError ? "with error" : "normally");
      });
    }

    // Setup all intervals
    setupIntervals();
  });

  bot.on('game', () => {
    const previousGameMode = currentGameMode;
    currentGameMode = getGameModeString(bot.gameMode);
    console.log(`Game mode changed from ${previousGameMode} to: ${currentGameMode}`);
    
    if (currentGameMode === 'Spectator') {
      sendDiscordEmbed('Mode Change', `${botOptions.username} entered spectator mode.`, INFO_EMBED_COLOR);
    } else {
      sendDiscordEmbed('Mode Change', `${botOptions.username} entered ${currentGameMode} mode.`, INFO_EMBED_COLOR);
    }
    
    // Setup or remove pathfinder based on new game mode
    setupPathfinder();
  });

  bot.on('end', (reason) => {
    console.log('Bot disconnected:', reason);
    sendDiscordEmbed('Bot Disconnect', `${botOptions.username} was disconnected. Reason: ${reason}.`, ERROR_EMBED_COLOR);
    isBotOnline = false;
    currentGameMode = 'Unknown';
    clearAllIntervals();
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log('Bot kicked:', reason);
    sendDiscordEmbed('Bot Kicked', `${botOptions.username} was kicked. Reason: ${reason}.`, ERROR_EMBED_COLOR);
    isBotOnline = false;
    currentGameMode = 'Unknown';
    clearAllIntervals();
    reconnectBot();
  });

  bot.on('error', (err) => {
    console.error('Bot error:', err.message);
    sendDiscordEmbed('Bot Error', `Error: ${err.message}`, ERROR_EMBED_COLOR);
    
    // Handle specific errors that require reconnection
    if (err.message.includes("timed out") || 
        err.message.includes("ECONNRESET") || 
        err.name === 'PartialReadError' || 
        err.message.includes("Unexpected buffer end")) {
      clearAllIntervals();
      reconnectBot();
    }
  });

  // Chat handlers
  bot.on('chat', (username, message) => {
    if (username !== botOptions.username) {
      sendPlayerMessage(username, message);
    }
  });

  bot.on('playerJoined', (player) => {
    if (player.username !== botOptions.username) {
      const onlinePlayers = bot?.players ? Object.keys(bot.players).filter(name => name !== botOptions.username).length : 0;
      sendChatEmbed('Player Joined', `**${player.username}** joined the game.`, SUCCESS_EMBED_COLOR, [
        { name: 'Current Players', value: `${onlinePlayers}`, inline: true }
      ]);
    }
  });

  bot.on('playerLeft', (player) => {
    if (player.username !== botOptions.username) {
      const onlinePlayers = bot?.players ? Object.keys(bot.players).filter(name => name !== botOptions.username).length - 1 : 0;
      sendChatEmbed('Player Left', `**${player.username}** left the game.`, 0xff4500, [
        { name: 'Current Players', value: `${Math.max(0, onlinePlayers)}`, inline: true }
      ]);
    }
  });
}

function reconnectBot() {
  console.log('Attempting to reconnect...');
  clearAllIntervals();
  
  reconnectTimeout = setTimeout(() => {
    console.log('Reconnecting now...');
    startBot();
  }, RECONNECT_DELAY);
}

// Web server
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/status', (req, res) => {
  try {
    const players = bot?.players ? Object.values(bot.players).filter(p => p.username !== botOptions.username) : [];
    const onlinePlayersCount = players.length;
    const playerDetails = players.map(p => ({
      username: p.username,
      uuid: p.uuid,
      skinUrl: `https://crafatar.com/avatars/${p.uuid}?size=24&overlay`
    }));

    const botStatus = {
      message: isBotOnline ? "Bot is running!" : "Bot is offline",
      onlinePlayersCount,
      playerDetails,
      gameMode: currentGameMode,
      position: bot?.entity?.position ? {
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
    };
    res.json(botStatus);
  } catch (err) {
    console.error('API status error:', err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(WEB_SERVER_PORT, () => {
  console.log(`Web server started on port ${WEB_SERVER_PORT}`);
  sendDiscordEmbed('Web Server', `Web monitoring server started on port ${WEB_SERVER_PORT}`, DEFAULT_EMBED_COLOR);
});

// Start the bot
startBot();
