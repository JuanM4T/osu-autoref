const bancho = require('bancho.js');
const chalk = require('chalk');
const nodesu = require('nodesu');
const fs = require('fs');
const { WebhookClient } = require('discord.js');

const readline = require('readline');
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

// Remember to fill config.json with your credentials
const config = require('./config.json');
const pool = require('./pool.json');
const match = require('./match.json');

const client = new bancho.BanchoClient(config);
const api = new nodesu.Client(config.apiKey);
const webhook = new WebhookClient({ url: config.discord.webhookLink })

let channel, lobby;

const RED = 0, BLUE = 1;
const WAITING_FOR_PICK = 1, WAITING_FOR_START = 2, PLAYING_MATCH = 4, TIMEOUT = 8;
const WAITING_FOR_BAN = 16, TIMER_RAN_OUT_WHILE_PICKING = 32, TIMER_RAN_OUT_WHILE_BANNING = 64;
const matchWinningScore = Math.ceil(match.BO / 2);
let matchScore = [0, 0];
let bans = [[], []];
let picks = [[], []];
let bansLeft = match.ban.perTeam * 2;
let firstBan = 0;
let banningTeam = 0;
let pickingTeam = 0;
let banOrder = match.ban.format.split("").reverse().join(""); //hack
let matchStartedAt;

// turn on to keep track of scores
// and ask players to pick maps
let auto = false;
let matchStatus = 0; //bitwise status

/**
 * Initialize the map pool by loading map information from the API.
 * @returns {Promise} A promise that resolves when all map information has been loaded.
 */
function initPool() {
	return Promise.all(pool.map(async (beatmap) => {
		const beatmapInformation = (await api.beatmaps.getByBeatmapId(beatmap.id))[0];
		beatmap.name = beatmap.code + ': ' + beatmapInformation.artist + ' - ' + beatmapInformation.title + ' [' + beatmapInformation.version + ']';
		console.log(chalk.dim(`Loaded ${beatmapInformation.title}`));
	}));
}

/**
 * Create a new multiplayer lobby and connect to the Bancho server.
 * @returns {Promise} A promise that resolves when the lobby has been created and the client has connected.
 */
async function init() {
	console.log(chalk.bold.cyan('Starting osu!autoref'));
	await initPool();
	console.log(chalk.bold.green('Loaded map pool!'));
	console.log(chalk.cyan('Attempting to connect...'));

	try {
		await client.connect();
		console.log(chalk.bold.green("Connected to Bancho!"));
		channel = await client.createLobby(`${match.tournament}: ${match.teams[RED].name} vs ${match.teams[BLUE].name}`);
	} catch (err) {
		console.log(err);
		console.log(chalk.bold.red("Failed to create lobby"));
		process.exit(1);
	}

	lobby = channel.lobby;

	const password = Math.random().toString(36).substring(8);
	await lobby.setPassword(password);
	await lobby.setMap(match.waitSong); //waiting song
	await lobby.addRef(match.trustedPeople);

	console.log(chalk.bold.green("Lobby created!"));
	console.log(chalk.bold.cyan(`Name: ${lobby.name}, password: ${password}`));
	console.log(chalk.bold.cyan(`Multiplayer link: https://osu.ppy.sh/mp/${lobby.id}`));
	console.log(chalk.cyan(`Open in your irc client with "/join #mp_${lobby.id}"`));
	console.log(chalk.yellow(`Match refs added: ${match.trustedPeople.join(', ')}`))


	lobby.setSettings(bancho.BanchoLobbyTeamModes.TeamVs, bancho.BanchoLobbyWinConditions.ScoreV2);

	createListeners();
}

/**
 * Set the current beatmap based on user input.
 * @param {string} input - The user's input, which can be a map code or part of a map name.
 * @param {boolean} [force=false] - Whether to force setting the beatmap even if the input doesn't look like a map code or song name. Default is false
 * @returns {string|undefined} The code of the selected beatmap, or undefined if no matching beatmap was found.
 */
