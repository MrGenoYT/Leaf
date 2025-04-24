// LookAtBOT
const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const express = require('express');
const os = require('os');

// Server Details
const botOptions = {
  host: 'LostCloud.aternos.me',
  port: 12032,
  username: 'lookAt',
  connectTimeout: null,
};

// Use environment variables for webhooks instead of hardcoded URLs
const discordWebhook = process.env.DISCORD_WEBHOOK; // For bot logs only
const chatWebhook = process.env.CHAT_WEBHOOK;       // For chat, player status, and bot stats

let bot = null;
let reconnectTimeout = null;
let moveInterval = null;
let pendingActions = [];   // Actions to execute when bot is ready
let botStartTime = null;   // Track when the bot started
let lastMovementTime = Date.now(); // Track last successful movement
let movementCount = 0;     // Track number of movements performed

// Spectator mode specific settings
let spectatorCenter = null;  // Will be set to bot spawn position
const SPECTATOR_RANGE = 32;  // 64x64 area = 32 blocks in each direction from center
let spectatorWaypoints = [];
let currentWaypointIndex = 0;
let lastPositionChange = Date.now();
const POSITION_CHANGE_INTERVAL = 45000; // 45 seconds between position changes

// --- Execute or Queue Actions ---
function executeOrQueue(action) {
  if (bot && bot._client && bot._client.socket && bot._client.socket.writable) {
    try {
      action();
    } catch (err) {
      console.error("Error executing action:", err.message);
    }
  } else {
    pendingActions.push(action);
  }
}

function flushPendingActions() {
  while (pendingActions.length > 0) {
    const action = pendingActions.shift();
    try {
      action();
    } catch (err) {
      console.error("Error executing queued action:", err.message);
    }
  }
}

