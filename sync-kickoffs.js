// sync-kickoffs.js (ES Module version)
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { readFileSync } from 'fs';

config({ path: '.env' });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !API_FOOTBALL_KEY) {
  console.error('❌ Faltan variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_KEY, API_FOOTBALL_KEY');
  process.exit(1);
}

const NOMBRE_MAP = {
  'México': ['Mexico'],
  'Sudáfrica': ['South Africa'],
  'Corea del Sur': ['South Korea'],
  'Chequia': ['Czech Republic', 'Czechia'],
  'Canadá': ['Canada'],
  'Bosnia-Herzegovina': ['Bosnia', 'Bosnia & Herzegovina', 'Bosnia and Herzegovina'],
  'USA': ['United States', 'USA'],
  'Haití': ['Haiti'],
  'Escocia': ['Scotland'],
  'Australia': ['Australia'],
  'Turquía': ['Turkey', 'Türkiye'],
  'Brasil': ['Brazil'],
  'Marruecos': ['Morocco'],
  'Qatar': ['Qatar'],
  'Suiza': ['Switzerland'],
  'Costa de Marfil': ["Ivory Coast", "Cote d'Ivoire", "Côte d'Ivoire"],
  'Ecuador': ['Ecuador'],
  'Alemania': ['Germany'],
  'Curazao': ['Curaçao', 'Curacao'],
  'Iraq': ['Iraq'],
  'Noruega': ['Norway'],
  'Argentina': ['Argentina'],
  'Argelia': ['Algeria'],
  'Austria': ['Austria'],
  'Jordania': ['Jordan'],
  'Ghana': ['Ghana'],
  'Panamá': ['Panama'],
  'Paraguay': ['Paraguay'],
  'Inglaterra': ['England'],
  'Croacia': ['Croatia'],
  'Portugal': ['Portugal'],
  'Congo DR': ['DR Congo', 'Congo DR', 'Democratic Republic of the Congo'],
  'Uzbekistán': ['Uzbekistan'],
  'Colombia': ['Colombia'],
  'Países Bajos': ['Netherlands', 'Holland'],
  'Suecia': ['Sweden'],
  'Túnez': ['Tunisia'],
  'Japón': ['Japan'],
  'Uruguay': ['Uruguay'],
  'Cabo Verde': ['Cape Verde', 'Cape Verde Islands'],
  'España': ['Spain'],
  'Arabia Saudita': ['Saudi Arabia'],
  'Bélgica': ['Belgium'],
  'Irán': ['Iran'],
  'Nueva Zelanda': ['New Zealand'],
  'Egipto': ['Egypt'],
  'Senegal': ['Senegal'],
  'Francia': ['France'],
};

const MAPA_INVERSO = {};
for (const [es, engList] of Object.entries(NOMBRE_MAP)) {
  for (const eng of engList) {
    MAPA_INVERSO[eng.toLowerCase()] = es;
  }
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  console.log('📡 Consultando API-Football...');
  const res = await fetch('https://v3.football.api-sports.io/fixtures?league=1&season=2026', {
    headers: {
      'x-rapidapi-key': API_FOOTBALL_KEY,
      'x-rapidapi-host': 'v3.football.api-sports.io',
    },
  });

  const data = await res.json();
  if (!data.response || data.response.length === 0) {
    console.error('❌ API-Football no devolvió fixtures. Respuesta:', JSON.stringify(data));
    process.exit(1);
  }

  const fixtures = data.response;
  console.log(`✅ ${fixtures.length} fixtures traídos de API-Football`);

  const fixtureMap = {};
  const sinMapeo = [];

  for (const f of fixtures) {
    const homeEng = f.teams.home.name;
    const awayEng = f.teams.away.name;
    const homeEs = MAPA_INVERSO[homeEng.toLowerCase()];
    const awayEs = MAPA_INVERSO[awayEng.toLowerCase()];

    if (homeEs && awayEs) {
      const key = `${homeEs}|${awayEs}`;
      fixtureMap[key] = {
        fixture_id: String(f.fixture.id),
        kickoff_utc: f.fixture.date,
      };
    } else {
      sinMapeo.push(`${homeEng} vs ${awayEng}`);
    }
  }

  if (sinMapeo.length > 0) {
    console.warn(`⚠️  Sin mapeo para ${sinMapeo.length} partidos de API-Football:`);
    sinMapeo.forEach(m => console.warn('   -', m));
  }

  console.log('\n📊 Consultando Supabase...');
  const { data: matches, error: matchError } = await supabase
    .from('matches')
    .select(`
      id,
      wc_api_id,
      kickoff_utc,
      home_team:home_team_id ( name ),
      away_team:away_team_id ( name )
    `);

  if (matchError) {
    console.error('❌ Error al consultar matches:', matchError);
    process.exit(1);
  }

  console.log(`✅ ${matches.length} partidos encontrados en DB\n`);

  let actualizados = 0;
  let fallidos = 0;
  const sinPartido = [];

  for (const match of matches) {
    const homeEs = match.home_team?.name;
    const awayEs = match.away_team?.name;
    const key = `${homeEs}|${awayEs}`;
    const fixture = fixtureMap[key];

    if (!fixture) {
      sinPartido.push(`${homeEs} vs ${awayEs}`);
      fallidos++;
      continue;
    }

    const { error: updateError } = await supabase
      .from('matches')
      .update({
        kickoff_utc: fixture.kickoff_utc,
        wc_api_id: fixture.fixture_id,
      })
      .eq('id', match.id);

    if (updateError) {
      console.error(`❌ Error: ${homeEs} vs ${awayEs}:`, updateError.message);
      fallidos++;
    } else {
      console.log(`✅ ${homeEs} vs ${awayEs} → ${fixture.kickoff_utc}`);
      actualizados++;
    }
  }

  console.log('\n========== RESUMEN ==========');
  console.log(`✅ Actualizados: ${actualizados}`);
  console.log(`❌ Fallidos:     ${fallidos}`);

  if (sinPartido.length > 0) {
    console.warn('\n⚠️  Sin match en API-Football:');
    sinPartido.forEach(p => console.warn('   -', p));
  }

  console.log('\n✅ Listo.');
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});