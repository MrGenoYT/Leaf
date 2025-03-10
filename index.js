// LookATBOT
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
let lookInterval = null;
let moveInterval = null;
let afkInterval = null;
let pendingActions = [];   // Actions to execute when bot is ready
let packetQueue = [];      // Low-level packet actions to retry

// --- Packet Queueing Functions ---
// Call this to queue a packet action
function queuePacket(packetName, data) {
  packetQueue.push({ packetName, data });
  processPacketQueue();
}

// Attempt to flush queued packets if connection is active
function processPacketQueue() {
  if (!bot || !bot._client || !bot._client.socket || !bot._client.socket.writable) return;
  while (packetQueue.length > 0) {
    const { packetName, data } = packetQueue.shift();
    try {
      bot._client.write(packetName, data);
    } catch (err) {
      console.error("Error sending queued packet", packetName, ":", err.message);
      // Put it back at the front and break the loop to retry later
      packetQueue.unshift({ packetName, data });
      break;
    }
  }
}

// --- Execute or Queue Actions ---
// If the bot connection is ready, execute immediately; otherwise, queue the action.
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

// Flush queued actions when the bot is connected
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
// Wrap the underlying packet sending to catch errors and queue packets for later.
function patchPacketSending() {
  if (!bot || !bot._client) return;
  const originalWrite = bot._client.write.bind(bot._client);
  bot._client.write = function(packetName, data) {
    try {
      originalWrite(packetName, data);
    } catch (err) {
      console.error("Packet sending error for", packetName, ":", err.message);
      queuePacket(packetName, data); // Requeue the packet if sending fails
    }
  };
  // Optional: Catch errors on incoming packets
  bot._client.on('data', (data) => {
    try {
      // Let mineflayer handle the packet normally.
    } catch (err) {
      console.error("Packet receiving error:", err.message);
    }
  });
}

// --- Discord Functions ---
// These functions use axios to send webhooks and are not packet queued.
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

// New function: rotateHead - rotates the bot's head 360° smoothly over 1 second.
// This replaces the previous behavior of looking at the nearest player.
function rotateHead() {
  if (!bot || !bot.entity) return;
  const duration = 1000; // duration of rotation in ms
  const steps = 20;
  const intervalTime = duration / steps;
  let step = 0;
  const initialYaw = bot.entity.yaw;
  const targetYaw = initialYaw + 2 * Math.PI; // full rotation
  const rotateInterval = setInterval(() => {
    if (step >= steps) {
      clearInterval(rotateInterval);
    } else {
      const newYaw = initialYaw + ((targetYaw - initialYaw) * (step / steps));
      bot.look(newYaw, bot.entity.pitch, false);
      step++;
    }
  }, intervalTime);
}

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

function preventAfk() {
  try {
    executeOrQueue(() => {
      bot.swingArm();
    });
    executeOrQueue(() => {
      bot.setControlState('sneak', true);
      setTimeout(() => {
        bot.setControlState('sneak', false);
      }, Math.random() * 1000 + 500);
    });
  } catch (err) {
    console.error("Error in preventAfk:", err.message);
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
// Basic error handling
function basicErrorHandler(err) {
  console.error(`Basic error handling: ${err.message}`);
}

// Advanced error handling
function advancedErrorHandler(err) {
  console.error(`Advanced error handling: ${err.stack}`);
  if (err.message && (err.message.includes("timed out after 30000 milliseconds") || err.code === 'ECONNRESET')) {
    console.log("Network error detected, attempting to reconnect...");
    reconnectBot();
  }
}

// --- Bot Creation and Lifecycle ---
function startBot() {
  // Clear previous intervals
  if (lookInterval) clearInterval(lookInterval);
  if (moveInterval) clearInterval(moveInterval);
  if (afkInterval) clearInterval(afkInterval);

  if (bot) bot.removeAllListeners();
  console.log("🔄 Starting the bot...");

  bot = mineflayer.createBot(botOptions);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('✅ Bot joined the server!');
    sendEmbed('✅ LookAt Start', 'LookAtBOT has started and joined the server.', 0x00ff00);

    // Patch packet sending to wrap all low-level writes with our queuing
    patchPacketSending();
    // Flush any actions or packets queued during downtime
    flushPendingActions();
    processPacketQueue();

    // Set keep-alive on the socket to maintain connection
    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        console.log("Socket closed", hadError ? "with error" : "normally");
      });
    }

    // Start periodic actions:
    // Rotate head every 5 minutes (300000 ms)
    lookInterval = setInterval(() => safeBotAction(rotateHead), 300000);
    moveInterval = setInterval(() => safeBotAction(moveRandomly), 5000);
    afkInterval = setInterval(() => safeBotAction(preventAfk), 60000 + Math.random() * 10000);
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ Bot disconnected: ${reason}. Attempting to reconnect...`);
    sendEmbed('⚠️ LookAt Disconnect', `LookAtBOT was disconnected. Reason: ${reason}.`, 0xff0000);
    // Clear packetQueue on disconnect to prevent memory leaks
    packetQueue = [];
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log(`🚫 Bot was kicked: ${reason}. Reconnecting...`);
    sendEmbed('🚫 LookAt Stop', `LookAtBOT was kicked. Reason: ${reason}.`, 0xff0000);
    // Clear packetQueue on disconnect to prevent memory leaks
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
  // Clear intervals
  if (lookInterval) { clearInterval(lookInterval); lookInterval = null; }
  if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
  if (afkInterval) { clearInterval(afkInterval); afkInterval = null; }

  if (reconnectTimeout) return;

  console.log("🔄 Reconnecting in 30 seconds...");
  reconnectTimeout = setTimeout(() => {
    startBot();
    reconnectTimeout = null;
  }, 30000);
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

// --- Start the Bot ---
startBot();
