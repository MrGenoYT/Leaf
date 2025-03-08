const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 37269,
  username: 'lookAt_Bot'
});

bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
  const mcData = require('minecraft-data')(bot.version);
  const defaultMovements = new Movements(bot, mcData);
  bot.pathfinder.setMovements(defaultMovements);
  
  moveRandomly();
});

function moveRandomly() {
  setInterval(() => {
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

// Express for web hosting on Render
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(3000, () => console.log('Server is running on port 3000'));

bot.on('physicTick', lookAtNearestPlayer);
function lookAtNearestPlayer() {
  const playerFilter = (entity) => entity.type === 'player';
  const playerEntity = bot.nearestEntity(playerFilter);
  if (!playerEntity) return;
  const pos = playerEntity.position.offset(0, playerEntity.height, 0);
  bot.lookAt(pos);
}
