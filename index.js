const { Client, Collection, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { prefix, token } = require('./config');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const OpenAI = require('openai');
const { Player } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');

// the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Create express app with dashboard
const app = express();
const port = 5000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'cmdo-bot-secret-key-2025',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

// Simple authentication middleware
const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Default credentials (in production, use real auth)
const defaultUsername = 'admin';
const defaultPassword = 'admin123';

// Login route
app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) {
        return res.redirect('/dashboard');
    }
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === defaultUsername && password === defaultPassword) {
        req.session.authenticated = true;
        res.redirect('/dashboard');
    } else {
        res.render('login', { error: 'Invalid username or password' });
    }
});

// Dashboard route
app.get('/dashboard', isAuthenticated, (req, res) => {
    try {
        res.render('dashboard', {
            stats: {
                serverCount: client.guilds.cache.size || 0,
                userCount: client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0) || 0,
                commandCount: client.commands?.size || 0,
                uptime: formatUptime(process.uptime())
            },
            servers: client.guilds.cache.map(guild => ({
                name: guild.name,
                memberCount: guild.memberCount,
                id: guild.id
            })),
            success: null
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).send('Error loading dashboard');
    }
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.send('Error logging out');
        }
        res.redirect('/login');
    });
});

// Redirect root to login or dashboard
app.get('/', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

// Helper function to format uptime
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
}

// Error handling for the express server
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong!');
});

