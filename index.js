// LookAtBOT
const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');

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
      if (err.message.includes("Unexpected buffer end")) {
        console.warn("⚠️ Incomplete packet detected. Retrying...");
        packetQueue.unshift({ packetName, data });  // Requeue the packet
      } else {
        console.error("Error sending packet:", err.message);
      }
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

// --- Anti-AFK Action ---
// This function now randomly chooses between moving, looking, or jumping.
// In spectator mode (game mode 3), it only rotates the view.
function antiAFKAction() {
  if (!bot.entity) return;
  if (bot.gameMode === 3) {
    // Spectator mode: simulate looking around
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() * Math.PI / 4) - (Math.PI / 8);
    executeOrQueue(() => bot.look(yaw, pitch, true));
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
    console.log('✅ Bot joined the server!');
    sendEmbed('✅ LookAt Start', 'LookAtBOT has started and joined the server.', 0x00ff00);

    patchPacketSending();
    flushPendingActions();
    processPacketQueue();

    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        console.log("Socket closed", hadError ? "with error" : "normally");
      });
    }

    // Start periodic anti-AFK actions every 5 seconds.
    moveInterval = setInterval(() => safeBotAction(antiAFKAction), 5000);
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ Bot disconnected: ${reason}. Attempting to reconnect...`);
    sendEmbed('⚠️ LookAt Disconnect', `LookAtBOT was disconnected. Reason: ${reason}.`, 0xff0000);
    packetQueue = [];
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log(`🚫 Bot was kicked: ${reason}. Reconnecting...`);
    sendEmbed('🚫 LookAt Stop', `LookAtBOT was kicked. Reason: ${reason}.`, 0xff0000);
    packetQueue = [];
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
  const onlinePlayers = bot?.players ? Object.keys(bot.players).length : 0;
  sendEmbed('👤 Player Joined', `**${player.username}** joined the game.`, 0x00ff00, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

function playerLeaveHandler(player) {
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
