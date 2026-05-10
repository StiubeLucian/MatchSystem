const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'tournament.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sseClients = new Set();

function getState() {
  if (!fs.existsSync(DATA_FILE)) {
    return { phase: 'setup', teams: [], matches: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { phase: 'setup', teams: [], matches: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  const payload = JSON.stringify(enrichState(state));
  sseClients.forEach(res => {
    try { res.write(`data: ${payload}\n\n`); } catch {}
  });
}

function calcStandings(state) {
  const standings = state.teams.map(t => ({
    teamId: t.id, name: t.name,
    played: 0, wins: 0, losses: 0,
    roundWins: 0, roundLosses: 0, points: 0
  }));

  const doneGroupMatches = state.matches.filter(m => m.phase === 'group' && m.status === 'done');
  for (const m of doneGroupMatches) {
    const s1 = standings.find(s => s.teamId === m.team1Id);
    const s2 = standings.find(s => s.teamId === m.team2Id);
    if (!s1 || !s2) continue;
    s1.played++; s2.played++;
    s1.roundWins += m.score1; s1.roundLosses += m.score2;
    s2.roundWins += m.score2; s2.roundLosses += m.score1;
    if (m.winner === m.team1Id) { s1.wins++; s1.points++; s2.losses++; }
    else                         { s2.wins++; s2.points++; s1.losses++; }
  }

  standings.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const aDiff = a.roundWins - a.roundLosses;
    const bDiff = b.roundWins - b.roundLosses;
    if (bDiff !== aDiff) return bDiff - aDiff;
    return b.roundWins - a.roundWins;
  });

  return standings;
}

function calcFinalResults(state) {
  const finalMatch  = state.matches.find(m => m.phase === 'final'       && m.status === 'done');
  const thirdMatch  = state.matches.find(m => m.phase === 'third_place' && m.status === 'done');
  if (!finalMatch || !thirdMatch) return null;

  const getTeam = id => state.teams.find(t => t.id === id);
  const loser = m => m.winner === m.team1Id ? m.team2Id : m.team1Id;

  return [
    { place: 1, team: getTeam(finalMatch.winner) },
    { place: 2, team: getTeam(loser(finalMatch)) },
    { place: 3, team: getTeam(thirdMatch.winner) },
    { place: 4, team: getTeam(loser(thirdMatch)) }
  ];
}

function enrichState(state) {
  const standings = calcStandings(state);
  const finalResults = calcFinalResults(state);
  return { ...state, standings, finalResults };
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/view', (_, res) => res.sendFile(path.join(__dirname, 'public', 'viewer.html')));

app.get('/api/state', (_, res) => res.json(enrichState(getState())));

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  res.write(`data: ${JSON.stringify(enrichState(getState()))}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

// ── Teams ────────────────────────────────────────────────────────────────────

app.post('/api/teams', (req, res) => {
  const state = getState();
  if (state.phase !== 'setup') return res.status(400).json({ error: 'Not in setup phase' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Team name required' });
  if (state.teams.some(t => t.name.toLowerCase() === name.toLowerCase()))
    return res.status(400).json({ error: 'Team name already exists' });

  const team = { id: randomUUID(), name };
  state.teams.push(team);
  saveState(state);
  res.json(team);
});

app.delete('/api/teams/:id', (req, res) => {
  const state = getState();
  if (state.phase !== 'setup') return res.status(400).json({ error: 'Not in setup phase' });
  state.teams = state.teams.filter(t => t.id !== req.params.id);
  saveState(state);
  res.json({ ok: true });
});

// ── Tournament lifecycle ─────────────────────────────────────────────────────

app.post('/api/start-group', (req, res) => {
  const state = getState();
  if (state.phase !== 'setup') return res.status(400).json({ error: 'Not in setup phase' });
  if (state.teams.length < 4) return res.status(400).json({ error: 'Need at least 4 teams' });

  const matches = [];
  const teams = state.teams;
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      matches.push({
        id: randomUUID(), phase: 'group', label: null,
        team1Id: teams[i].id, team2Id: teams[j].id,
        rounds: [], score1: 0, score2: 0,
        status: 'pending', winner: null
      });
    }
  }

  state.matches = matches;
  state.phase = 'group';
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/start-playoffs', (req, res) => {
  const state = getState();
  if (state.phase !== 'group') return res.status(400).json({ error: 'Not in group phase' });
  const pending = state.matches.filter(m => m.phase === 'group' && m.status !== 'done');
  if (pending.length) return res.status(400).json({ error: `${pending.length} group match(es) not finished` });

  const top4 = calcStandings(state).slice(0, 4);

  const makeMatch = (phase, label, t1, t2) => ({
    id: randomUUID(), phase, label,
    team1Id: t1, team2Id: t2,
    rounds: [], score1: 0, score2: 0,
    status: 'pending', winner: null
  });

  state.matches.push(
    makeMatch('semifinal', 'Semifinal 1 (1st vs 4th)', top4[0].teamId, top4[3].teamId),
    makeMatch('semifinal', 'Semifinal 2 (2nd vs 3rd)', top4[1].teamId, top4[2].teamId)
  );
  state.phase = 'playoffs';
  state.playoffSeeds = top4.map((s, i) => ({ teamId: s.teamId, seed: i + 1 }));
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/generate-finals', (req, res) => {
  const state = getState();
  const semis = state.matches.filter(m => m.phase === 'semifinal');
  if (semis.length < 2 || semis.some(m => m.status !== 'done'))
    return res.status(400).json({ error: 'Semifinals not complete' });

  const loser = m => m.winner === m.team1Id ? m.team2Id : m.team1Id;
  const makeMatch = (phase, label, t1, t2) => ({
    id: randomUUID(), phase, label,
    team1Id: t1, team2Id: t2,
    rounds: [], score1: 0, score2: 0,
    status: 'pending', winner: null
  });

  state.matches.push(
    makeMatch('third_place', '3rd Place Match',    loser(semis[0]), loser(semis[1])),
    makeMatch('final',       'Grand Final',        semis[0].winner, semis[1].winner)
  );
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/complete', (req, res) => {
  const state = getState();
  const finalDone = state.matches.find(m => m.phase === 'final' && m.status === 'done');
  const thirdDone = state.matches.find(m => m.phase === 'third_place' && m.status === 'done');
  if (!finalDone || !thirdDone) return res.status(400).json({ error: 'Finals not complete' });
  state.phase = 'complete';
  saveState(state);
  res.json({ ok: true });
});

// ── Match actions ────────────────────────────────────────────────────────────

app.put('/api/matches/:id/play', (req, res) => {
  const state = getState();
  const match = state.matches.find(m => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.status !== 'pending') return res.status(400).json({ error: 'Match not pending' });
  const playing = state.matches.find(m => m.status === 'playing');
  if (playing) return res.status(400).json({ error: 'Another match is already playing' });

  match.status = 'playing';
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/matches/:id/round', (req, res) => {
  const state = getState();
  const match = state.matches.find(m => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.status !== 'playing') return res.status(400).json({ error: 'Match not in play' });

  const { winner } = req.body;
  if (!['team1', 'team2'].includes(winner)) return res.status(400).json({ error: 'Invalid winner' });

  match.rounds.push({ winner });
  if (winner === 'team1') match.score1++; else match.score2++;

  if (match.score1 === 2 || match.score2 === 2) {
    match.status = 'done';
    match.winner = match.score1 === 2 ? match.team1Id : match.team2Id;

    const allDone = state.matches.filter(m => m.phase === 'final' && m.status === 'done').length > 0 &&
                    state.matches.filter(m => m.phase === 'third_place' && m.status === 'done').length > 0;
    if (allDone) state.phase = 'complete';
  }

  saveState(state);
  res.json(match);
});

app.post('/api/matches/:id/undo', (req, res) => {
  const state = getState();
  const match = state.matches.find(m => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.status !== 'playing' || match.rounds.length === 0)
    return res.status(400).json({ error: 'Nothing to undo' });

  const last = match.rounds.pop();
  if (last.winner === 'team1') match.score1--; else match.score2--;
  saveState(state);
  res.json(match);
});

app.post('/api/reset', (_, res) => {
  saveState({ phase: 'setup', teams: [], matches: [] });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n🤖 ZEM Sumo Tournament`);
  console.log(`   Organizer → http://localhost:${PORT}/`);
  console.log(`   Viewer    → http://localhost:${PORT}/view\n`);
});
