const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const express = require('express');
const os = require('os');

const BOT_HOST = process.env.BOT_HOST || 'Leafsong.aternos.me';
const BOT_PORT = parseInt(process.env.BOT_PORT, 10) || 36915;
const BOT_USERNAME = process.env.BOT_USERNAME || 'LeafBOT';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const CHAT_WEBHOOK = process.env.CHAT_WEBHOOK;
const MESSAGE_WEBHOOK = process.env.MESSAGE_WEBHOOK;
const WEB_SERVER_PORT = process.env.PORT || 3000;

const SPECTATOR_RANGE = 32;
const POSITION_CHANGE_INTERVAL = 45000;
const MIN_Y_COORDINATE = 0;
const MAX_Y_COORDINATE = 300;
const RECONNECT_DELAY = 10000;
const ANTI_AFK_INTERVAL = 3000;
const PLAYER_LIST_INTERVAL = 10 * 60 * 1000;
const BOT_STATS_INTERVAL = 30 * 60 * 1000;
const Y_POSITION_CHECK_INTERVAL = 5000;
const STUCK_DETECTION_INTERVAL = 3000;
const STUCK_COUNTER_THRESHOLD = 5;
const SPECTATOR_ASCENT_STEP_DELAY = 300;
const SPECTATOR_ASCENT_STEPS = 10;

const DEFAULT_EMBED_COLOR = 0x3498db;
const SUCCESS_EMBED_COLOR = 0x00ff00;
const WARNING_EMBED_COLOR = 0xff9900;
const ERROR_EMBED_COLOR = 0xff0000;
const INFO_EMBED_COLOR = 0x9b59b6;

const botOptions = {
  host: BOT_HOST,
  port: BOT_PORT,
  username: BOT_USERNAME,
  connectTimeout: null,
};

let bot = null;
let reconnectTimeout = null;
let moveInterval = null;
let pendingActions = [];
let botStartTime = null;
let lastMovementTime = Date.now();
let movementCount = 0;
let spectatorCenter = null;
let spectatorWaypoints = [];
let currentWaypointIndex = 0;
let lastPositionChange = Date.now();

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

async function sendDiscordEmbed(title, description, color = DEFAULT_EMBED_COLOR, fields = []) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await axios.post(DISCORD_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('❌ Discord Webhook Error:', err.message);
  }
}

