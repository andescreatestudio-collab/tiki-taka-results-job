import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Faltan variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const NOMBRE_MAP = {
  'Canada': 'Canadá',
  'Morocco': 'Marruecos',
  'Paraguay': 'Paraguay',
  'France': 'Francia',
  'Brazil': 'Brasil',
  'Norway': 'Noruega',
};

const fixtures = [
  {
    fixture_id: '1567824',
    home_name: 'Canada',
    away_name: 'Morocco',
    date: '2026-07-04T17:00:00.000Z',
    match_number: 90
  },
  {
    fixture_id: '1569870',
    home_name: 'Paraguay',
    away_name: 'France',
    date: '2026-07-04T21:00:00.000Z',
    match_number: 89
  },
  {
    fixture_id: '1568100',
    home_name: 'Brazil',
    away_name: 'Norway',
    date: '2026-07-05T20:00:00.000Z',
    match_number: 91
  }
];

async function run() {
  const [teamsRes, matchesRes] = await Promise.all([
    supabase.from('teams').select('id, name'),
    supabase.from('matches').select('id, match_number').in('match_number', [89, 90, 91])
  ]);

  if (teamsRes.error) {
    console.error('Error fetching teams:', teamsRes.error.message);
    process.exit(1);
  }
  if (matchesRes.error) {
    console.error('Error fetching matches:', matchesRes.error.message);
    process.exit(1);
  }

  const teams = teamsRes.data || [];
  const matches = matchesRes.data || [];

  const teamByName = {};
  for (const t of teams) {
    teamByName[t.name.toLowerCase()] = t.id;
  }

  const matchByNumber = {};
  for (const m of matches) {
    matchByNumber[m.match_number] = m.id;
  }

  console.log('-- ============================================================');
  console.log('-- Actualización de R16 — UPDATE matches (3 partidos conocidos)');
  console.log('-- Generado:', new Date().toISOString());
  console.log('-- ============================================================\n');

  for (const f of fixtures) {
    const dbMatchId = matchByNumber[f.match_number];
    if (!dbMatchId) {
      console.error(`-- ⚠️  Sin partido Supabase para match_number ${f.match_number}`);
      continue;
    }

    const homeTranslated = NOMBRE_MAP[f.home_name] || f.home_name;
    const awayTranslated = NOMBRE_MAP[f.away_name] || f.away_name;

    const homeId = teamByName[homeTranslated.toLowerCase()];
    const awayId = teamByName[awayTranslated.toLowerCase()];

    if (!homeId) {
      console.error(`-- ⚠️  No se encontró UUID para: ${f.home_name} -> ${homeTranslated}`);
    }
    if (!awayId) {
      console.error(`-- ⚠️  No se encontró UUID para: ${f.away_name} -> ${awayTranslated}`);
    }

    // Generar SQL
    console.log(`-- Partido #${f.match_number}: ${f.home_name} vs ${f.away_name} [NS]`);
    console.log(`UPDATE matches SET`);
    console.log(`  wc_api_id    = '${f.fixture_id}',`);
    console.log(`  home_team_id = ${homeId ? `'${homeId}'` : 'NULL'},`);
    console.log(`  away_team_id = ${awayId ? `'${awayId}'` : 'NULL'},`);
    console.log(`  kickoff_utc  = '${f.date}',`);
    console.log(`  home_score   = NULL,`);
    console.log(`  away_score   = NULL,`);
    console.log(`  status       = 'scheduled'`);
    console.log(`WHERE id = '${dbMatchId}';\n`);

    // Ejecutar en Supabase
    if (homeId && awayId) {
      const { error: updateError } = await supabase
        .from('matches')
        .update({
          wc_api_id: f.fixture_id,
          home_team_id: homeId,
          away_team_id: awayId,
          kickoff_utc: f.date,
          status: 'scheduled',
          home_score: null,
          away_score: null
        })
        .eq('id', dbMatchId);

      if (updateError) {
        console.error(`-- ❌ Error actualizando match_number ${f.match_number} en Supabase:`, updateError.message);
      } else {
        console.error(`-- ✅ Match #${f.match_number} actualizado en Supabase exitosamente.`);
      }
    } else {
      console.error(`-- ⚠️ No se actualizó match_number ${f.match_number} en DB por falta de UUIDs.`);
    }
  }
}

run().catch(console.error);
