// LookATBOT
const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');
const os = require('os'); // added for system metrics

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

// New globals for the periodic status and player list
let playerJoinTimes = {};  // Record when each player joined
let botStartTime = null;   // When the bot spawned (for uptime)
let playerListInterval = null; // Interval for sending player list every 15 minutes
let statusInterval = null;     // Interval for sending status every 30 minutes

// --- Utility function to format duration (ms to "Hh Mm Ss") ---
function formatDuration(ms) {
  let totalSeconds = Math.floor(ms / 1000);
  let hours = Math.floor(totalSeconds / 3600);
  let minutes = Math.floor((totalSeconds % 3600) / 60);
  let seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

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
  if (err.message && (err.message.includes("timed out after 30000 milliseconds") || err.code === 'ECONNRESET')) {
    console.log("Network error detected, attempting to reconnect...");
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
    // Record join times for players already online
    for (const username in bot.players) {
      if (!playerJoinTimes[username]) {
        playerJoinTimes[username] = Date.now();
      }
    }
    console.log('✅ Bot joined the server!');
    // Notify Discord with "ok discord" when bot joins
    sendEmbed('Bot has joined the server.', 0x00ff00);

    patchPacketSending();
    flushPendingActions();
    processPacketQueue();

    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        console.log("Socket closed", hadError ? "with error" : "normally");
      });
    }

    // Start periodic actions: only walking and jumping are allowed.
    moveInterval = setInterval(() => safeBotAction(moveRandomly), 5000);

    // Start 15-minute interval to send player list with play durations
    playerListInterval = setInterval(() => {
      const now = Date.now();
      let fields = [];
      for (const username in bot.players) {
        const joinTime = playerJoinTimes[username] || now;
        const durationMs = now - joinTime;
        const durationStr = formatDuration(durationMs);
        fields.push({ name: username, value: durationStr, inline: true });
      }
      if (fields.length === 0) {
        fields.push({ name: 'No players online', value: '-', inline: false });
      }
      sendEmbed('Player Play Durations', 'List of players and their play durations:', 0x3498db, fields);
    }, 15 * 60 * 1000);

    // Start 30-minute interval to send status update
    statusInterval = setInterval(() => {
      const now = Date.now();
      const uptime = formatDuration(now - botStartTime);
      // Server uptime is not tracked so we mark it as 'N/A'
      const serverUptime = 'N/A';
      const botPing = (bot.ping !== undefined ? bot.ping : 'N/A');
      const serverPing = 'N/A';
      const cpuLoad = os.loadavg()[0].toFixed(2);
      const memoryUsage = process.memoryUsage();
      const memoryUsedMB = (memoryUsage.rss / (1024 * 1024)).toFixed(2);
      const heapUsedMB = (memoryUsage.heapUsed / (1024 * 1024)).toFixed(2);
      const heapTotalMB = (memoryUsage.heapTotal / (1024 * 1024)).toFixed(2);

      const fields = [
        { name: 'Bot Uptime', value: uptime, inline: true },
        { name: 'Server Uptime', value: serverUptime, inline: true },
        { name: 'Bot Ping', value: String(botPing), inline: true },
        { name: 'Server Ping', value: serverPing, inline: true },
        { name: 'CPU Load (1m avg)', value: `${cpuLoad}`, inline: true },
        { name: 'Memory (RSS)', value: `${memoryUsedMB} MB`, inline: true },
        { name: 'Heap Used/Total', value: `${heapUsedMB}/${heapTotalMB} MB`, inline: true }
      ];
      sendEmbed('Status Update', 'Periodic status update:', 0x3498db, fields);
    }, 30 * 60 * 1000);
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ Bot disconnected: ${reason}. Attempting to reconnect...`);
    // Notify Discord with "ok discord" when bot disconnects
    sendEmbed('Bot has disconnected.', 0xff0000);
    // Clear our custom intervals so they don’t pile up on reconnect
    if (playerListInterval) { clearInterval(playerListInterval); playerListInterval = null; }
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
    packetQueue = [];
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log(`🚫 Bot was kicked: ${reason}. Reconnecting...`);
    sendEmbed('Bot was kicked.', 0xff0000);
    if (playerListInterval) { clearInterval(playerListInterval); playerListInterval = null; }
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
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
  // Record the join time for calculating play duration later
  playerJoinTimes[player.username] = Date.now();
  const onlinePlayers = bot?.players ? Object.keys(bot.players).length : 0;
  sendEmbed('👤 Player Joined', `**${player.username}** joined the game.`, 0x00ff00, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

function playerLeaveHandler(player) {
  // Optionally, you can remove the player's join time or keep it for historical data.
  delete playerJoinTimes[player.username];
  const onlinePlayers = bot?.players ? Object.keys(bot.players).length - 1 : 0;
  sendEmbed('🚪 Player Left', `**${player.username}** left the game.`, 0xff4500, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

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