// Start express server with error handling
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Dashboard server is running on port ${port}`);
}).on('error', (err) => {
    console.error('Dashboard server error:', err);
});

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Initialize discord-player with optimized settings for Replit
const player = new Player(client, {
    skipFFmpeg: true,
    connectionTimeout: 60000,
    lagMonitor: 30000,
    probeTimeout: 10000
});
player.extractors.loadMulti(DefaultExtractors);

client.commands = new Collection();
client.aliases = new Collection();
client.cooldowns = new Collection();
client.autoRoles = new Collection();
client.logsChannel = new Map();
client.serverStatuses = new Map();
client.player = player;
client.musicQueues = new Map();

// Discord player event listeners
player.events.on('playerError', (queue, error) => {
    console.error('Player error:', error);
});

player.events.on('error', (queue, error) => {
    console.error('Queue error:', error);
});

player.events.on('trackStart', (queue, track) => {
    console.log(`Now playing: ${track.title}`);
});

player.events.on('trackEnd', (queue, track) => {
    console.log(`Finished playing: ${track.title}`);
});

// Load autorole data from file
const loadAutoRoles = () => {
    const autoRolePath = path.join(__dirname, 'data/autoroles.json');
    try {
        if (fs.existsSync(autoRolePath)) {
            const data = JSON.parse(fs.readFileSync(autoRolePath));
            client.autoRoles.clear();
            for (const [key, value] of Object.entries(data)) {
                client.autoRoles.set(key, value);
            }
            console.log('Auto-roles loaded successfully');
        }
    } catch (error) {
        console.error('Error loading auto-roles:', error);
    }
};

// Save autorole data to file
const saveAutoRoles = () => {
    const autoRolePath = path.join(__dirname, 'data/autoroles.json');
    try {
        const data = Object.fromEntries(client.autoRoles);
        fs.writeFileSync(autoRolePath, JSON.stringify(data, null, 2));
        console.log('Auto-roles saved successfully');
    } catch (error) {
        console.error('Error saving auto-roles:', error);
    }
};

// Command Handler
const commandFolders = fs.readdirSync('./commands');
for (const folder of commandFolders) {
    const commandFiles = fs.readdirSync(`./commands/${folder}`).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const command = require(`./commands/${folder}/${file}`);
        client.commands.set(command.name, command);

        if (command.aliases) {
            command.aliases.forEach(alias => {
                client.aliases.set(alias, command.name);
            });
        }
    }
}

// Logging function
async function sendLog(guild, embed) {
    if (!client.logsChannel.has(guild.id)) return;
    const channelId = client.logsChannel.get(guild.id);
    const logChannel = guild.channels.cache.get(channelId);

    if (logChannel) {
        try {
            await logChannel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Error sending log:', error);
        }
    }
}

// Load server statuses
const loadServerStatuses = () => {
    const statusPath = path.join(__dirname, 'data/serverstatus.json');
    try {
        if (fs.existsSync(statusPath)) {
            const data = JSON.parse(fs.readFileSync(statusPath));
            client.serverStatuses.clear();
            for (const [guildId, status] of Object.entries(data.servers)) {
                client.serverStatuses.set(guildId, status);
            }
            console.log('Server statuses loaded successfully');
        }
    } catch (error) {
        console.error('Error loading server statuses:', error);
    }
};

// Save server statuses
const saveServerStatuses = () => {
    const statusPath = path.join(__dirname, 'data/serverstatus.json');
    try {
        const data = {
            servers: Object.fromEntries(client.serverStatuses)
        };
        fs.writeFileSync(statusPath, JSON.stringify(data, null, 2));
        console.log('Server statuses saved successfully');
    } catch (error) {
        console.error('Error saving server statuses:', error);
    }
};

// Load messages function
const loadMessages = () => {
    const messagesPath = path.join(__dirname, 'data/messages.json');
    try {
        if (fs.existsSync(messagesPath)) {
            const data = JSON.parse(fs.readFileSync(messagesPath));
            client.addedMessages = new Map(Object.entries(data.addedMessages));
            console.log('Messages loaded successfully');
        }
    } catch (error) {
        console.error('Error loading messages:', error);
        client.addedMessages = new Map();
    }
};

// Save messages function
// Load invites function
const loadInvites = () => {
    const invitesPath = path.join(__dirname, 'data/invites.json');
    try {
        if (!fs.existsSync(invitesPath)) {
            fs.writeFileSync(invitesPath, JSON.stringify({ invites: {} }, null, 2));
        }
        console.log('Invites system initialized');
    } catch (error) {
        console.error('Error initializing invites:', error);
    }
};

const saveMessages = () => {
    const messagesPath = path.join(__dirname, 'data/messages.json');
    try {
        const data = {
            addedMessages: Object.fromEntries(client.addedMessages || new Map())
        };
        fs.writeFileSync(messagesPath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving messages:', error);
    }
};

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    
    // Initialize messages Map
    client.addedMessages = new Map();
    
    // Initialize chatting bot Maps
    client.chattingEnabled = new Map();
    client.chattingTopics = new Map();
    
    // Load configurations
    loadMessages();
    loadInvites();
    loadAutoRoles();
    loadServerStatuses();

    // Load logs channels
    const fs = require('fs');
    const path = require('path');
    const logsPath = path.join(__dirname, 'data/logs.json');

    try {
        const logsData = JSON.parse(fs.readFileSync(logsPath));
        for (const [guildId, channelId] of Object.entries(logsData.channels)) {
            client.logsChannel.set(guildId, channelId);
        }
    } catch (error) {
        console.error('Error loading logs data:', error);
    }

    // Set initial status
    client.user.setPresence({
        activities: [{
            name: `${prefix}help✅`,
            type: 3 // ActivityType.Watching
        }],
        status: 'dnd'
    });
});

// Auto-role event handler with logging
client.on('guildMemberAdd', async (member) => {
    try {
        const roleId = client.autoRoles.get('DEFAULT_ROLE_ID');
        if (!roleId) {
            console.log('No auto-role configured for this server.');
            return;
        }

        const role = member.guild.roles.cache.get(roleId);
        if (!role) {
            console.error(`Auto-role ${roleId} not found!`);
            return;
        }

        await member.roles.add(role);
        console.log(`Assigned role ${role.name} to new member ${member.user.tag}`);

        const systemChannel = member.guild.systemChannel;
        if (systemChannel) {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('👋 Welcome!')
                .setDescription(`Welcome ${member}! You've been automatically assigned the ${role.name} role.`)
                .setTimestamp();

            systemChannel.send({ embeds: [embed] });
        }

        const logEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('👋 Member Joined')
            .setDescription(`**${member.user.tag}** joined the server`)
            .addFields(
                { name: 'Auto-role', value: role.name },
                { name: 'Member ID', value: member.id }
            )
            .setTimestamp();

        sendLog(member.guild, logEmbed);
    } catch (error) {
        console.error(`Error assigning auto-role to ${member.user.tag}:`, error);
    }
});