async function sendChatEmbed(title, description, color = SUCCESS_EMBED_COLOR, fields = []) {
  if (!CHAT_WEBHOOK) return;
  try {
    await axios.post(CHAT_WEBHOOK, {
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('❌ Chat Webhook Error:', err.message);
  }
}

async function sendPlayerMessage(username, message) {
  if (username === botOptions.username || !MESSAGE_WEBHOOK) return;
  try {
    await axios.post(MESSAGE_WEBHOOK, {
      embeds: [{ author: { name: username }, description: message, color: SUCCESS_EMBED_COLOR, timestamp: new Date().toISOString() }],
    });
  } catch (err) {
    console.error('❌ Message Webhook Error:', err.message);
  }
}

function sendPlayerList() {
  if (!bot || !bot.players) return;
  try {
    const playerList = Object.keys(bot.players)
      .filter(name => name !== botOptions.username)
      .map(name => ({ name: name, ping: bot.players[name].ping || 'N/A', entity: bot.players[name].entity ? 'Yes' : 'No' }));

    if (playerList.length === 0) {
      sendChatEmbed('👥 Player List', 'No players online', DEFAULT_EMBED_COLOR);
      return;
    }
    const fields = playerList.map(player => ({ name: player.name, value: `Ping: ${player.ping}ms | In Range: ${player.entity}`, inline: true }));
    sendChatEmbed('👥 Player List', `${playerList.length} player(s) online`, DEFAULT_EMBED_COLOR, fields);
  } catch (err) {
    console.error('Error sending player list:', err.message);
  }
}

function sendBotStats() {
  if (!bot || !bot.entity) return;
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

    sendChatEmbed('🤖 Bot Status Report', `Status report for ${botOptions.username}`, INFO_EMBED_COLOR, [
      { name: 'Uptime', value: uptimeStr, inline: true },
      { name: 'Position', value: posStr, inline: true },
      { name: 'Game Mode', value: bot.gameMode === 3 ? 'Spectator' : `Mode ${bot.gameMode || 'Unknown'}`, inline: true },
      { name: 'Memory Usage', value: memoryStr, inline: true },
      { name: 'Ping', value: `${ping}ms`, inline: true },
      { name: 'Movement Status', value: isMoving ? '✅ Moving' : '❌ Static', inline: true },
      { name: 'Movement Count', value: `${movementCount} moves`, inline: true },
      { name: 'Server Load', value: `${os.loadavg()[0].toFixed(2)}`, inline: true },
      { name: 'Waypoints', value: `${spectatorWaypoints.length}`, inline: true }
    ]);
  } catch (err) {
    console.error('Error sending bot stats:', err.message);
  }
}

function spectatorFlyUp() {
  if (!bot || !bot.entity || bot.gameMode !== 3) return false;
  const currentPos = bot.entity.position;
  if (currentPos.y < MIN_Y_COORDINATE) {
    console.log(`🔼 Bot below Y=${MIN_Y_COORDINATE}. Flying up to safe altitude...`);
    sendDiscordEmbed('🛫 Spectator Ascent', `Bot flying up from Y=${currentPos.y.toFixed(2)} to safe altitude`, WARNING_EMBED_COLOR);
    const safeY = MIN_Y_COORDINATE + 15;
    const targetPos = new Vec3(currentPos.x, safeY, currentPos.z);
    const steps = SPECTATOR_ASCENT_STEPS;
    const stepSize = (safeY - currentPos.y) / steps;

    for (let i = 1; i <= steps; i++) {
      setTimeout(() => {
        if (!bot || !bot.entity) return;
        const stepY = currentPos.y + (stepSize * i);
        const stepPos = new Vec3(currentPos.x, stepY, currentPos.z);
        executeOrQueue(() => {
          bot.entity.position = stepPos;
          bot.look(bot.entity.yaw, -0.3, true);
          if (i === steps) {
            console.log(`✅ Completed ascent to Y=${stepPos.y.toFixed(2)}`);
            spectatorCenter = bot.entity.position.clone();
            generateSpectatorWaypoints();
          }
        });
      }, i * SPECTATOR_ASCENT_STEP_DELAY);
    }
    lastMovementTime = Date.now();
    movementCount++;
    return true;
  }
  return false;
}

function enforceYAxisLimits(position) {
  const safePosition = position.clone();
  if (safePosition.y < MIN_Y_COORDINATE) {
    console.log(`🔼 Bot position too low (Y=${safePosition.y.toFixed(2)}). Correcting to Y=${MIN_Y_COORDINATE + 10}`);
    safePosition.y = MIN_Y_COORDINATE + 10;
  } else if (safePosition.y > MAX_Y_COORDINATE) {
    console.log(`🔽 Bot position too high (Y=${safePosition.y.toFixed(2)}). Correcting to Y=${MAX_Y_COORDINATE - 10}`);
    safePosition.y = MAX_Y_COORDINATE - 10;
  }
  return safePosition;
}

function generateSpectatorWaypoints() {
  if (!spectatorCenter) return;
  spectatorWaypoints = [];
  for (let layer = 0; layer < 8; layer++) {
    const layerDistance = (layer + 1) * 4;
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 / 8) * i;
      const x = spectatorCenter.x + Math.cos(angle) * layerDistance;
      const z = spectatorCenter.z + Math.sin(angle) * layerDistance;
      let y = spectatorCenter.y + (Math.random() * 20 - 10);
      y = Math.max(MIN_Y_COORDINATE + 5, Math.min(MAX_Y_COORDINATE - 5, y));
      spectatorWaypoints.push({ position: new Vec3(x, y, z), yaw: angle + Math.PI, pitch: Math.random() * 0.5 - 0.25 });
    }
  }
  spectatorWaypoints.sort(() => Math.random() - 0.5);
  console.log(`Generated ${spectatorWaypoints.length} waypoints for spectator mode (Y-limited: ${MIN_Y_COORDINATE}-${MAX_Y_COORDINATE})`);
  sendDiscordEmbed('🗺️ Waypoints Generated', `Generated ${spectatorWaypoints.length} waypoints for spectator mode navigation with Y-axis limits (${MIN_Y_COORDINATE}-${MAX_Y_COORDINATE})`, INFO_EMBED_COLOR);
}

