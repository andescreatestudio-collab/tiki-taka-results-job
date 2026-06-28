/**
 * bridge.js — TikiTaka WC2026
 * ─────────────────────────────────────────────────────────────────────────────
 * Sistema unificado de resultados. Reemplaza results-job.js y simulate-results.cjs.
 *
 * MODOS:
 *   USE_API = false → Simulación local: genera resultados aleatorios y siembra
 *                     la siguiente ronda automáticamente de forma secuencial.
 *   USE_API = true  → API real: consulta API-Football (https://v3.football.api-sports.io)
 *                     con lógica de reintentos (T+15, T+110, T+140, T+155 min).
 *
 * FLUJO SECUENCIAL DE RONDAS:
 *   group → R32 → R16 → QF → SF → 3rd + final
 *   Cada ronda espera que la anterior esté 100% finished antes de sembrar la siguiente.
 *
 * USO:
 *   node bridge.js
 *
 * Variables de entorno requeridas en jobs/.env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, API_FOOTBALL_KEY
 *
 * Dependencias (solo estas dos):
 *   @supabase/supabase-js, node-cron
 */

import 'dotenv/config';
import { createClient }  from '@supabase/supabase-js';
import cron              from 'node-cron';
import fetch             from 'node-fetch';

// ─── SWITCH PRINCIPAL ─────────────────────────────────────────────────────────
/**
 * API_MODE (variable de entorno):
 *   'test' → Usa el mock server local (mock-api-server.cjs en localhost:3001).
 *            Ideal para probar el flujo completo de API sin consumir cuota real.
 *   'real' → Usa API-Football real (v3.football.api-sports.io). Activar el 11/06/2026.
 *   'sim'  → Modo simulación local: genera scores aleatorios, sin llamadas HTTP.
 *   'auto' → Detección automática por fecha (sim antes del 11-jun-2026, real después).
 *
 * Ejemplo de uso:
 *   API_MODE=test node bridge.js
 *   API_MODE=test node bridge.js start 15
 *   API_MODE=real node bridge.js
 */
const API_MODE = (process.env.API_MODE || 'auto').toLowerCase();

/** URL del mock server (solo usada si API_MODE=test) */
const MOCK_API_URL = process.env.MOCK_API_URL || 'http://localhost:3001';

/**
 * true  → Consultar una API HTTP (real o mock) para obtener resultados.
 * false → Modo simulación local (sin llamadas HTTP externas).
 */
const USE_API =
  API_MODE === 'test' ? true  :
  API_MODE === 'real' ? true  :
  API_MODE === 'sim'  ? false :
  /* auto */           new Date() >= new Date('2026-06-11T19:00:00Z');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://ruwnxeyrfvuyzddmygkd.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const API_FOOTBALL_KEY     = process.env.API_FOOTBALL_KEY     || '';

/**
 * Base URL de la API de resultados.
 * - API_MODE=test  → mock local (mock-api-server.cjs)
 * - API_MODE=real o auto (después del 11-jun) → API-Football real
 */
const API_FOOTBALL_BASE    = API_MODE === 'test'
  ? MOCK_API_URL
  : 'https://v3.football.api-sports.io';


/** Fecha mínima de kickoff que consulta la API real (inicio real del torneo) */
const WC_REAL_START        = new Date('2026-06-01T00:00:00Z');

/** Orden secuencial de rondas */
const ROUND_ORDER = ['group', 'R32', 'R16', 'QF', 'SF', '3rd', 'final'];

/** Rondas de eliminatoria (donde un empate al 90' genera penales) */
const KNOCKOUT_ROUNDS = new Set(['R32', 'R16', 'QF', 'SF', '3rd', 'final']);

const MIN = 60_000; // 1 minuto en ms

// ─── CLIENTE SUPABASE ─────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── GUARD ANTI-DOBLE PROCESO ─────────────────────────────────────────────────
// Evita que dos ciclos del cron procesen el mismo partido en paralelo.
let isRunning = false;

// ═════════════════════════════════════════════════════════════════════════════
//  MODO SIMULACIÓN
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Genera un resultado aleatorio para un partido.
 *
 * - Fase de grupos: marcador normal (0-4 goles por equipo), empates permitidos.
 * - Eliminatorias: si hay empate al 90', se generan penales (3-5 goles,
 *   sin empate en penales).
 *
 * @param {{ id: string, match_number: number, round: string }} match
 * @returns {{ homeScore: number, awayScore: number, homePenalties: number|null, awayPenalties: number|null }}
 */
function getSimulationResult(match) {
  const homeScore = Math.floor(Math.random() * 5); // 0..4
  const awayScore = Math.floor(Math.random() * 5); // 0..4

  let homePenalties = null;
  let awayPenalties = null;

  if (KNOCKOUT_ROUNDS.has(match.round) && homeScore === awayScore) {
    // Empate en eliminatoria → desempate por penales (3, 4 o 5 goles c/u, sin empate)
    homePenalties = Math.floor(Math.random() * 3) + 3; // 3..5
    awayPenalties = Math.floor(Math.random() * 3) + 3; // 3..5

    // Garantizar que no haya empate en penales
    if (homePenalties === awayPenalties) {
      // El equipo local gana el desempate (incrementamos visitante o local
      // alternando de forma aleatoria para que no siempre gane el mismo)
      if (Math.random() < 0.5) {
        homePenalties += 1;
      } else {
        awayPenalties += 1;
      }
    }
  }

  return { homeScore, awayScore, homePenalties, awayPenalties };
}

// ═════════════════════════════════════════════════════════════════════════════
//  MODO API REAL
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Consulta la API-Football (API-Sports) para obtener el resultado de un partido.
 * Solo se llama si kickoff_utc >= 2026-06-01.
 *
 * Reintentos programados desde el caller:
 *   T+15min → 1ª consulta
 *   T+110min → 2ª consulta principal
 *   T+140min → 3ª consulta
 *   T+155min+ → consultas cada 15min (hasta 20 intentos)
 *
 * @param {string} wcApiId - ID externo (fixture_id) del partido en la API
 * @returns {Promise<{ status: string, homeScore: number|null, awayScore: number|null, homePenalties: number|null, awayPenalties: number|null, isExtraTime: boolean }>}
 */
async function getApiResult(wcApiId) {
  const url = `${API_FOOTBALL_BASE}/fixtures?id=${wcApiId}`;

  const response = await fetch(url, {
    headers: {
      'x-rapidapi-key': API_FOOTBALL_KEY,
      'x-rapidapi-host': 'v3.football.api-sports.io',
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`API-Football ${response.status} ${response.statusText} — ${url}`);
  }

  const data = await response.json();
  const fixture = data.response?.[0];

  if (!fixture) {
    throw new Error(`Empty response from API-Football for fixture ID ${wcApiId}`);
  }

  const apiStatus = fixture.fixture?.status?.short;
  const isFinished = apiStatus === 'FT' || apiStatus === 'AET' || apiStatus === 'PEN';
  const isLive = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'].includes(apiStatus);

  const status = isFinished ? 'finished' : (isLive ? 'in_play' : 'scheduled');

  return {
    status,
    homeScore: fixture.goals?.home ?? null,
    awayScore: fixture.goals?.away ?? null,
    homePenalties: fixture.score?.penalty?.home ?? null,
    awayPenalties: fixture.score?.penalty?.away ?? null,
    isExtraTime: apiStatus === 'ET' || apiStatus === 'AET' || apiStatus === 'PEN',
    rawFixture: fixture,
  };
}

const teamCodeMap = {
  'Mexico': 'MEX', 'South Africa': 'RSA', 'South Korea': 'KOR', 'Korea Republic': 'KOR', 'Czechia': 'CZE', 'Czech Republic': 'CZE',
  'Canada': 'CAN', 'Bosnia and Herzegovina': 'BIH', 'Bosnia-Herzegovina': 'BIH', 'Qatar': 'QAT', 'Switzerland': 'SUI',
  'Brazil': 'BRA', 'Morocco': 'MAR', 'Haiti': 'HAI', 'Scotland': 'SCO',
  'USA': 'USA', 'Paraguay': 'PAR', 'Australia': 'AUS', 'Turkey': 'TUR',
  'Germany': 'GER', 'Curacao': 'CUW', 'Curaçao': 'CUW', 'Ivory Coast': 'CIV', "Côte d'Ivoire": 'CIV', 'Ecuador': 'ECU',
  'Netherlands': 'NED', 'Japan': 'JPN', 'Sweden': 'SWE', 'Tunisia': 'TUN',
  'Belgium': 'BEL', 'Egypt': 'EGY', 'Iran': 'IRN', 'IR Iran': 'IRN', 'New Zealand': 'NZL',
  'Spain': 'ESP', 'Cape Verde': 'CPV', 'Cabo Verde': 'CPV', 'Saudi Arabia': 'KSA', 'Uruguay': 'URU',
  'France': 'FRA', 'Senegal': 'SEN', 'Iraq': 'IRQ', 'Norway': 'NOR',
  'Argentina': 'ARG', 'Algeria': 'ALG', 'Austria': 'AUT', 'Jordan': 'JOR',
  'Portugal': 'POR', 'DR Congo': 'COD', 'Congo DR': 'COD', 'Uzbekistan': 'UZB', 'Colombia': 'COL',
  'England': 'ENG', 'Croatia': 'CRO', 'Ghana': 'GHA', 'Panama': 'PAN'
};

/**
 * Busca el fixture ID de un partido específico en API-Football por equipos
 * y lo guarda en Supabase. Retorna el ID encontrado o null.
 */
async function syncSingleMatchApiId(match) {
  const tag = `#${match.match_number} (${match.round})`;
  console.log(`[sync] 🔄 Intentando sincronizar wc_api_id automáticamente para Partido ${tag}...`);

  const dbHomeCode = match.home_team?.code;
  const dbAwayCode = match.away_team?.code;

  if (!dbHomeCode || !dbAwayCode) {
    console.warn(`[sync] ⚠️ No se pueden obtener los códigos de los equipos para el Partido ${tag}.`);
    return null;
  }

  try {
    const url = `${API_FOOTBALL_BASE}/fixtures?league=1&season=2026`;
    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': API_FOOTBALL_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io',
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`API-Football error: ${response.status} ${response.statusText}`);
    }

    const apiData = await response.json();
    const fixtures = apiData.response || [];

    // Buscar coincidencia
    const matchedFixture = fixtures.find(f => {
      const apiHomeCode = teamCodeMap[f.teams.home.name] || f.teams.home.name;
      const apiAwayCode = teamCodeMap[f.teams.away.name] || f.teams.away.name;
      return (
        (dbHomeCode === apiHomeCode && dbAwayCode === apiAwayCode) ||
        (dbHomeCode === apiAwayCode && dbAwayCode === apiHomeCode)
      );
    });

    if (matchedFixture) {
      const fixtureIdStr = String(matchedFixture.fixture.id);
      console.log(`[sync] ✅ Encontrado Fixture ID ${fixtureIdStr} para el Partido ${tag} (${matchedFixture.teams.home.name} vs ${matchedFixture.teams.away.name})`);

      // Actualizar en Supabase
      const { error: updateErr } = await supabase
        .from('matches')
        .update({ wc_api_id: fixtureIdStr })
        .eq('id', match.id);

      if (updateErr) {
        console.error(`[sync] ❌ Error actualizando wc_api_id en Supabase para el Partido ${tag}:`, updateErr.message);
        return null;
      }

      return fixtureIdStr;
    } else {
      console.warn(`[sync] ⚠️ No se encontró ningún fixture coincidente en API-Football para el Partido ${tag} (${dbHomeCode} vs ${dbAwayCode})`);
      return null;
    }
  } catch (err) {
    console.error(`[sync] ❌ Error durante la autosincronización del Partido ${tag}:`, err.message);
    return null;
  }
}

