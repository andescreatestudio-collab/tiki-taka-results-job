// auto-results.js — TikiTaka WC2026
// Script de respaldo que corre cada 30 minutos.
// Busca partidos terminados en API-Football y los actualiza en Supabase
// automáticamente, en caso de que bridge.js falle.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !API_FOOTBALL_KEY) {
  console.error('❌ Faltan variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_KEY, API_FOOTBALL_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

async function fetchApiResult(wcApiId) {
  const url = `https://v3.football.api-sports.io/fixtures?league=1&season=2026&id=${wcApiId}`;
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-key': API_FOOTBALL_KEY,
      'x-rapidapi-host': 'v3.football.api-sports.io',
    },
  });

  if (!res.ok) throw new Error(`API-Football ${res.status} ${res.statusText}`);

  const data = await res.json();
  const fixture = data.response?.[0];
  if (!fixture) throw new Error(`Sin datos para fixture ${wcApiId}`);

  const statusShort = fixture.fixture?.status?.short;
  const isFinished = ['FT', 'AET', 'PEN'].includes(statusShort);

  return {
    isFinished,
    statusShort,
    homeScore: fixture.goals?.home ?? null,
    awayScore: fixture.goals?.away ?? null,
    homePenalties: fixture.score?.penalty?.home ?? null,
    awayPenalties: fixture.score?.penalty?.away ?? null,
  };
}

async function processPendingMatches() {
  const now = new Date().toISOString();
  console.log(`\n[auto-results] ─── Check ${now} ───`);

  // Buscar partidos que deberian haber terminado:
  // 1. scheduled con kickoff hace más de 115 minutos (partido + tiempo añadido)
  // 2. in_progress con kickoff hace más de 115 minutos
  const cutoff = new Date(Date.now() - 115 * 60 * 1000).toISOString();

  const { data: matches, error } = await supabase
    .from('matches')
    .select('id, match_number, round, wc_api_id, kickoff_utc, status')
    .in('status', ['scheduled', 'in_progress'])
    .lt('kickoff_utc', cutoff)
    .not('wc_api_id', 'is', null)
    .order('kickoff_utc', { ascending: true });

  if (error) {
    console.error('[auto-results] ❌ Error consultando Supabase:', error.message);
    return;
  }

  if (!matches || matches.length === 0) {
    console.log('[auto-results] ✅ Sin partidos pendientes.');
    return;
  }

  console.log(`[auto-results] Encontrados ${matches.length} partidos para verificar.`);

  for (const match of matches) {
    const tag = `Partido #${match.match_number} (${match.round}) [${match.wc_api_id}]`;

    try {
      const result = await fetchApiResult(match.wc_api_id);

      if (!result.isFinished) {
        console.log(`[auto-results] ⏳ ${tag} → status: ${result.statusShort} — aún no terminó.`);
        continue;
      }

      if (result.homeScore === null || result.awayScore === null) {
        console.log(`[auto-results] ⚠️  ${tag} → FT pero sin scores. Saltando.`);
        continue;
      }

      // Guardar resultado
      const { error: updateErr } = await supabase
        .from('matches')
        .update({
          home_score: result.homeScore,
          away_score: result.awayScore,
          home_penalties: result.homePenalties,
          away_penalties: result.awayPenalties,
          status: 'finished',
        })
        .eq('id', match.id);

      if (updateErr) {
        console.error(`[auto-results] ❌ Error guardando ${tag}:`, updateErr.message);
        continue;
      }

      console.log(`[auto-results] ✅ ${tag} → ${result.homeScore}-${result.awayScore}`);

      // Calcular puntos
      const { error: rpcErr } = await supabase.rpc('calcular_puntos_partido', {
        p_match_id: match.id,
      });

      if (rpcErr) {
        console.error(`[auto-results] ❌ RPC calcular_puntos_partido para ${tag}:`, rpcErr.message);
      } else {
        console.log(`[auto-results] ✅ Puntos calculados para ${tag}`);
      }

    } catch (err) {
      console.error(`[auto-results] ❌ Error procesando ${tag}:`, err.message);
    }

    // Pequeña pausa entre llamadas a API para no saturar rate limits
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════╗');
console.log('║   TikiTaka — Auto-Results v1.0 (Respaldo)    ║');
console.log('╚══════════════════════════════════════════════╝');
console.log(`   Intervalo: cada 30 minutos`);
console.log(`   Supabase:  ${SUPABASE_URL}`);
console.log(`   Hora:      ${new Date().toISOString()}\n`);

// Primer check inmediato al arrancar
processPendingMatches();

// Luego cada 30 minutos
setInterval(processPendingMatches, INTERVAL_MS);
