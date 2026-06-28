/**
 * gen_r32_sql.mjs — genera UPDATEs para TODA la eliminatoria del Mundial 2026
 * Cubre: Round of 32, Round of 16, Quarter-finals, Semi-finals, 3rd Place Final, Final
 *
 * Para partidos con equipos conocidos → actualiza wc_api_id, home_team_id, away_team_id, kickoff_utc
 * Para partidos TBD                  → actualiza solo wc_api_id y kickoff_utc (teams quedan NULL)
 *
 * Uso: node gen_r32_sql.mjs
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_FOOTBALL_KEY     = process.env.API_FOOTBALL_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const NOMBRE_MAP = {
  'Mexico': 'México', 'South Africa': 'Sudáfrica', 'South Korea': 'Corea del Sur',
  'Czech Republic': 'Chequia', 'Czechia': 'Chequia', 'Canada': 'Canadá',
  'Bosnia': 'Bosnia-Herzegovina', 'Bosnia & Herzegovina': 'Bosnia-Herzegovina',
  'Bosnia and Herzegovina': 'Bosnia-Herzegovina',
  'United States': 'USA', 'Haiti': 'Haití', 'Scotland': 'Escocia',
  'Turkey': 'Turquía', 'Türkiye': 'Turquía', 'Brazil': 'Brasil',
  'Morocco': 'Marruecos', 'Switzerland': 'Suiza', "Ivory Coast": 'Costa de Marfil',
  "Cote d'Ivoire": 'Costa de Marfil', 'Germany': 'Alemania', 'Curaçao': 'Curazao',
  'Curacao': 'Curazao', 'Norway': 'Noruega', 'Algeria': 'Argelia', 'Jordan': 'Jordania',
  'Panama': 'Panamá', 'England': 'Inglaterra', 'Croatia': 'Croacia',
  'DR Congo': 'Congo DR', 'Congo DR': 'Congo DR', 'Uzbekistan': 'Uzbekistán',
  'Netherlands': 'Países Bajos', 'Sweden': 'Suecia', 'Tunisia': 'Túnez',
  'Japan': 'Japón', 'Cape Verde': 'Cabo Verde', 'Cape Verde Islands': 'Cabo Verde',
  'Spain': 'España', 'Saudi Arabia': 'Arabia Saudita',
  'Belgium': 'Bélgica', 'Iran': 'Irán', 'New Zealand': 'Nueva Zelanda', 'Egypt': 'Egipto',
  'France': 'Francia', 'Paraguay': 'Paraguay', 'Australia': 'Australia',
  'Ecuador': 'Ecuador', 'Portugal': 'Portugal', 'Colombia': 'Colombia',
  'Uruguay': 'Uruguay', 'Argentina': 'Argentina', 'Qatar': 'Qatar', 'Iraq': 'Iraq',
  'Senegal': 'Senegal', 'Ghana': 'Ghana', 'Austria': 'Austria',
};

// Detecta si el nombre de equipo es un placeholder (TBD, Winner of..., etc.)
const isPlaceholder = (name) => {
  if (!name) return true;
  const n = name.toLowerCase();
  return n === 'tbd' || n.includes('winner') || n.includes('runner') ||
         n.includes('loser') || n.includes('group') || n === 'to be decided';
};

// Mapeo de round string de API → round en Supabase + orden para match_number
const ROUND_MAP = {
  'Round of 32':      { dbRound: 'R32',   apiSlug: 'Round%20of%2032' },
  'Round of 16':      { dbRound: 'R16',   apiSlug: 'Round%20of%2016' },
  'Quarter-finals':   { dbRound: 'QF',    apiSlug: 'Quarter-finals'  },
  'Semi-finals':      { dbRound: 'SF',    apiSlug: 'Semi-finals'     },
  '3rd Place Final':  { dbRound: '3rd',   apiSlug: '3rd%20Place%20Final' },
  'Final':            { dbRound: 'final', apiSlug: 'Final'            },
};

// ── 1. Cargar equipos y matches de Supabase en paralelo ──────────────────────
const [teamsRes, matchesRes] = await Promise.all([
  supabase.from('teams').select('id, name, code'),
  supabase.from('matches')
    .select('id, match_number, round')
    .in('round', ['R32','R16','QF','SF','3rd','final'])
    .order('match_number', { ascending: true }),
]);

const teams   = teamsRes.data  || [];
const allDbMatches = matchesRes.data || [];

console.error(`Supabase: ${teams.length} equipos | ${allDbMatches.length} partidos de eliminatoria`);

// Mapa nombre español (lowercase) → team uuid
const teamByName = {};
for (const t of teams) teamByName[t.name.toLowerCase()] = t;

const resolveId = (apiName) => {
  if (isPlaceholder(apiName)) return null;
  const es = NOMBRE_MAP[apiName] || apiName;
  const t  = teamByName[es.toLowerCase()];
  if (!t) console.error(`  ⚠️  Sin UUID para: "${apiName}" → "${es}"`);
  return t?.id ?? null;
};

// ── 2. Header SQL ─────────────────────────────────────────────────────────────
console.log('-- ============================================================');
console.log('-- Eliminatoria completa — UPDATE matches (toda la eliminatoria)');
console.log('-- Generado:', new Date().toISOString());
console.log('-- ============================================================\n');

// ── 3. Por cada round, consultar API y generar SQL ───────────────────────────
for (const [roundName, { dbRound, apiSlug }] of Object.entries(ROUND_MAP)) {
  // Fetch a la API
  let fixtures = [];
  try {
    const resp = await fetch(
      `https://v3.football.api-sports.io/fixtures?league=1&season=2026&round=${apiSlug}`,
      { headers: { 'x-rapidapi-key': API_FOOTBALL_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' } }
    );
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const json = await resp.json();
    fixtures = json.response || [];
  } catch (err) {
    console.error(`-- ERROR fetching ${roundName}:`, err.message);
    continue;
  }

  const dbMatches = allDbMatches.filter(m => m.round === dbRound);

  console.log(`-- ─────────────────────────────────────────────────────────`);
  console.log(`-- ${roundName} (${fixtures.length} fixtures API | ${dbMatches.length} partidos DB)`);
  console.log(`-- ─────────────────────────────────────────────────────────\n`);

  if (fixtures.length === 0) {
    console.log(`-- (Sin fixtures en API para ${roundName} — partidos no publicados aún)\n`);
    continue;
  }

  // Ordenar fixtures cronológicamente para alinear con match_number
  fixtures.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

  for (let i = 0; i < fixtures.length; i++) {
    const f   = fixtures[i];
    const dbM = dbMatches[i];

    if (!dbM) {
      console.error(`-- ⚠️  Sin partido Supabase en índice ${i} para ${roundName}`);
      continue;
    }

    const homeNameEn = f.teams?.home?.name;
    const awayNameEn = f.teams?.away?.name;
    const homeIsTBD  = isPlaceholder(homeNameEn);
    const awayIsTBD  = isPlaceholder(awayNameEn);

    const homeId  = homeIsTBD ? null : resolveId(homeNameEn);
    const awayId  = awayIsTBD ? null : resolveId(awayNameEn);

    const kickoff   = new Date(f.fixture.date).toISOString();
    const apiId     = String(f.fixture.id);
    const apiStatus = f.fixture?.status?.short;
    const isFinished = ['FT','AET','PEN'].includes(apiStatus);
    const status    = isFinished ? 'FT' : 'scheduled';
    const homeScore = isFinished ? (f.goals?.home ?? 'NULL') : 'NULL';
    const awayScore = isFinished ? (f.goals?.away ?? 'NULL') : 'NULL';

    const homeLabel = homeIsTBD ? 'TBD' : (homeNameEn || '?');
    const awayLabel = awayIsTBD ? 'TBD' : (awayNameEn || '?');

    console.log(`-- Partido #${dbM.match_number}: ${homeLabel} vs ${awayLabel} [${apiStatus}]`);
    console.log(`UPDATE matches SET`);
    console.log(`  wc_api_id    = '${apiId}',`);

    if (homeId) {
      console.log(`  home_team_id = '${homeId}',`);
    } else {
      console.log(`  home_team_id = NULL,  -- TBD`);
    }

    if (awayId) {
      console.log(`  away_team_id = '${awayId}',`);
    } else {
      console.log(`  away_team_id = NULL,  -- TBD`);
    }

    console.log(`  kickoff_utc  = '${kickoff}',`);
    console.log(`  home_score   = ${homeScore},`);
    console.log(`  away_score   = ${awayScore},`);
    console.log(`  status       = '${status}'`);
    console.log(`WHERE id = '${dbM.id}';\n`);
  }
}
