const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');

// 🔹 Bot Configuration
const botOptions = {
  host: 'bataksurvival.aternos.me',
  port: 12032,
  username: 'lookAt',
};

let bot;
let reconnectTimeout = null;

// 🔹 Function to Start the Bot
function startBot() {
  if (bot) bot.removeAllListeners(); // Remove old listeners to prevent duplicates
  console.log("Starting bot...");

  bot = mineflayer.createBot(botOptions);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('✅ Bot joined the server!');
    clearTimeout(reconnectTimeout); // Stop reconnection attempts

    const mcData = require('minecraft-data')(bot.version);
    const defaultMovements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMovements);

    moveRandomly();
    preventAfk();
  });

  // 🔹 Reconnect on Disconnection
  bot.on('end', (reason) => {
    console.log(`⚠️ Bot disconnected: ${reason}. Reconnecting in 10 seconds...`);
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log(`⚠️ Bot was kicked: ${reason}. Reconnecting in 10 seconds...`);
    reconnectBot();
  });

  bot.on('error', (err) => {
    console.log(`❌ Bot error: ${err.message}`);
  });

  bot.on('physicTick', lookAtNearestPlayer);
}

// 🔹 Function to Handle Reconnection
function reconnectBot() {
  if (reconnectTimeout) return; // Prevent multiple reconnection attempts

  reconnectTimeout = setTimeout(() => {
    console.log("🔄 Reconnecting...");
    startBot();
    reconnectTimeout = null;
  }, 10000); // Retry every 10 seconds
}

// 🔹 Function for Random Movement
function moveRandomly() {
  setInterval(() => {
    if (!bot.entity) return;

    const x = Math.floor(Math.random() * 10 - 5);
    const z = Math.floor(Math.random() * 10 - 5);
    const goal = new goals.GoalBlock(bot.entity.position.x + x, bot.entity.position.y, bot.entity.position.z + z);
    bot.pathfinder.setGoal(goal);

    if (Math.random() > 0.7) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  }, 5000);
}

// 🔹 Function to Prevent AFK Kicks
function preventAfk() {
  setInterval(() => {
    bot.swingArm(); // Moves the bot slightly to prevent AFK kicks
    bot.setControlState('sneak', true);
    setTimeout(() => bot.setControlState('sneak', false), 500);
  }, 60000); // Every 1 minute
}

// 🔹 Function to Look at the Nearest Player
function lookAtNearestPlayer() {
  const playerFilter = (entity) => entity.type === 'player';
  const playerEntity = bot.nearestEntity(playerFilter);
  if (!playerEntity) return;
  const pos = playerEntity.position.offset(0, playerEntity.height, 0);
  bot.lookAt(pos);
}

// 🔹 Web Server for Monitoring
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('✅ Bot is running!');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// 🔹 Start the Bot
startBot();
