/**
 * results-job.js — TikiTaka WC2026
 * ─────────────────────────────────────────────────────────────────────────────
 * Job automático de sincronización de resultados desde la WC2026 API.
 *
 * Lógica de consultas por partido:
 *   T+15min  → 1ª consulta. Si no hay resultado, espera +15min.
 *   T+110min → 2ª consulta principal. Si 'finished' → guarda y calcula puntos.
 *              Si 'extra_time' / 'penalties' → espera +30min.
 *   T+140min → 3ª consulta.
 *   T+155min → 4ª consulta y siguientes cada 15min hasta obtener 'finished'.
 *
 * Uso:
 *   node results-job.js
 *
 * Variables de entorno requeridas (.env o hardcoded abajo):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, WC_API_KEY
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import cron from 'node-cron';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL        || 'https://ruwnxeyrfvuyzddmygkd.supabase.co';
const SUPABASE_SERVICE_KEY= process.env.SUPABASE_SERVICE_KEY|| '';
const WC_API_KEY          = process.env.WC_API_KEY          || '';
const WC_API_BASE         = 'https://api.wc2026api.com';

// ─── MODO DE OPERACIÓN ────────────────────────────────────────────────────────
// ✅ true  → Lee resultados directamente de Supabase (sin consultar la API externa).
//            Ideal para pruebas y simulaciones previas al Mundial.
// ✅ false → Consulta la WC2026 API real. Cambiar a false el 11 de junio de 2026.
const SIMULATION_MODE = true;

const MIN = 60_000; // 1 minuto en ms

// ─── CLIENTES ─────────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── ESTADO LOCAL ─────────────────────────────────────────────────────────────
// Evitar programar el mismo partido dos veces
const scheduledMatches = new Set();

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Consulta la WC2026 API para obtener el estado y resultado de un partido.
 * @param {string} wcApiId - ID externo del partido en la API
 * @returns {{ status: string, homeScore: number|null, awayScore: number|null }}
 */
async function fetchMatchFromAPI(wcApiId) {
  const url = `${WC_API_BASE}/matches/${wcApiId}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${WC_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText} — ${url}`);
  }

  const data = await response.json();
  return {
    status:    data.status || 'unknown',
    homeScore: data.home_score  ?? data.score?.home ?? null,
    awayScore: data.away_score  ?? data.score?.away ?? null,
    extraTime: ['extra_time', 'penalties', 'penalty_shootout'].includes(data.status),
  };
}

/**
 * Guarda el resultado final en Supabase y ejecuta el cálculo de puntos.
 */
async function saveResultAndCalcPoints(match, homeScore, awayScore) {
  console.log(`[RESULTADO] Partido #${match.match_number} → ${homeScore}-${awayScore}`);

  // 1. Actualizar resultado en matches
  const { error: updateError } = await supabase
    .from('matches')
    .update({
      home_score: homeScore,
      away_score: awayScore,
      status: 'finished',
    })
    .eq('id', match.id);

  if (updateError) {
    console.error(`[ERROR] No se pudo actualizar partido ${match.id}:`, updateError.message);
    return;
  }

  // 2. Llamar la función RPC para calcular puntos de todas las predicciones
  const { error: rpcError } = await supabase.rpc('calcular_puntos_partido', {
    p_match_id: match.id,
  });

  if (rpcError) {
    console.error(`[ERROR] RPC calcular_puntos_partido para ${match.id}:`, rpcError.message);
  } else {
    console.log(`[OK] Puntos calculados para partido #${match.match_number} (${match.id})`);
  }
}

/**
 * Actualiza el status del partido en Supabase (p. ej. 'in_play').
 */
async function updateMatchStatus(matchId, status) {
  await supabase.from('matches').update({ status }).eq('id', matchId);
}

/**
 * Verifica si todos los partidos de una ronda han finalizado.
 */
async function checkRoundFinished(roundName) {
  const { data, error } = await supabase
    .from('matches')
    .select('id')
    .eq('round', roundName)
    .neq('status', 'finished')
    .limit(1);

  if (error) {
    console.error(`[ERROR] [SIM] Error al verificar partidos pendientes de ${roundName}:`, error.message);
    return false;
  }
  return data && data.length === 0;
}

/**
 * Llama a una RPC de sembrado y muestra los logs de resultado.
 */
