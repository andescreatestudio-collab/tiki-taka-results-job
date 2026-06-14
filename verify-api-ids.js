/**
 * verify-api-ids.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifica que los wc_api_id almacenados en Supabase correspondan a fixtures
 * reales en API-Football, para los partidos no finalizados con kickoff en los
 * próximos 3 días.
 *
 * Uso:
 *   node --env-file=.env.dev verify-api-ids.js
 *   — o —
 *   DOTENV_CONFIG_PATH=.env.dev node verify-api-ids.js  (con dotenv instalado)
 */

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// ─── Variables de entorno (.env.dev) ─────────────────────────────────────────
const SUPABASE_URL         = process.env.SUPABASE_URL         || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const API_FOOTBALL_KEY     = process.env.API_FOOTBALL_KEY     || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !API_FOOTBALL_KEY) {
  console.error('❌ Faltan variables de entorno. Asegúrate de cargar .env.dev');
  console.error('   Uso: node --env-file=.env.dev verify-api-ids.js');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Rango de fechas: hoy → +3 días ──────────────────────────────────────────
const now     = new Date();
const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

const fromUtc = now.toISOString();
const toUtc   = in3Days.toISOString();

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║   verify-api-ids.js — Verificación de wc_api_id             ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`Rango kickoff: ${fromUtc} → ${toUtc}\n`);

// ─── 1. Obtener partidos de Supabase ─────────────────────────────────────────
const { data: matches, error: dbErr } = await supabase
  .from('matches')
  .select(`
    id,
    match_number,
    wc_api_id,
    kickoff_utc,
    status,
    t1:home_team_id ( name ),
    t2:away_team_id ( name )
  `)
  .neq('status', 'finished')
  .not('wc_api_id', 'is', null)
  .gte('kickoff_utc', fromUtc)
  .lte('kickoff_utc', toUtc)
  .order('kickoff_utc', { ascending: true });

if (dbErr) {
  console.error('❌ Error al consultar Supabase:', dbErr.message);
  process.exit(1);
}

if (!matches || matches.length === 0) {
  console.log('ℹ️  No hay partidos con wc_api_id en el rango indicado.');
  process.exit(0);
}

console.log(`📋 ${matches.length} partido(s) a verificar:\n`);

// ─── 2. Verificar cada wc_api_id contra API-Football ─────────────────────────
let ok = 0;
let invalid = 0;

for (const match of matches) {
  const home = match.t1?.name ?? '???';
  const away = match.t2?.name ?? '???';
  const tag  = `Partido #${match.match_number} (${home} vs ${away})`;

  try {
    const url = `https://v3.football.api-sports.io/fixtures?id=${match.wc_api_id}`;
    const res = await fetch(url, {
      headers: {
        'x-rapidapi-key':  API_FOOTBALL_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io',
        'Content-Type':    'application/json',
      },
    });

    if (!res.ok) {
      console.log(`⚠️  ${tag}: ID ${match.wc_api_id} — HTTP ${res.status} ${res.statusText}`);
      invalid++;
      continue;
    }

    const data    = await res.json();
    const fixture = data.response?.[0];

    if (!fixture) {
      console.log(`❌ ${tag}: ID ${match.wc_api_id} INVÁLIDO`);
      invalid++;
    } else {
      const apiHome = fixture.teams?.home?.name ?? '?';
      const apiAway = fixture.teams?.away?.name ?? '?';
      console.log(`✅ ${tag}: ID ${match.wc_api_id} OK — API dice: ${apiHome} vs ${apiAway}`);
      ok++;
    }
  } catch (e) {
    console.error(`❌ ${tag}: Error de red — ${e.message}`);
    invalid++;
  }

  // Pequeña pausa para no saturar el rate limit de la API
  await new Promise(r => setTimeout(r, 500));
}

// ─── 3. Resumen ───────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────');
console.log(`✅ OK:       ${ok}`);
console.log(`❌ Inválidos: ${invalid}`);
console.log('──────────────────────────────────────────────\n');
