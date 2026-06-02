/**
 * mock-api-server.cjs — TikiTaka WC2026
 * ─────────────────────────────────────────────────────────────────────────────
 * Servidor Express que imita exactamente la respuesta de API-Football v3
 * (v3.football.api-sports.io) para pruebas de bridge.js en modo API_MODE=test.
 *
 * Endpoint principal:
 *   GET /fixtures?league=1&season=2026[&id=<fixture_id>][&compress=15min|30min|1h|2h|4h]
 *
 * Comportamiento:
 *   - Lee los 104 partidos de Supabase (con JOIN a teams) en tiempo real.
 *   - Si el partido ya tiene score en DB → lo devuelve tal cual (status FT/PEN).
 *   - Si el kickoff ya pasó pero no hay score → genera score aleatorio (cacheado
 *     en memoria para consistencia dentro de la sesión del servidor).
 *   - ?compress=Xmin → redistribuye los kickoff_utc en una ventana comprimida
 *     a partir de NOW (útil para probar el flujo sin esperar fechas reales).
 *   - ?id=<n> → filtra por fixture_id (wc_api_id del partido o match_number+900000).
 *
 * USO:
 *   node mock-api-server.cjs
 *   API_MODE=test node bridge.js          ← bridge.js apunta aquí
 *
 * Variables de entorno (lee jobs/.env o jobs/.env.dev):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   MOCK_PORT (default: 3001)
 */

// ─── Cargar .env ──────────────────────────────────────────────────────────────
const dotenv = require('dotenv');
// Intenta .env primero, luego .env.dev como fallback
const r1 = dotenv.config({ path: '.env' });
if (r1.error || !process.env.SUPABASE_URL) {
  dotenv.config({ path: '.env.dev' });
}

const express     = require('express');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://ruwnxeyrfvuyzddmygkd.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PORT          = parseInt(process.env.MOCK_PORT || '3001', 10);