async function ejecutarSembrado(rpcName, label) {
  console.log(`[CRON] [SIM] Todos los partidos de la ronda anterior están FINISHED. Ejecutando ${rpcName}()...`);
  const { data, error } = await supabase.rpc(rpcName);
  if (error) {
    console.error(`[ERROR] [SIM] Error al ejecutar RPC ${rpcName}:`, error.message);
  } else {
    console.log(`[OK] [SIM] RPC ${rpcName} ejecutada con éxito para ${label}:`, JSON.stringify(data));
  }
}

/**
 * Lógica central: consultar la API en el momento correcto y reintentar según
 * el estado del partido. Retorna una Promise que se resuelve cuando el partido
 * termina o se agota el tiempo máximo.
 */
async function pollMatch(match) {
  const matchTag = `Partido #${match.match_number} (${match.wc_api_id})`;
  const kickoff  = new Date(match.kickoff_utc);
  const now      = Date.now();

  // ── MODO SIMULACIÓN: leer resultados directamente de Supabase ──────────────
  if (SIMULATION_MODE) {
    console.log(`[SIM] ${matchTag} — Verificando resultado en Supabase...`);
    const { data: m, error } = await supabase
      .from('matches')
      .select('home_score, away_score, status')
      .eq('id', match.id)
      .single();

    if (!error && m && m.home_score !== null && m.away_score !== null) {
      console.log(`[SIM] ${matchTag} → resultado ya disponible: ${m.home_score}-${m.away_score}`);
      await saveResultAndCalcPoints(match, m.home_score, m.away_score);
    } else {
      console.log(`[SIM] ${matchTag} → sin resultado en Supabase todavía, ignorando.`);
    }
    return; // En modo simulación no hay polling: el resultado ya está o no está.
  }

  // ── MODO REAL: polling a la WC2026 API ────────────────────────────────────
  /**
   * Programa la siguiente consulta con un delay en ms.
   * Si el partido ya terminó, resuelve la Promise.
   */
  const poll = (delayMs, attempt = 1) => new Promise((resolve) => {
    const pollAt = new Date(Date.now() + delayMs);
    console.log(`[SCHEDULE] ${matchTag} → intento ${attempt} a las ${pollAt.toISOString()}`);

    setTimeout(async () => {
      try {
        const result = await fetchMatchFromAPI(match.wc_api_id);

        if (result.status === 'finished' && result.homeScore !== null) {
          await saveResultAndCalcPoints(match, result.homeScore, result.awayScore);
          resolve();
          return;
        }

        console.log(`[POLL] ${matchTag} → status: ${result.status}, score: ${result.homeScore}-${result.awayScore}`);

        if (result.status === 'in_play') {
          await updateMatchStatus(match.id, 'in_play');
        }

        // Decidir próximo intento según tabla de reintentos
        const nextDelay = getNextDelay(attempt, result);
        if (nextDelay === null) {
          console.warn(`[TIMEOUT] ${matchTag} — máximo de intentos alcanzado.`);
          resolve();
          return;
        }
        resolve(poll(nextDelay, attempt + 1));
      } catch (err) {
        console.error(`[ERROR] ${matchTag} intento ${attempt}:`, err.message);
        // Reintento de seguridad en 10 min ante error de red
        if (attempt <= 20) {
          resolve(poll(10 * MIN, attempt + 1));
        } else {
          resolve();
        }
      }
    }, delayMs);
  });

  // Calcular delay hasta el primer intento (T+15min, nunca en el pasado)
  const firstPollAt = kickoff.getTime() + 15 * MIN;
  const initialDelay = Math.max(firstPollAt - now, 0);
  return poll(initialDelay, 1);
}

/**
 * Tabla de delays según intento y estado:
 *   Intento 1 (T+15min):   Si no inició → +15min
 *   Intento 2 (T+110min):  Si extra_time → +30min
 *   Intento 3 (T+140min):  +15min
 *   Intento 4+ (T+155min+): +15min (hasta 20 intentos ~5h)
 */
function getNextDelay(attempt, apiResult) {
  if (attempt === 1) {
    // Primera consulta: partido no inició, esperar 15min más
    return 15 * MIN;
  }
  if (attempt === 2) {
    // Consulta principal: si hay tiempo extra/penales, esperar 30min
    if (apiResult.extraTime) return 30 * MIN;
    // Si sigue 'scheduled', seguimos esperando 30min
    return 30 * MIN;
  }
  if (attempt <= 20) {
    return 15 * MIN;
  }
  return null; // Timeout
}

// ─── CRON PRINCIPAL ───────────────────────────────────────────────────────────

