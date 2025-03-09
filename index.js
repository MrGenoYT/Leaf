// LookAt Bot
const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');

// Server Details
const botOptions = {
  host: 'bataksurvival.aternos.me',
  port: 12032,
  username: 'lookAt',
  connectTimeout: 120000,
};

const discordWebhook = 'https://discord.com/api/webhooks/1348283775930470492/03Z_3or9YY6uMB-1ANCEpBG229tHbM8_uYORdptwdm_5uraEewp69eHmj1m73GbYUzVD';
const chatWebhook = 'https://discord.com/api/webhooks/1348283959473213462/UA2lue2vWNaGLZesYGYKsKmY5WtqT3I2pnLNlA96YQCmR8-CeN71ShSLWRAWLWYnGkTZ';

let bot;
let reconnectTimeout = null;

// Function to send an embed message to Discord
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

// Function to send chat messages to Discord
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

// Start the bot
function startBot() {
  if (bot) bot.removeAllListeners();
  console.log("🔄 Starting the bot...");

  bot = mineflayer.createBot(botOptions);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('✅ Bot joined the server!');
    sendEmbed('✅ LookAt Start', 'LookAtBOT has started and joined the server.', 0x00ff00);
    
    setTimeout(preventAfk, 5000);
    setTimeout(moveRandomly, 5000);

    // Start the web server after bot spawns
    app.listen(PORT, () => {
      console.log(`🌐 Web server running on port ${PORT}`);
    });

    // Keep-Alive Packet Logger
    setInterval(() => {
      if (bot && bot._client) {
        bot._client.write('keep_alive', { id: BigInt(Date.now()) });
        console.log("📡 Keep-alive packet sent.");
      }
    }, 10000);
  });

  bot.on('end', (reason) => handleDisconnection(`⚠️ Bot disconnected: ${reason}`));
  bot.on('kicked', (reason) => handleDisconnection(`🚫 Bot was kicked: ${reason}`));
  bot.on('error', (err) => handleError(err));

  bot.on('physicTick', () => safeBotAction(() => lookAtNearestPlayer()));
  bot.on('chat', (username, message) => safeBotAction(() => sendChatMessage(username, message)));
  bot.on('playerJoined', (player) => safeBotAction(() => playerJoinHandler(player)));
  bot.on('playerLeft', (player) => safeBotAction(() => playerLeaveHandler(player)));
}

// Safe Execution Wrapper
function safeBotAction(action) {
  try {
    if (bot) action();
  } catch (err) {
    console.error(`⚠️ Error in function ${action.name}:`, err.message);
  }
}

// Reconnection Handler
function reconnectBot() {
  if (reconnectTimeout) return;

  console.log("🔄 Reconnecting in 30 seconds...");
  
  reconnectTimeout = setTimeout(() => {
    startBot();
    reconnectTimeout = null;
  }, 30000);
}

// Handle Disconnections
function handleDisconnection(message) {
  console.log(message);
  sendEmbed('⚠️ LookAtBOT Disconnection', message, 0xff0000);
  reconnectBot();
}

// Enhanced Error Handling
function handleError(err) {
  console.error(`❌ Bot error: ${err.message}`);
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
    console.log("🔄 Attempting to reconnect...");
    reconnectBot();
  }
}

// Player Events
function playerJoinHandler(player) {
  sendEmbed('👤 Player Joined', `**${player.username}** joined the game.`, 0x00ff00, [
    { name: 'Current Players', value: `${Object.keys(bot.players).length}`, inline: true },
  ]);
}

function playerLeaveHandler(player) {
  sendEmbed('🚪 Player Left', `**${player.username}** left the game.`, 0xff4500, [
    { name: 'Current Players', value: `${Object.keys(bot.players).length - 1}`, inline: true },
  ]);
}

// Random Movement
function moveRandomly() {
  setInterval(() => safeBotAction(() => {
    if (!bot.entity) return;

    const x = Math.floor(Math.random() * 10 - 5);
    const z = Math.floor(Math.random() * 10 - 5);
    const goal = new goals.GoalBlock(bot.entity.position.x + x, bot.entity.position.y, bot.entity.position.z + z);

    bot.pathfinder.setGoal(null);
    bot.pathfinder.setGoal(goal);

    if (Math.random() > 0.7) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  }), 5000);
}

// Prevent AFK Kicks
function preventAfk() {
  setInterval(() => safeBotAction(() => {
    bot.swingArm();
    bot.setControlState('sneak', true);
    setTimeout(() => bot.setControlState('sneak', false), Math.random() * 1000 + 500);
  }), 60000 + Math.random() * 10000);
}

// Look at Nearest Player (Only if Present)
function lookAtNearestPlayer() {
  if (!bot.entity) return;
  
  const playerEntity = bot.nearestEntity(entity => entity.type === 'player');
  if (!playerEntity) return;

  const pos = playerEntity.position.offset(0, playerEntity.height, 0);
  bot.lookAt(pos);
  console.log(`👀 Looking at player: ${playerEntity.username}`);
}

// Web Monitoring Server
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  try {
    res.json({ message: "✅ Bot is running!", onlinePlayers: Object.keys(bot.players).length });
  } catch (err) {
    console.error('⚠️ Web server error:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Start the bot
startBot();
