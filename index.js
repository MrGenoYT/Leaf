
// LookAtBOT - Improved version with stability fixes
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
  version: '1.20.1', // Adding explicit version
  chatLengthLimit: 256, // Set chat length limit
  checkTimeoutInterval: 60000, // Check connection every minute
  respawn: true, // Auto respawn
  connectTimeout: 60000, // Longer timeout (60 seconds)
  hideErrors: false // Show all errors for debugging
};

// Use environment variables for webhooks instead of hardcoded URLs
const discordWebhook = process.env.DISCORD_WEBHOOK; // For bot logs only
const chatWebhook = process.env.CHAT_WEBHOOK;       // For chat, player status, and bot stats

let bot = null;
let reconnectTimeout = null;
let moveInterval = null;
let botStartTime = null;   // Track when the bot started
let lastMovementTime = Date.now(); // Track last successful movement
let movementCount = 0;     // Track number of movements performed
let connectionAttempts = 0; // Track connection attempts
let lastReconnectAttempt = 0; // Timestamp of last reconnect attempt
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_COOLDOWN = 60000; // 1 minute between reconnect attempts

// Spectator mode specific settings
let spectatorCenter = null;  // Will be set to bot spawn position
const SPECTATOR_RANGE = 32;  // 64x64 area = 32 blocks in each direction from center
let spectatorWaypoints = [];
let currentWaypointIndex = 0;
let lastPositionChange = Date.now();
const POSITION_CHANGE_INTERVAL = 45000; // 45 seconds between position changes

// Connection state tracking
let isConnecting = false;
let isConnected = false;
let lastHeartbeat = Date.now();
const HEARTBEAT_INTERVAL = 15000; // 15 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds - consider disconnected if no heartbeat

// --- Discord & Chat Webhook Functions ---
async function sendDiscordEmbed(title, description, color = 0x3498db, fields = []) {
  if (!discordWebhook) return; // Skip if webhook not configured
  
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
  if (!chatWebhook) return; // Skip if webhook not configured
  
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
  if (!chatWebhook) return; // Skip if webhook not configured
  
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

// --- Helper Functions ---
function safeBotAction(action) {
  try {
    if (bot && isConnected) action();
  } catch (err) {
    console.error(`⚠️ Error in function ${action.name || 'anonymous'}:`, err.message);
  }
}

function attemptReconnect() {
  // Prevent reconnect spam
  const now = Date.now();
  if (isConnecting || now - lastReconnectAttempt < RECONNECT_COOLDOWN) return;

  // Reset connection attempts after a longer period of stability
  if (now - lastReconnectAttempt > RECONNECT_COOLDOWN * 5) {
    connectionAttempts = 0;
  }

  // Implement exponential backoff for reconnect attempts
  connectionAttempts++;
  const delay = Math.min(10000 * Math.pow(1.5, connectionAttempts - 1), 5 * 60000); // Max 5 minutes
  
  console.log(`🔄 Reconnecting in ${Math.round(delay/1000)} seconds... (Attempt ${connectionAttempts})`);
  sendDiscordEmbed('🔄 Reconnection', `Attempting to reconnect in ${Math.round(delay/1000)} seconds (Attempt ${connectionAttempts})`, 0xff9900);
  
  lastReconnectAttempt = now;
  
  // Clear existing reconnect timers
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  if (moveInterval) {
    clearInterval(moveInterval);
    moveInterval = null;
  }
  
  reconnectTimeout = setTimeout(() => {
    isConnecting = true;
    if (connectionAttempts > MAX_RECONNECT_ATTEMPTS) {
      // If we've tried too many times, wait longer
      console.log(`⚠️ Too many reconnection attempts. Waiting 5 minutes before retrying.`);
      sendDiscordEmbed('⚠️ Reconnection Cooling', `Too many reconnection attempts. Waiting 5 minutes before retrying.`, 0xff0000);
      setTimeout(() => {
        connectionAttempts = 0;
        startBot();
      }, 5 * 60000);
    } else {
      startBot();
    }
    isConnecting = false;
    reconnectTimeout = null;
  }, delay);
}

// --- Spectator Mode Functions ---
function generateSpectatorWaypoints() {
  if (!spectatorCenter) return;
  
  spectatorWaypoints = [];
  
  // Generate waypoints in a more stable pattern
  for (let layer = 0; layer < 4; layer++) {
    const layerDistance = (layer + 1) * 6;  // More distance between points
    
    // Generate points on each layer
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI * 2 / 6) * i;
      const x = spectatorCenter.x + Math.cos(angle) * layerDistance;
      const z = spectatorCenter.z + Math.sin(angle) * layerDistance;
      
      // Less Y variation to reduce chunk loading issues
      const y = spectatorCenter.y + (Math.random() * 10 - 5);
      
      spectatorWaypoints.push({
        position: new Vec3(x, y, z),
        yaw: angle + Math.PI, // Look toward center
        pitch: Math.random() * 0.3 - 0.15 // Less vertical variation
      });
    }
  }
  
  // Don't shuffle - more predictable movement is better for stability
  
  console.log(`Generated ${spectatorWaypoints.length} waypoints for spectator mode`);
  sendDiscordEmbed('🗺️ Waypoints Generated', `Generated ${spectatorWaypoints.length} waypoints for spectator mode navigation`, 0x9b59b6);
}