/**
 * Corre cada 5 minutos y busca partidos próximos (en las próximas 4 horas)
 * que aún no hayan sido programados (Modo Real) o simula partidos pasados (Modo Simulación).
 */
async function checkUpcomingMatches() {
  if (SIMULATION_MODE) {
    console.log('\n[CRON] [SIM] Buscando partidos scheduled pasados (> 2 min de kickoff)...', new Date().toISOString());
    // kickoff_utc < NOW() - interval '2 minutes'
    const cutoffTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const { data: matches, error } = await supabase
      .from('matches')
      .select('id, match_number, round, kickoff_utc, status, home_score, away_score')
      .eq('status', 'scheduled')
      .lt('kickoff_utc', cutoffTime);

    if (error) {
      console.error('[ERROR] [SIM] No se pudieron obtener partidos para simular:', error.message);
      return;
    }

    if (matches && matches.length > 0) {
      for (const match of matches) {
      console.log(`\n[CRON] [SIM] Procesando Partido #${match.match_number} (${match.round}) - Kickoff: ${match.kickoff_utc}`);
      
      const hasHomeScore = match.home_score !== null && match.home_score !== undefined;
      let finalHomeScore = match.home_score;
      let finalAwayScore = match.away_score;

      if (!hasHomeScore) {
        // Generar scores aleatorios entre 0 y 4
        finalHomeScore = Math.floor(Math.random() * 5);
        finalAwayScore = Math.floor(Math.random() * 5);
        let homePenalties = null;
        let awayPenalties = null;

        // Si es eliminatoria (R32, R16, QF, SF, 3rd, final), se manejan empates con penales
        const isKnockout = ['R32', 'R16', 'QF', 'SF', '3rd', 'final'].includes(match.round);
        if (isKnockout && finalHomeScore === finalAwayScore) {
          homePenalties = Math.floor(Math.random() * 3) + 3; // 3, 4, 5
          awayPenalties = Math.floor(Math.random() * 3) + 3; // 3, 4, 5
          if (homePenalties === awayPenalties) {
            homePenalties += 1;
          }
        }

        let logScore = `${finalHomeScore}-${finalAwayScore}`;
        if (homePenalties !== null) {
          logScore += ` (Penales: ${homePenalties}-${awayPenalties})`;
        }
        console.log(`[CRON] [SIM] Partido #${match.match_number} sin score en DB. Generados aleatorios: ${logScore}`);

        // Actualizar en Supabase
        const { error: updateError } = await supabase
          .from('matches')
          .update({
            home_score: finalHomeScore,
            away_score: finalAwayScore,
            home_penalties: homePenalties,
            away_penalties: awayPenalties,
            status: 'finished'
          })
          .eq('id', match.id);

        if (updateError) {
          console.error(`[ERROR] [SIM] No se pudo actualizar scores de partido #${match.match_number}:`, updateError.message);
          continue;
        }
        console.log(`[CRON] [SIM] Partido #${match.match_number} actualizado a finished con scores ${logScore}`);
      } else {
        // Ya tiene score pero status != 'finished' (ya que status = 'scheduled')
        console.log(`[CRON] [SIM] Partido #${match.match_number} ya tiene score en DB (${finalHomeScore}-${finalAwayScore}) pero status es scheduled.`);
        
        const { error: updateError } = await supabase
          .from('matches')
          .update({
            status: 'finished'
          })
          .eq('id', match.id);

        if (updateError) {
          console.error(`[ERROR] [SIM] No se pudo actualizar estado a finished para partido #${match.match_number}:`, updateError.message);
          continue;
        }
        console.log(`[CRON] [SIM] Partido #${match.match_number} actualizado a finished.`);
      }

      // Llamar RPC calcular_puntos_partido(partido.id)
      const { error: rpcError } = await supabase.rpc('calcular_puntos_partido', {
        p_match_id: match.id
      });

      if (rpcError) {
        console.error(`[ERROR] [SIM] RPC calcular_puntos_partido para partido #${match.match_number}:`, rpcError.message);
      } else {
        console.log(`[OK] [SIM] Puntos calculados para partido #${match.match_number}`);
      }
    }
  } else {
    console.log('[CRON] [SIM] Sin partidos pasados pendientes de finalizar.');
  }

    // Cascada de validaciones y sembrados de eliminatorias
    const groupFinished = await checkRoundFinished('group');
    if (groupFinished) {
      await ejecutarSembrado('sembrar_eliminatorias', 'R32');

      const r32Finished = await checkRoundFinished('R32');
      if (r32Finished) {
        await ejecutarSembrado('sembrar_r16', 'R16');

        const r16Finished = await checkRoundFinished('R16');
        if (r16Finished) {
          await ejecutarSembrado('sembrar_qf', 'QF');

          const qfFinished = await checkRoundFinished('QF');
          if (qfFinished) {
            await ejecutarSembrado('sembrar_sf', 'SF');

            const sfFinished = await checkRoundFinished('SF');
            if (sfFinished) {
              await ejecutarSembrado('sembrar_final', '3rd/Final');
            } else {
              console.log('[CRON] [SIM] Semifinales (SF) aún en curso.');
            }
          } else {
            console.log('[CRON] [SIM] Cuartos de Final (QF) aún en curso.');
          }
        } else {
          console.log('[CRON] [SIM] Octavos de Final (R16) aún en curso.');
        }
      } else {
        console.log('[CRON] [SIM] Dieciseisavos de Final (R32) aún en curso.');
      }
    } else {
      console.log('[CRON] [SIM] Fase de Grupos aún en curso. Quedan partidos por finalizar.');
    }
  } else {
    console.log('\n[CRON] Verificando partidos próximos...', new Date().toISOString());

    const now = new Date();
    const window = new Date(now.getTime() + 4 * 60 * MIN); // próximas 4 horas

    const { data: matches, error } = await supabase
      .from('matches')
      .select('id, match_number, wc_api_id, kickoff_utc, status')
      .eq('status', 'scheduled')
      .not('wc_api_id', 'is', null)
      .lte('kickoff_utc', window.toISOString())
      .gte('kickoff_utc', now.toISOString());

    if (error) {
      console.error('[ERROR] No se pudieron obtener partidos:', error.message);
      return;
    }

    if (!matches || matches.length === 0) {
      console.log('[CRON] Sin partidos próximos.');
      return;
    }

    for (const match of matches) {
      if (scheduledMatches.has(match.id)) continue;
      scheduledMatches.add(match.id);
      console.log(`[CRON] Programando → Partido #${match.match_number} a las ${match.kickoff_utc}`);
      pollMatch(match).finally(() => {
        scheduledMatches.delete(match.id);
      });
    }
  }
}

