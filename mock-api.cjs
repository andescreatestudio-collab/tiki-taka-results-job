/**
 * mock-api.js
 * Simula la WC2026 API para pruebas completas del flujo:
 *   countdown → bloqueo → resultado → puntos
 *
 * USO:
 *   node mock-api.js          → Aplica fechas simuladas y resultados
 *   node mock-api.js reset    → Restaura fechas y estado originales de junio 2026
 */

require('dotenv').config({ path: '.env.dev' });
const { createClient } = require('@supabase/supabase-js');

// ─── Credenciales ────────────────────────────────────────────────────────────
const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.EXPO_PUBLIC_SUPABASE_URL;

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: Faltan credenciales de Supabase en el archivo .env.dev');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const getRandomScore = () => Math.floor(Math.random() * 5); // 0 a 4

/** Devuelve un ISO string de: ahora + `minutes` minutos */
const nowPlusMinutes = (minutes) => {
  const d = new Date();
  d.setSeconds(d.getSeconds() + minutes * 60);
  return d.toISOString();
};

// ─── Fechas originales (junio 2026) para el reset ────────────────────────────
// Indexadas por match_number
const ORIGINAL_DATES = {
  1: '2026-06-11T19:00:00+00:00',
  2: '2026-06-12T02:00:00+00:00',
  3: '2026-06-12T19:00:00+00:00',
  4: '2026-06-13T01:00:00+00:00',
  5: '2026-06-14T01:00:00+00:00',
  6: '2026-06-14T04:00:00+00:00',
  7: '2026-06-13T22:00:00+00:00',
  8: '2026-06-13T19:00:00+00:00',
};

// ─── Configuración de simulación por match_number ────────────────────────────
/**
 * scenario: 'future'   → partido próximo (solo ajustar kickoff)
 *           'finished' → partido ya terminado (kickoff en el pasado + resultado)
 *
 * kickoffOffsetMinutes: positivo = futuro, negativo = pasado (en minutos)
 */
const MATCH_SCENARIOS = {
  1: { scenario: 'future',   kickoffOffsetMinutes: +20,  label: 'Cuenta regresiva (~20 min)' },
  2: { scenario: 'future',   kickoffOffsetMinutes: +17,  label: 'Bloqueo de pronósticos (~17 min)' },
  3: { scenario: 'finished', kickoffOffsetMinutes: -120, label: 'Terminado hace 2 horas' },
  4: { scenario: 'finished', kickoffOffsetMinutes: -60,  label: 'Terminado hace 1 hora' },
  5: { scenario: 'future',   kickoffOffsetMinutes: null, label: 'Fecha original junio 2026' },
  6: { scenario: 'future',   kickoffOffsetMinutes: null, label: 'Fecha original junio 2026' },
  7: { scenario: 'future',   kickoffOffsetMinutes: null, label: 'Fecha original junio 2026' },
  8: { scenario: 'future',   kickoffOffsetMinutes: null, label: 'Fecha original junio 2026' },
};