// Modified to be more gentle with position changes
function moveToNextSpectatorWaypoint() {
  if (!bot || !bot.entity || !isConnected || spectatorWaypoints.length === 0) return;
  
  const waypoint = spectatorWaypoints[currentWaypointIndex];
  currentWaypointIndex = (currentWaypointIndex + 1) % spectatorWaypoints.length;
  
  try {
    // In spectator mode, use teleport instead of direct position setting
    bot.entity.position = waypoint.position;
    bot.look(waypoint.yaw, waypoint.pitch, true);
    
    // Update timestamps
    lastPositionChange = Date.now();
    lastMovementTime = Date.now();
    movementCount++;
  } catch (err) {
    console.error('Error moving in spectator mode:', err.message);
  }
}

// More gentle spectator look around
function spectatorLookAround() {
  if (!bot || !bot.entity || !isConnected) return;
  
  try {
    // More subtle movements
    const yaw = bot.entity.yaw + (Math.random() * 0.5 - 0.25);
    const pitch = bot.entity.pitch + (Math.random() * 0.3 - 0.15);
    
    bot.look(yaw, pitch, true);
    lastMovementTime = Date.now();
    movementCount++;
  } catch (err) {
    console.error('Error during spectator look:', err.message);
  }
}

// --- Anti-AFK Action ---
// Enhanced to be more gentle
function antiAFKAction() {
  if (!bot || !bot.entity || !isConnected) return;
  
  try {
    if (bot.gameMode === 3) { // Spectator mode
      // Check if it's time to move to a new position
      if (Date.now() - lastPositionChange > POSITION_CHANGE_INTERVAL) {
        moveToNextSpectatorWaypoint();
      } else {
        // Just look around between position changes
        spectatorLookAround();
      }
    } else {
      // Regular mode: reduced movement frequency
      const action = Math.random();
      if (action < 0.2) {
        // Look action - most gentle
        const yaw = bot.entity.yaw + (Math.random() * 0.3 - 0.15);
        const pitch = bot.entity.pitch + (Math.random() * 0.2 - 0.1);
        bot.look(yaw, pitch, true);
      } else if (action < 0.5 && Date.now() - lastMovementTime > 10000) {
        // Small movement - only every 10+ seconds
        bot.setControlState('forward', true);
        setTimeout(() => {
          bot.setControlState('forward', false);
        }, 500);
      } else if (action < 0.6 && Date.now() - lastMovementTime > 20000) {
        // Jump - least frequent, only every 20+ seconds
        bot.setControlState('jump', true);
        setTimeout(() => {
          bot.setControlState('jump', false);
        }, 200);
      }
      
      lastMovementTime = Date.now();
      movementCount++;
    }
  } catch (err) {
    console.error('Error in anti-AFK action:', err.message);
  }
}