// --- Discord & Chat Webhook Functions ---
async function sendDiscordEmbed(title, description, color = 0x3498db, fields = []) {
  try {
    await axios.post(discordWebhook, {
      embeds: [{
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (err) {
    console.error('❌ Discord Webhook Error:', err.message);
  }
}

async function sendChatEmbed(title, description, color = 0x00ff00, fields = []) {
  try {
    await axios.post(chatWebhook, {
      embeds: [{
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (err) {
    console.error('❌ Chat Webhook Error:', err.message);
  }
}

async function sendChatMessage(username, message) {
  // Don't process bot's own messages
  if (username === botOptions.username) return;
  
  try {
    await axios.post(chatWebhook, {
      embeds: [{
        author: { name: username },
        description: message,
        color: 0x00ff00,
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (err) {
    console.error('❌ Chat Webhook Error:', err.message);
  }
}

// --- Periodic Status Reports ---

// Send list of all players every 10 minutes
function sendPlayerList() {
  if (!bot || !bot.players) return;
  
  try {
    // Filter out the bot itself from player list
    const playerList = Object.keys(bot.players)
      .filter(name => name !== botOptions.username)
      .map(name => {
        const player = bot.players[name];
        return {
          name: name,
          ping: player.ping || 'N/A',
          entity: player.entity ? 'Yes' : 'No' // Whether entity is loaded (player is nearby)
        };
      });
    
    if (playerList.length === 0) {
      sendChatEmbed('👥 Player List', 'No players online', 0x3498db);
      return;
    }
    
    const fields = playerList.map(player => ({
      name: player.name,
      value: `Ping: ${player.ping}ms | In Range: ${player.entity}`,
      inline: true
    }));
    
    sendChatEmbed(
      '👥 Player List', 
      `${playerList.length} player(s) online`, 
      0x3498db, 
      fields
    );
  } catch (err) {
    console.error('Error sending player list:', err.message);
  }
}

// Send detailed bot statistics every 30 minutes
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
    
    const isMoving = Date.now() - lastMovementTime < 5000;
    const ping = bot.player ? bot.player.ping : 'Unknown';
    
    sendChatEmbed(
      '🤖 Bot Status Report', 
      `Status report for LookAtBOT`, 
      0x9b59b6, 
      [
        { name: 'Uptime', value: uptimeStr, inline: true },
        { name: 'Position', value: posStr, inline: true },
        { name: 'Game Mode', value: bot.gameMode === 3 ? 'Spectator' : `Mode ${bot.gameMode || 'Unknown'}`, inline: true },
        { name: 'Memory Usage', value: memoryStr, inline: true },
        { name: 'Ping', value: `${ping}ms`, inline: true },
        { name: 'Movement Status', value: isMoving ? '✅ Moving' : '❌ Static', inline: true },
        { name: 'Movement Count', value: `${movementCount} moves`, inline: true },
        { name: 'Server Load', value: `${os.loadavg()[0].toFixed(2)}`, inline: true },
        { name: 'Waypoints', value: `${spectatorWaypoints.length}`, inline: true }
      ]
    );
  } catch (err) {
    console.error('Error sending bot stats:', err.message);
  }
}

// --- Spectator Mode Functions ---

// Generate waypoints in a 64x64 area around the center
function generateSpectatorWaypoints() {
  if (!spectatorCenter) return;
  
  spectatorWaypoints = [];
  
  // Generate waypoints in a spiral pattern
  for (let layer = 0; layer < 8; layer++) {
    const layerDistance = (layer + 1) * 4;  // Increasing distance for each layer
    
    // Generate points on each layer
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 / 8) * i;
      const x = spectatorCenter.x + Math.cos(angle) * layerDistance;
      const z = spectatorCenter.z + Math.sin(angle) * layerDistance;
      
      // Add variation to Y coordinate
      const y = spectatorCenter.y + (Math.random() * 20 - 10);
      
      spectatorWaypoints.push({
        position: new Vec3(x, y, z),
        yaw: angle + Math.PI, // Look toward center
        pitch: Math.random() * 0.5 - 0.25 // Slight random up/down look
      });
    }
  }
  
  // Shuffle waypoints for more random movement pattern
  spectatorWaypoints.sort(() => Math.random() - 0.5);
  
  console.log(`Generated ${spectatorWaypoints.length} waypoints for spectator mode`);
  sendDiscordEmbed('🗺️ Waypoints Generated', `Generated ${spectatorWaypoints.length} waypoints for spectator mode navigation`, 0x9b59b6);
}

// Move to the next waypoint in spectator mode
function moveToNextSpectatorWaypoint() {
  if (!bot || !bot.entity || spectatorWaypoints.length === 0) return;
  
  const waypoint = spectatorWaypoints[currentWaypointIndex];
  currentWaypointIndex = (currentWaypointIndex + 1) % spectatorWaypoints.length;
  
  // Use mineflayer's built-in methods instead of direct packet handling
  executeOrQueue(() => {
    bot.entity.position = waypoint.position;
    bot.look(waypoint.yaw, waypoint.pitch, true);
  });
  
  lastPositionChange = Date.now();
  lastMovementTime = Date.now();
  movementCount++;
}

// Random look around function specifically for spectator mode
function spectatorLookAround() {
  if (!bot || !bot.entity) return;
  
  const yaw = Math.random() * Math.PI * 2;
  const pitch = (Math.random() * Math.PI / 2) - (Math.PI / 4); // Look up/down more extensively
  
  executeOrQueue(() => {
    bot.look(yaw, pitch, true);
  });
  
  lastMovementTime = Date.now();
  movementCount++;
}

// --- Anti-AFK Action ---
// Enhanced to better handle spectator mode
function antiAFKAction() {
  if (!bot || !bot.entity) return;
  
  if (bot.gameMode === 3) { // Spectator mode
    // Check if it's time to move to a new position
    if (Date.now() - lastPositionChange > POSITION_CHANGE_INTERVAL) {
      moveToNextSpectatorWaypoint();
    } else {
      // Just look around between position changes
      spectatorLookAround();
    }
  } else {
    // Regular mode: pick a random action.
    const action = Math.random();
    if (action < 0.33) {
      // Random walk
      const x = Math.floor(Math.random() * 20 - 10);
      const z = Math.floor(Math.random() * 20 - 10);
      const goal = new goals.GoalBlock(bot.entity.position.x + x, bot.entity.position.y, bot.entity.position.z + z);
      executeOrQueue(() => bot.pathfinder.setGoal(goal));
    } else if (action < 0.66) {
      // Random look direction
      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() * Math.PI / 4) - (Math.PI / 8);
      executeOrQueue(() => bot.look(yaw, pitch, true));
    } else {
      // Jump action
      executeOrQueue(() => {
        bot.setControlState('jump', true);
        setTimeout(() => {
          bot.setControlState('jump', false);
        }, 300);
      });
    }
    
    lastMovementTime = Date.now();
    movementCount++;
  }
}

// Helper wrapper to safely execute bot actions
function safeBotAction(action) {
  try {
    if (bot) action();
  } catch (err) {
    console.error(`⚠️ Error in function ${action.name}:`, err.message);
  }
}

// --- Error Handling Steps ---
function basicErrorHandler(err) {
  console.error(`Basic error handling: ${err.message}`);
  sendDiscordEmbed('⚠️ Error Detected', `Bot encountered an error: ${err.message}`, 0xff9900);
}

function advancedErrorHandler(err) {
  console.error(`Advanced error handling: ${err.stack}`);
  if (err.message && (err.message.includes("timed out after 30000 milliseconds") || err.code === 'ECONNRESET')) {
    console.log("Network error detected, attempting to reconnect...");
    sendDiscordEmbed('🔄 Network Error', `Network error detected: ${err.message}. Attempting to reconnect...`, 0xff0000);
    reconnectBot();
  }
}

// --- Bot Creation and Lifecycle ---
function startBot() {
  if (moveInterval) clearInterval(moveInterval);
  if (bot) bot.removeAllListeners();
  console.log("🔄 Starting the bot...");
  
  botStartTime = Date.now();
  movementCount = 0;

  bot = mineflayer.createBot(botOptions);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('✅ Bot joined the server!');
    sendDiscordEmbed('✅ LookAt Start', 'LookAtBOT has started and joined the server.', 0x00ff00);

    // Set spectator center to spawn position
    spectatorCenter = bot.entity.position.clone();
    generateSpectatorWaypoints();
    
    flushPendingActions();

    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        console.log("Socket closed", hadError ? "with error" : "normally");
      });
    }

    // Start more frequent anti-AFK actions every 3 seconds
    moveInterval = setInterval(() => safeBotAction(antiAFKAction), 3000);
    
    // Set up periodic player list updates (every 10 minutes)
    setInterval(() => safeBotAction(sendPlayerList), 10 * 60 * 1000);
    
    // Set up periodic bot stats updates (every 30 minutes)
    setInterval(() => safeBotAction(sendBotStats), 30 * 60 * 1000);
    
    // Send initial player list and bot stats
    setTimeout(() => safeBotAction(sendPlayerList), 5000);
    setTimeout(() => safeBotAction(sendBotStats), 10000);
  });

  // Monitor game mode changes
  bot.on('game', (event) => {
    if (event?.gameMode === 3 && bot.gameMode !== 3) {
      console.log('🔍 Bot entered spectator mode');
      sendDiscordEmbed('🔍 Mode Change', 'LookAtBOT entered spectator mode.', 0x9b59b6);
      
      // Regenerate waypoints when entering spectator mode
      spectatorCenter = bot.entity.position.clone();
      generateSpectatorWaypoints();
      moveToNextSpectatorWaypoint(); // Move immediately to first waypoint
    }
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ Bot disconnected: ${reason}. Attempting to reconnect...`);
    sendDiscordEmbed('⚠️ LookAt Disconnect', `LookAtBOT was disconnected. Reason: ${reason}.`, 0xff0000);
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log(`🚫 Bot was kicked: ${reason}. Reconnecting...`);
    sendDiscordEmbed('🚫 LookAt Stop', `LookAtBOT was kicked. Reason: ${reason}.`, 0xff0000);
    reconnectBot();
  });

  bot.on('error', (err) => {
    console.error(`⚠️ Bot encountered an error: ${err.message}`);
    if (err.name === 'PartialReadError' || err.message.includes("Unexpected buffer end")) {
      console.log("🔄 Detected PartialReadError. Restarting bot...");
      reconnectBot();
    }
    basicErrorHandler(err);
    advancedErrorHandler(err);
  });

  // Keep track of position changes to detect if bot is stuck
  let lastPosition = null;
  let stuckCounter = 0;
  setInterval(() => {
    if (!bot || !bot.entity) return;
    
    if (bot.gameMode === 3) { // Only in spectator mode
      const currentPos = bot.entity.position;
      if (lastPosition && currentPos.distanceTo(lastPosition) < 0.1) {
        stuckCounter++;
        if (stuckCounter > 5) { // If stuck for more than 15 seconds (5 * 3s interval)
          console.log("🚨 Bot appears stuck in spectator mode. Forcing position change.");
          sendDiscordEmbed('🚨 Bot Stuck', `Bot appears stuck in spectator mode. Forcing position change.`, 0xff9900);
          moveToNextSpectatorWaypoint();
          stuckCounter = 0;
        }
      } else {
        stuckCounter = 0;
      }
      lastPosition = currentPos.clone();
    }
  }, 3000);

  bot.on('chat', (username, message) => safeBotAction(() => sendChatMessage(username, message)));
  
  bot.on('playerJoined', (player) => safeBotAction(() => playerJoinHandler(player)));
  
  bot.on('playerLeft', (player) => safeBotAction(() => playerLeaveHandler(player)));
}

function reconnectBot() {
  if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
  // Clear any existing reconnect timer to avoid duplicate timers
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  console.log("🔄 Reconnecting in 10 seconds...");
  reconnectTimeout = setTimeout(() => {
    startBot();
    reconnectTimeout = null;
  }, 10000);
}

function playerJoinHandler(player) {
  // Ignore the bot itself
  if (player.username === botOptions.username) return;
  
  const onlinePlayers = bot?.players ? 
    Object.keys(bot.players).filter(name => name !== botOptions.username).length : 0;
    
  sendChatEmbed('👤 Player Joined', `**${player.username}** joined the game.`, 0x00ff00, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

function playerLeaveHandler(player) {
  // Ignore the bot itself
  if (player.username === botOptions.username) return;
  
  const onlinePlayers = bot?.players ? 
    Object.keys(bot.players).filter(name => name !== botOptions.username).length - 1 : 0;
    
  sendChatEmbed('🚪 Player Left', `**${player.username}** left the game.`, 0xff4500, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

// --- Web Monitoring Server ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  try {
    const onlinePlayers = bot?.players ? 
      Object.keys(bot.players).filter(name => name !== botOptions.username).length : 0;
      
    const botStatus = {
      message: "✅ Bot is running!",
      onlinePlayers,
      gameMode: bot?.gameMode === 3 ? "Spectator" : (bot?.gameMode || "Unknown"),
      position: bot?.entity?.position ? {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z)
      } : null,
      uptime: botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
      waypoints: spectatorWaypoints.length,
      movements: movementCount,
      memoryUsage: `${Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100} MB`
    };
    res.json(botStatus);
  } catch (err) {
    console.error('⚠️ Error in web server route:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
  sendDiscordEmbed('🌐 Web Server', `Web monitoring server started on port ${PORT}`, 0x3498db);
});

startBot();