// ─── Función principal: aplicar simulación ───────────────────────────────────
async function mock() {
  console.log('🚀 mock-api.js · Iniciando simulación del flujo WC2026...\n');

  // 1. Obtener los primeros 8 partidos ordenados
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
    console.error('❌ Error al obtener partidos:', fetchError.message);
    return;
  }

  if (!matches || matches.length === 0) {
    console.log('ℹ️  No se encontraron partidos.');
    return;
  }

  for (const match of matches) {
    const num = match.match_number;
    const cfg = MATCH_SCENARIOS[num];
    const homeName = match.home?.name || 'Local';
    const awayName = match.away?.name || 'Visitante';

    console.log(`──────────────────────────────────────────`);
    console.log(`⚽ Partido ${num}: ${homeName} vs ${awayName}`);
    console.log(`   Escenario: ${cfg.label}`);

    // 2. Calcular kickoff_utc a usar
    const kickoffUtc = cfg.kickoffOffsetMinutes !== null
      ? nowPlusMinutes(cfg.kickoffOffsetMinutes)
      : ORIGINAL_DATES[num];

    // 3. Payload base: actualizar kickoff y asegurar scheduled si es futuro
    const updatePayload = {
      kickoff_utc: kickoffUtc,
      status: cfg.scenario === 'finished' ? 'finished' : 'scheduled',
      home_score: cfg.scenario === 'finished' ? getRandomScore() : null,
      away_score: cfg.scenario === 'finished' ? getRandomScore() : null,
    };

    const { error: updateError } = await supabase
      .from('matches')
      .update(updatePayload)
      .eq('id', match.id);

    if (updateError) {
      console.error(`   ❌ Error al actualizar:`, updateError.message);
      continue;
    }

    if (cfg.scenario === 'finished') {
      console.log(`   ✅ kickoff → ${new Date(kickoffUtc).toLocaleString()} (pasado)`);
      console.log(`   🏁 Resultado: ${homeName} ${updatePayload.home_score} - ${updatePayload.away_score} ${awayName}`);

      // 4. Calcular puntos via RPC
      const { error: rpcError } = await supabase.rpc('calcular_puntos_partido', {
        p_match_id: match.id,
      });

      if (rpcError) {
        console.error(`   ⚠️  Error al calcular puntos:`, rpcError.message);
      } else {
        console.log(`   💰 Puntos calculados exitosamente.`);
      }
    } else {
      const kickoffDisplay = cfg.kickoffOffsetMinutes !== null
        ? `en ~${cfg.kickoffOffsetMinutes} min (${new Date(kickoffUtc).toLocaleTimeString()})`
        : `fecha original: ${kickoffUtc}`;
      console.log(`   ✅ kickoff → ${kickoffDisplay}`);
    }
  }

  console.log('\n──────────────────────────────────────────');
  console.log('🏆 Simulación aplicada con éxito.\n');
  console.log('📋 Resumen del flujo de prueba:');
  console.log('   Partido 1 → cuenta regresiva activa (~20 min para el kickoff)');
  console.log('   Partido 2 → bloqueo de pronósticos activo (~17 min para el kickoff)');
  console.log('   Partido 3 → terminado hace 2h con resultado y puntos calculados');
  console.log('   Partido 4 → terminado hace 1h con resultado y puntos calculados');
  console.log('   Partidos 5-8 → fechas originales de junio 2026 (sin cambios)');
  console.log('\n💡 Para restaurar: node mock-api.js reset\n');
}

// ─── Función reset: restaurar fechas y estado originales ─────────────────────
async function reset() {
  console.log('🔄 mock-api.js · Restaurando datos originales de junio 2026...\n');

  const { data: matches, error: fetchError } = await supabase
    .from('matches')
    .select('id, match_number')
    .order('match_number', { ascending: true })
    .limit(8);

  if (fetchError) {
    console.error('❌ Error al obtener partidos:', fetchError.message);
    return;
  }

  let ok = 0;
  let fail = 0;

  for (const match of matches) {
    const num = match.match_number;
    const originalDate = ORIGINAL_DATES[num];

    const { error: updateError } = await supabase
      .from('matches')
      .update({
        kickoff_utc: originalDate,
        status: 'scheduled',
        home_score: null,
        away_score: null,
      })
      .eq('id', match.id);

    if (updateError) {
      console.error(`❌ Partido ${num}: Error al resetear →`, updateError.message);
      fail++;
    } else {
      console.log(`✅ Partido ${num} → kickoff restaurado a ${originalDate}, status: scheduled`);
      ok++;
    }
  }

  console.log(`\n🔄 Reset completado. ${ok} partidos restaurados${fail > 0 ? `, ${fail} con errores` : ''}.`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('reset')) {
  reset();
} else {
  mock();
}