// --- Periodic Status Reports ---
function sendPlayerList() {
  if (!bot || !bot.players || !isConnected) return;
  
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

function sendBotStats() {
  if (!bot || !bot.entity || !isConnected) return;
  
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
        { name: 'Connection Attempts', value: `${connectionAttempts}`, inline: true }
      ]
    );
  } catch (err) {
    console.error('Error sending bot stats:', err.message);
  }
}

// Heartbeat check to ensure connectivity
function performHeartbeat() {
  if (!bot || !bot._client) return;
  
  try {
    // Only send keep-alive if we're connected
    if (isConnected) {
      lastHeartbeat = Date.now();
      bot._client.write('keep_alive', { keepAliveId: Math.floor(Math.random() * 1000000) });
    }
  } catch (err) {
    console.error('Error during heartbeat:', err.message);
  }
}

// Check if we're still connected
function checkConnection() {
  if (!isConnected) return;
  
  const now = Date.now();
  if (now - lastHeartbeat > HEARTBEAT_TIMEOUT) {
    console.log('⚠️ Connection timeout detected. No heartbeat received in 60 seconds.');
    sendDiscordEmbed('⚠️ Connection Timeout', 'No heartbeat received in 60 seconds. Attempting to reconnect.', 0xff0000);
    isConnected = false;
    attemptReconnect();
  }
}

// --- Player Event Handlers ---
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