// Chatting Bot - Context-aware Response Handler
const contextResponses = {
    greetings: {
        triggers: ['hi', 'hello', 'hey', 'sup', 'yo', 'whats up', "what's up", 'wassup', 'hii', 'heyy', 'heyo'],
        responses: ["heyyy", "yooo whats good", "hey hey", "sup!", "ayy whats up", "hii", "heya", "yo yo"]
    },
    goodbye: {
        triggers: ['bye', 'gn', 'goodnight', 'good night', 'cya', 'gtg', 'gotta go', 'im out', 'leaving'],
        responses: ["laterr", "byee", "cya!", "peace out", "gn!", "take care", "see ya", "bye bye"]
    },
    howAreYou: {
        triggers: ['how are you', 'how r u', 'hru', 'how you doing', 'how are u', 'wbu', 'and you'],
        responses: ["im good! wbu?", "chillin hbu", "pretty good ngl, u?", "im vibing, how about u", "doing alright wby"]
    },
    thanks: {
        triggers: ['thanks', 'thank you', 'thx', 'ty', 'tysm', 'appreciate'],
        responses: ["np!", "no problem!", "ofc!", "anytime", "gotchu", "no worries"]
    },
    sorry: {
        triggers: ['sorry', 'my bad', 'mb', 'apologize', 'sry'],
        responses: ["ur good dw", "its fine lol", "no worries", "all good", "dw about it"]
    },
    laughter: {
        triggers: ['lol', 'lmao', 'lmfao', 'haha', 'hahaha', 'rofl', 'dead', '💀', 'crying'],
        responses: ["lmaoo", "im dead 💀", "LMAO", "stoppp 😭", "bruhhh", "hahaha fr", "lolol"]
    },
    agreement: {
        triggers: ['ikr', 'fr', 'facts', 'true', 'same', 'real', 'exactly', 'right', 'yes', 'yeah', 'yea', 'yep'],
        responses: ["frfr", "literally", "on god", "100%", "big facts", "so true", "realest thing ever"]
    },
    disagreement: {
        triggers: ['no', 'nah', 'nope', 'cap', 'false', 'wrong', 'disagree', 'dont think so'],
        responses: ["wait really?", "hmm idk about that", "u sure?", "lowkey disagree ngl", "interesting take"]
    },
    confusion: {
        triggers: ['what', 'huh', 'wdym', 'confused', 'idk', 'i dont get it', 'explain', '?'],
        responses: ["wdym?", "wait what happened", "im confused too ngl", "huh??", "explain pls"]
    },
    excitement: {
        triggers: ['omg', 'yay', 'lets go', 'pog', 'hype', 'excited', 'cant wait', 'finally', 'yess'],
        responses: ["LETS GOOO", "yooo thats hype", "W", "im so hyped", "ayyyy", "poggers"]
    },
    sadness: {
        triggers: ['sad', 'upset', 'depressed', 'crying', 'bad day', 'not ok', 'stressed', 'tired', 'exhausted'],
        responses: ["aw man that sucks", "u ok?", "that's rough :(", "im here if u wanna talk", "sending good vibes"]
    },
    bored: {
        triggers: ['bored', 'boring', 'nothing to do', 'so bored'],
        responses: ["same tbh", "mood", "lets do something", "boredom hits different", "felt that"]
    },
    gaming: {
        triggers: ['game', 'gaming', 'play', 'playing', 'fortnite', 'minecraft', 'valorant', 'roblox', 'cod', 'apex'],
        responses: ["ooh what game", "gaming time lets go", "what u playing?", "nice what game tho", "im down to play"]
    },
    music: {
        triggers: ['music', 'song', 'listening', 'spotify', 'album', 'artist', 'playlist', 'beat'],
        responses: ["ooh what song", "drop the playlist", "music hits different", "whats ur fav artist", "banger?"]
    },
    food: {
        triggers: ['food', 'eat', 'eating', 'hungry', 'lunch', 'dinner', 'breakfast', 'snack', 'cooking'],
        responses: ["im hungry now thanks", "what u eating", "food pics or it didnt happen", "that sounds good ngl"]
    },
    school: {
        triggers: ['school', 'homework', 'class', 'teacher', 'test', 'exam', 'studying', 'assignment'],
        responses: ["school is pain", "rip", "good luck with that", "homework can wait", "felt that"]
    },
    work: {
        triggers: ['work', 'job', 'boss', 'coworker', 'shift', 'working'],
        responses: ["work grind", "get that bread", "adulting moment", "sounds rough", "at least u getting paid"]
    },
    love: {
        triggers: ['crush', 'boyfriend', 'girlfriend', 'dating', 'relationship', 'love', 'like someone'],
        responses: ["ooh spill the tea", "love that for u", "thats cute ngl", "relationship goals", "tell me more"]
    },
    questions: {
        triggers: ['do you', 'are you', 'can you', 'will you', 'would you', 'have you', 'what do you think'],
        responses: ["hmm good question", "honestly idk lol", "maybe?", "depends tbh", "what do u think"]
    }
};

const fallbackResponses = [
    "lol", "nice", "oh word", "thats cool", "fr", "interesting", 
    "tell me more", "wait really", "no way", "hmm", "true true"
];

function getHumanResponse(topic, userMessage) {
    const msg = userMessage.toLowerCase().trim();
    
    for (const [category, data] of Object.entries(contextResponses)) {
        for (const trigger of data.triggers) {
            if (msg.includes(trigger) || msg === trigger) {
                const responses = data.responses;
                return responses[Math.floor(Math.random() * responses.length)];
            }
        }
    }
    
    if (topic) {
        const t = topic.toLowerCase();
        if (t.includes('game')) return contextResponses.gaming.responses[Math.floor(Math.random() * contextResponses.gaming.responses.length)];
        if (t.includes('music')) return contextResponses.music.responses[Math.floor(Math.random() * contextResponses.music.responses.length)];
        if (t.includes('food')) return contextResponses.food.responses[Math.floor(Math.random() * contextResponses.food.responses.length)];
    }
    
    return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
}

