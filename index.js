// LookAtBOT
const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');
const os = require('os');

// Server Details
const botOptions = {
  host: 'bataksurvival.aternos.me',
  port: 12032,
  username: 'lookAt',
  connectTimeout: null,
};

// Use environment variables for webhooks instead of hardcoded URLs
const discordWebhook = process.env.DISCORD_WEBHOOK;
const chatWebhook = process.env.CHAT_WEBHOOK;

let bot = null;
let reconnectTimeout = null;
let moveInterval = null;
let pendingActions = [];   // Actions to execute when bot is ready
let packetQueue = [];      // Low-level packet actions to retry
let botStartTime = null;   // Record when bot successfully spawns
let playerJoinTimes = {};  // Track when players join

// --- Packet Queueing Functions ---
function queuePacket(packetName, data) {
  packetQueue.push({ packetName, data });
  processPacketQueue();
}

function processPacketQueue() {
  if (!bot || !bot._client || !bot._client.socket || !bot._client.socket.writable) return;
  while (packetQueue.length > 0) {
    const { packetName, data } = packetQueue.shift();
    try {
      bot._client.write(packetName, data);
    } catch (err) {
      console.error("Error sending queued packet", packetName, ":", err.message);
      packetQueue.unshift({ packetName, data });
      break;
    }
  }
}

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

// --- Patch Bot's Packet Sending ---
function patchPacketSending() {
  if (!bot || !bot._client) return;
  const originalWrite = bot._client.write.bind(bot._client);
  bot._client.write = function(packetName, data) {
    try {
      originalWrite(packetName, data);
    } catch (err) {
      console.error("Packet sending error for", packetName, ":", err.message);
      queuePacket(packetName, data);
    }
  };
  bot._client.on('data', (data) => {
    try {
      // Let mineflayer handle the packet normally.
    } catch (err) {
      console.error("Packet receiving error:", err.message);
    }
  });
}

// --- Discord Functions ---
async function sendEmbed(title, description, color = 0x3498db, fields = []) {
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
    console.error('❌ Webhook Error:', err.message);
  }
}