/**
 * Gestiona el polling con reintentos para un partido en modo API real.
 * Programa setTimeouts según la tabla de esperas.
 *
 * @param {{ id: string, match_number: number, wc_api_id: string, kickoff_utc: string }} match
 */
async function pollApiMatch(match) {
  const tag     = `#${match.match_number} (${match.wc_api_id})`;
  const kickoff = new Date(match.kickoff_utc).getTime();
  const now     = Date.now();

  /**
   * Tabla de delays entre intentos:
   *   Intento 1 (T+15min):  si no terminó → +15min
   *   Intento 2 (T+110min): si extra_time → +30min, si no → +30min
   *   Intento 3 (T+140min): +15min
   *   Intento 4+ (T+155min+): +15min (máx 20 intentos)
   */
  const nextDelay = (attempt, result) => {
    if (API_MODE === 'test') {
      if (attempt <= 20) return 2000; // 2 segundos en modo test
      return null;
    }
    if (attempt === 1) return 15 * MIN;
    if (attempt === 2) return result.isExtraTime ? 30 * MIN : 30 * MIN;
    if (attempt <= 20) return 15 * MIN;
    return null; // timeout
  };

  const poll = (delayMs, attempt = 1) => new Promise((resolve) => {
    const pollAt = new Date(Date.now() + delayMs).toISOString();
    console.log(`  [API] Partido ${tag} → intento ${attempt} programado a las ${pollAt}`);

    setTimeout(async () => {
      try {
        const result = await getApiResult(match.wc_api_id);

        if (result.status === 'finished' && result.homeScore !== null) {
          // ✅ Partido terminado → guardar y calcular puntos
          await processMatch(match, {
            homeScore:    result.homeScore,
            awayScore:    result.awayScore,
            homePenalties: result.homePenalties ?? null,
            awayPenalties: result.awayPenalties ?? null,
          });
          resolve();
          return;
        }

        console.log(`  [API] Partido ${tag} → status: ${result.status} | score: ${result.homeScore}-${result.awayScore}`);

        // Marcar como in_play si corresponde
        if (result.status === 'in_play') {
          await supabase.from('matches').update({ status: 'in_play' }).eq('id', match.id);
        }

        const delay = nextDelay(attempt, result);
        if (delay === null) {
          console.warn(`  [API] ⚠️ Partido ${tag} — timeout de intentos alcanzado.`);
          resolve();
          return;
        }

        resolve(poll(delay, attempt + 1));
      } catch (err) {
        console.error(`  [API] ❌ Error partido ${tag} intento ${attempt}:`, err.message);
        // Reintento de seguridad en 10 min ante error de red (2s en modo test)
        if (attempt <= 20) {
          resolve(poll(API_MODE === 'test' ? 2000 : 10 * MIN, attempt + 1));
        } else {
          resolve();
        }
      }
    }, delayMs);
  });

  // Marcar como in_progress para evitar que el cron lance pollings duplicados
  await supabase.from('matches').update({ status: 'in_progress' }).eq('id', match.id);

  // Primer intento a T+15min (nunca en el pasado, inmediato en modo test)
  const firstPollAt = kickoff + 15 * MIN;
  const initialDelay = API_MODE === 'test' ? 0 : Math.max(firstPollAt - now, 0);
  return poll(initialDelay, 1);
}

/**
 * Calcula y asigna los puntos de bonificación por Early Picks (Pre-tournament picks).
 * Reglas de puntuación:
 *   - Campeón correcto: +10 pts
 *   - Finalista correcto: +5 pts
 *   - Semifinalista correcto: +2 pts por cada uno (hasta 4 semifinalistas)
 */