function moveToNextSpectatorWaypoint() {
  if (!bot || !bot.entity || spectatorWaypoints.length === 0) return;
  if (spectatorFlyUp()) return;

  const waypoint = spectatorWaypoints[currentWaypointIndex];
  currentWaypointIndex = (currentWaypointIndex + 1) % spectatorWaypoints.length;
  const safePosition = enforceYAxisLimits(waypoint.position);
  executeOrQueue(() => {
    bot.entity.position = safePosition;
    bot.look(waypoint.yaw, waypoint.pitch, true);
  });
  lastPositionChange = Date.now();
  lastMovementTime = Date.now();
  movementCount++;
}

function spectatorLookAround() {
  if (!bot || !bot.entity) return;
  if (spectatorFlyUp()) return;

  const yaw = Math.random() * Math.PI * 2;
  const pitch = (Math.random() * Math.PI / 2) - (Math.PI / 4);
  executeOrQueue(() => bot.look(yaw, pitch, true));
  lastMovementTime = Date.now();
  movementCount++;
}

function antiAFKAction() {
  if (!bot || !bot.entity) return;
  if (bot.gameMode === 3 && spectatorFlyUp()) return;

  if (bot.gameMode === 3) {
    if (Date.now() - lastPositionChange > POSITION_CHANGE_INTERVAL) {
      moveToNextSpectatorWaypoint();
    } else {
      spectatorLookAround();
    }
  } else {
    const currentPosition = bot.entity.position;
    if (currentPosition.y < MIN_Y_COORDINATE) {
      executeOrQueue(() => {
        const goal = new goals.GoalBlock(Math.floor(currentPosition.x), Math.floor(MIN_Y_COORDINATE + 10), Math.floor(currentPosition.z));
        bot.pathfinder.setGoal(goal);
      });
      console.log(`🔼 Anti-AFK: Moving up from Y=${currentPosition.y.toFixed(2)} to Y=${MIN_Y_COORDINATE + 10}`);
    } else if (currentPosition.y > MAX_Y_COORDINATE) {
      executeOrQueue(() => {
        const goal = new goals.GoalBlock(Math.floor(currentPosition.x), Math.floor(MAX_Y_COORDINATE - 10), Math.floor(currentPosition.z));
        bot.pathfinder.setGoal(goal);
      });
      console.log(`🔽 Anti-AFK: Moving down from Y=${currentPosition.y.toFixed(2)} to Y=${MAX_Y_COORDINATE - 10}`);
    } else {
      const action = Math.random();
      if (action < 0.33) {
        const x = Math.floor(Math.random() * 20 - 10);
        const z = Math.floor(Math.random() * 20 - 10);
        let y = bot.entity.position.y;
        if (Math.random() < 0.3) {
          y += (Math.random() * 10) - 5;
          y = Math.max(MIN_Y_COORDINATE + 5, Math.min(MAX_Y_COORDINATE - 5, y));
        }
        const goal = new goals.GoalBlock(Math.floor(bot.entity.position.x + x), Math.floor(y), Math.floor(bot.entity.position.z + z));
        executeOrQueue(() => bot.pathfinder.setGoal(goal));
      } else if (action < 0.66) {
        const yaw = Math.random() * Math.PI * 2;
        const pitch = (Math.random() * Math.PI / 4) - (Math.PI / 8);
        executeOrQueue(() => bot.look(yaw, pitch, true));
      } else {
        executeOrQueue(() => {
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 300);
        });
      }
    }
    lastMovementTime = Date.now();
    movementCount++;
  }
}

function safeBotAction(action) {
  try {
    if (bot) action();
  } catch (err) {
    console.error(`⚠️ Error in function ${action.name}:`, err.message);
  }
}

function basicErrorHandler(err) {
  console.error(`Basic error handling: ${err.message}`);
  sendDiscordEmbed('⚠️ Error Detected', `Bot encountered an error: ${err.message}`, WARNING_EMBED_COLOR);
}

