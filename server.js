/* eslint-disable no-console */

// World Cup Predictor local engine + web API server.
// Serves a browser UI from /public and exposes JSON APIs.

const express = require("express");
const path = require("path");

// Demo timing:
// We keep official kickoff timestamps for display (officialKickoffISO),
// but compress lock/evaluation timings so the UI and bots feel live locally.
const DEMO_MINUTE_MS = Number(process.env.DEMO_MINUTE_MS || 1000); // 1 sim minute = 1 second by default
const LOCK_LEAD_MINUTES = 5;
const MATCH_DURATION_MINUTES = Number(process.env.MATCH_DURATION_MINUTES || 12);
const FIVE_MIN_BEFORE_LOCK_MS = LOCK_LEAD_MINUTES * DEMO_MINUTE_MS;

const BOT_MONKEY = "🐒 הקוף הרנדומלי";
const BOT_OWL = "🦉 פרופסור ינשוף (AI)";
const botNames = [BOT_MONKEY, BOT_OWL];

// Shared in-memory state used by the API.
let matches = [];
let tournamentActual = null;
let tournamentOdds = null;
let macroPredictions = Object.create(null);

function nowMs() {
  return Date.now();
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function direction(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return "H";
  if (homeGoals < awayGoals) return "A";
  return "D";
}

function winnerTeam(homeTeam, awayTeam, homeGoals, awayGoals) {
  const dir = direction(homeGoals, awayGoals);
  if (dir === "H") return homeTeam;
  if (dir === "A") return awayTeam;
  return null; // draw (no winner)
}

function stagePoints(stage) {
  // Rules:
  // Group stage: Exact score = 3 pts, Winner/Draw direction = 1 pt.
  // Round of 16: 4 and 2. Quarterfinals: 5 and 3. Semifinals: 8 and 4. Finals: 10 and 5.
  switch (stage) {
    case "GROUP":
      return { exact: 3, direction: 1 };
    case "ROUND_OF_16":
      return { exact: 4, direction: 2 };
    case "QUARTERFINALS":
      return { exact: 5, direction: 3 };
    case "SEMIFINALS":
      return { exact: 8, direction: 4 };
    case "FINALS":
      return { exact: 10, direction: 5 };
    default:
      throw new Error(`Unknown stage: ${stage}`);
  }
}

function calcMatchPoints(match, prediction) {
  if (!match.actual) throw new Error(`Match ${match.id} has no actual result`);

  const { exact, direction: dirPts } = stagePoints(match.stage);
  const pts = { exact: 0, direction: 0, total: 0 };

  const ah = match.actual.homeGoals;
  const aa = match.actual.awayGoals;
  const ph = prediction.homeGoals;
  const pa = prediction.awayGoals;

  const exactMatch = ph === ah && pa === aa;
  const dirMatch = direction(ph, pa) === direction(ah, aa);

  if (exactMatch) pts.exact += exact;
  if (dirMatch) pts.direction += dirPts;

  pts.total = pts.exact + pts.direction;
  return pts;
}

function calcMacroPoints(tournamentActual, macroPrediction) {
  const topScorerOk = tournamentActual.topScorers.includes(macroPrediction.topScorer);
  const winnerOk = tournamentActual.winner === macroPrediction.winner;
  // Macro bets:
  // - Top scorer correct = 10 pts
  // - Tournament winner correct = 10 pts
  // Awarded independently (0/10/20).
  const topScorerPoints = topScorerOk ? 10 : 0;
  const winnerPoints = winnerOk ? 10 : 0;
  return { topScorerOk, winnerOk, topScorerPoints, winnerPoints, total: topScorerPoints + winnerPoints };
}

function randIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function scoreAroundFavorite({
  predictedOutcome,
  homeBase,
  awayBase,
}) {
  // Small randomness around a baseline, biased toward the favorite outcome.
  let homeGoals = homeBase + randIntInclusive(-1, 1);
  let awayGoals = awayBase + randIntInclusive(-1, 1);

  // Enforce the favorite outcome more often than not.
  if (predictedOutcome === "HOME_WIN") {
    if (homeGoals <= awayGoals) homeGoals = awayGoals + randIntInclusive(1, 2);
  } else if (predictedOutcome === "AWAY_WIN") {
    if (awayGoals <= homeGoals) awayGoals = homeGoals + randIntInclusive(1, 2);
  } else if (predictedOutcome === "DRAW") {
    // Prefer low-scoring draws.
    homeGoals = randIntInclusive(0, 2);
    awayGoals = homeGoals;
  }

  // Ensure integer goals.
  homeGoals = Math.round(homeGoals);
  awayGoals = Math.round(awayGoals);

  // Clamp for nicer numbers.
  homeGoals = Math.max(0, Math.min(7, homeGoals));
  awayGoals = Math.max(0, Math.min(7, awayGoals));

  return { homeGoals, awayGoals };
}

function botPlaceMatchPrediction(botName, match, lockTimeMs) {
  // Both bots place predictions right before lock.
  // Monkey: random scores.
  // Wise Owl: choose the favorite based on hardcoded odds (decimal odds).
  const stage = match.stage;

  if (botName === BOT_MONKEY) {
    const max = stage === "GROUP" ? 5 : 6;
    const homeGoals = randIntInclusive(0, max);
    const awayGoals = randIntInclusive(0, max);
    return { homeGoals, awayGoals, lockTimeMs };
  }

  if (botName === BOT_OWL) {
    const { homeWin, draw, awayWin } = match.odds;

    // Favorite = smallest odds => highest implied probability.
    const minOdd = Math.min(homeWin, draw, awayWin);
    let predictedOutcome;
    if (minOdd === homeWin) predictedOutcome = "HOME_WIN";
    else if (minOdd === awayWin) predictedOutcome = "AWAY_WIN";
    else predictedOutcome = "DRAW";

    // Baseline score based on stage (roughly: later rounds are slightly higher scoring).
    const base = stage === "GROUP" ? 1 : stage === "ROUND_OF_16" ? 2 : stage === "QUARTERFINALS" ? 2 : stage === "SEMIFINALS" ? 3 : 3;
    const homeBase = predictedOutcome === "HOME_WIN" ? base + 1 : base;
    const awayBase = predictedOutcome === "AWAY_WIN" ? base + 1 : base;

    const score = scoreAroundFavorite({
      favoriteIsHome: predictedOutcome === "HOME_WIN",
      predictedOutcome,
      homeBase,
      awayBase,
    });

    return { homeGoals: score.homeGoals, awayGoals: score.awayGoals, lockTimeMs };
  }

  throw new Error(`Unknown bot: ${botName}`);
}

function botPlaceMacroPrediction(botName, tournamentActualIfKnown, odds) {
  // For demo: Wise Owl uses hardcoded tournament odds; Monkey random.
  if (botName === BOT_OWL) {
    const winner = Object.entries(odds.tournamentWinnerOdds).sort((a, b) => a[1] - b[1])[0][0]; // smallest odds = favorite
    const topScorer = Object.entries(odds.topScorerOdds).sort((a, b) => a[1] - b[1])[0][0];
    return { winner, topScorer };
  }

  // Monkey: random pick among teams and among possible top scorers.
  const winnerTeams = Object.keys(odds.tournamentWinnerOdds);
  const topScorerPlayers = Object.keys(odds.topScorerOdds);
  return {
    winner: winnerTeams[randIntInclusive(0, winnerTeams.length - 1)],
    topScorer: topScorerPlayers[randIntInclusive(0, topScorerPlayers.length - 1)],
  };
}

function buildTournamentMatches() {
  // Match data: 4 real Group Stage matches (מחזור 1), with Hebrew country names.
  // OfficialKickoffISO is used only for display; lockAt/finishedAt are compressed for local play.
  const base = nowMs();
  const kickoffIn = (minsFromNow) => base + minsFromNow * DEMO_MINUTE_MS;
  const lockForKickoff = (kickoffAt) => kickoffAt - FIVE_MIN_BEFORE_LOCK_MS;
  const finishedAtForKickoff = (kickoffAt) => kickoffAt + MATCH_DURATION_MINUTES * DEMO_MINUTE_MS;

  const finished = (homeGoals, awayGoals, goalEvents = []) => ({ homeGoals, awayGoals, goalEvents });

  const fixtures = [
    {
      id: "M1",
      stageDisplay: "שלב הבתים - מחזור 1",
      homeTeam: "ארגנטינה",
      awayTeam: "ערב הסעודית",
      officialKickoffISO: "2022-11-22T10:00:00Z",
      kickoffAt: kickoffIn(8),
      actual: finished(1, 2, [
        { player: "Lionel Messi", team: "Argentina", goals: 1 },
        { player: "Saleh Al-Shehri", team: "Saudi Arabia", goals: 1 },
        { player: "Salem Al-Dawsari", team: "Saudi Arabia", goals: 1 },
      ]),
      odds: { homeWin: 1.2, draw: 6.0, awayWin: 12.0 },
    },
    {
      id: "M2",
      stageDisplay: "שלב הבתים - מחזור 1",
      homeTeam: "צרפת",
      awayTeam: "אוסטרליה",
      officialKickoffISO: "2022-11-22T19:00:00Z",
      kickoffAt: kickoffIn(16),
      actual: finished(4, 1, [
        { player: "Olivier Giroud", team: "France", goals: 2 },
        { player: "Kylian Mbappé", team: "France", goals: 1 },
        { player: "Adrien Rabiot", team: "France", goals: 1 },
        { player: "Craig Goodwin", team: "Australia", goals: 1 },
      ]),
      odds: { homeWin: 1.4, draw: 4.4, awayWin: 8.5 },
    },
    {
      id: "M3",
      stageDisplay: "שלב הבתים - מחזור 1",
      homeTeam: "ברזיל",
      awayTeam: "סרביה",
      officialKickoffISO: "2022-11-24T19:00:00Z",
      kickoffAt: kickoffIn(24),
      actual: finished(2, 0, [
        { player: "Richarlison", team: "Brazil", goals: 1 },
        { player: "Casemiro", team: "Brazil", goals: 1 },
      ]),
      odds: { homeWin: 1.8, draw: 3.6, awayWin: 5.0 },
    },
    {
      id: "M4",
      stageDisplay: "שלב הבתים - מחזור 1",
      homeTeam: "ספרד",
      awayTeam: "קוסטה ריקה",
      officialKickoffISO: "2022-11-23T16:00:00Z",
      kickoffAt: kickoffIn(32),
      actual: finished(7, 0, [
        { player: "Dani Olmo", team: "Spain", goals: 1 },
        { player: "Marco Asensio", team: "Spain", goals: 1 },
        { player: "Ferran Torres", team: "Spain", goals: 2 },
        { player: "Gavi", team: "Spain", goals: 1 },
        { player: "Álvaro Morata", team: "Spain", goals: 1 },
        { player: "Carlos Soler", team: "Spain", goals: 1 },
      ]),
      odds: { homeWin: 1.25, draw: 5.0, awayWin: 10.0 },
    },
  ];

  return fixtures.map((m) => ({
    ...m,
    stage: "GROUP",
    lockAt: lockForKickoff(m.kickoffAt),
    finishedAt: finishedAtForKickoff(m.kickoffAt),
  }));
}

function calcTournamentActual(matches) {
  // Winner = winner of finals match.
  const finals = matches.find((m) => m.stage === "FINALS");
  const winner = finals ? winnerTeam(finals.homeTeam, finals.awayTeam, finals.actual.homeGoals, finals.actual.awayGoals) : null;

  // Top scorer = player with most goals across all finished matches.
  // (In this demo, all matches have an actual result; in a real system you'd filter by time.)
  const goalByPlayer = new Map();
  for (const match of matches) {
    if (!match.actual || !match.actual.goalEvents) continue;
    for (const ev of match.actual.goalEvents) {
      goalByPlayer.set(ev.player, (goalByPlayer.get(ev.player) || 0) + ev.goals);
    }
  }

  let max = -Infinity;
  for (const v of goalByPlayer.values()) max = Math.max(max, v);
  const topScorers = [];
  for (const [player, v] of goalByPlayer.entries()) {
    if (v === max) topScorers.push(player);
  }

  return { winner, topScorers };
}

function prettyScore(pred) {
  return `${pred.homeGoals}-${pred.awayGoals}`;
}

async function run() {
  const start = nowMs();
  console.log(`[engine] Booting at ${fmtTime(start)}`);

  matches = buildTournamentMatches();
  tournamentActual = calcTournamentActual(matches);

  tournamentOdds = {
    tournamentWinnerOdds: {
      ארגנטינה: 6.0,
      ברזיל: 5.5,
      צרפת: 6.5,
      ספרד: 7.5,
    },
    topScorerOdds: {
      "Ferran Torres": 1.6,
      "Olivier Giroud": 1.8,
      "Lionel Messi": 2.8,
      "Kylian Mbappé": 3.1,
    },
  };

  // Bot predictions:
  // matchesById[matchId].predictions[botName] = {homeGoals, awayGoals, lockTimeMs}
  const matchesById = new Map(matches.map((m) => [m.id, m]));
  for (const m of matchesById.values()) m.predictions = Object.create(null);

  // Macro predictions (placed once at boot for demo).
  for (const botName of botNames) {
    macroPredictions[botName] = botPlaceMacroPrediction(botName, tournamentActual, tournamentOdds);
  }
  console.log(`[engine] Macro bets placed:`);
  for (const botName of botNames) {
    const mp = macroPredictions[botName];
    console.log(`  - ${botName}: top scorer = ${mp.topScorer}, winner = ${mp.winner}`);
  }

  const totals = {};
  for (const botName of botNames) totals[botName] = { total: 0, exact: 0, direction: 0, macro: 0 };

  function awardBotPoints(botName, ptsObj, macroPtsObj) {
    totals[botName].exact += ptsObj?.exact ?? 0;
    totals[botName].direction += ptsObj?.direction ?? 0;
    totals[botName].total += ptsObj?.total ?? 0;
    if (macroPtsObj) {
      totals[botName].macro += macroPtsObj.total;
      totals[botName].total += macroPtsObj.total;
    }
  }

  // Schedule bot placements and match evaluations.
  for (const match of matches) {
    // Place predictions exactly 5 sim minutes before match lock.
    const placementTime = match.lockAt - FIVE_MIN_BEFORE_LOCK_MS;

    for (const botName of botNames) {
      const delayPlace = Math.max(0, placementTime - nowMs());
      setTimeout(() => {
        const lockTimeMs = match.lockAt;
        const pred = botPlaceMatchPrediction(botName, match, lockTimeMs);
        match.predictions[botName] = pred;
        const when = fmtTime(nowMs());
        console.log(
          `[${when}] ${botName} placed prediction for ${match.id} (${match.stage.replaceAll("_", " ").toLowerCase()}): ${match.homeTeam} vs ${match.awayTeam} => ${prettyScore(pred)}`
        );
      }, delayPlace);
    }

    // Evaluate when the match is finished.
    const delayEval = Math.max(0, match.finishedAt - nowMs());
    setTimeout(() => {
      const when = fmtTime(nowMs());
      console.log(`\n[${when}] Match finished: ${match.id} (${match.stage.replaceAll("_", " ").toLowerCase()}) ${match.homeTeam} ${match.actual.homeGoals}-${match.actual.awayGoals} ${match.awayTeam}`);

      for (const botName of botNames) {
        const pred = match.predictions[botName];
        if (!pred) {
          console.log(`  - ${botName}: no prediction found (0 pts)`);
          continue;
        }
        const pts = calcMatchPoints(match, pred);
        awardBotPoints(botName, pts, null);
        console.log(`  - ${botName}: predicted ${prettyScore(pred)} => exact=${pts.exact}, direction=${pts.direction}, total=${pts.total}`);
      }
    }, delayEval);
  }

  // Schedule tournament end after the last match is done.
  const lastFinishedAt = Math.max(...matches.map((m) => m.finishedAt));
  const delayEnd = Math.max(0, lastFinishedAt - nowMs()) + 800;
  setTimeout(() => {
    console.log(`\n[engine] Tournament ended. Actual results:`);
    console.log(`  - Winner: ${tournamentActual.winner}`);
    console.log(`  - Top scorers (${tournamentActual.topScorers.length}): ${tournamentActual.topScorers.join(", ")}`);

    for (const botName of botNames) {
      const macroPts = calcMacroPoints(tournamentActual, macroPredictions[botName]);
      awardBotPoints(botName, null, macroPts);
      const mp = macroPredictions[botName];
      console.log(
        `\n[macro] ${botName}: predicted top scorer=${mp.topScorer} winner=${mp.winner} => winnerOk=${macroPts.winnerOk} topScorerOk=${macroPts.topScorerOk} => macro total=${macroPts.total}`
      );
    }

    console.log(`\n[leaderboard]`);
    const ranking = botNames
      .map((b) => ({ bot: b, total: totals[b].total, exact: totals[b].exact, direction: totals[b].direction, macro: totals[b].macro }))
      .sort((a, b) => b.total - a.total);

    for (const row of ranking) {
      console.log(`  - ${row.bot}: total=${row.total} (exact=${row.exact}, direction=${row.direction}, macro=${row.macro})`);
    }
    console.log(`\n[engine] Done at ${fmtTime(nowMs())}.\n`);
  }, delayEnd);

  // Keep the process alive until end.
  const endWaitMs = delayEnd + 2000;
  await sleepMs(endWaitMs);
}

// ---- Simple API helpers (used by Express routes) ----

function computeLeaderboard() {
  if (!matches.length) return [];

  const participantNames = new Set();
  for (const m of matches) {
    if (!m.predictions) continue;
    for (const name of Object.keys(m.predictions)) {
      participantNames.add(name);
    }
  }

  const rows = [];
  for (const name of participantNames) {
    let exact = 0;
    let directionPts = 0;
    let macro = 0;

    for (const m of matches) {
      if (!m.actual || !m.predictions || !m.predictions[name]) continue;
      const pts = calcMatchPoints(m, m.predictions[name]);
      exact += pts.exact;
      directionPts += pts.direction;
    }

    if (macroPredictions[name] && tournamentActual) {
      const macroPts = calcMacroPoints(tournamentActual, macroPredictions[name]);
      macro = macroPts.total;
    }

    const total = exact + directionPts + macro;
    rows.push({
      name,
      exact,
      direction: directionPts,
      macro,
      total,
    });
  }

  rows.sort((a, b) => b.total - a.total);
  return rows;
}

// ---- Express app (serves API + static frontend) ----

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Get all matches (used by frontend to render Match Center).
app.get("/api/matches", (req, res) => {
  res.json({
    now: nowMs(),
    matches,
  });
});

// Submit / update a single score prediction.
app.post("/api/predictions", (req, res) => {
  const { userName, matchId, homeGoals, awayGoals } = req.body || {};

  if (!userName || !matchId || homeGoals === undefined || awayGoals === undefined) {
    return res.status(400).json({ error: "userName, matchId, homeGoals, awayGoals are required" });
  }

  const match = matches.find((m) => m.id === matchId);
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  if (nowMs() > match.lockAt) {
    return res.status(403).json({ error: "Predictions are locked for this match" });
  }

  if (!match.predictions) match.predictions = Object.create(null);

  const parsedHome = Number(homeGoals);
  const parsedAway = Number(awayGoals);
  if (!Number.isFinite(parsedHome) || !Number.isFinite(parsedAway) || parsedHome < 0 || parsedAway < 0) {
    return res.status(400).json({ error: "Scores must be non-negative numbers" });
  }

  match.predictions[userName] = {
    homeGoals: parsedHome,
    awayGoals: parsedAway,
    lockTimeMs: match.lockAt,
  };

  const leaderboard = computeLeaderboard();
  res.json({ ok: true, leaderboard });
});

// Get current leaderboard (used by Live Leaderboard widget).
app.get("/api/leaderboard", (req, res) => {
  res.json({ leaderboard: computeLeaderboard() });
});

app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  // Start the background simulation once the HTTP server is up.
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
});