// ─── VERIFICACIÓN INICIAL: partidos en curso ──────────────────────────────────
/**
 * Al iniciar el proceso, también revisa si hay partidos 'in_play' o partidos
 * que ya deberían haber terminado pero siguen 'scheduled'.
 */
async function checkInProgressMatches() {
  console.log('[INIT] Verificando partidos en progreso...');
  const now = new Date();

  // Partidos que ya comenzaron pero aún están 'scheduled' o 'in_play'
  const { data: matches } = await supabase
    .from('matches')
    .select('id, match_number, wc_api_id, kickoff_utc, status')
    .in('status', ['scheduled', 'in_play'])
    .not('wc_api_id', 'is', null)
    .lt('kickoff_utc', now.toISOString());

  if (!matches || matches.length === 0) {
    console.log('[INIT] Sin partidos en curso pendientes.');
    return;
  }

  for (const match of matches) {
    if (scheduledMatches.has(match.id)) continue;
    scheduledMatches.add(match.id);
    console.log(`[INIT] Retomando → Partido #${match.match_number}`);
    // Primer intento inmediato (0ms de delay)
    pollMatch({ ...match, kickoff_utc: new Date(Date.now() - 15 * MIN).toISOString() })
      .finally(() => scheduledMatches.delete(match.id));
  }
}

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════╗');
console.log('║   TikiTaka — Results Job v1.0            ║');
console.log('╚══════════════════════════════════════════╝');
if (SIMULATION_MODE) {
  console.log('🧪 MODO SIMULACIÓN — resultados se leen de Supabase (sin WC2026 API)');
  console.log('   ➡  Cambiar SIMULATION_MODE = false el 11 de junio para el Mundial real.');
} else {
  console.log('⚽ MODO REAL — consultando la WC2026 API en vivo');
  console.log(`   WC API Key: ${WC_API_KEY.substring(0, 8)}...`);
}
console.log(`   Supabase URL: ${SUPABASE_URL}\n`);

// Verificar partidos en curso o realizar simulación inicial al iniciar
if (SIMULATION_MODE) {
  checkUpcomingMatches();
} else {
  checkInProgressMatches();
}

// Cron cada 5 minutos para detectar partidos próximos
cron.schedule('*/5 * * * *', checkUpcomingMatches);
console.log('[OK] Cron activo — verificando cada 5 minutos.');