// Chatting bot message handler
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;
    
    const serverPrefix = message.client.serverPrefixes?.get(message.guild?.id) || prefix;
    if (message.content.startsWith(serverPrefix)) return;
    
    const channelId = message.channel.id;
    if (!client.chattingEnabled?.get(channelId)) return;
    
    if (Math.random() < 0.7) {
        const topic = client.chattingTopics?.get(channelId) || null;
        const response = getHumanResponse(topic, message.content);
        
        await message.channel.sendTyping();
        setTimeout(async () => {
            await message.reply(response);
        }, 500 + Math.random() * 1500);
    }
});

// Message Command Handler
client.on('messageCreate', async message => {
    const serverPrefix = message.client.serverPrefixes?.get(message.guild?.id) || prefix;
    if (!message.content.startsWith(serverPrefix) || message.author.bot) return;

    const args = message.content.slice(serverPrefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command = client.commands.get(commandName) ||
        client.aliases.get(commandName) ||
        client.commands.find(cmd => cmd.aliases && cmd.aliases.includes(commandName));

    if (!command) return;

    // Check permissions
    if (command.permissions) {
        const authorPerms = message.channel.permissionsFor(message.author);
        if (!authorPerms || !command.permissions.every(perm => authorPerms.has(perm))) {
            return message.reply('You do not have permission to use this command!');
        }
    }

    // Check cooldowns
    if (!client.cooldowns.has(command.name)) {
        client.cooldowns.set(command.name, new Collection());
    }

    const now = Date.now();
    const timestamps = client.cooldowns.get(command.name);
    const cooldownAmount = (command.cooldown || 3) * 1000;

    if (timestamps.has(message.author.id)) {
        const expirationTime = timestamps.get(message.author.id) + cooldownAmount;

        if (now < expirationTime) {
            const timeLeft = (expirationTime - now) / 1000;
            return message.reply(
                `Please wait ${timeLeft.toFixed(1)} more second(s) before reusing the \`${command.name}\` command.`
            );
        }
    }

    timestamps.set(message.author.id, now);
    setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);

    try {
        // Execute command with client parameter
        await command.execute(message, args, client);

        // Save autoroles if the command was autorole
        if (command.name === 'autorole') {
            saveAutoRoles();
        }

        // Only log moderation commands and server-changing actions
        if (command.category === 'moderation' || command.name === 'setup' || command.permissions?.includes(PermissionFlagsBits.ManageGuild)) {
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('🛡️ Server Action')
                .setDescription(`**${message.author.tag}** used moderation command: ${prefix}${command.name}`)
                .addFields(
                    { name: 'Channel', value: message.channel.name },
                    { name: 'Details', value: args.join(' ') || 'No additional details' }
                )
                .setTimestamp();

            sendLog(message.guild, embed);
        }
    } catch (error) {
        console.error(error);
        message.reply('There was an error executing that command!');

        // Log only server-impacting errors
        if (command.category === 'moderation' || command.name === 'setup' || command.permissions?.includes(PermissionFlagsBits.ManageGuild)) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⚠️ Server Action Error')
                .setDescription(`Error executing moderation command: ${prefix}${command.name}`)
                .addFields(
                    { name: 'User', value: message.author.tag },
                    { name: 'Error', value: error.message }
                )
                .setTimestamp();

            sendLog(message.guild, errorEmbed);
        }
    }
});

client.on('guildCreate', guild => {
    // Set default status for new servers
    if (!client.serverStatuses.has(guild.id)) {
        client.serverStatuses.set(guild.id, 'online');
    }
});

// Add event handlers for switching between servers
client.on('interactionCreate', async interaction => {
    if (!interaction.guild) return;
    updateBotStatus(interaction.guild);
});

client.on('messageCreate', async message => {
    if (!message.guild) return;
    updateBotStatus(message.guild);
});

async function updateBotStatus(guild) {
    const serverStatus = client.serverStatuses.get(guild.id) || 'online';
    await client.user.setPresence({
        activities: [{
            name: `${prefix}help✅`,
            type: 3
        }],
        status: serverStatus === 'offline' ? 'invisible' : serverStatus
    });
}

// Reconnection handling
client.on('disconnect', () => {
    console.log('Bot disconnected! Attempting to reconnect...');
    client.login(token);
});

client.on('error', error => {
    console.error('Discord client error:', error);
    // Attempt to reconnect after 5 seconds
    setTimeout(() => {
        console.log('Attempting to reconnect after error...');
        client.login(token);
    }, 5000);
});

// Initial login
client.login(token).catch(error => {
    console.error('Failed to login:', error);
    // Attempt to reconnect after 5 seconds
    setTimeout(() => {
        console.log('Attempting to reconnect...');
        client.login(token);
    }, 5000);
});