async function calculateEarlyPickBonus() {
  console.log('\n🌟 [calculateEarlyPickBonus] Calculando bonus de Early Picks...');

  try {
    // 1. Obtener la Gran Final (match_number = 104)
    const { data: finalMatch, error: finalErr } = await supabase
      .from('matches')
      .select('id, home_team_id, away_team_id, home_score, away_score, home_penalties, away_penalties, status')
      .eq('match_number', 104)
      .single();

    const isFinalFinished = ['FT', 'AET', 'PEN', 'finished'].includes(finalMatch?.status);
    if (finalErr || !finalMatch || !isFinalFinished) {
      console.log('  ⚠️ No se puede calcular bonus aún: el partido de la Final no está terminado o no se encontró.');
      return;
    }

    // 2. Determinar campeón y finalista real
    let champId = null;
    let finalistId = null;

    const hs = finalMatch.home_score ?? 0;
    const as = finalMatch.away_score ?? 0;
    const hp = finalMatch.home_penalties;
    const ap = finalMatch.away_penalties;

    if (hs > as) {
      champId = finalMatch.home_team_id;
      finalistId = finalMatch.away_team_id;
    } else if (as > hs) {
      champId = finalMatch.away_team_id;
      finalistId = finalMatch.home_team_id;
    } else {
      // Penales
      if (hp !== null && ap !== null) {
        if (hp > ap) {
          champId = finalMatch.home_team_id;
          finalistId = finalMatch.away_team_id;
        } else {
          champId = finalMatch.away_team_id;
          finalistId = finalMatch.home_team_id;
        }
      } else {
        // Fallback si por algún motivo no hay penales registrados
        champId = finalMatch.home_team_id;
        finalistId = finalMatch.away_team_id;
      }
    }

    console.log(`  🏆 Campeón Real: ${champId}`);
    console.log(`  🥈 Finalista Real: ${finalistId}`);

    // 3. Obtener semifinalistas (match_number 101 y 102)
    const { data: sfMatches, error: sfErr } = await supabase
      .from('matches')
      .select('home_team_id, away_team_id')
      .in('match_number', [101, 102]);

    if (sfErr || !sfMatches || sfMatches.length < 2) {
      console.warn('  ⚠️ No se obtuvieron ambos partidos de semifinales. No se pueden determinar semifinalistas reales.');
      return;
    }

    const realSemis = [
      sfMatches[0].home_team_id,
      sfMatches[0].away_team_id,
      sfMatches[1].home_team_id,
      sfMatches[1].away_team_id
    ].filter(Boolean);

    console.log(`  🥉 Semifinalistas Reales:`, realSemis);

    // 4. Obtener todos los pre_tournament_picks
    const { data: userPicks, error: picksErr } = await supabase
      .from('pre_tournament_picks')
      .select('id, user_id, group_id, champion_team_id, finalist_team_id, semi1_team_id, semi2_team_id, semi3_team_id, semi4_team_id');

    if (picksErr || !userPicks) {
      console.error('  ❌ Error al obtener pre_tournament_picks:', picksErr?.message);
      return;
    }

    console.log(`  📋 Procesando picks de ${userPicks.length} participantes...`);

    // 5. Comparar y actualizar
    for (const pick of userPicks) {
      let bonus = 0;

      // Campeón: +10 pts
      if (pick.champion_team_id === champId) {
        bonus += 10;
      }

      // Finalista: +5 pts
      if (pick.finalist_team_id === finalistId) {
        bonus += 5;
      }

      // Semifinalistas: +2 pts c/u
      const userSemis = [
        pick.semi1_team_id,
        pick.semi2_team_id,
        pick.semi3_team_id,
        pick.semi4_team_id
      ];

      for (const us of userSemis) {
        if (us && realSemis.includes(us)) {
          bonus += 2;
        }
      }

      // Guardar en la tabla pre_tournament_picks
      await supabase
        .from('pre_tournament_picks')
        .update({ bonus_points_earned: bonus })
        .eq('id', pick.id);

      // Actualizar leaderboard
      const { data: lbEntry, error: lbErr } = await supabase
        .from('leaderboard')
        .select('total_points, exact_scores, correct_winners, bonus_points')
        .eq('user_id', pick.user_id)
        .eq('group_id', pick.group_id)
        .single();

      if (lbErr || !lbEntry) {
        // Si no existe, crearla
        const total = bonus;
        await supabase
          .from('leaderboard')
          .insert({
            user_id: pick.user_id,
            group_id: pick.group_id,
            exact_scores: 0,
            correct_winners: 0,
            bonus_points: bonus,
            total_points: total
          });
      } else {
        // Si ya existe, recalculamos
        const regularPoints = (lbEntry.exact_scores * 3) + lbEntry.correct_winners;
        const newTotal = regularPoints + bonus;

        await supabase
          .from('leaderboard')
          .update({
            bonus_points: bonus,
            total_points: newTotal
          })
          .eq('user_id', pick.user_id)
          .eq('group_id', pick.group_id);
      }
    }

    console.log('  ✅ [calculateEarlyPickBonus] Todos los bonus por Early Picks han sido calculados y aplicados.');
  } catch (err) {
    console.error('  ❌ Error inesperado en calculateEarlyPickBonus:', err.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PROCESAMIENTO CENTRAL DE UN PARTIDO
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Guarda el resultado en Supabase y llama a la RPC de puntos.
 *
 * @param {{ id: string, match_number: number, round: string }} match
 * @param {{ homeScore: number, awayScore: number, homePenalties: number|null, awayPenalties: number|null }} result
 */
async function processMatch(match, result) {
  const { homeScore, awayScore, homePenalties, awayPenalties } = result;

  const tag = `Partido #${match.match_number} (${match.round})`;
  let logScore = `${homeScore}-${awayScore}`;
  if (homePenalties !== null) logScore += ` (pen: ${homePenalties}-${awayPenalties})`;

  // 1. Guardar resultado y marcar como finished
  const { error: updateError } = await supabase
    .from('matches')
    .update({
      home_score:      homeScore,
      away_score:      awayScore,
      home_penalties:  homePenalties,
      away_penalties:  awayPenalties,
      status:          'FT',
    })
    .eq('id', match.id);

  if (updateError) {
    console.error(`  ❌ [processMatch] Error al guardar ${tag}:`, updateError.message);
    return;
  }

  console.log(`  ✅ [RESULTADO] ${tag} → ${logScore}`);

  // 2. Calcular puntos de todas las predicciones de este partido
  const { error: rpcError } = await supabase.rpc('calcular_puntos_partido', {
    p_match_id: match.id,
  });

  if (rpcError) {
    console.error(`  ❌ [processMatch] RPC calcular_puntos_partido para ${tag}:`, rpcError.message);
  } else {
    console.log(`  ✅ [puntos] Calculados para ${tag}`);
  }

  // ── Si el partido es la gran final (#104), calcular bonus por early picks ──
  if (Number(match.match_number) === 104) {
    await calculateEarlyPickBonus();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SEMBRADO DE LA SIGUIENTE RONDA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Verifica si TODOS los partidos de una ronda están finished.
 *
 * @param {string} round - Nombre de la ronda ('group', 'R32', etc.)
 * @returns {Promise<boolean>}
 */
async function isRoundComplete(round) {
  const { data, error } = await supabase
    .from('matches')
    .select('id')
    .eq('round', round)
    .not('status', 'in', '("FT","AET","PEN","finished")')
    .limit(1);

  if (error) {
    console.error(`  ❌ [isRoundComplete] Error verificando ronda ${round}:`, error.message);
    return false;
  }

  return data !== null && data.length === 0;
}

/**
 * Verifica si una ronda existe en la BD (tiene al menos un partido sembrado con equipos).
 *
 * @param {string} round
 * @returns {Promise<boolean>}
 */
async function roundHasSeededMatches(round) {
  const { data, error } = await supabase
    .from('matches')
    .select('id')
    .eq('round', round)
    .not('home_team_id', 'is', null)
    .limit(1);

  if (error) return false;
  return data !== null && data.length > 0;
}

/**
 * Calcula la tabla de posiciones de un grupo a partir de sus partidos.
 *
 * @param {Array} matches - Partidos del grupo con scores y team ids
 * @returns {Array} - Equipos ordenados por pts → dg → gf
 */
function calculateGroupStandings(matches) {
  const stats = {};

  const ensureTeam = (id) => {
    if (!stats[id]) {
      stats[id] = { id, pts: 0, gf: 0, gc: 0, dg: 0 };
    }
  };

  for (const m of matches) {
    if (!m.home_team_id || !m.away_team_id || m.home_score === null || m.away_score === null) continue;

    ensureTeam(m.home_team_id);
    ensureTeam(m.away_team_id);

    const h = stats[m.home_team_id];
    const a = stats[m.away_team_id];

    h.gf += m.home_score; h.gc += m.away_score;
    a.gf += m.away_score; a.gc += m.home_score;
    h.dg = h.gf - h.gc;
    a.dg = a.gf - a.gc;

    if (m.home_score > m.away_score)      { h.pts += 3; }
    else if (m.home_score < m.away_score) { a.pts += 3; }
    else                                  { h.pts += 1; a.pts += 1; }
  }

  return Object.values(stats).sort(
    (a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf
  );
}

/**
 * Siembra los equipos en los partidos de la siguiente ronda basándose en los
 * resultados de la ronda actual. También propaga perdedores al partido de 3er lugar.
 *
 * Flujo de siembra:
 *   group  done → calcular clasificados → sembrar R32 (vía RPC o directo)
 *   R32    done → sembrar R16 (ganadores R32[i*2] vs R32[i*2+1])
 *   R16    done → sembrar QF
 *   QF     done → sembrar SF
 *   SF     done → sembrar 3rd (perdedores) y final (ganadores)
 *
 * @param {string} currentRound - Ronda que acaba de completarse
 */
async function seedNextRound(currentRound) {
  const roundIdx  = ROUND_ORDER.indexOf(currentRound);
  const nextRound = ROUND_ORDER[roundIdx + 1];

  // No hay ronda siguiente después de la final
  if (!nextRound) return;

  // Si la siguiente ronda ya tiene equipos sembrados, no volver a sembrar
  if (await roundHasSeededMatches(nextRound)) {
    return;
  }

  console.log(`\n[seedNextRound] Ronda "${currentRound}" completa → sembrando "${nextRound}"...`);

  let seededWithApi = false;

  // En modo test, siempre usar lógica local directamente
  if (API_MODE === 'test') {
    console.log(`[seedNextRound] MODO TEST (API_MODE=test) activo. Usando lógica local directamente.`);
  } else {
    try {
      console.log(`[seedNextRound] Consultando API-Football para buscar emparejamientos de la ronda "${nextRound}"...`);
      const url = `${API_FOOTBALL_BASE}/fixtures?league=1&season=2026`;
      const response = await fetch(url, {
        headers: {
          'x-rapidapi-key': API_FOOTBALL_KEY,
          'x-rapidapi-host': 'v3.football.api-sports.io',
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`API-Football responded with status ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const apiFixtures = data.response || [];

      if (apiFixtures.length === 0) {
        throw new Error('API-Football returned no fixtures.');
      }

      // Ordenar cronológicamente para tener una asignación 1-a-1 estable con match_number
      apiFixtures.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

      // Determinar los partidos locales de la siguiente ronda a sembrar
      let targetRounds = [nextRound];
      if (nextRound === '3rd') {
        targetRounds = ['3rd', 'final'];
      }

      const { data: dbMatches, error: dbMatchesErr } = await supabase
        .from('matches')
        .select('id, match_number, round')
        .in('round', targetRounds)
        .order('match_number', { ascending: true });

      if (dbMatchesErr || !dbMatches || dbMatches.length === 0) {
        throw new Error(`Error fetching local matches for round(s) ${targetRounds.join(', ')}: ${dbMatchesErr?.message}`);
      }

      // Obtener todos los equipos de la base de datos para mapeo
      const { data: dbTeams, error: teamsErr } = await supabase
        .from('teams')
        .select('id, code, name');

      if (teamsErr || !dbTeams) {
        throw new Error(`Error fetching teams from Supabase: ${teamsErr?.message}`);
      }

      const teamMapByCode = {};
      const teamMapByName = {};
      for (const t of dbTeams) {
        teamMapByCode[t.code] = t.id;
        teamMapByName[t.name.toLowerCase()] = t.id;
      }

      const isRealTeamName = (name) => {
        if (!name) return false;
        const n = name.toLowerCase();
        if (n === 'tbd' || n === 'to be decided' || n.includes('winner') || n.includes('runner') || n.includes('group')) {
          return false;
        }
        return true;
      };

      const resolveTeamId = (apiName) => {
        if (!isRealTeamName(apiName)) return null;
        const code = teamCodeMap[apiName];
        if (code && teamMapByCode[code]) {
          return teamMapByCode[code];
        }
        if (teamMapByName[apiName.toLowerCase()]) {
          return teamMapByName[apiName.toLowerCase()];
        }
        return null;
      };

      // Mapear fixtures correspondientes a la ronda
      const updates = [];

      for (const dbM of dbMatches) {
        const idx = dbM.match_number - 1;
        const fixture = apiFixtures[idx];

        if (!fixture) {
          console.warn(`[seedNextRound] No se encontró fixture de API en el índice ${idx} para Partido #${dbM.match_number}`);
          continue;
        }

        const homeName = fixture.teams?.home?.name;
        const awayName = fixture.teams?.away?.name;

        const homeId = resolveTeamId(homeName);
        const awayId = resolveTeamId(awayName);

        if (homeId && awayId) {
          updates.push({
            dbMatchId: dbM.id,
            match_number: dbM.match_number,
            home_team_id: homeId,
            away_team_id: awayId,
            wc_api_id: String(fixture.fixture.id)
          });
        }
      }

      // Si todos los partidos requeridos tienen equipos resueltos en la API
      if (updates.length === dbMatches.length && dbMatches.length > 0) {
        console.log(`[seedNextRound] ¡Usando emparejamientos de API-Football para la ronda "${nextRound}"!`);
        for (const u of updates) {
          const { error: upErr } = await supabase
            .from('matches')
            .update({
              home_team_id: u.home_team_id,
              away_team_id: u.away_team_id,
              wc_api_id: u.wc_api_id
            })
            .eq('id', u.dbMatchId);

          if (upErr) {
            console.error(`  ❌ Error sembrando Partido #${u.match_number} desde API:`, upErr.message);
          } else {
            console.log(`  ✅ Sembrado Partido #${u.match_number} desde API: ${u.home_team_id} vs ${u.away_team_id} (API ID: ${u.wc_api_id})`);
          }
        }
        seededWithApi = true;
      } else {
        console.log(`[seedNextRound] API sin datos completos (solo ${updates.length}/${dbMatches.length} partidos resueltos en API), usando lógica local como fallback.`);
      }
    } catch (e) {
      console.error(`[seedNextRound] Error consultando o procesando API, usando lógica local como fallback:`, e.message);
    }
  }

  // Fallback a lógica local si la API no sembró la ronda
  if (!seededWithApi) {
    if (currentRound === 'group') {
      await seedR32FromGroups();
    } else {
      await seedKnockoutRound(currentRound, nextRound);
    }
  }
}

/**
 * Calcula los 32 clasificados de la fase de grupos y los siembra en R32.
 * Bracket: partido[i] = classified[i] vs classified[31-i].
 */
async function seedR32FromGroups() {
  // Obtener todos los partidos de grupos con resultados y team ids
  const { data: groupMatches, error } = await supabase
    .from('matches')
    .select('id, match_number, round, group_name, home_team_id, away_team_id, home_score, away_score')
    .eq('round', 'group')
    .in('status', ['FT', 'AET', 'PEN', 'finished']);

  if (error) {
    console.error('  ❌ [seedR32] Error al obtener partidos de grupo:', error.message);
    return;
  }

  const GROUPS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

  // Agrupar partidos por group_name
  const byGroup = {};
  for (const m of groupMatches) {
    const g = m.group_name || '?';
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(m);
  }

  const winners    = [];
  const runnersUp  = [];
  const thirdsAll  = [];

  for (const g of GROUPS) {
    const standings = calculateGroupStandings(byGroup[g] || []);
    if (standings[0]) winners.push(standings[0].id);
    if (standings[1]) runnersUp.push(standings[1].id);
    if (standings[2]) {
      thirdsAll.push({
        id:  standings[2].id,
        pts: standings[2].pts,
        dg:  standings[2].dg,
        gf:  standings[2].gf,
      });
    }
  }

  // Los 8 mejores terceros (por pts → dg → gf)
  const best8Thirds = thirdsAll
    .sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf)
    .slice(0, 8)
    .map(t => t.id);

  // 32 clasificados: [12 ganadores, 12 sub-campeones, 8 mejores terceros]
  const classified = [...winners, ...runnersUp, ...best8Thirds];

  console.log(`  [seedR32] Clasificados: ${winners.length}W + ${runnersUp.length}RU + ${best8Thirds.length} mejores 3° = ${classified.length}`);

  if (classified.length < 32) {
    console.warn('  ⚠️ [seedR32] No se obtuvieron 32 clasificados. ¿Faltan datos de grupos?');
    return;
  }

  // Obtener los 16 partidos de R32 ordenados por match_number
  const { data: r32Matches, error: r32Err } = await supabase
    .from('matches')
    .select('id, match_number')
    .eq('round', 'R32')
    .order('match_number', { ascending: true });

  if (r32Err || !r32Matches) {
    console.error('  ❌ [seedR32] Error al obtener partidos R32:', r32Err?.message);
    return;
  }

  // Sembrar: partido[i] = classified[i] vs classified[31-i]
  for (let i = 0; i < r32Matches.length; i++) {
    const homeId = classified[i];
    const awayId = classified[31 - i];
    const { error: upErr } = await supabase
      .from('matches')
      .update({ home_team_id: homeId, away_team_id: awayId })
      .eq('id', r32Matches[i].id);

    if (upErr) {
      console.error(`  ❌ [seedR32] Error partido R32 #${r32Matches[i].match_number}:`, upErr.message);
    }
  }

  console.log(`  ✅ [seedR32] 16 partidos de R32 sembrados.`);
}

/**
 * Siembra una ronda knockout basándose en los ganadores (o perdedores para 3rd)
 * de la ronda anterior.
 *
 * Lógica de bracket:
 *   - Para R16, QF, SF: partido[i] ← ganador(prev[i*2]) vs ganador(prev[i*2+1])
 *   - Para 3rd:         partido[0] ← perdedor(SF[0]) vs perdedor(SF[1])
 *   - Para final:       partido[0] ← ganador(SF[0]) vs ganador(SF[1])
 *
 * @param {string} prevRound  - Ronda que acaba de terminar
 * @param {string} nextRound  - Ronda a sembrar
 */
async function seedKnockoutRound(prevRound, nextRound) {
  // Obtener partidos de la ronda anterior con sus resultados y team ids
  const { data: prevMatches, error: prevErr } = await supabase
    .from('matches')
    .select('id, match_number, home_team_id, away_team_id, home_score, away_score, home_penalties, away_penalties')
    .eq('round', prevRound)
    .in('status', ['FT', 'AET', 'PEN', 'finished'])
    .order('match_number', { ascending: true });

  if (prevErr || !prevMatches) {
    console.error(`  ❌ [seedKnockout] Error al obtener partidos de ${prevRound}:`, prevErr?.message);
    return;
  }

  // Helper: ganador de un partido (considerando penales)
  const getWinner = (m) => {
    if (m.home_score > m.away_score) return m.home_team_id;
    if (m.home_score < m.away_score) return m.away_team_id;
    // Empate → decidir por penales
    if (m.home_penalties !== null && m.away_penalties !== null) {
      return m.home_penalties > m.away_penalties ? m.home_team_id : m.away_team_id;
    }
    // Sin datos de penales: home gana (fallback)
    return m.home_team_id;
  };

  const getLoser = (m) => {
    const winner = getWinner(m);
    return winner === m.home_team_id ? m.away_team_id : m.home_team_id;
  };

  // Obtener partidos de la ronda siguiente ordenados
  const { data: nextMatches, error: nextErr } = await supabase
    .from('matches')
    .select('id, match_number')
    .eq('round', nextRound)
    .order('match_number', { ascending: true });

  if (nextErr || !nextMatches || nextMatches.length === 0) {
    console.error(`  ❌ [seedKnockout] No se encontraron partidos de ${nextRound}:`, nextErr?.message);
    return;
  }

  // Caso especial: 3er lugar (perdedores de SF)
  if (nextRound === '3rd') {
    if (prevMatches.length < 2) {
      console.warn('  ⚠️ [seedKnockout] No hay 2 partidos de SF para sembrar 3er lugar.');
      return;
    }
    const { error: upErr } = await supabase
      .from('matches')
      .update({
        home_team_id: getLoser(prevMatches[0]),
        away_team_id: getLoser(prevMatches[1]),
      })
      .eq('id', nextMatches[0].id);

    if (upErr) {
      console.error('  ❌ [seedKnockout] Error al sembrar 3er lugar:', upErr.message);
    } else {
      console.log('  ✅ [seedKnockout] Partido de 3er lugar sembrado.');
    }

    // También sembrar la Final (ganadores de SF) si aún no está sembrada
    const { data: finalMatches } = await supabase
      .from('matches')
      .select('id, match_number, home_team_id')
      .eq('round', 'final')
      .limit(1);

    if (finalMatches && finalMatches.length > 0 && !finalMatches[0].home_team_id) {
      const { error: finalErr } = await supabase
        .from('matches')
        .update({
          home_team_id: getWinner(prevMatches[0]),
          away_team_id: getWinner(prevMatches[1]),
        })
        .eq('id', finalMatches[0].id);

      if (finalErr) {
        console.error('  ❌ [seedKnockout] Error al sembrar Final:', finalErr.message);
      } else {
        console.log('  ✅ [seedKnockout] Gran Final sembrada.');
      }
    }

    return;
  }

  // Caso general: nextRound = R16, QF, SF, final
  // partido[i] ← ganador(prev[i*2]) vs ganador(prev[i*2+1])
  let seeded = 0;
  for (let i = 0; i < nextMatches.length; i++) {
    const homeTeam = getWinner(prevMatches[i * 2]);
    const awayTeam = getWinner(prevMatches[i * 2 + 1]);

    if (!homeTeam || !awayTeam) {
      console.warn(`  ⚠️ [seedKnockout] Faltan equipos para partido ${nextRound}[${i}]`);
      continue;
    }

    const { error: upErr } = await supabase
      .from('matches')
      .update({ home_team_id: homeTeam, away_team_id: awayTeam })
      .eq('id', nextMatches[i].id);

    if (upErr) {
      console.error(`  ❌ [seedKnockout] Error sembrando ${nextRound} partido ${i}:`, upErr.message);
    } else {
      seeded++;
    }
  }

  console.log(`  ✅ [seedKnockout] ${seeded}/${nextMatches.length} partidos de ${nextRound} sembrados.`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  CRON — LOOP PRINCIPAL (cada 1 minuto)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Función principal del cron. En cada tick:
 *
 * 1. Busca el próximo partido pendiente en orden secuencial (match_number ASC).
 * 2. Si su kickoff ya pasó → procesarlo (simulación) o iniciar polling (API real).
 * 3. Verifica si hay que sembrar la siguiente ronda.
 *
 * El orden secuencial garantiza que los grupos se procesen antes que R32, etc.
 * Cada ronda bloquea la siguiente hasta estar 100% finished.
 */
async function tick() {
  if (isRunning) {
    console.log('[cron] ⚠️  Tick anterior aún en ejecución, saltando...');
    return;
  }

  isRunning = true;
  const now = new Date();

  try {
    console.log(`\n[cron] ─── Tick ${now.toISOString()} ───`);

    // ── 1. Buscar y procesar partidos pendientes (kickoff ya pasó) ──────────
    if (!USE_API) {
      // ── MODO SIMULACIÓN ──
      // Buscamos TODOS los partidos cuya fecha de kickoff ya pasó y están scheduled.
      const { data: pendingMatches, error: fetchErr } = await supabase
        .from('matches')
        .select('id, match_number, round, kickoff_utc, home_team_id, away_team_id')
        .eq('status', 'scheduled')
        .lt('kickoff_utc', now.toISOString())
        .order('match_number', { ascending: true });

      if (fetchErr) {
        console.error('[cron] ❌ Error al buscar partidos pendientes:', fetchErr.message);
        return;
      }

      if (!pendingMatches || pendingMatches.length === 0) {
        console.log('[cron] Sin partidos pendientes en este tick.');
      } else {
        console.log(`[cron] Encontrados ${pendingMatches.length} partidos pendientes para procesar.`);

        for (const match of pendingMatches) {
          let currentMatch = { ...match };

          // Validar que todas las rondas previas estén 100% terminadas antes de procesar este partido
          const roundIdx = ROUND_ORDER.indexOf(currentMatch.round);
          let prevRoundsComplete = true;
          for (let rIdx = 0; rIdx < roundIdx; rIdx++) {
            const prevRound = ROUND_ORDER[rIdx];
            const isPrevComplete = await isRoundComplete(prevRound);
            if (!isPrevComplete) {
              prevRoundsComplete = false;
              break;
            }
          }

          if (!prevRoundsComplete) {
            console.log(`[cron] Partido #${currentMatch.match_number} (${currentMatch.round}) en espera porque la ronda anterior no ha terminado.`);
            continue;
          }

          // Si no tiene equipos asignados, podría haber sido sembrado durante este tick por el partido anterior.
          // Hacemos una consulta rápida a la BD para tener los datos más frescos.
          if (!currentMatch.home_team_id || !currentMatch.away_team_id) {
            const { data: freshMatch } = await supabase
              .from('matches')
              .select('home_team_id, away_team_id')
              .eq('id', match.id)
              .single();
            
            if (freshMatch) {
              currentMatch.home_team_id = freshMatch.home_team_id;
              currentMatch.away_team_id = freshMatch.away_team_id;
            }
          }

          if (!currentMatch.home_team_id || !currentMatch.away_team_id) {
            console.log(`[cron] Partido #${currentMatch.match_number} (${currentMatch.round}) aún sin equipos sembrados. Saltando por ahora.`);
            continue;
          }

          console.log(`[cron] Procesando Partido #${currentMatch.match_number} (${currentMatch.round}) — kickoff: ${currentMatch.kickoff_utc}`);
          const result = getSimulationResult(currentMatch);
          await processMatch(currentMatch, result);

          // Verificar siembra inmediatamente después de procesar este partido
          // por si habilitó la siembra de la siguiente ronda en este mismo tick.
          await checkAndSeedRounds();
        }
      }
    } else {
      // ── MODO REAL / TEST ──
      // En modo real, procesamos de a UNO por tick para evitar saturar la API externa.
      // En modo test, procesamos TODOS los partidos cuyo kickoff ya pasó.
      const query = supabase
        .from('matches')
        .select(`
          id, match_number, round, kickoff_utc, wc_api_id, home_team_id, away_team_id,
          home_team:teams!home_team_id(id, code, name),
          away_team:teams!away_team_id(id, code, name)
        `)
        .eq('status', 'scheduled')
        .lt('kickoff_utc', now.toISOString())
        .order('match_number', { ascending: true });

      if (API_MODE !== 'test') {
        query.limit(1);
      }

      const { data: pendingMatches, error: fetchErr } = await query;

      if (fetchErr) {
        console.error('[cron] ❌ Error al buscar partidos pendientes:', fetchErr.message);
        return;
      }

      if (!pendingMatches || pendingMatches.length === 0) {
        console.log('[cron] Sin partidos pendientes en este tick.');
      } else {
        console.log(`[cron] Encontrados ${pendingMatches.length} partidos pendientes para procesar.`);

        for (const match of pendingMatches) {
          // Validar que todas las rondas previas estén 100% terminadas antes de procesar este partido.
          // Esto evita que en modo test procesemos octavos si todavía no terminó dieciseisavos.
          const roundIdx = ROUND_ORDER.indexOf(match.round);
          let prevRoundsComplete = true;
          for (let rIdx = 0; rIdx < roundIdx; rIdx++) {
            const prevRound = ROUND_ORDER[rIdx];
            const isPrevComplete = await isRoundComplete(prevRound);
            if (!isPrevComplete) {
              prevRoundsComplete = false;
              break;
            }
          }

          if (!prevRoundsComplete) {
            console.log(`[cron] Partido #${match.match_number} (${match.round}) en espera porque la ronda anterior no ha terminado.`);
            continue;
          }

          if (!match.home_team_id || !match.away_team_id) {
            console.log(`[cron] Partido #${match.match_number} (${match.round}) aún sin equipos sembrados. Saltando por ahora.`);
            continue;
          }

          console.log(`[cron] Procesando Partido #${match.match_number} (${match.round}) — kickoff: ${match.kickoff_utc}`);
          const kickoff = new Date(match.kickoff_utc);

          if (kickoff < WC_REAL_START && API_MODE !== 'test' && !KNOCKOUT_ROUNDS.has(match.round)) {
            // Solo bloquear partidos de grupos con fecha antigua — los de eliminatoria
            // pueden tener kickoff_utc incorrecto hasta que syncKnockoutFixtures los corrija.
            console.log(`[cron] Partido #${match.match_number} (grupo) tiene kickoff anterior a ${WC_REAL_START.toISOString()}, ignorando (sin datos API).`);
          } else if (!match.wc_api_id) {
            // Auto-sincronización de wc_api_id para eliminatorias
            const isKnockout = ['R32', 'R16', 'QF', 'SF', '3rd', 'final'].includes(match.round);
            let syncedId = null;
            if (isKnockout) {
              syncedId = await syncSingleMatchApiId(match);
            }
            if (syncedId) {
              match.wc_api_id = syncedId;
              pollApiMatch(match).catch(err =>
                console.error(`[cron] ❌ Error en pollApiMatch #${match.match_number}:`, err.message)
              );
            } else {
              console.warn(`[cron] ⚠️ Partido #${match.match_number} no tiene wc_api_id y falló la autosincronización.`);
            }
          } else {
            pollApiMatch(match).catch(err =>
              console.error(`[cron] ❌ Error en pollApiMatch #${match.match_number}:`, err.message)
            );
          }
        }
      }
    }

    // ── 2. Verificar siembra de rondas (asegura cobertura general) ──────────
    await checkAndSeedRounds();

  } catch (err) {
    console.error('[cron] ❌ Error inesperado en tick:', err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Recorre el orden de rondas y verifica si alguna está completa para sembrar la siguiente.
 * Se detiene en la primera ronda incompleta (orden estrictamente secuencial).
 */
async function checkAndSeedRounds() {
  for (const round of ROUND_ORDER) {
    const complete = await isRoundComplete(round);

    if (!complete) {
      // Esta ronda no está terminada → las siguientes tampoco pueden sembrarse
      const { data: pending } = await supabase
        .from('matches')
        .select('id')
        .eq('round', round)
        .not('status', 'in', '("FT","AET","PEN","finished")')
        .limit(5);

      console.log(`[cron] Ronda "${round}" en curso (${pending?.length || '?'}+ partidos pendientes). Próxima siembra en espera.`);
      break;
    }

    // Ronda completa → intentar sembrar la siguiente
    const nextRound = ROUND_ORDER[ROUND_ORDER.indexOf(round) + 1];
    if (nextRound) {
      const alreadySeeded = await roundHasSeededMatches(nextRound);
      if (!alreadySeeded) {
        console.log(`[cron] ✅ Ronda "${round}" 100% finished → sembrando "${nextRound}"...`);
        await seedNextRound(round);
      }
    }
    // Si no hay nextRound, es la final y ya terminó el torneo.
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ACTUALIZACIÓN EN VIVO (cada 1 minuto)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Consulta la API para actualizar marcadores de partidos que se están jugando.
 */
async function updateLiveScores() {
  if (!USE_API) {
    return;
  }

  try {
    const { data: liveMatches, error: dbErr } = await supabase
      .from('matches')
      .select('id, wc_api_id, status')
      .lte('kickoff_utc', new Date().toISOString())
      .not('status', 'in', '("FT","AET","PEN","finished")')
      .not('wc_api_id', 'is', null);

    if (dbErr) {
      console.error('[updateLiveScores] ❌ Error consultando partidos activos:', dbErr.message);
      return;
    }

    if (!liveMatches || liveMatches.length === 0) {
      console.log('[updateLiveScores] No hay partidos activos, saltando.');
      return;
    }

    console.log(`[updateLiveScores] Actualizando ${liveMatches.length} partido(s) en vivo...`);

    for (const match of liveMatches) {
      try {
        const apiResult = await getApiResult(match.wc_api_id);
        const fixture = apiResult.rawFixture;

        if (!fixture) {
          console.warn(`[updateLiveScores] ⚠️ No se obtuvo el fixture para el partido ID ${match.id} (wc_api_id: ${match.wc_api_id})`);
          continue;
        }

        await supabase
          .from('matches')
          .update({
            home_score: fixture.goals.home ?? 0,
            away_score: fixture.goals.away ?? 0,
            home_penalties: fixture.score.penalty.home,
            away_penalties: fixture.score.penalty.away,
            status: fixture.fixture.status.short,
            elapsed: fixture.fixture.status.elapsed ?? null
          })
          .eq('id', match.id);

        const newStatus = fixture.fixture.status.short;
        if (['FT', 'AET', 'PEN'].includes(newStatus)) {
          // Verificar si hay predicciones sin procesar
          const { count } = await supabase
            .from('predictions')
            .select('id', { count: 'exact', head: true })
            .eq('match_id', match.id)
            .is('points_earned', null);

          if (count > 0) {
            const { error: rpcError } = await supabase.rpc('calcular_puntos_partido', {
              p_match_id: match.id,
            });
            if (rpcError) {
              console.error(`[updateLiveScores] ❌ RPC error:`, rpcError.message);
            } else {
              console.log(`[updateLiveScores] ✅ Puntos calculados para partido ${match.id}`);
            }
          }
        }

        const elapsed = fixture.fixture?.status?.elapsed;
        const elapsedStr = elapsed !== null && elapsed !== undefined ? ` (${elapsed}')` : '';
        console.log(`[updateLiveScores] Partido ${match.id} actualizado: ${fixture.goals?.home ?? 0}-${fixture.goals?.away ?? 0}${elapsedStr}`);
      } catch (err) {
        console.error(`[updateLiveScores] ❌ Error al actualizar partido ${match.id}:`, err.message);
      }
    }
  } catch (error) {
    console.error('[updateLiveScores] ❌ Error general en updateLiveScores:', error.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  INICIALIZACIÓN DE LA SIMULACIÓN COMPLETA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Inicia una simulación completa del Mundial.
 *
 * 1. Resetea toda la base de datos (RPC reset_simulation).
 * 2. Genera predicciones aleatorias y early picks para todos los usuarios.
 * 3. Distribuye secuencialmente los 104 kickoffs:
 *    - Fase de grupos en el 40% del tiempo total.
 *    - 1 minuto de separación (gap) entre rondas.
 *    - Knockouts distribuidos en el tiempo restante de forma proporcional.
 * 4. Guarda la configuración en la base de datos (app_config).
 *
 * @param {number} durationMinutes - Duración total de la simulación en minutos
 */
async function startSimulation(durationMinutes) {
  console.log(`\n🚀 [startSimulation] Iniciando simulación completa de ${durationMinutes} minutos...`);

  // 1. Resetear todo (RPC reset_simulation)
  console.log('  ⏳ [1/5] Reseteando base de datos (reset_simulation)...');
  const { error: resetError } = await supabase.rpc('reset_simulation');
  if (resetError) {
    console.error('  ❌ Error al resetear simulación:', resetError.message);
    throw resetError;
  }
  console.log('  ✅ Base de datos reseteada.');

  // Cargar datos base
  console.log('  ⏳ [2/5] Cargando usuarios, membresías, equipos y partidos...');
  const [usersRes, membersRes, teamsRes, matchesRes] = await Promise.all([
    supabase.from('users').select('id'),
    supabase.from('group_members').select('user_id, group_id'),
    supabase.from('teams').select('id'),
    supabase.from('matches').select('id, match_number, round').order('match_number', { ascending: true })
  ]);

  if (usersRes.error || membersRes.error || teamsRes.error || matchesRes.error) {
    console.error('  ❌ Error cargando datos base:', usersRes.error || membersRes.error || teamsRes.error || matchesRes.error);
    return;
  }

  const users = usersRes.data || [];
  const groupMembers = membersRes.data || [];
  const teams = teamsRes.data || [];
  const matches = matchesRes.data || [];

  console.log(`  ✅ Cargados: ${users.length} usuarios, ${groupMembers.length} membresías, ${teams.length} equipos, ${matches.length} partidos.`);

  // 2. Generar predicciones para todos los usuarios
  console.log('  ⏳ [3/5] Generando predicciones aleatorias para todos los usuarios...');
  const predRows = [];
  for (const { user_id, group_id } of groupMembers) {
    for (const m of matches) {
      predRows.push({
        user_id,
        match_id:        m.id,
        group_id,
        home_score_pred: Math.floor(Math.random() * 5),
        away_score_pred: Math.floor(Math.random() * 5),
        is_locked:       false,
        points_earned:   null,
      });
    }
  }

  const batchSize = 200;
  let insertedPreds = 0;
  for (let i = 0; i < predRows.length; i += batchSize) {
    const batch = predRows.slice(i, i + batchSize);
    const { error: insErr } = await supabase.from('predictions').insert(batch);
    if (insErr) {
      console.error('  ❌ Error insertando predicciones:', insErr.message);
    } else {
      insertedPreds += batch.length;
    }
  }
  console.log(`  ✅ Generadas ${insertedPreds} predicciones.`);

  // Generar early picks (pre_tournament_picks)
  console.log('  ⏳ Generando early picks aleatorios...');
  const teamIds = teams.map(t => t.id);
  const picksRows = [];
  const seen = new Set();
  for (const { user_id, group_id } of groupMembers) {
    const key = `${user_id}:${group_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const shuffled = [...teamIds].sort(() => Math.random() - 0.5);
    picksRows.push({
      user_id,
      group_id,
      champion_team_id:  shuffled[0],
      finalist_team_id:  shuffled[1],
      semi1_team_id:     shuffled[2],
      semi2_team_id:     shuffled[3],
      semi3_team_id:     shuffled[4],
      semi4_team_id:     shuffled[5],
      is_locked:         false,
      bonus_points_earned: 0,
    });
  }

  if (picksRows.length > 0) {
    const { error: picksErr } = await supabase.from('pre_tournament_picks').insert(picksRows);
    if (picksErr) {
      console.error('  ❌ Error insertando early picks:', picksErr.message);
    } else {
      console.log(`  ✅ Generados ${picksRows.length} early picks.`);
    }
  }

  // 3. Distribución de 104 kickoffs secuencialmente
  console.log('  ⏳ [4/5] Distribuyendo 104 kickoffs secuencialmente...');
  const now = Date.now();
  const total_ms = durationMinutes * 60 * 1000;
  const group_duration_ms = 0.40 * total_ms;
  const gap_ms = 1 * 60 * 1000; // 1 minuto
  const knockout_active_time = Math.max(0.1 * total_ms, 0.60 * total_ms - 6 * gap_ms);

  // Proporciones knockout
  const koWeights = {
    R32:   0.25,
    R16:   1/6,
    QF:    1/6,
    SF:    1/6,
    '3rd': 1/12,
    final: 1/6
  };

  const schedule = {};
  
  // group stage
  schedule.group = { start: 0, end: group_duration_ms };
  
  // R32
  schedule.R32 = { 
    start: schedule.group.end + gap_ms, 
    end:   schedule.group.end + gap_ms + koWeights.R32 * knockout_active_time 
  };
  
  // R16
  schedule.R16 = { 
    start: schedule.R32.end + gap_ms, 
    end:   schedule.R32.end + gap_ms + koWeights.R16 * knockout_active_time 
  };
  
  // QF
  schedule.QF = { 
    start: schedule.R16.end + gap_ms, 
    end:   schedule.R16.end + gap_ms + koWeights.QF * knockout_active_time 
  };
  
  // SF
  schedule.SF = { 
    start: schedule.QF.end + gap_ms, 
    end:   schedule.QF.end + gap_ms + koWeights.SF * knockout_active_time 
  };
  
  // 3rd
  schedule['3rd'] = { 
    start: schedule.SF.end + gap_ms, 
    end:   schedule.SF.end + gap_ms + koWeights['3rd'] * knockout_active_time 
  };
  
  // final
  schedule.final = { 
    start: schedule['3rd'].end + gap_ms, 
    end:   schedule['3rd'].end + gap_ms + koWeights.final * knockout_active_time 
  };

  const updates = [];
  for (const round of ROUND_ORDER) {
    const roundMatches = matches.filter(m => m.round === round);
    if (roundMatches.length === 0) continue;

    const limits = schedule[round];
    const N = roundMatches.length;

    for (let i = 0; i < N; i++) {
      const offset = limits.start + (limits.end - limits.start) * (i / (N - 1 || 1));
      const kickoffDate = new Date(now + offset);
      updates.push({
        id: roundMatches[i].id,
        kickoff_utc: kickoffDate.toISOString()
      });
    }
  }

  // Ejecutar updates en lotes de 20
  let updatedMatches = 0;
  const updateBatchSize = 20;
  for (let i = 0; i < updates.length; i += updateBatchSize) {
    const batch = updates.slice(i, i + updateBatchSize);
    await Promise.all(batch.map(u => 
      supabase.from('matches').update({ kickoff_utc: u.kickoff_utc }).eq('id', u.id)
    ));
    updatedMatches += batch.length;
  }
  console.log(`  ✅ Kickoffs distribuidos para ${updatedMatches} partidos.`);

  // 4. Guardar config en la base de datos
  console.log('  ⏳ [5/5] Actualizando configuración en Supabase app_config...');
  const end_at = new Date(now + total_ms).toISOString();
  await Promise.all([
    supabase.from('app_config').upsert({ key: 'simulation_duration_minutes', value: durationMinutes.toString(), updated_at: new Date().toISOString() }),
    supabase.from('app_config').upsert({ key: 'simulation_end_at', value: end_at, updated_at: new Date().toISOString() }),
    supabase.from('app_config').upsert({ key: 'simulation_mode', value: 'true', updated_at: new Date().toISOString() })
  ]);
  console.log('  ✅ Configuración guardada.');
  
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('🎉 SIMULACIÓN COMPLETAMENTE CONFIGURADA Y LISTA');
  console.log(`   Duración total:   ${durationMinutes} minutos`);
  console.log(`   Finalización:     ${new Date(now + total_ms).toLocaleString()}`);
  console.log('══════════════════════════════════════════════════════════════\n');
}

// ═════════════════════════════════════════════════════════════════════════════
//  SYNC DIARIO DE KICKOFFS (API-Football → Supabase)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Mapa de nombres de equipos en inglés (API-Football) al español usado en la DB.
 */
const NOMBRE_MAP = {
  'Mexico': 'México', 'South Africa': 'Sudáfrica', 'South Korea': 'Corea del Sur',
  'Czech Republic': 'Chequia', 'Czechia': 'Chequia', 'Canada': 'Canadá',
  'Bosnia': 'Bosnia-Herzegovina', 'Bosnia & Herzegovina': 'Bosnia-Herzegovina',
  'United States': 'USA', 'Haiti': 'Haití', 'Scotland': 'Escocia',
  'Turkey': 'Turquía', 'Türkiye': 'Turquía', 'Brazil': 'Brasil',
  'Morocco': 'Marruecos', 'Switzerland': 'Suiza', "Ivory Coast": 'Costa de Marfil',
  "Cote d'Ivoire": 'Costa de Marfil', 'Germany': 'Alemania', 'Curaçao': 'Curazao',
  'Curacao': 'Curazao', 'Norway': 'Noruega', 'Algeria': 'Argelia', 'Jordan': 'Jordania',
  'Panama': 'Panamá', 'England': 'Inglaterra', 'Croatia': 'Croacia',
  'DR Congo': 'Congo DR', 'Uzbekistan': 'Uzbekistán', 'Netherlands': 'Países Bajos',
  'Sweden': 'Suecia', 'Tunisia': 'Túnez', 'Japan': 'Japón', 'Cape Verde': 'Cabo Verde',
  'Cape Verde Islands': 'Cabo Verde', 'Spain': 'España', 'Saudi Arabia': 'Arabia Saudita',
  'Belgium': 'Bélgica', 'Iran': 'Irán', 'New Zealand': 'Nueva Zelanda', 'Egypt': 'Egipto',
  'France': 'Francia', 'Paraguay': 'Paraguay', 'Australia': 'Australia',
  'Ecuador': 'Ecuador', 'Portugal': 'Portugal', 'Colombia': 'Colombia',
  'Uruguay': 'Uruguay', 'Argentina': 'Argentina', 'Qatar': 'Qatar', 'Iraq': 'Iraq',
  'Senegal': 'Senegal', 'Ghana': 'Ghana', 'Austria': 'Austria',
};

/**
 * Sincroniza kickoff_utc y wc_api_id de todos los partidos con datos de API-Football.
 * Se ejecuta al arrancar y luego cada 24 horas.
 *
 * Flujo:
 *   1. GET /fixtures?league=1&season=2026  → lista completa de fixtures de la API.
 *   2. SELECT matches con sus equipos desde Supabase.
 *   3. Para cada partido con home y away conocidos, buscar el fixture coincidente
 *      por nombre español (usando NOMBRE_MAP).
 *   4. Si encontró → comparar kickoff_utc y wc_api_id; actualizar solo si cambiaron.
 *   5. Loggear resumen.
 */
async function syncFixtures() {
  console.log('\n[syncFixtures] ⏳ Iniciando sincronización de kickoffs desde API-Football...');

  // ── 1. Obtener fixtures de la API ──────────────────────────────────────────
  let apiFixtures = [];
  try {
    const url = 'https://v3.football.api-sports.io/fixtures?league=1&season=2026';
    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`API-Football respondió con ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    apiFixtures = data.response || [];
    console.log(`[syncFixtures] ✅ ${apiFixtures.length} fixtures obtenidos de API-Football.`);
  } catch (err) {
    console.error('[syncFixtures] ❌ Error al obtener fixtures de API-Football:', err.message);
    return;
  }

  if (apiFixtures.length === 0) {
    console.warn('[syncFixtures] ⚠️  La API no devolvió fixtures. Abortando sync.');
    return;
  }

  // Construir índice: "homeEs|awayEs" → fixture (para búsqueda rápida)
  const fixtureIndex = new Map();
  for (const f of apiFixtures) {
    const homeEn = f.teams?.home?.name || '';
    const awayEn = f.teams?.away?.name || '';
    const homeEs = NOMBRE_MAP[homeEn] || homeEn;
    const awayEs = NOMBRE_MAP[awayEn] || awayEn;
    // Indexar por ambas direcciones para mayor robustez
    fixtureIndex.set(`${homeEs}|${awayEs}`, f);
    fixtureIndex.set(`${awayEs}|${homeEs}`, f);
  }

  // ── 2. Obtener partidos con sus equipos desde Supabase ────────────────────
  const { data: dbMatches, error: dbErr } = await supabase
    .from('matches')
    .select(`
      id,
      wc_api_id,
      kickoff_utc,
      t1:home_team_id ( name ),
      t2:away_team_id ( name )
    `);

  if (dbErr || !dbMatches) {
    console.error('[syncFixtures] ❌ Error al consultar matches en Supabase:', dbErr?.message);
    return;
  }

  // ── 3. Cruzar y actualizar ────────────────────────────────────────────────
  let updated = 0;

  for (const match of dbMatches) {
    const homeName = match.t1?.name;
    const awayName = match.t2?.name;

    // Saltar partidos sin equipos asignados aún
    if (!homeName || !awayName) continue;

    const key = `${homeName}|${awayName}`;
    const fixture = fixtureIndex.get(key);

    if (!fixture) continue; // No se encontró coincidencia en la API

    const apiKickoff  = fixture.fixture?.date   ? new Date(fixture.fixture.date).toISOString() : null;
    const apiFixtureId = fixture.fixture?.id     ? String(fixture.fixture.id) : null;

    const needsUpdate =
      (apiKickoff  && apiKickoff  !== match.kickoff_utc)  ||
      (apiFixtureId && apiFixtureId !== match.wc_api_id);

    if (!needsUpdate) continue;

    const updatePayload = {};
    if (apiKickoff  && apiKickoff  !== match.kickoff_utc)  updatePayload.kickoff_utc = apiKickoff;
    if (apiFixtureId && apiFixtureId !== match.wc_api_id)  updatePayload.wc_api_id   = apiFixtureId;

    const { error: upErr } = await supabase
      .from('matches')
      .update(updatePayload)
      .eq('id', match.id);

    if (upErr) {
      console.error(`[syncFixtures] ❌ Error actualizando partido ${match.id} (${homeName} vs ${awayName}):`, upErr.message);
    } else {
      updated++;
    }
  }

  console.log(`[syncFixtures] ✅ Actualizados: ${updated} partidos.`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  SYNC DE EMPAREJAMIENTOS DE ELIMINATORIA (cada 6 horas)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Sincroniza los emparejamientos reales (home_team_id, away_team_id, kickoff_utc)
 * de los partidos de eliminatoria consultando API-Football por su wc_api_id.
 *
 * Solo actúa sobre partidos de eliminatoria que ya tienen wc_api_id asignado.
 * Ignora equipos con nombres placeholder (TBD, Winner of…, etc.).
 * No modifica partidos ya terminados.
 *
 * Se ejecuta al arrancar (después de syncFixtures) y cada 6 horas.
 */
async function syncKnockoutFixtures() {
  // En modo simulación no hay API que consultar
  if (!USE_API) {
    console.log('[syncKnockout] ℹ️  Modo simulación — sync de eliminatorias omitido.');
    return;
  }

  console.log('\n[syncKnockout] ⏳ Sincronizando emparejamientos reales de eliminatorias...');

  // ── 1. Partidos de eliminatoria con wc_api_id asignado ────────────────────
  const { data: knockoutMatches, error: matchesErr } = await supabase
    .from('matches')
    .select('id, match_number, wc_api_id, round, home_team_id, away_team_id, kickoff_utc, status')
    .not('wc_api_id', 'is', null)
    .not('round', 'eq', 'group');

  if (matchesErr || !knockoutMatches) {
    console.error('[syncKnockout] ❌ Error al obtener partidos de eliminatoria:', matchesErr?.message);
    return;
  }

  if (knockoutMatches.length === 0) {
    console.log('[syncKnockout] ℹ️  No hay partidos de eliminatoria con wc_api_id asignado.');
    return;
  }

  console.log(`[syncKnockout] 🔍 Procesando ${knockoutMatches.length} partidos de eliminatoria...`);

  // ── 2. Cargar equipos de Supabase y construir mapa nombre→id ─────────────
  const { data: dbTeams, error: teamsErr } = await supabase
    .from('teams')
    .select('id, name, code');

  if (teamsErr || !dbTeams) {
    console.error('[syncKnockout] ❌ Error al obtener equipos:', teamsErr?.message);
    return;
  }

  // Mapa nombre español (lowercase) → team_id
  const teamIdByName = {};
  for (const t of dbTeams) {
    teamIdByName[t.name.toLowerCase()] = t.id;
  }

  // Helper: detecta nombres placeholder de la API (TBD, Winner of…, etc.)
  const isPlaceholder = (name) => {
    if (!name) return true;
    const n = name.toLowerCase();
    return n === 'tbd' || n.includes('winner') || n.includes('runner') ||
           n.includes('loser') || n.includes('group') || n === 'to be decided';
  };

  // Helper: inglés API-Football → team_id Supabase
  // Usa NOMBRE_MAP (inglés→español) para encontrar el nombre en la BD.
  const resolveTeamId = (apiNameEn) => {
    if (isPlaceholder(apiNameEn)) return null;
    const nameEs = NOMBRE_MAP[apiNameEn] || apiNameEn;
    return teamIdByName[nameEs.toLowerCase()] || null;
  };

  // ── 3. Consultar API por cada partido y actualizar si hay cambios ─────────
  let updated = 0;
  let skipped = 0;

  for (const match of knockoutMatches) {
    try {
      const result = await getApiResult(match.wc_api_id);
      const fixture = result?.rawFixture;

      if (!fixture) {
        console.warn(`[syncKnockout] ⚠️  Partido #${match.match_number} — fixture no encontrado en API.`);
        skipped++;
        continue;
      }

      const apiHomeNameEn = fixture.teams?.home?.name;
      const apiAwayNameEn = fixture.teams?.away?.name;

      // Extraer kickoff y validar que sea de 2026 (descarta fixtures incorrectos de años anteriores)
      const rawDate = fixture.fixture?.date ? new Date(fixture.fixture.date) : null;
      const apiKickoff = (rawDate && rawDate.getFullYear() >= 2026)
        ? rawDate.toISOString()
        : null;

      if (fixture.fixture?.date && !apiKickoff) {
        console.warn(`[syncKnockout] ⚠️  Partido #${match.match_number} — la API devuelvió kickoff de ${rawDate.getFullYear()} (wc_api_id posiblemente incorrecto). kickoff_utc no se actualizará.`);
      }

      const homeId = resolveTeamId(apiHomeNameEn);
      const awayId = resolveTeamId(apiAwayNameEn);

      // Construir payload solo con campos que realmente cambiaron
      const updatePayload = {};
      if (homeId && homeId !== match.home_team_id) updatePayload.home_team_id = homeId;
      if (awayId && awayId !== match.away_team_id)  updatePayload.away_team_id  = awayId;
      if (apiKickoff && apiKickoff !== match.kickoff_utc) updatePayload.kickoff_utc = apiKickoff;

      if (Object.keys(updatePayload).length === 0) {
        skipped++;
        continue; // Sin cambios
      }

      // Log legible: nombre anterior → nombre nuevo
      const prevHome = match.home_team_id
        ? (dbTeams.find(t => t.id === match.home_team_id)?.name ?? '?') : '?';
      const prevAway = match.away_team_id
        ? (dbTeams.find(t => t.id === match.away_team_id)?.name ?? '?') : '?';
      const newHome  = homeId
        ? (dbTeams.find(t => t.id === homeId)?.name || apiHomeNameEn) : prevHome;
      const newAway  = awayId
        ? (dbTeams.find(t => t.id === awayId)?.name || apiAwayNameEn) : prevAway;

      console.log(`[syncKnockout] Actualizando partido #${match.match_number}: ${prevHome} vs ${prevAway} → ${newHome} vs ${newAway}`);

      const { error: upErr } = await supabase
        .from('matches')
        .update(updatePayload)
        .eq('id', match.id);

      if (upErr) {
        console.error(`[syncKnockout] ❌ Error actualizando partido #${match.match_number}:`, upErr.message);
      } else {
        updated++;
      }

      // Pausa de 500ms entre requests para no saturar la API
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[syncKnockout] ❌ Error en partido #${match.match_number}:`, err.message);
      skipped++;
    }
  }

  console.log(`[syncKnockout] ✅ ${updated} partidos actualizados, ${skipped} sin cambios o con error.`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  CORRECIÓN DE wc_api_id INCORRECTOS EN ELIMINATORIA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Corrige los wc_api_id incorrectos de los partidos de eliminatoria
 * cruzando la lista completa de fixtures del Mundial 2026 (API-Football)
 * con los partidos en Supabase por nombre de equipos.
 *
 * Flujo:
 *   1. GET /fixtures?league=1&season=2026  → todos los fixtures del torneo.
 *   2. Filtrar solo partidos de eliminatoria (excluir "Group Stage").
 *   3. Construir mapa (homeEs|awayEs) → fixture desde la API.
 *   4. Obtener matches de Supabase con sus equipos.
 *   5. Cruzar por nombre de equipo (español); si el wc_api_id o kickoff difieren → actualizar.
 *
 * Se llama UNA sola vez al arrancar, después de syncKnockoutFixtures.
 * No requiere wc_api_id previo en la BD; trabaja solo por nombre de equipo.
 */
async function fixKnockoutApiIds() {
  if (!USE_API) {
    console.log('[fixKnockoutIds] ℹ️  Modo simulación — corrección de IDs omitida.');
    return;
  }

  console.log('\n[fixKnockoutIds] ⏳ Corrigiendo wc_api_id de eliminatorias desde API-Football...');

  // ── 1. Obtener todos los fixtures del Mundial 2026 ──────────────────────
  let allFixtures = [];
  try {
    const url = `${API_FOOTBALL_BASE}/fixtures?league=1&season=2026`;
    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': API_FOOTBALL_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io',
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) throw new Error(`API-Football ${response.status} ${response.statusText}`);
    const data = await response.json();
    allFixtures = data.response || [];
    console.log(`[fixKnockoutIds] 📊 ${allFixtures.length} fixtures obtenidos de API-Football.`);
  } catch (err) {
    console.error('[fixKnockoutIds] ❌ Error al consultar API-Football:', err.message);
    return;
  }

  if (allFixtures.length === 0) {
    console.warn('[fixKnockoutIds] ⚠️  La API no devolvió fixtures. Abortando.');
    return;
  }

  // ── 2. Filtrar solo fixtures de eliminatoria ──────────────────────────
  const knockoutFixtures = allFixtures.filter(f =>
    !f.league?.round?.toLowerCase().includes('group')
  );
  console.log(`[fixKnockoutIds] 🏆 ${knockoutFixtures.length} fixtures de eliminatoria identificados.`);

  // ── 3. Construir índice (homeEs|awayEs) → fixture ──────────────────────
  // Usa NOMBRE_MAP para convertir nombres inglés→español como en la BD.
  const apiIndex = new Map();
  for (const f of knockoutFixtures) {
    const homeEn = f.teams?.home?.name || '';
    const awayEn = f.teams?.away?.name || '';
    const homeEs = NOMBRE_MAP[homeEn] || homeEn;
    const awayEs = NOMBRE_MAP[awayEn] || awayEn;
    // Indexar en ambas direcciones para mayor robustez
    apiIndex.set(`${homeEs}|${awayEs}`, f);
    apiIndex.set(`${awayEs}|${homeEs}`, f);
  }

  // ── 4. Obtener partidos de eliminatoria de Supabase (con nombres de equipo) ──
  const { data: dbMatches, error: dbErr } = await supabase
    .from('matches')
    .select(`
      id,
      match_number,
      round,
      wc_api_id,
      kickoff_utc,
      home_team:home_team_id ( name ),
      away_team:away_team_id ( name )
    `)
    .not('round', 'eq', 'group');

  if (dbErr || !dbMatches) {
    console.error('[fixKnockoutIds] ❌ Error al consultar Supabase:', dbErr?.message);
    return;
  }

  // ── 5. Cruzar y corregir ────────────────────────────────────────
  let fixed = 0;
  let unchanged = 0;
  let notFound = 0;

  for (const match of dbMatches) {
    const homeName = match.home_team?.name;
    const awayName = match.away_team?.name;

    // Saltar partidos sin equipos asignados (aún sin sembrar)
    if (!homeName || !awayName) continue;

    const key = `${homeName}|${awayName}`;
    const fixture = apiIndex.get(key);

    if (!fixture) {
      console.warn(`[fixKnockoutIds] ⚠️  No se encontró partido para: ${homeName} vs ${awayName}`);
      notFound++;
      continue;
    }

    const newApiId   = String(fixture.fixture.id);
    const rawDate    = fixture.fixture?.date ? new Date(fixture.fixture.date) : null;
    const newKickoff = (rawDate && rawDate.getFullYear() >= 2026)
      ? rawDate.toISOString()
      : null;

    const updatePayload = {};
    if (newApiId && newApiId !== match.wc_api_id)           updatePayload.wc_api_id   = newApiId;
    if (newKickoff && newKickoff !== match.kickoff_utc)     updatePayload.kickoff_utc = newKickoff;

    if (Object.keys(updatePayload).length === 0) {
      unchanged++;
      continue;
    }

    const { error: upErr } = await supabase
      .from('matches')
      .update(updatePayload)
      .eq('id', match.id);

    if (upErr) {
      console.error(`[fixKnockoutIds] ❌ Error actualizando Partido #${match.match_number}:`, upErr.message);
    } else {
      const idPart = updatePayload.wc_api_id ? ` → wc_api_id: ${newApiId}` : '';
      console.log(`[fixKnockoutIds] ✅ Partido #${match.match_number} ${homeName} vs ${awayName}${idPart}`);
      fixed++;
    }
  }

  // ── 6. Segunda pasada: partidos sin equipos asignados (cruzar por posición) ──
  const ROUND_MAP = {
    'Round of 16': 'R16',
    'Quarter-finals': 'QF',
    'Semi-finals': 'SF',
    '3rd Place Final': '3rd',
    'Final': 'final'
  };

  // Agrupar fixtures de la API por round
  const apiFixturesByDbRound = {};
  for (const f of knockoutFixtures) {
    const apiRound = f.league?.round;
    const dbRoundKey = ROUND_MAP[apiRound];
    if (dbRoundKey) {
      if (!apiFixturesByDbRound[dbRoundKey]) {
        apiFixturesByDbRound[dbRoundKey] = [];
      }
      apiFixturesByDbRound[dbRoundKey].push(f);
    }
  }

  // Ordenar fixtures cronológicamente en cada round
  for (const rKey in apiFixturesByDbRound) {
    apiFixturesByDbRound[rKey].sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
  }

  // Agrupar matches de Supabase sin equipos por round
  const dbMatchesNoTeamsByRound = {};
  for (const match of dbMatches) {
    if (!match.home_team || !match.away_team) {
      const r = match.round;
      if (!dbMatchesNoTeamsByRound[r]) {
        dbMatchesNoTeamsByRound[r] = [];
      }
      dbMatchesNoTeamsByRound[r].push(match);
    }
  }

  // Ordenar matches por match_number
  for (const rKey in dbMatchesNoTeamsByRound) {
    dbMatchesNoTeamsByRound[rKey].sort((a, b) => a.match_number - b.match_number);
  }

  let positionFixed = 0;
  for (const [dbRoundKey, matchesList] of Object.entries(dbMatchesNoTeamsByRound)) {
    const apiFixturesList = apiFixturesByDbRound[dbRoundKey] || [];
    const limit = Math.min(matchesList.length, apiFixturesList.length);

    if (limit > 0) {
      console.log(`[fixKnockoutIds] 🔗 Vinculando ${limit} partidos sin equipos en ${dbRoundKey} por orden de posición...`);
    }

    for (let i = 0; i < limit; i++) {
      const match = matchesList[i];
      const fixture = apiFixturesList[i];

      const newApiId = String(fixture.fixture.id);
      const rawDate = fixture.fixture?.date ? new Date(fixture.fixture.date) : null;
      const newKickoff = (rawDate && rawDate.getFullYear() >= 2026)
        ? rawDate.toISOString()
        : null;

      const updatePayload = {};
      if (newApiId && newApiId !== match.wc_api_id)           updatePayload.wc_api_id   = newApiId;
      if (newKickoff && newKickoff !== match.kickoff_utc)     updatePayload.kickoff_utc = newKickoff;

      if (Object.keys(updatePayload).length === 0) {
        unchanged++;
        continue;
      }

      const { error: upErr } = await supabase
        .from('matches')
        .update(updatePayload)
        .eq('id', match.id);

      if (upErr) {
        console.error(`[fixKnockoutIds] ❌ Error actualizando por posición Partido #${match.match_number}:`, upErr.message);
      } else {
        console.log(`[fixKnockoutIds] ✅ Asignado por posición Partido #${match.match_number} (${dbRoundKey} [${i}]) → wc_api_id: ${newApiId}`);
        positionFixed++;
        fixed++;
      }
    }
  }

  console.log(`[fixKnockoutIds] 🏁 Resultado: ${fixed} corregidos (${positionFixed} por posición), ${unchanged} sin cambios, ${notFound} no encontrados en API.`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  ARRANQUE
// ═════════════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════╗');
console.log('║   TikiTaka — Bridge v2.0 (Resultados)        ║');
console.log('╚══════════════════════════════════════════════╝');

if (API_MODE === 'test') {
  console.log('🔬 MODO TEST — Consumiendo mock server local (API-Football fake)');
  console.log(`   Mock URL:          ${MOCK_API_URL}`);
  console.log(`   Iniciar el mock:   node mock-api-server.cjs`);
} else if (USE_API) {
  console.log('⚽ MODO API REAL — Consultando API-Football en vivo');
  console.log(`   API-Football URL:  ${API_FOOTBALL_BASE}`);
  console.log(`   API Key:           ${API_FOOTBALL_KEY.substring(0, 8)}...`);
} else {
  console.log('🧪 MODO SIMULACIÓN — Resultados aleatorios (sin llamadas HTTP)');
  console.log(`   API_MODE actual:   ${API_MODE}`);
  console.log('   Cambiar: API_MODE=real el 11-jun-2026 o API_MODE=test para usar mock.');
}

console.log(`   Supabase URL: ${SUPABASE_URL}`);
console.log(`   Hora actual:  ${new Date().toISOString()}\n`);

// Parsear argumentos CLI
const args = process.argv.slice(2);
const startIdx = args.indexOf('start');

if (startIdx !== -1) {
  const duration = parseInt(args[startIdx + 1] || '15', 10);
  const validDuration = isNaN(duration) ? 15 : duration;
  
  startSimulation(validDuration).then(() => {
    // Iniciar el cron y tick inicial
    tick();
    updateLiveScores();
    cron.schedule('* * * * *', tick);
    cron.schedule('* * * * *', updateLiveScores);
    console.log('[OK] Cron activo — verificando cada 1 minuto.\n');

    // Sync diario de kickoffs (al arrancar + cada 24h)
    syncFixtures();
    setInterval(syncFixtures, 24 * 60 * 60 * 1000);

    // Sync de emparejamientos de eliminatoria (al arrancar + cada 1h)
    syncKnockoutFixtures();
    setInterval(syncKnockoutFixtures, 1 * 60 * 60 * 1000);

    // Corrección de wc_api_id incorrectos (al arrancar + cada 1h)
    fixKnockoutApiIds();
    setInterval(fixKnockoutApiIds, 1 * 60 * 60 * 1000);
  }).catch(err => {
    console.error('❌ Error fatal al iniciar simulación:', err);
    process.exit(1);
  });
} else {
  // Ejecutar un tick inmediato al arrancar normal
  tick();
  updateLiveScores();

  // Cron cada 1 minuto
  cron.schedule('* * * * *', tick);
  cron.schedule('* * * * *', updateLiveScores);
  console.log('[OK] Cron activo — verificando cada 1 minuto.\n');

  // Sync diario de kickoffs (al arrancar + cada 24h)
  syncFixtures();
  setInterval(syncFixtures, 24 * 60 * 60 * 1000);

  // Sync de emparejamientos de eliminatoria (al arrancar + cada 1h)
  syncKnockoutFixtures();
  setInterval(syncKnockoutFixtures, 1 * 60 * 60 * 1000);

  // Corrección de wc_api_id incorrectos (al arrancar + cada 1h)
  fixKnockoutApiIds();
  setInterval(fixKnockoutApiIds, 1 * 60 * 60 * 1000);
}

// ═════════════════════════════════════════════════════════════════════════════
//  BACKUP DE RESULTADOS (cada 30 minutos)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Respaldo de resultados: consulta API-Football para cualquier partido
 * scheduled o in_progress cuyo kickoff_utc sea mayor a 115 minutos atrás
 * y que tenga wc_api_id. Si el partido ya terminó (FT/AET/PEN), guarda
 * el resultado y calcula puntos.
 *
 * Cubre el caso en que el polling principal de bridge.js falle o no arranque
 * correctamente para algún partido.
 */
async function autoResultsBackup() {
  console.log('\n[auto-results] ─── Check backup ───');
  const cutoff = new Date(Date.now() - 115 * 60 * 1000).toISOString();

  const { data: matches, error: matchesError } = await supabase
    .from('matches')
    .select('id, match_number, round, wc_api_id, kickoff_utc, status')
    .in('status', ['scheduled', 'in_progress'])
    .lt('kickoff_utc', cutoff)
    .not('wc_api_id', 'is', null)
    .order('kickoff_utc', { ascending: true });

  if (matchesError) {
    console.error('[auto-results] ❌ Error Supabase:', matchesError.message);
    return;
  }

  if (!matches || matches.length === 0) {
    console.log('[auto-results] ✅ Sin partidos pendientes.');
    return;
  }


  for (const match of matches) {
    try {
      const res = await fetch(
        `https://v3.football.api-sports.io/fixtures?league=1&season=2026&id=${match.wc_api_id}`,
        {
          headers: {
            'x-rapidapi-key': API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io',
          },
        }
      );
      const data = await res.json();
      const fixture = data.response?.[0];
      if (!fixture) continue;

      const status = fixture.fixture?.status?.short;
      if (!['FT', 'AET', 'PEN'].includes(status)) continue;

      const homeScore = fixture.goals?.home;
      const awayScore = fixture.goals?.away;
      if (homeScore === null || awayScore === null) continue;

      await supabase
        .from('matches')
        .update({
          home_score:     homeScore,
          away_score:     awayScore,
          home_penalties: fixture.score?.penalty?.home ?? null,
          away_penalties: fixture.score?.penalty?.away ?? null,
          status:         'FT',
        })
        .eq('id', match.id);

      await supabase.rpc('calcular_puntos_partido', { p_match_id: match.id });
      console.log(`[auto-results] ✅ Partido #${match.match_number} → ${homeScore}-${awayScore}`);

      // Pausa de 1.5s entre peticiones para no saturar la API
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error(`[auto-results] ❌ Partido #${match.match_number}:`, e.message);
    }
  }
}

// Correr backup cada 30 minutos
setInterval(autoResultsBackup, 30 * 60 * 1000);
autoResultsBackup(); // primer check inmediato