function setBeatmap(input, force = false) {
	if (force || input.length > 4 || (input.length > 2 && isCode(input))) {

		let map = findMap(input);

		// Find correct mods based on map code
		let mod = findMods(map);

		channel.sendMessage("Selecting " + map.name);
		lobby.setMap(map.id);
		lobby.setMods(mod, false);
		return map.code;
	}
}

function findMods(map) {
	let mapType = map.code.slice(0, 2);
	let mod = 'Freemod';
	if (map.mod) {
		mod = map.mod; // if mod explicitly provided (not normal)
	} else if (['HD', 'HR', 'DT'].includes(mapType)) {
		mod = mapType + ' NF';
	} else if (mapType === 'NM') {
		mod = 'NF';
	}
	return mod;
}

function isCode(input) {
	return !isNaN(input.slice(-1)); //is a numbered map code like NM2, DT1, etc.
}

function findMap(input) {
	const codeResult = pool.filter((map) => {
		return map.code.toLowerCase() === input.toLowerCase();
	});

	const result = pool.filter((map) => {
		return map.name.toLowerCase().includes(input.toLowerCase());
	});

	// Prioritize matches to map code before checking by name
	let map;
	if (codeResult.length === 1) {
		map = codeResult[0];
	} else if (result.length === 1) {
		map = result[0];
	} else {
		return;
	}

	return map;
}

/**
 * Print the current score to the chat.
 */
function printScore() {
	channel.sendMessage(`${match.teams[0].name} ${matchScore[0]} -- ${matchScore[1]} ${match.teams[1].name}`);
}

/**
 * Prompt the team currently picking to pick a map.
 */
function promptPick() {
	channel.sendMessage(`${match.teams[pickingTeam].name}, you have ${match.timers.pickWait} to pick the next map`);
	lobby.startTimer(match.timers.pickWait);
	matchStatus = WAITING_FOR_PICK;
}

/**
 * Calculate and announce the (current) match result based on the scores.
 * @param {Array} scores - An array of scores, where each score is an object with properties 'player' and 'score'.
 */
function lastPickResult(scores) {
	let scoreline = { "Blue": 0, "Red": 0 };
	scores.forEach((score) => {
		scoreline[score.player.team] += score.score; //* score.pass not to count fails
	});

	let diff = scoreline["Blue"] - scoreline["Red"];
	if (diff > 0) {
		channel.sendMessage(`${match.teams[BLUE].name} wins by ${diff}`);
		matchScore[BLUE]++;
	} else if (diff < 0) {
		channel.sendMessage(`${match.teams[RED].name} wins by ${-diff}`);
		matchScore[RED]++;
	} else {
		channel.sendMessage("It was a tie!");
	}
}

/**
 * Check if a specific bit is set in the match status.
 * @param {number} value - The value to be tested for the bit.
 * @param {number} bit - The bit to check. (2 to the power of n, where n is the bit position starting from 0)
 * @returns {boolean} True if the bit is set, false otherwise.
 */
function isBitSet(value, bit) {
	return (value & bit) === bit;
}

/**
 * Check the match score and announce the final result or prompt for the next pick.
 */
function checkScoreAndProceed() {
	if (matchScore[BLUE] >= matchWinningScore) {
		channel.sendMessage(`${match.teams[BLUE].name} has won the match!`);
	} else if (matchScore[RED] >= matchWinningScore) {
		channel.sendMessage(`${match.teams[RED].name} has won the match!`);
	} else if (matchScore[BLUE] === matchWinningScore - 1 && matchScore[RED] === matchWinningScore - 1) {
		channel.sendMessage("It's time for the tiebreaker!");
		setTimeout(() => setBeatmap('TB', true), 2000); // bug: after match ends, need to wait a bit before changing map
	} else {
		promptPick();
	}
}

/**
 * Handle a player leaving during a match.
 */
