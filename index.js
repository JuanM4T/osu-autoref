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
match.winningScore = Math.ceil(match.BO/2);
match.score = [0, 0];
match.picking = 0;

// turn on to keep track of scores
// and ask players to pick maps
let auto = false;

// populate mappool with map info
function initPool() {
  return Promise.all(pool.map(async (b) => {
    const info = (await api.beatmaps.getByBeatmapId(b.id))[0];
    b.name = b.code + ': ' + info.artist + ' - ' + info.title + ' [' + info.version + ']';
    console.log(chalk.dim(`Loaded ${info.title}`));
  }));
}

// Creates a new multi lobby
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
  await lobby.setMap(1262832); //hitorigoto dayo

  console.log(chalk.bold.green("Lobby created!"));
  console.log(chalk.bold.cyan(`Name: ${lobby.name}, password: ${password}`));
  console.log(chalk.bold.cyan(`Multiplayer link: https://osu.ppy.sh/mp/${lobby.id}`));
  console.log(chalk.cyan(`Open in your irc client with "/join #mp_${lobby.id}"`));

  lobby.setSettings(bancho.BanchoLobbyTeamModes.TeamVs, bancho.BanchoLobbyWinConditions.ScoreV2);

  createListeners();
}

// Sets current beatmap by matching a user input
function setBeatmap(input, force=false) {
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
    }  else if(result.length === 1) {
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

function printScore() {
  channel.sendMessage(`${match.teams[0].name} ${match.score[0]} -- ${match.score[1]} ${match.teams[1].name}`);
}

function promptPick() {
  channel.sendMessage(`${match.teams[match.picking].name}, pick the next map`);
}

// Respond to events occurring in lobby
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
   });

  lobby.on("allPlayersReady", () => {
    lobby.startMatch(match.timers.readyStart);
  });

  lobby.on("matchFinished", (scores) => {
    if (auto) {
      let scoreline = {"Blue": 0, "Red": 0};
      scores.forEach((score) => {
        scoreline[score.player.team] += score.score; //* score.pass not to count fails
      });

      let diff = scoreline["Blue"] - scoreline["Red"];
      if (diff > 0) {
        channel.sendMessage(`${match.teams[BLUE].name} wins by ${diff}`);
        match.score[BLUE]++;
      } else if (diff < 0) {
        channel.sendMessage(`${match.teams[RED].name} wins by ${-diff}`);
        match.score[RED]++;
      } else {
        channel.sendMessage("It was a tie!");
      }

      match.picking = 1 - match.picking;
      printScore();

      if (match.score[BLUE] >= match.winningScore) {
        channel.sendMessage(`${match.teams[BLUE].name} has won the match!`);
      } else if (match.score[RED] >= match.winningScore) {
        channel.sendMessage(`${match.teams[RED].name} has won the match!`);
      } else if (match.score[BLUE] === match.winningScore - 1 && match.score[RED] === match.winningScore - 1) {
        channel.sendMessage("It's time for the tiebreaker!");

        // bug: after match ends, need to wait a bit before changing map
        setTimeout(() => setBeatmap('TB', true), 2000);
      } else {
        promptPick();
      }
    }    
  });

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
          match.score[0] = parseInt(m[1]);
          match.score[1] = parseInt(m[2]);
          printScore();
          break;
        case 'auto':
          auto = (m[1] === 'on');
          channel.sendMessage("Auto referee is " + (auto ? "ON" : "OFF"));
          if (auto) promptPick(); 
          break;
        case 'picking':
          match.picking = (m[1].toLowerCase() === "red" ? 0 : 1);
          if (auto) promptPick();
          break;
        case 'ping':
          channel.sendMessage("pong");
          break;
        default:
          console.log(chalk.bold.red(`Unrecognized command "${m[0]}"`));
      }
    } 
   
    // people on the picking team can choose just by saying the map name/code
    if (auto && match.teams[match.picking].members.includes(msg.user.ircUsername)) {
      const map = setBeatmap(msg.message);
      if (map) console.log(chalk.cyan(`Changing map to ${map}`));
    }
  });
}

rl.on('line', (input) => {
  channel.sendMessage(input);
});

async function close() {
  console.log(chalk.cyan("Closing..."));
  rl.close();
  await lobby.closeLobby();
  await client.disconnect();
  console.log(chalk.cyan("Closed."));
}

init()
  .then(() => {
    console.log(chalk.bold.green("Initialization complete!"));
  })
