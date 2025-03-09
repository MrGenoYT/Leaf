const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');

const botOptions = {
  host: 'bataksurvival.aternos.me',
  port: 12032,
  username: 'lookAt',
  connectTimeout: null,
};

const discordWebhook = 'https://discord.com/api/webhooks/1348283775930470492/03Z_3or9YY6uMB-1ANCEpBG229tHbM8_uYORdptwdm_5uraEewp69eHmj1m73GbYUzVD';
const chatWebhook = 'https://discord.com/api/webhooks/1348283959473213462/UA2lue2vWNaGLZesYGYKsKmY5WtqT3I2pnLNlA96YQCmR8-CeN71ShSLWRAWLWYnGkTZ';

let bot = null;
let reconnectTimeout = null;
let lookInterval = null;
let moveInterval = null;
let afkInterval = null;
let packetQueue = [];

// Queue and execute packets safely
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
      console.error("Packet sending error:", err.message);
      packetQueue.unshift({ packetName, data }); // Requeue packet if error occurs
    }
  }
}

// Send an embed message to Discord
async function sendEmbed(title, description, color = 0x3498db, fields = []) {
  queuePacket('discordWebhook', { embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }] });
}

// Send chat messages to Discord
async function sendChatMessage(username, message) {
  queuePacket('chatWebhook', { embeds: [{ author: { name: username }, description: message, color: 0x00ff00, timestamp: new Date().toISOString() }] });
}

// Patch packet sending for error handling
function patchPacketSending() {
  if (!bot || !bot._client) return;
  const originalWrite = bot._client.write.bind(bot._client);
  
  bot._client.write = function (packetName, data) {
    try {
      originalWrite(packetName, data);
    } catch (err) {
      console.error("Packet sending error:", packetName, ":", err.message);
      queuePacket(packetName, data); // Requeue packet
    }
  };

  bot._client.on('data', (data) => {
    try {
      // Let mineflayer handle the packet normally
    } catch (err) {
      console.error("Packet receiving error:", err.message);
    }
  });
}

// Update bot look direction
function updateLookDirection() {
  if (!bot || !bot.entity) return;
  try {
    const playerEntity = bot.nearestEntity(entity => entity.type === 'player');
    if (playerEntity) {
      const pos = playerEntity.position.offset(0, playerEntity.height, 0);
      queuePacket('look', pos);
    }
  } catch (err) {
    console.error("Error updating look direction:", err.message);
  }
}

// Start the bot
function startBot() {
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
    patchPacketSending();

    lookInterval = setInterval(updateLookDirection, 5000);
    moveInterval = setInterval(moveRandomly, 5000);
    afkInterval = setInterval(preventAfk, 60000 + Math.random() * 10000);
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ Bot disconnected: ${reason}. Attempting to reconnect...`);
    sendEmbed('⚠️ LookAt Disconnect', `LookAtBOT was disconnected. Reason: ${reason}.`, 0xff0000);
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log(`🚫 Bot was kicked: ${reason}. Reconnecting...`);
    sendEmbed('🚫 LookAt Stop', `LookAtBOT was kicked. Reason: ${reason}.`, 0xff0000);
    reconnectBot();
  });

  bot.on('error', (err) => {
    console.error(`❌ Bot error: ${err.message}`);
    if (err.code === 'ECONNRESET') {
      reconnectBot();
    }
  });

  bot.on('chat', (username, message) => sendChatMessage(username, message));
  bot.on('playerJoined', (player) => playerJoinHandler(player));
  bot.on('playerLeft', (player) => playerLeaveHandler(player));
}

// Reconnect the bot
function reconnectBot() {
  if (lookInterval) clearInterval(lookInterval);
  if (moveInterval) clearInterval(moveInterval);
  if (afkInterval) clearInterval(afkInterval);

  if (reconnectTimeout) return;

  console.log("🔄 Reconnecting in 30 seconds...");
  reconnectTimeout = setTimeout(() => {
    startBot();
    reconnectTimeout = null;
  }, 30000);
}

// Handle player joining
function playerJoinHandler(player) {
  const onlinePlayers = bot?.players ? Object.keys(bot.players).length : 0;
  sendEmbed('👤 Player Joined', `**${player.username}** joined the game.`, 0x00ff00, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

// Handle player leaving
function playerLeaveHandler(player) {
  const onlinePlayers = bot?.players ? Object.keys(bot.players).length - 1 : 0;
  sendEmbed('🚪 Player Left', `**${player.username}** left the game.`, 0xff4500, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

// Move randomly
function moveRandomly() {
  if (!bot.entity) return;
  try {
    const x = Math.floor(Math.random() * 10 - 5);
    const z = Math.floor(Math.random() * 10 - 5);
    const goal = new goals.GoalBlock(bot.entity.position.x + x, bot.entity.position.y, bot.entity.position.z + z);
    queuePacket('move', { x, y: bot.entity.position.y, z });
    bot.pathfinder.setGoal(goal);

    if (Math.random() > 0.7) {
      queuePacket('jump', {});
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  } catch (err) {
    console.error("Error in moveRandomly:", err.message);
  }
}

// Prevent AFK kicks
function preventAfk() {
  try {
    queuePacket('swing', {});
    bot.swingArm();
    queuePacket('sneak', { state: true });
    bot.setControlState('sneak', true);
    setTimeout(() => {
      queuePacket('sneak', { state: false });
      bot.setControlState('sneak', false);
    }, Math.random() * 1000 + 500);
  } catch (err) {
    console.error("Error in preventAfk:", err.message);
  }
}

// Web server for monitoring
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

// Start bot
startBot();