function handlePlayerLeave() {
	if (isBitSet(matchStatus, PLAYING_MATCH)) {
		console.log(chalk.red.bold("Player left during match!"));
		if (auto) {
			const abortLeniency = match.timers.abortLeniency * 1000; // convert to milliseconds
			const currentTime = Date.now();
			if (currentTime - matchStartedAt < abortLeniency) {
				lobby.abortMatch();
				channel.sendMessage("Match aborted due to player leaving.");
				matchStatus = WAITING_FOR_START;
			}
		}
	}
}
/**
 * Replaces all spaces in each string of an array with underscores.
 * If a string doesn't contain any spaces, the original string is returned.
 * The function uses the `replaceSpacesWithUnderscores` function to process each string.
 *
 * @param {Array<string>} arr - The array of strings to process.
 * @returns {Array<string>} The processed array with spaces in strings replaced by underscores.
 */
function replaceSpacesWithUnderscoresInArray(arr) {
	return arr.map(function (str) {
		return replaceSpacesWithUnderscores(str);
	});
}
/**
 * Replaces all spaces in a string with underscores.
 * @param {string} str - The string to process.
 * @returns {string} The processed string with spaces replaced by underscores.
 */
function replaceSpacesWithUnderscores(str) {
	return str.replace(/ /g, '_');
}

/**
 * Create event listeners for various lobby and chat events.
 */
