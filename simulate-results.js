import dotenv from 'dotenv';
dotenv.config({ path: '.env.dev', override: true });
import { createClient } from '@supabase/supabase-js';

// Leer variables de entorno (pueden ser las que usamos en el cliente o las del rol de servicio)
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Error: Faltan credenciales de Supabase en el archivo .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Función para generar score aleatorio (0 a 4)
const getRandomScore = () => Math.floor(Math.random() * 5);

async function simulate() {
  console.log("⚽ Iniciando simulación de resultados...");

  // 1. Obtener los primeros 8 partidos
  const { data: matches, error: fetchError } = await supabase
    .from('matches')
    .select(`
      id, 
      match_number, 
      home:home_team_id(name), 
      away:away_team_id(name)
    `)
    .order('match_number', { ascending: true })
    .limit(8);

  if (fetchError) {
    console.error("❌ Error al obtener los partidos:", fetchError);
    return;
  }

  if (!matches || matches.length === 0) {
    console.log("ℹ️ No se encontraron partidos para simular.");
    return;
  }

  for (const match of matches) {
    const homeScore = getRandomScore();
    const awayScore = getRandomScore();

    // 2. Actualizar scores y status
    const { error: updateError } = await supabase
      .from('matches')
      .update({
        home_score: homeScore,
        away_score: awayScore,
        status: 'finished'
      })
      .eq('id', match.id);

    if (updateError) {
      console.error(`❌ Error al actualizar el partido ${match.match_number}:`, updateError);
      continue;
    }

    const homeName = match.home?.name || 'Local';
    const awayName = match.away?.name || 'Visitante';
    console.log(`✅ Partido ${match.match_number} | ${homeName} ${homeScore} - ${awayScore} ${awayName} | Status: finished`);

    // 3. Llamar RPC para calcular los puntos
    const { error: rpcError } = await supabase.rpc('calcular_puntos_partido', {
      p_match_id: match.id
    });

    if (rpcError) {
      console.error(`⚠️ Error al calcular puntos para el partido ${match.match_number}:`, rpcError);
    } else {
      console.log(`   └─ Puntos calculados exitosamente.`);
    }
  }

  console.log("🏆 Simulación completada con éxito.");
}

async function reset() {
  console.log("🔄 Iniciando reseteo de los primeros 8 partidos...");

  const { data: matches, error: fetchError } = await supabase
    .from('matches')
    .select('id, match_number')
    .order('match_number', { ascending: true })
    .limit(8);

  if (fetchError) {
    console.error("❌ Error al obtener los partidos:", fetchError);
    return;
  }

  let resetCount = 0;

  for (const match of matches) {
    const { error: updateError } = await supabase
      .from('matches')
      .update({
        home_score: null,
        away_score: null,
        status: 'scheduled'
      })
      .eq('id', match.id);

    if (updateError) {
      console.error(`❌ Error al resetear el partido ${match.match_number}:`, updateError);
    } else {
      resetCount++;
      console.log(`✅ Partido ${match.match_number} reseteado a 'scheduled'. Scores eliminados.`);
    }
  }

  console.log(`🔄 Reseteo completado. ${resetCount} partidos restaurados.`);
}

const args = process.argv.slice(2);

if (args.includes('reset')) {
  reset();
} else {
  simulate();
}
