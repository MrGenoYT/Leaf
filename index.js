// LookAtBOT
const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');
const os = require('os');

// Fix for punycode deprecation
try {
  require.resolve('punycode');
} catch (e) {
  console.warn("⚠️ Warning: 'punycode' module is deprecated. No need to import it.");
}

// Server Details
const botOptions = {
  host: 'bataksurvival.aternos.me',
  port: 12032,
  username: 'lookAt',
  connectTimeout: 60000,
};

const discordWebhook = 'https://discord.com/api/webhooks/1348283775930470492/03Z_3or9YY6uMB-1ANCEpBG229tHbM8_uYORdptwdm_5uraEewp69eHmj1m73GbYUzVD';
const chatWebhook = 'https://discord.com/api/webhooks/1348283959473213462/UA2lue2vWNaGLZesYGYKsKmY5WtqT3I2pnLNlA96YQCmR8-CeN71ShSLWRAWLWYnGkTZ';

let bot;
let reconnectTimeout = null;
let botStartTime = Date.now();

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
    moveRandomly();
    preventAfk();
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
  });

  bot.on('physicTick', () => {
    try {
      lookAtNearestPlayer();
    } catch (err) {
      console.error('⚠️ Error in physicTick event:', err.message);
    }
  });

  bot.on('chat', (username, message) => {
    try {
      sendChatMessage(username, message);
    } catch (err) {
      console.error(`⚠️ Error handling chat message from ${username}:`, err.message);
    }
  });

  bot.on('playerJoined', (player) => {
    try {
      playerJoinHandler(player);
    } catch (err) {
      console.error('⚠️ Error handling player join:', err.message);
    }
  });

  bot.on('playerLeft', (player) => {
    try {
      playerLeaveHandler(player);
    } catch (err) {
      console.error('⚠️ Error handling player leave:', err.message);
    }
  });
}

// Reconnect the bot if it disconnects
function reconnectBot() {
  if (reconnectTimeout) return;
  
  console.log("🔄 Reconnecting in 30 seconds...");
  
  reconnectTimeout = setTimeout(() => {
    startBot();
    reconnectTimeout = null;
  }, 30000); // Increased reconnect delay to 30 seconds to prevent frequent rejoining
}

// Handle player joining
function playerJoinHandler(player) {
  const onlinePlayers = bot?.players ? Object.keys(bot.players).length : 0; // Fix for undefined players
  sendEmbed('👤 Player Joined', `**${player.username}** joined the game.`, 0x00ff00, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

// Handle player leaving
function playerLeaveHandler(player) {
  const onlinePlayers = bot?.players ? Object.keys(bot.players).length - 1 : 0; // Fix for undefined players
  sendEmbed('🚪 Player Left', `**${player.username}** left the game.`, 0xff4500, [
    { name: 'Current Players', value: `${onlinePlayers}`, inline: true },
  ]);
}

// Make the bot move randomly
function moveRandomly() {
  setInterval(() => {
    try {
      if (!bot.entity) return;
      
      const x = Math.floor(Math.random() * 10 - 5);
      const z = Math.floor(Math.random() * 10 - 5);
      const goal = new goals.GoalBlock(bot.entity.position.x + x, bot.entity.position.y, bot.entity.position.z + z);

      bot.pathfinder.setGoal(null); // Clears any existing goal to avoid conflicts
      bot.pathfinder.setGoal(goal);

      if (Math.random() > 0.7) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 500);
      }
    } catch (err) {
      console.error('⚠️ Error in moveRandomly function:', err.message);
    }
  }, 5000);
}

// Prevent the bot from being kicked for inactivity
function preventAfk() {
  setInterval(() => {
    try {
      bot.swingArm();
      bot.setControlState('sneak', true);
      setTimeout(() => bot.setControlState('sneak', false), Math.random() * 1000 + 500); // Randomized sneak duration
    } catch (err) {
      console.error('⚠️ Error in preventAfk function:', err.message);
    }
  }, 60000 + Math.random() * 10000); // Randomized interval
}

// Make the bot look at the nearest player
function lookAtNearestPlayer() {
  try {
    const playerFilter = (entity) => entity.type === 'player';
    const playerEntity = bot.nearestEntity(playerFilter);
    if (!playerEntity) return;
    const pos = playerEntity.position.offset(0, playerEntity.height, 0);
    bot.lookAt(pos);
  } catch (err) {
    console.error('⚠️ Error in lookAtNearestPlayer function:', err.message);
  }
}

// Web monitoring server
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  try {
    const onlinePlayers = bot?.players ? Object.keys(bot.players).length : 0; // Fix for undefined players
    res.json({ message: "✅ Bot is running!", onlinePlayers });
  } catch (err) {
    console.error('⚠️ Error in web server route:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

// Start the bot
startBot();