function createListeners() {
	lobby.on("playerJoined", (obj) => {
		const name = obj.player.user.username;
		console.log(chalk.yellow(`Player ${name} has joined!`));

		// Attempt to auto-assign team
		if (match.teams[BLUE].members.includes(name)) {
			lobby.changeTeam(obj.player, "Blue");
		} else if (match.teams[RED].members.includes(name)) {
			lobby.changeTeam(obj.player, "Red");
		} else {
			console.log(chalk.red("Warning! Couldn't figure out team"));
		}

		if (obj.player.user.isClient()) {
			lobby.setHost("#" + obj.player.user.id);
		}

		if (auto && isBitSet(matchStatus, WAITING_FOR_START)) {
			console.log(chalk.yellow("Player joined and auto is enabled. Starting timer."));
			printScore(); channel.sendMessage("You have " + match.timers.readyUp + " to ready up.");
			lobby.startTimer(match.timers.readyUp);
		}
	});

	lobby.on("playerLeft", handlePlayerLeave);
	lobby.on("allPlayersReady", () => {
		lobby.abortTimer();
		lobby.startMatch(match.timers.readyStart);
	});
	lobby.on("matchStarted", () => {
		console.log(chalk.green("Match started!"));
		matchStatus &= PLAYING_MATCH;
		matchStartedAt = Date.now();
	});
	lobby.on("matchFinished", (scores) => {
		if (auto) {
			if(!match.bans.spanishBans || (picks[0].length + picks[1].length) != match.ban.spanishPicksBeforeBan) 
			pickCycle(scores); 
			else promptBan();
		}
	});
	lobby.on("timerEnded", () => {
		if (auto) {
			if (isBitSet(matchStatus, TIMEOUT)) {
				console.log(chalk.magenta("Timeout given"));
				lobby.startTimer(match.timers.timeout);
				matchStatus ^= TIMEOUT; // remove timeout flag
			}
			else if (isBitSet(matchStatus, WAITING_FOR_PICK)) {
				pickingTeam ^= 1; // switch picking team
				channel.sendMessage(`Time has ran out for team ${match.teams[pickingTeam].name} to pick a map. ` + `The other team will pick now.`)
				matchStatus |= TIMER_RAN_OUT_WHILE_PICKING;
				promptPick();
			}
			else if (isBitSet(matchStatus, WAITING_FOR_START)) {
				Console.log(chalk.magenta("Players weren't ready after the timer ran out. ") + chalk.yellow("Forcing start."));
				lobby.startMatch(match.timers.forceStart);
				matchStatus &= PLAYING_MATCH;
			}
		}
	})

	channel.on("message", async (msg) => {
		// All ">" commands must be sent by host
		console.log(chalk.dim(`${msg.user.ircUsername}: ${msg.message}`));
		if (msg.message.startsWith(">") && msg.user.ircUsername === config.username) {
			const m = msg.message.substring(1).split(' ');
			console.log(chalk.yellow(`Received command "${m[0]}"`));

			switch (m[0]) {
				case 'close':
					await close();
					break;
				case 'invite':
					const players = match.teams[RED].members.concat(match.teams[RED].members);
					for (const p of players) {
						// intentionally fire these synchronously
						await lobby.invitePlayer(p);
					}
					break;
				case 'forcepick':
					const forced = setBeatmap(m.slice(1).join(' '));
					if (forced) pick(forced);
					break;
				case 'map':
					const map = setBeatmap(m.slice(1).join(' '), true);
					if (map) console.log(chalk.cyan(`Changing map to ${map}`));
					break;
				case 'score':
					matchScore[RED] = parseInt(m[1]);
					matchScore[BLUE] = parseInt(m[2]);
					printScore();
					break;
				case 'auto':
					autoToggle(msg);
					break;
				case 'picking':
					pickingTeam = (m[1].toLowerCase() === "red" ? RED : BLUE);
					if (auto) promptPick();
					break;
				case 'ping':
					channel.sendMessage("pong");
					break;
				case 'timeout':
					await channel.sendMessage(`An additional ${match.timers.timeout}s of timeout have been given.`)
					channel.sendMessage("It will be added after the current timer ends.");
					matchStatus |= TIMEOUT;
					break;
				case 'abort':
					await lobby.abortMatch();
					channel.sendMessage("Match aborted manually.")
					break;
				case 'banning'://ban phase start
				if (m[1] === 'red') banningTeam = RED; else banningTeam = BLUE;
					if (auto) {
						console.log(chalk.yellow("Ban phase started"));
						channel.sendMessage("Ban phase started.");
						promptBan();
					}
				case 'remind':
					remindOptions(m[1]);
					break;
				default:
					console.log(chalk.bold.red(`Unrecognized command "${m[0]}"`));
			}
		}

		if (auto && msg.message === "!panic") {
			auto = false;
			channel.sendMessage("Panic command received. A ref will be checking in shortly.")
			console.log(chalk.red.bold("Something has gone really wrong!\n") + "Someone has executed the !panic command and " + chalk.yellow("auto mode has been disabled"));
			await webhook.send(`<@${config.discord.refereeRole}>, someone has executed the !panic command on match https://osu.ppy.sh/mp/${lobby.id}.\n` +
				"join using ` /join #mp_" + lobby.id + "` The host is " + config.username + ` and added refs are ${match.trustedPeople.toString()}.`)
			if (matchStatus & PLAYING_MATCH == 0) {
				lobby.abortTimer();
			}
		}

		// people on the picking team can choose just by saying the map name/code
		if (isBitSet(matchStatus, WAITING_FOR_PICK) && auto && replaceSpacesWithUnderscoresInArray(match.teams[pickingTeam].members).includes(msg.user.ircUsername)) {
			const map = setBeatmap(msg.message);
			if (map) {
				matchStatus &= ~TIMEOUT; // remove timeout flag
				await pick(map);
				matchStatus &= ~WAITING_FOR_PICK; // remove timeout flag
			}
		}
		// people on the banning team can ban just by saying the map name/code
		if (isBitSet(matchStatus, WAITING_FOR_BAN) && auto && replaceSpacesWithUnderscoresInArray(match.teams[banningTeam].members).includes(msg.user.ircUsername)) {
			const map = findMap(msg.message)
			if (map) processBan(map.code);
		}
	});
}

/**
 * Redirect input from the console to the Bancho channel.
 * @param {string} input - The line of input.
 * @returns {void}
 * @emits {string} The input line to the Bancho channel.
 */
rl.on('line', (input) => {
	channel.sendMessage(input);
});

