const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.dev') });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Error: SUPABASE_URL y SUPABASE_SERVICE_KEY son requeridos.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function main() {
  console.log('🏁 Iniciando recalculación de puntos para todos los partidos finalizados...');
  console.log(`Conectando a Supabase en: ${SUPABASE_URL}`);

  // Buscar todos los partidos que ya están finished y tienen home_score not null
  const { data: matches, error: matchesError } = await supabase
    .from('matches')
    .select('id, match_number, home_team_id, away_team_id, home_score, away_score, status')
    .eq('status', 'finished')
    .not('home_score', 'is', null);

  if (matchesError) {
    console.error('❌ Error al buscar partidos:', matchesError.message);
    process.exit(1);
  }

  if (!matches || matches.length === 0) {
    console.log('ℹ️ No se encontraron partidos con status = "finished" y home_score no nulo.');
    process.exit(0);
  }

  console.log(`📊 Se encontraron ${matches.length} partidos para procesar.`);

  for (const match of matches) {
    console.log(`\n🔄 Procesando Partido #${match.match_number} (${match.home_score} - ${match.away_score})...`);

    // Llamar calcular_puntos_partido via RPC
    const { error: rpcError } = await supabase.rpc('calcular_puntos_partido', {
      p_match_id: match.id
    });

    if (rpcError) {
      console.error(`❌ Error al calcular puntos para el Partido #${match.match_number}:`, rpcError.message);
    } else {
      console.log(`✅ Puntos calculados correctamente para el Partido #${match.match_number}`);
    }
  }

  console.log('\n🎉 Recalculación completa finalizada con éxito.');
}

main().catch((err) => {
  console.error('❌ Error general durante la ejecución:', err);
  process.exit(1);
});