if (!SUPABASE_KEY) {
  console.error('❌ Falta SUPABASE_SERVICE_KEY en .env o .env.dev');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app      = express();

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Rondas de eliminatoria (empate al 90' → penales) */
const KNOCKOUT_ROUNDS = new Set(['R32', 'R16', 'QF', 'SF', '3rd', 'final']);

/** Tiempo comprimido soportado */
const COMPRESS_MS = {
  '15min': 15 * 60_000,
  '30min': 30 * 60_000,
  '1h':    60 * 60_000,
  '2h':   120 * 60_000,
  '4h':   240 * 60_000,
};

/**
 * Inverso del teamCodeMap de bridge.js.
 * Nuestro código de 3 letras (DB) → nombre exacto que API-Football usa,
 * para que bridge.syncSingleMatchApiId() pueda hacer el match por nombre.
 */
const CODE_TO_API_NAME = {
  MEX: 'Mexico',
  RSA: 'South Africa',
  KOR: 'Korea Republic',
  CZE: 'Czechia',
  CAN: 'Canada',
  BIH: 'Bosnia and Herzegovina',
  QAT: 'Qatar',
  SUI: 'Switzerland',
  BRA: 'Brazil',
  MAR: 'Morocco',
  HAI: 'Haiti',
  SCO: 'Scotland',
  USA: 'USA',
  PAR: 'Paraguay',
  AUS: 'Australia',
  TUR: 'Turkey',
  GER: 'Germany',
  CUW: 'Curaçao',
  CIV: "Côte d'Ivoire",
  ECU: 'Ecuador',
  NED: 'Netherlands',
  JPN: 'Japan',
  SWE: 'Sweden',
  TUN: 'Tunisia',
  BEL: 'Belgium',
  EGY: 'Egypt',
  IRN: 'IR Iran',
  NZL: 'New Zealand',
  ESP: 'Spain',
  CPV: 'Cape Verde',
  KSA: 'Saudi Arabia',
  URU: 'Uruguay',
  FRA: 'France',
  SEN: 'Senegal',
  IRQ: 'Iraq',
  NOR: 'Norway',
  ARG: 'Argentina',
  ALG: 'Algeria',
  AUT: 'Austria',
  JOR: 'Jordan',
  POR: 'Portugal',
  COD: 'DR Congo',
  UZB: 'Uzbekistan',
  COL: 'Colombia',
  ENG: 'England',
  CRO: 'Croatia',
  GHA: 'Ghana',
  PAN: 'Panama',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const randScore = () => Math.floor(Math.random() * 5); // 0..4

/**
 * Genera un fixture_id ficticio pero determinista para un partido.
 * Se usa cuando el partido aún no tiene wc_api_id en la BD.
 * bridge.js almacenará este ID vía syncSingleMatchApiId().
 */
const fakeFixtureId = (matchNumber) => 900000 + matchNumber;

// ─── Cache de scores en memoria ───────────────────────────────────────────────
// Garantiza que dentro de la misma sesión del servidor el score no cambia.
// Formato: { [matchNumber]: { hs, as, hp, ap, statusShort } }
const scoreCache = new Map();

/**
 * Devuelve el score para un partido cuyo kickoff ya pasó pero no tiene
 * resultado en la BD. Genera y cachea de forma determinista.
 */
function getOrGenerateScore(matchNumber, round) {
  if (scoreCache.has(matchNumber)) {
    return scoreCache.get(matchNumber);
  }

  const hs = randScore();
  const as = randScore();
  let hp = null;
  let ap = null;
  let statusShort = 'FT';

  if (KNOCKOUT_ROUNDS.has(round) && hs === as) {
    hp = Math.floor(Math.random() * 3) + 3; // 3..5
    ap = Math.floor(Math.random() * 3) + 3; // 3..5
    if (hp === ap) {
      Math.random() < 0.5 ? hp++ : ap++;
    }
    statusShort = 'PEN';
  }

  const result = { hs, as, hp, ap, statusShort };
  scoreCache.set(matchNumber, result);
  return result;
}

// ─── Cache de kickoffs comprimidos ────────────────────────────────────────────
// Se regenera si cambia el param compress o pasan más de 10 segundos.
let compressCache = { param: null, ts: 0, map: null };

/**
 * Redistribuye los kickoff_utc de todos los partidos en una ventana comprimida
 * a partir de NOW. Retorna Map<matchId, isoString>.
 */
function buildCompressedKickoffs(matches, compressParam) {
  const now = Date.now();
  // Reusar si el mismo param y < 10s de antigüedad
  if (
    compressCache.param === compressParam &&
    (now - compressCache.ts) < 10_000 &&
    compressCache.map
  ) {
    return compressCache.map;
  }

  const totalMs = COMPRESS_MS[compressParam];
  if (!totalMs) return null;

  // Ordenar por match_number para mantener secuencia lógica
  const sorted = [...matches].sort((a, b) => a.match_number - b.match_number);
  const N = sorted.length;
  const map = new Map();

  sorted.forEach((m, i) => {
    const offset = N === 1 ? 0 : (i / (N - 1)) * totalMs;
    map.set(m.id, new Date(now + offset).toISOString());
  });

  compressCache = { param: compressParam, ts: now, map };
  return map;
}

// ─── Conversión match DB → fixture API-Football ───────────────────────────────

/**
 * Convierte un partido de Supabase al formato exacto de respuesta de API-Football v3.
 * bridge.js accede a:
 *   fixture.fixture.id               → para almacenar wc_api_id
 *   fixture.fixture.status.short     → para determinar estado
 *   fixture.teams.home.name          → para syncSingleMatchApiId por nombre
 *   fixture.teams.away.name
 *   fixture.goals.home               → score
 *   fixture.goals.away
 *   fixture.score.penalty.home       → penales
 *   fixture.score.penalty.away
 */
function matchToFixture(match, kickoffUtc, isSimMode = false, simDurationMin = 15) {
  const kickoffMs = new Date(kickoffUtc).getTime();
  const nowMs     = Date.now();
  const elapsed   = nowMs - kickoffMs; // ms desde kickoff (negativo si futuro)

  const homeCode = match.home_team?.code;
  const awayCode = match.away_team?.code;
  const homeName = CODE_TO_API_NAME[homeCode] || match.home_team?.name || 'TBD';
  const awayName = CODE_TO_API_NAME[awayCode] || match.away_team?.name || 'TBD';

  // Fixture ID: usar wc_api_id de la BD si existe, si no → fake determinista
  const fixtureId = match.wc_api_id
    ? parseInt(match.wc_api_id, 10)
    : fakeFixtureId(match.match_number);

  // ── Determinar status y scores ────────────────────────────────────────────
  let statusShort = 'NS'; // Not Started
  let homeGoals   = null;
  let awayGoals   = null;
  let homePen     = null;
  let awayPen     = null;

  if (match.status === 'finished' || match.home_score !== null) {
    // Resultado ya confirmado en la BD
    homeGoals   = match.home_score;
    awayGoals   = match.away_score;
    homePen     = match.home_penalties ?? null;
    awayPen     = match.away_penalties ?? null;
    statusShort = (homePen !== null || awayPen !== null) ? 'PEN' : 'FT';

  } else if (elapsed >= 0) {
    // Kickoff pasado sin resultado en BD
    // Entre kickoff y fin del partido → partido en curso (Live)
    // En modo simulación escalamos 110 minutos de forma proporcional (15 minutos = ~2.3 segundos)
    const inPlayWindowMs = isSimMode
      ? Math.max(2000, (110 * 60_000) * (simDurationMin / 43200))
      : 110 * 60_000;

    const inPlay = elapsed <= inPlayWindowMs;
    if (inPlay) {
      // Simular minuto aproximado para que se vea realista
      const minuteElapsed = Math.min(Math.floor(elapsed / 60_000), 90);
      statusShort = minuteElapsed <= 45 ? '1H' : minuteElapsed === 45 ? 'HT' : '2H';
      // Sin score visible en vivo (igual que la API real en muchas peticiones)
      homeGoals = null;
      awayGoals = null;
    } else {
      // Más allá de la duración del partido → terminado
      const r = getOrGenerateScore(match.match_number, match.round);
      statusShort = r.statusShort;
      homeGoals   = r.hs;
      awayGoals   = r.as;
      homePen     = r.hp;
      awayPen     = r.ap;
    }
  }
  // else: futuro → NS, sin scores

  // ── Construir respuesta con estructura exacta de API-Football v3 ──────────
  return {
    fixture: {
      id:        fixtureId,
      referee:   null,
      timezone:  'UTC',
      date:      kickoffUtc,
      timestamp: Math.floor(new Date(kickoffUtc).getTime() / 1000),
      periods: { first: null, second: null },
      venue: { id: null, name: `Stadium ${match.match_number}`, city: null },
      status: {
        long:    statusShort === 'NS'  ? 'Not Started'
               : statusShort === 'FT'  ? 'Match Finished'
               : statusShort === 'PEN' ? 'Penalty In Progress'
               : statusShort === 'AET' ? 'Match Finished (AET)'
               : statusShort === 'HT'  ? 'Half Time'
               : 'First Half',
        short:   statusShort,
        elapsed: statusShort === '1H' || statusShort === '2H'
                   ? Math.min(Math.floor(elapsed / 60_000), 90)
                   : null,
      },
    },
    league: {
      id:      1,
      name:    'World Cup',
      country: 'World',
      logo:    null,
      flag:    null,
      season:  2026,
      round:   match.round === 'group'
                 ? `Group Stage - Matchday ${match.match_number}`
                 : match.round,
    },
    teams: {
      home: {
        id:     match.home_team?.id ? match.home_team.id : null,
        name:   homeName,
        logo:   null,
        winner: homeGoals !== null && awayGoals !== null
                  ? (homeGoals > awayGoals ? true : homeGoals < awayGoals ? false : null)
                  : null,
      },
      away: {
        id:     match.away_team?.id ? match.away_team.id : null,
        name:   awayName,
        logo:   null,
        winner: homeGoals !== null && awayGoals !== null
                  ? (awayGoals > homeGoals ? true : awayGoals < homeGoals ? false : null)
                  : null,
      },
    },
    goals: {
      home: homeGoals,
      away: awayGoals,
    },
    score: {
      halftime:  { home: null, away: null },
      fulltime:  { home: homeGoals, away: awayGoals },
      extratime: { home: null, away: null },
      penalty: {
        home: homePen,
        away: awayPen,
      },
    },
  };
}

// ─── Endpoint principal ───────────────────────────────────────────────────────

app.get('/fixtures', async (req, res) => {
  const startMs = Date.now();

  try {
    const { id: fixtureIdParam, compress } = req.query;

    // 1. Leer todos los partidos de Supabase con datos de equipos y también app_config en paralelo
    const [matchesRes, configRes] = await Promise.all([
      supabase
        .from('matches')
        .select(`
          id, match_number, round, group_name,
          kickoff_utc, status,
          home_score, away_score, home_penalties, away_penalties,
          wc_api_id,
          home_team:teams!home_team_id(id, name, code),
          away_team:teams!away_team_id(id, code, name)
        `)
        .order('match_number', { ascending: true }),
      supabase.from('app_config').select('key, value')
    ]);

    if (matchesRes.error) {
      console.error('[mock] ❌ Error al leer partidos de Supabase:', matchesRes.error.message);
      return res.status(500).json({
        get: 'fixtures', parameters: req.query,
        errors: { supabase: matchesRes.error.message }, results: 0,
        paging: { current: 1, total: 1 }, response: [],
      });
    }

    const matches = matchesRes.data || [];
    const config = configRes.data || [];

    // Detectar si el torneo está en modo simulación y cuál es su duración
    const isSimMode = config.find(c => c.key === 'simulation_mode')?.value === 'true';
    const simDurationMin = parseInt(config.find(c => c.key === 'simulation_duration_minutes')?.value || '15', 10);

    // 2. Aplicar compresión de kickoffs si se solicita
    let kickoffMap = null;
    if (compress && COMPRESS_MS[compress]) {
      kickoffMap = buildCompressedKickoffs(matches, compress);
      console.log(`[mock] 🗜️  Compress=${compress} → ${matches.length} kickoffs redistribuidos desde NOW`);
    } else if (compress) {
      console.warn(`[mock] ⚠️  compress="${compress}" inválido. Valores válidos: ${Object.keys(COMPRESS_MS).join(', ')}`);
    }

    // 3. Filtrar por fixture ID si se proporciona (?id=...)
    let filtered = matches;
    if (fixtureIdParam) {
      const targetId = parseInt(fixtureIdParam, 10);
      filtered = matches.filter(m =>
        // Coincide si el wc_api_id real coincide
        (m.wc_api_id && parseInt(m.wc_api_id, 10) === targetId) ||
        // O si el fake ID generado coincide
        fakeFixtureId(m.match_number) === targetId
      );

      if (filtered.length === 0) {
        console.warn(`[mock] ⚠️  No se encontró partido con fixture_id=${fixtureIdParam}`);
      }
    }

    // 4. Convertir al formato API-Football v3
    const response = filtered.map(m => {
      const kickoffUtc = kickoffMap ? kickoffMap.get(m.id) : m.kickoff_utc;
      return matchToFixture(m, kickoffUtc || m.kickoff_utc, isSimMode, simDurationMin);
    });

    const elapsed = Date.now() - startMs;
    console.log(
      `[mock] GET /fixtures?${new URLSearchParams(req.query)} → ${response.length} fixtures (${elapsed}ms)`
    );

    // 5. Respuesta con envoltorio exacto de API-Football
    res.json({
      get:        'fixtures',
      parameters: {
        league: req.query.league || '1',
        season: req.query.season || '2026',
        ...(fixtureIdParam && { id: fixtureIdParam }),
      },
      errors:  [],
      results: response.length,
      paging:  { current: 1, total: 1 },
      response,
    });

  } catch (err) {
    console.error('[mock] ❌ Error inesperado:', err.message);
    res.status(500).json({
      get: 'fixtures', parameters: req.query,
      errors: [err.message], results: 0,
      paging: { current: 1, total: 1 }, response: [],
    });
  }
});

// ─── Endpoint de estado ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    server:    'TikiTaka Mock API-Football v3',
    port:      PORT,
    supabase:  SUPABASE_URL,
    cached_scores: scoreCache.size,
    timestamp: new Date().toISOString(),
  });
});

// ─── Endpoint de reset de cache (útil en pruebas) ─────────────────────────────
app.delete('/cache', (_req, res) => {
  const n = scoreCache.size;
  scoreCache.clear();
  compressCache = { param: null, ts: 0, map: null };
  console.log(`[mock] 🗑️  Cache reseteado (${n} scores eliminados)`);
  res.json({ cleared: n });
});

// ─── Arranque ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  TikiTaka — Mock API-Football v3 Server               ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\n🏟️  Escuchando en http://localhost:${PORT}`);
  console.log(`   Supabase: ${SUPABASE_URL}`);
  console.log('\n📋 Endpoints disponibles:');
  console.log(`   GET  /fixtures                       → todos los partidos`);
  console.log(`   GET  /fixtures?id=<fixture_id>       → partido específico`);
  console.log(`   GET  /fixtures?compress=15min|30min|1h|2h|4h  → kickoffs comprimidos`);
  console.log(`   GET  /health                         → estado del servidor`);
  console.log(`   DELETE /cache                        → resetear cache de scores`);
  console.log('\n🔗 Para usar con bridge.js:');
  console.log('   API_MODE=test node bridge.js');
  console.log('   API_MODE=test node bridge.js start 15\n');
});
