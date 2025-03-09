// LookAT Bot
const mineflayer = require('mineflayer');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');
const os = require('os');
// Server
const botOptions = {
host: 'bataksurvival.aternos.me',
port: 12032,
username: 'lookAt',
connectTimeout: 60000,
};
// WebHooks
const discordWebhook = 'https://discord.com/api/webhooks/1348283775930470492/03Z_3or9YY6uMB-1ANCEpBG229tHbM8_uYORdptwdm_5uraEewp69eHmj1m73GbYUzVD'; // Main notifications webhook
const chatWebhook = 'https://discord.com/api/webhooks/1348283959473213462/UA2lue2vWNaGLZesYGYKsKmY5WtqT3I2pnLNlA96YQCmR8-CeN71ShSLWRAWLWYnGkTZ'; // Chat logging webhook

let bot;
let reconnectTimeout = null;
let botStartTime = Date.now();

// Function to send Discord webhook messages with embeds
function sendEmbed(title, description, color = 0x3498db, fields = []) {
axios.post(discordWebhook, {
embeds: [{
title,
description,
color,
fields,
timestamp: new Date().toISOString()
}]
}).catch(err => console.error('❌ Webhook Error:', err.message));
}

// Function to send chat messages to a separate webhook
function sendChatMessage(username, message) {
axios.post(chatWebhook, {
embeds: [{
author: { name: username },
description: message,
color: 0x00ff00,
timestamp: new Date().toISOString()
}]
}).catch(err => console.error('❌ Chat Webhook Error:', err.message));
}

// Start the bot
function startBot() {
if (bot) bot.removeAllListeners();
console.log("Starting bot...");

bot = mineflayer.createBot(botOptions);  
bot.loadPlugin(pathfinder);  

bot.once('spawn', () => {  
    console.log('✅ Bot joined the server!');  
    sendEmbed('✅ LookAt Start', 'LookAtBOT has started and joined the server.', 0x00ff00);  
    moveRandomly();  
    preventAfk();  
});  

bot.on('end', (reason) => {  
    console.log(`⚠️ Bot disconnected: ${reason}. Reconnecting in 10 seconds...`);  
    sendEmbed('⚠️ LookAt Disconnect', `LookAtBOT was disconnected. Reason: ${reason}.`, 0xff0000);  
    reconnectBot();  
});  

bot.on('kicked', (reason) => {  
    console.log(`⚠️ Bot was kicked: ${reason}. Reconnecting...`);  
    sendEmbed('🚫 LookAt Stop', `LookAtBOT was kicked. Reason: ${reason}.`, 0xff0000);  
    reconnectBot();  
});  

bot.on('error', (err) => {  
    console.log(`❌ Bot error: ${err.message}`);  
});  

bot.on('physicTick', lookAtNearestPlayer);  
bot.on('chat', (username, message) => sendChatMessage(username, message));  
bot.on('playerJoined', playerJoinHandler);  
bot.on('playerLeft', playerLeaveHandler);

}

// Reconnection handling
function reconnectBot() {
if (reconnectTimeout) return;
reconnectTimeout = setTimeout(() => {
console.log("🔄 Reconnecting...");
startBot();
reconnectTimeout = null;
}, 10000);
}

// Handle player joining
function playerJoinHandler(player) {
const onlinePlayers = Object.keys(bot.players).length;
sendEmbed('👤 Player Joined', **${player.username}** joined the game., 0x00ff00, [
{ name: 'Current Players', value: ${onlinePlayers}, inline: true }
]);
}

// Handle player leaving
function playerLeaveHandler(player) {
const onlinePlayers = Object.keys(bot.players).length - 1;
sendEmbed('🚪 Player Left', **${player.username}** left the game., 0xff4500, [
{ name: 'Current Players', value: ${onlinePlayers}, inline: true }
]);
}

// Random movement function
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

// Prevent AFK kicks
function preventAfk() {
setInterval(() => {
bot.swingArm();
bot.setControlState('sneak', true);
setTimeout(() => bot.setControlState('sneak', false), 500);
}, 60000);
}

// Look at nearest player
function lookAtNearestPlayer() {
const playerFilter = (entity) => entity.type === 'player';
const playerEntity = bot.nearestEntity(playerFilter);
if (!playerEntity) return;
const pos = playerEntity.position.offset(0, playerEntity.height, 0);
bot.lookAt(pos);
}

// Function to get system uptime
function getUptime() {
const uptime = Date.now() - botStartTime;
return ${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m;
}

// Function to ping the server and bot
function sendServerStatus() {
const serverUptime = os.uptime();
sendEmbed('📡 LookAt Server Details', 'Here are the current server details:', 0x3498db, [
{ name: 'Bot Uptime', value: getUptime(), inline: true },
{ name: 'Server Uptime', value: ${Math.floor(serverUptime / 3600)}h ${Math.floor((serverUptime % 3600) / 60)}m, inline: true },
{ name: 'Server Name', value: botOptions.host, inline: true },
{ name: 'Server IP', value: botOptions.host, inline: true },
{ name: 'Server Port', value: ${botOptions.port}, inline: true }
]);
}

// Send server status every 30 minutes
setInterval(sendServerStatus, 1800000);

// Web monitoring server
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
const onlinePlayers = Object.keys(bot.players).length;
res.json({
message: "✅ Bot is running!",
onlinePlayers
});
});

app.listen(PORT, () => {
console.log(🌐 Web server running on port ${PORT});
});

// Start the bot
startBot();  