function remindOptions(m) {
	switch (m) {
		case 'picks': //read out loud all picked maps
			channel.sendMessage("Picked maps by " +  match.teams[RED].name + ": "  + picks[RED].join(", "));
			channel.sendMessage("Picked maps by " +  match.teams[BLUE].name + ": " + picks[BLUE].join(", "));
			break;
		case 'bans':
			channel.sendMessage("Maps banned by " +  match.teams[RED].name + ": " + bans[RED].join(", "));
			channel.sendMessage("Maps banned by " +  match.teams[BLUE].name + ": " + bans[BLUE].join(", "));
			break;
		case 'score':
			printScore();
			break;
		case 'maps': //maps left
			let maps = pool.map((map) => map.code);
			let pickedMaps = picks[0].concat(picks[1]);
			let remainingMaps = maps.filter((map) => !pickedMaps.includes(map));
			channel.sendMessage("Maps left: " + remainingMaps.join(", "));
			break;
		case 'all':
			remindOptions('picks');
			remindOptions('bans');
			remindOptions('score');
			remindOptions('maps');
		default: //need arguments
			console.log(chalk.red("Invalid arguments for remind command. Available arguments: picks, maps, bans, score"));
	}
}

function autoToggle(m, force=false) {
	auto = (m[1] === 'on' || force);
	channel.sendMessage("Auto referee is " + (auto ? "ON" : "OFF"));
	channel.sendMessage("Remember to use '!panic' if there's any problem throughout (lobby breaking ones). Don't abuse it.");
	if (auto) 
		if (bansLeft > 1 && (!match.ban.spanishBans || picks[0].length + picks[1].length != match.ban.spanishPicksBeforeBan)) 
		promptBan();
		else promptPick();
}

function processBan(msg) {
	lobby.abortTimer();
	if(bansLeft == match.ban.perTeam * 2) firstBan = banningTeam;
	bansLeft--;
	bans[pickingTeam].push(msg.message);
	channel.sendMessage(`Map ${msg.message} has been banned by ${match.teams[pickingTeam].name}. ${bansLeft} ban` + (bansLeft == 1 ? "" : `s`) + ` left.`);
	if (bansLeft > 0) {
		banCycle();
		if((!match.ban.spanishBans || bansLeft % 2 != 0)){
			channel.sendMessage(`Next ban will be from ${match.teams[pickingTeam].name}`); // switch banning team
			promptBan();
		} else{
			console.log("Proceeding with picks. Will ban again after " + match.ban.spanishPicksBeforeBan + " picks.");
			channel.sendMessage("1st part of the ban phase is over.");
			promptPick();
			remindOptions("bans");
		}
	} else{
		console.log("Proceeding with picks.");
		channel.sendMessage("Ban phase is over.")
		autoToggle("", true);
		remindOptions("bans");
	}
}

function banCycle() {
	if (banOrder[bansLeft - 1] === 'B') banningTeam = ~firstBan;
	else banningTeam = firstBan;
}

async function pick(map) {
	console.log(chalk.cyan(`Changing map to ${map}`));
	lobby.abortTimer();
	matchStatus &= WAITING_FOR_START;
	await channel.sendMessage(`A map has been picked. You have ${match.timers.readyUp} to ready up.`);
	lobby.startTimer(match.timers.readyUp);
}

function pickCycle(scores) {
	lastPickResult(scores);
	printScore();
	if(isBitSet(matchStatus, TIMER_RAN_OUT_WHILE_PICKING)) pickingTeam ^= 1; // switch picking team
	matchStatus &= ~TIMER_RAN_OUT_WHILE_PICKING;
	checkScoreAndProceed();
}

function promptBan() {
	channel.sendMessage(`${match.teams[banningTeam].name}, you have ${match.timers.banTime} to ban a map.`);
	lobby.startTimer(match.timers.banTime);
	matchStatus = WAITING_FOR_BAN;

}

/**
 * Close the lobby and disconnect from the Bancho server, and exits.
 */
async function close() {
	console.log(chalk.cyan("Closing..."));
	rl.close();
	await lobby.closeLobby();
	await client.disconnect();
	console.log(chalk.cyan("Closed."));
	process.exit(0);
}

init()
	.then(() => {
		console.log(chalk.bold.green("Initialization complete!"));
	})