// --- Bot Creation and Lifecycle ---
function startBot() {
  if (isConnecting) return; // Prevent multiple simultaneous connection attempts
  isConnecting = true;
  
  if (moveInterval) {
    clearInterval(moveInterval);
    moveInterval = null;
  }
  
  if (bot) {
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (err) {
      console.error('Error cleaning up old bot instance:', err.message);
    }
    bot = null;
  }
  
  console.log("🔄 Starting the bot...");
  
  botStartTime = Date.now();
  isConnected = false;

  try {
    bot = mineflayer.createBot(botOptions);
    
    // Load pathfinder plugin with error handling
    try {
      bot.loadPlugin(pathfinder);
      
      // Configure pathfinder for safer movement
      const movements = new Movements(bot);
      movements.canDig = false; // Don't allow digging
      movements.maxDropDown = 1; // Safer drops
      movements.allowParkour = false; // No parkour
      bot.pathfinder.setMovements(movements);
    } catch (err) {
      console.error('Error loading pathfinder:', err.message);
    }
    
    // Set up all event listeners with proper error handling
    
    bot.once('spawn', () => {
      console.log('✅ Bot joined the server!');
      sendDiscordEmbed('✅ LookAt Start', 'LookAtBOT has successfully joined the server.', 0x00ff00);
      
      isConnected = true;
      lastHeartbeat = Date.now();
      
      // Reset connection attempts on successful connection
      connectionAttempts = 0;
      
      // Set spectator center to spawn position
      spectatorCenter = bot.entity.position.clone();
      generateSpectatorWaypoints();
      
      // Socket keepalive
      if (bot._client && bot._client.socket) {
        bot._client.socket.setKeepAlive(true, 30000);
      }
      
      // Start gentler anti-AFK actions every 5 seconds instead of 3
      moveInterval = setInterval(() => safeBotAction(antiAFKAction), 5000);
      
      // Set up heartbeat mechanism (every 15 seconds)
      setInterval(() => safeBotAction(performHeartbeat), HEARTBEAT_INTERVAL);
      
      // Check connection every minute
      setInterval(() => checkConnection(), 60000);
      
      // Set up periodic player list updates (every 10 minutes)
      setInterval(() => safeBotAction(sendPlayerList), 10 * 60 * 1000);
      
      // Set up periodic bot stats updates (every 30 minutes)
      setInterval(() => safeBotAction(sendBotStats), 30 * 60 * 1000);
      
      // Send initial player list and bot stats after a delay
      setTimeout(() => safeBotAction(sendPlayerList), 10000);
      setTimeout(() => safeBotAction(sendBotStats), 15000);
    });
    
    // Monitor game mode changes
    bot.on('game', (event) => {
      try {
        if (event?.gameMode === 3 && bot.gameMode !== 3) {
          console.log('🔍 Bot entered spectator mode');
          sendDiscordEmbed('🔍 Mode Change', 'LookAtBOT entered spectator mode.', 0x9b59b6);
          
          // Regenerate waypoints when entering spectator mode
          spectatorCenter = bot.entity.position.clone();
          generateSpectatorWaypoints();
          
          // Don't move immediately, wait for the normal interval
          setTimeout(() => moveToNextSpectatorWaypoint(), 5000);
        }
      } catch (err) {
        console.error('Error handling game mode change:', err.message);
      }
    });
    
    bot.on('physicsTick', () => {
      // Update heartbeat timestamp on physics tick to indicate active connection
      lastHeartbeat = Date.now();
    });
    
    bot.on('end', (reason) => {
      console.log(`⚠️ Bot disconnected: ${reason}`);
      sendDiscordEmbed('⚠️ LookAt Disconnect', `LookAtBOT was disconnected. Reason: ${reason}.`, 0xff0000);
      isConnected = false;
      attemptReconnect();
    });
    
    bot.on('kicked', (reason) => {
      console.log(`🚫 Bot was kicked: ${reason}`);
      sendDiscordEmbed('🚫 LookAt Kick', `LookAtBOT was kicked. Reason: ${reason}.`, 0xff0000);
      isConnected = false;
      attemptReconnect();
    });
    
    bot.on('error', (err) => {
      console.error(`⚠️ Bot encountered an error: ${err.message}`);
      if (err.code === 'ECONNRESET' || err.message.includes('timed out')) {
        isConnected = false;
        attemptReconnect();
      }
    });
    
    // Keep track of position changes to detect if bot is stuck but with gentler recovery
    let lastPosition = null;
    let stuckCounter = 0;
    setInterval(() => {
      if (!bot || !bot.entity || !isConnected) return;
      
      if (bot.gameMode === 3) { // Only in spectator mode
        const currentPos = bot.entity.position;
        if (lastPosition && currentPos.distanceTo(lastPosition) < 0.1) {
          stuckCounter++;
          if (stuckCounter > 10) { // Longer time before considering stuck (10 * interval)
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
    }, 5000); // Longer interval
    
    bot.on('chat', (username, message) => safeBotAction(() => sendChatMessage(username, message)));
    bot.on('playerJoined', (player) => safeBotAction(() => playerJoinHandler(player)));
    bot.on('playerLeft', (player) => safeBotAction(() => playerLeaveHandler(player)));
    
  } catch (err) {
    console.error('Failed to create bot:', err.message);
    sendDiscordEmbed('❌ Bot Creation Failed', `Failed to create bot: ${err.message}`, 0xff0000);
    isConnected = false;
    attemptReconnect();
  }
  
  isConnecting = false;
}

// --- Web Monitoring Server ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  try {
    const onlinePlayers = bot?.players ? 
      Object.keys(bot.players).filter(name => name !== botOptions.username).length : 0;
      
    const botStatus = {
      status: isConnected ? "connected" : "disconnected",
      message: isConnected ? "✅ Bot is running!" : "⚠️ Bot is reconnecting...",
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
      memoryUsage: `${Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100} MB`,
      connectionAttempts,
      lastHeartbeat: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null
    };
    res.json(botStatus);
  } catch (err) {
    console.error('⚠️ Error in web server route:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get('/health', (req, res) => {
  res.send('OK');
});

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
  sendDiscordEmbed('🌐 Web Server', `Web monitoring server started on port ${PORT}`, 0x3498db);
});

// Start the bot
startBot();

// Add process error handling for increased stability
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  sendDiscordEmbed('🔥 Uncaught Exception', `Server encountered an error: ${err.message}`, 0xff0000);
  // Don't crash, try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  sendDiscordEmbed('🔥 Unhandled Rejection', `Server encountered a promise rejection: ${reason}`, 0xff0000);
  // Don't crash, try to keep running
});