function advancedErrorHandler(err) {
  console.error(`Advanced error handling: ${err.stack}`);
  if (err.message && (err.message.includes("timed out after 30000 milliseconds") || err.code === 'ECONNRESET')) {
    console.log("Network error detected, attempting to reconnect...");
    sendDiscordEmbed('🔄 Network Error', `Network error detected: ${err.message}. Attempting to reconnect...`, ERROR_EMBED_COLOR);
    reconnectBot();
  }
}

function startBot() {
  if (moveInterval) clearInterval(moveInterval);
  if (bot) bot.removeAllListeners();
  console.log("🔄 Starting the bot...");
  botStartTime = Date.now();
  movementCount = 0;

  bot = mineflayer.createBot(botOptions);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('✅ Bot joined the server!');
    sendDiscordEmbed('✅ Bot Start', `${botOptions.username} has started and joined the server.`, SUCCESS_EMBED_COLOR);

    spectatorCenter = bot.entity.position.clone();
    spectatorCenter.y = Math.max(MIN_Y_COORDINATE + 20, Math.min(MAX_Y_COORDINATE - 20, spectatorCenter.y));
    generateSpectatorWaypoints();
    flushPendingActions();

    if (bot._client && bot._client.socket) {
      bot._client.socket.setKeepAlive(true, 30000);
      bot._client.socket.on('close', (hadError) => {
        console.log("Socket closed", hadError ? "with error" : "normally");
      });
    }

    moveInterval = setInterval(() => safeBotAction(antiAFKAction), ANTI_AFK_INTERVAL);
    setInterval(() => safeBotAction(sendPlayerList), PLAYER_LIST_INTERVAL);
    setInterval(() => safeBotAction(sendBotStats), BOT_STATS_INTERVAL);
    setInterval(() => safeBotAction(() => {
      if (bot.gameMode === 3 && bot.entity && bot.entity.position.y < MIN_Y_COORDINATE) {
        spectatorFlyUp();
      }
    }), Y_POSITION_CHECK_INTERVAL);

    setTimeout(() => safeBotAction(sendPlayerList), 5000);
    setTimeout(() => safeBotAction(sendBotStats), 10000);
  });

  bot.on('game', () => {
    if (bot.gameMode === 3) {
        const wasNotSpectator = !bot.lastGameMode || bot.lastGameMode !== 3;
        if (wasNotSpectator) {
            console.log('🔍 Bot entered spectator mode');
            sendDiscordEmbed('🔍 Mode Change', `${botOptions.username} entered spectator mode.`, INFO_EMBED_COLOR);
            if (bot.entity && bot.entity.position.y < MIN_Y_COORDINATE) {
                console.log('⚠️ Entered spectator mode below minimum Y. Flying up...');
                spectatorFlyUp();
            } else if (bot.entity) {
                spectatorCenter = bot.entity.position.clone();
                spectatorCenter.y = Math.max(MIN_Y_COORDINATE + 20, Math.min(MAX_Y_COORDINATE - 20, spectatorCenter.y));
                generateSpectatorWaypoints();
                moveToNextSpectatorWaypoint();
            }
        }
    }
    bot.lastGameMode = bot.gameMode;
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ Bot disconnected: ${reason}. Attempting to reconnect...`);
    sendDiscordEmbed('⚠️ Bot Disconnect', `${botOptions.username} was disconnected. Reason: ${reason}.`, ERROR_EMBED_COLOR);
    reconnectBot();
  });

  bot.on('kicked', (reason) => {
    console.log(`🚫 Bot was kicked: ${reason}. Reconnecting...`);
    sendDiscordEmbed('🚫 Bot Kicked', `${botOptions.username} was kicked. Reason: ${reason}.`, ERROR_EMBED_COLOR);
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

  let lastPosition = null;
  let stuckCounter = 0;
  setInterval(() => {
    if (!bot || !bot.entity) return;
    const currentPos = bot.entity.position;

    if (bot.gameMode === 3 && currentPos.y < MIN_Y_COORDINATE) {
      console.log(`⚠️ Bot below Y-axis minimum in spectator mode: Y=${currentPos.y.toFixed(2)}`);
      sendDiscordEmbed('⚠️ Position Warning', `Bot below Y-axis minimum (${MIN_Y_COORDINATE}) in spectator mode: Y=${currentPos.y.toFixed(2)}. Flying up...`, WARNING_EMBED_COLOR);
      spectatorFlyUp();
      return;
    }

    if (bot.gameMode === 3 && currentPos.y > MAX_Y_COORDINATE) {
      console.log(`⚠️ Bot above Y-axis maximum in spectator mode: Y=${currentPos.y.toFixed(2)}`);
      const safeY = MAX_Y_COORDINATE - 10;
      executeOrQueue(() => {
        bot.entity.position = new Vec3(currentPos.x, safeY, currentPos.z);
      });
      sendDiscordEmbed('⚠️ Position Warning', `Bot above Y-axis maximum (${MAX_Y_COORDINATE}) in spectator mode: Y=${currentPos.y.toFixed(2)}. Moving down...`, WARNING_EMBED_COLOR);
      return;
    }

    if (bot.gameMode === 3) {
      if (lastPosition && currentPos.distanceTo(lastPosition) < 0.1) {
        stuckCounter++;
        if (stuckCounter > STUCK_COUNTER_THRESHOLD) {
          console.log("🚨 Bot appears stuck in spectator mode. Forcing position change.");
          sendDiscordEmbed('🚨 Bot Stuck', `Bot appears stuck in spectator mode. Forcing position change.`, WARNING_EMBED_COLOR);
          if (currentPos.y < MIN_Y_COORDINATE) {
            spectatorFlyUp();
          } else {
            moveToNextSpectatorWaypoint();
          }
          stuckCounter = 0;
        }
      } else {
        stuckCounter = 0;
      }
      lastPosition = currentPos.clone();
    }
  }, STUCK_DETECTION_INTERVAL);

  bot.on('chat', (username, message) => safeBotAction(() => sendPlayerMessage(username, message)));
  bot.on('playerJoined', (player) => safeBotAction(() => playerJoinHandler(player)));
  bot.on('playerLeft', (player) => safeBotAction(() => playerLeaveHandler(player)));
}

function reconnectBot() {
  if (moveInterval) {
    clearInterval(moveInterval);
    moveInterval = null;
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  console.log(`🔄 Reconnecting in ${RECONNECT_DELAY / 1000} seconds...`);
  reconnectTimeout = setTimeout(() => {
    startBot();
    reconnectTimeout = null;
  }, RECONNECT_DELAY);
}

function playerJoinHandler(player) {
  if (player.username === botOptions.username) return;
  const onlinePlayers = bot?.players ? Object.keys(bot.players).filter(name => name !== botOptions.username).length : 0;
  sendChatEmbed('👤 Player Joined', `**${player.username}** joined the game.`, SUCCESS_EMBED_COLOR, [{ name: 'Current Players', value: `${onlinePlayers}`, inline: true }]);
}

function playerLeaveHandler(player) {
  if (player.username === botOptions.username) return;
  const onlinePlayers = bot?.players ? Object.keys(bot.players).filter(name => name !== botOptions.username).length -1 : 0; // -1 because playerLeft is emitted after removal from list in some versions
  sendChatEmbed('🚪 Player Left', `**${player.username}** left the game.`, 0xff4500, [{ name: 'Current Players', value: `${onlinePlayers > 0 ? onlinePlayers : 0}`, inline: true }]);
}

const app = express();
app.get('/', (req, res) => {
  try {
    const onlinePlayers = bot?.players ? Object.keys(bot.players).filter(name => name !== botOptions.username).length : 0;
    const botStatus = {
      message: "✅ Bot is running!",
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
      yAxisLimits: `${MIN_Y_COORDINATE}-${MAX_Y_COORDINATE}`,
      belowMinY: bot?.entity?.position ? bot.entity.position.y < MIN_Y_COORDINATE : false
    };
    res.json(botStatus);
  } catch (err) {
    console.error('⚠️ Error in web server route:', err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(WEB_SERVER_PORT, () => {
  console.log(`🌐 Web server running on port ${WEB_SERVER_PORT}`);
  sendDiscordEmbed('🌐 Web Server', `Web monitoring server started on port ${WEB_SERVER_PORT}`, DEFAULT_EMBED_COLOR);
});

startBot();