async function sendChatMessage(username, message) {
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

// --- Bot Actions ---
// This function handles walking and occasionally jumping.
function moveRandomly() {
  if (!bot.entity) return;
  try {
    const x = Math.floor(Math.random() * 10 - 5);
    const z = Math.floor(Math.random() * 10 - 5);
    const goal = new goals.GoalBlock(bot.entity.position.x + x, bot.entity.position.y, bot.entity.position.z + z);
    executeOrQueue(() => {
      bot.pathfinder.setGoal(goal);
    });
    if (Math.random() > 0.7) {
      executeOrQueue(() => {
        bot.setControlState('jump', true);
        setTimeout(() => {
          bot.setControlState('jump', false);
        }, 500);
      });
    }
  } catch (err) {
    console.error("Error in moveRandomly:", err.message);
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
}

function advancedErrorHandler(err) {
  console.error(`Advanced error handling: ${err.stack}`);
  // Check for timeout, connection reset, or "Logged in from another location" errors
  if (err.message && (err.message.includes("timed out after 30000 milliseconds") ||
      err.code === 'ECONNRESET' ||
      err.message.includes("Logged in from another location"))) {
    console.log("Network/login error detected, attempting to reconnect...");
    reconnectBot();
  }
}

// --- Bot Creation and Lifecycle ---
function startBot() {
  if (moveInterval) clearInterval(moveInterval);
  if (bot) bot.removeAllListeners();
  console.log("🔄 Starting the bot...");

  bot = mineflayer.createBot(botOptions);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    botStartTime = Date.now();
    console.log('✅ Bot joined the server!');
    sendEmbed('✅ Bot Live', 'LookAtBOT has started and joined the server.', 0x00ff00);
    patchPacketSending();
    flushPendingActions();
    processPacketQueue();

    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        console.log("Socket closed", hadError ? "with error" : "normally");
      });
    }

    // Start periodic actions: walking and jumping.
    moveInterval = setInterval(() => safeBotAction(moveRandomly), 5000);
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ Bot disconnected: ${reason}. Attempting to reconnect...`);
    sendEmbed('⚠️ Bot Disconnected', `LookAtBOT was disconnected. Reason: ${reason}.`, 0xff0000);
    packetQueue = [];
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log(`🚫 Bot was kicked: ${reason}. Reconnecting...`);
    sendEmbed('🚫 Bot Kicked', `LookAtBOT was kicked. Reason: ${reason}.`, 0xff0000);
    packetQueue = [];
    reconnectBot();
  });

  bot.on('error', (err) => {
    basicErrorHandler(err);
    advancedErrorHandler(err);
  });

  bot.on('chat', (username, message) => safeBotAction(() => sendChatMessage(username, message)));

  bot.on('playerJoined', (player) => safeBotAction(() => playerJoinHandler(player)));
  bot.on('playerLeft', (player) => safeBotAction(() => playerLeaveHandler(player)));
}

function reconnectBot() {
  if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
  if (reconnectTimeout) return;
  console.log("🔄 Reconnecting in 10 seconds...");
  reconnectTimeout = setTimeout(() => {
    startBot();
    reconnectTimeout = null;
  }, 10000);
}

function playerJoinHandler(player) {
  // Record the join time for this player
  playerJoinTimes[player.username] = Date.now();
  const onlinePlayers = bot?.players ? Object.keys(bot.players).length : 0;
  sendEmbed('👤 Player Joined', `**${player.username}** joined the game.`, 0x00ff00, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

function playerLeaveHandler(player) {
  // Remove the player's join time on leaving
  delete playerJoinTimes[player.username];
  const onlinePlayers = bot?.players ? Object.keys(bot.players).length : 0;
  sendEmbed('🚪 Player Left', `**${player.username}** left the game.`, 0xff4500, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

// --- Periodic Discord Notifications ---

// Every 15 minutes, send a list of players with their play duration
function sendPlayerList() {
  let fields = [];
  const now = Date.now();
  for (let username in playerJoinTimes) {
    const durationMs = now - playerJoinTimes[username];
    let seconds = Math.floor(durationMs / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);
    seconds %= 60;
    minutes %= 60;
    const durationStr = `${hours}h ${minutes}m ${seconds}s`;
    fields.push({ name: username, value: durationStr, inline: true });
  }
  if (fields.length === 0) {
    fields.push({ name: 'No players online', value: 'N/A' });
  }
  sendEmbed('👥 Player List', 'Current players and play duration:', 0x3498db, fields);
}
setInterval(sendPlayerList, 15 * 60 * 1000); // every 15 minutes

// Every 30 minutes, send a status update
function sendStatusUpdate() {
  const serverUptime = process.uptime(); // in seconds
  const botUptime = botStartTime ? (Date.now() - botStartTime) / 1000 : 0;
  const playersCount = bot && bot.players ? Object.keys(bot.players).length : 0;
  const memoryUsage = process.memoryUsage();
  const usedMemMB = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
  const totalMemMB = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);
  const loadAvg = os.loadavg()[0].toFixed(2); // 1-minute load average
  const ping = bot ? bot.ping : 'N/A';
  const fields = [
    { name: 'Server Uptime', value: `${Math.floor(serverUptime)}s`, inline: true },
    { name: 'Bot Uptime', value: `${Math.floor(botUptime)}s`, inline: true },
    { name: 'Ping', value: `${ping}ms`, inline: true },
    { name: 'Players', value: `${playersCount}`, inline: true },
    { name: 'Memory Usage', value: `${usedMemMB}MB / ${totalMemMB}MB`, inline: true },
    { name: 'Load Average', value: `${loadAvg}`, inline: true },
  ];
  sendEmbed('🛠 Status Update', 'Current bot and server status:', 0x9b59b6, fields);
}
setInterval(sendStatusUpdate, 30 * 60 * 1000); // every 30 minutes

// --- Web Monitoring Server ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  try {
    const onlinePlayers = bot?.players ? Object.keys(bot.players).length : 0;
    res.json({ message: "✅ Bot is running!", onlinePlayers });
  } catch (err) {
    console.error('⚠️ Error in web server route:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

startBot();
