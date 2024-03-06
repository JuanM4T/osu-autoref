const bancho = require('bancho.js');
const chalk = require('chalk');
const nodesu = require('nodesu');
const fs = require('fs');

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

let channel, lobby;

const RED = 0, BLUE = 1;
const WAITING_FOR_PICK = 1, WAITING_FOR_START = 2, PLAYING_MATCH = 4, TIMEOUT = 8;
const matchWinningScore = Math.ceil(match.BO / 2);
let matchScore = [0, 0];
let pickingTeam = 0;

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
  let isCode = !isNaN(input.slice(-1)); //is a numbered map code like NM2, DT1, etc.
  if (force || input.length > 4 || (input.length > 2 && isCode)) {

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

    // Find correct mods based on map code
    let mapType = map.code.slice(0, 2);
    let mod = 'Freemod';
    if (map.mod) {
      mod = map.mod; // if mod explicitly provided (not normal)
    } else if (['HD', 'HR', 'DT'].includes(mapType)) {
      mod = mapType;
    } else if (mapType === 'NM') {
      mod = 'None';
    }

    channel.sendMessage("Selecting " + map.name);
    lobby.setMap(map.id);
    lobby.setMods(mod, false);
    return map.code;
  }
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
  matchStatus &= WAITING_FOR_PICK;
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
        matchStatus &= WAITING_FOR_START;
      }
    }
  }
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
      printScore(); channel.sendMessage("You have " + match.timers.waitingForStart + " to ready up.");
      lobby.startTimer(match.timers.waitingForStart);
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
    const matchStartedAt = Date.now();
  });
  lobby.on("matchFinished", (scores) => {
    if (auto) {
      lastPickResult(scores);
      printScore();
      pickingTeam ^= 1; // switch picking team
      checkScoreAndProceed();
    }
  });
  lobby.on("timerEnded", async () => {
    if (auto) {
      if (isBitSet(matchStatus, TIMEOUT)) {
        console.log(chalk.magenta("Timeout given"));
        lobby.startTimer(match.timers.timeout);
        matchStatus ^= TIMEOUT; // remove timeout flag
      }
      else if (isBitSet(matchStatus, WAITING_FOR_PICK)) {
        pickingTeam ^= 1; // switch picking team
        channel.sendMessage(`Time has ran out for team ${match.teams[pickingTeam]}`)
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
          const players = match.teams[0].members.concat(match.teams[1].members);
          for (const p of players) {
            // intentionally fire these synchronously
            await lobby.invitePlayer(p);
          }
          break;
        case 'map':
          const map = setBeatmap(m.slice(1).join(' '), true);
          if (map) console.log(chalk.cyan(`Changing map to ${map}`));
          break;
        case 'score':
          matchScore[0] = parseInt(m[1]);
          matchScore[1] = parseInt(m[2]);
          printScore();
          break;
        case 'auto':
          auto = (m[1] === 'on');
          channel.sendMessage("Auto referee is " + (auto ? "ON" : "OFF"));
          if (auto) promptPick();
          break;
        case 'picking':
          pickingTeam = (m[1].toLowerCase() === "red" ? 0 : 1);
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
        default:
          console.log(chalk.bold.red(`Unrecognized command "${m[0]}"`));
      }
    }

    // people on the picking team can choose just by saying the map name/code
    if (auto && match.teams[pickingTeam].members.includes(msg.user.ircUsername)) {
      const map = setBeatmap(msg.message);
      if (map) {
        console.log(chalk.cyan(`Changing map to ${map}`));
        lobby.abortTimer();
        matchStatus &= WAITING_FOR_START;
        await channel.sendMessage(`A map has been picked. You have ${match.timers.waitingForStart} to ready up.`);
        lobby.startTimer(match.timers.waitingForStart);
      }
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
