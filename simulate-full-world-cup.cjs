/**
 * simulate-full-world-cup.cjs
 * ──────────────────────────────────────────────────────────────────────────────
 * Simula el Mundial 2026 COMPLETO con tiempos reales comprimidos.
 * La Final queda agendada para mañana a las 15:00 hora local.
 *
 * Distribución de fases (desde AHORA, todo termina antes de mañana 15:00):
 *   Fase de grupos (72 partidos) → +0h … +8.9h  (cada 7.5 min)
 *   R32  (16 partidos)           → +9h … +10.5h (cada 6 min)
 *   R16  ( 8 partidos)           → +11h … +11.7h (cada 6 min)
 *   QF   ( 4 partidos)           → +12h … +12.5h (cada 10 min)
 *   SF   ( 2 partidos)           → +13h … +13.3h (cada 20 min)
 *   3rd  ( 1 partido)            → +13.75h
 *   Final( 1 partido)            → mañana a las 15:00 hora local  ← SIEMPRE ÚLTIMA
 *
 * Lo que hace el script:
 *   1) Resetea predicciones, leaderboard y scores de todos los partidos
 *   2) Genera predicciones aleatorias para todos los usuarios en los 104 partidos
 *   3) Genera early picks (pre_tournament_picks) aleatorios para cada usuario/grupo
 *   4) Actualiza kickoff_utc de todos los partidos con la distribución comprimida
 *   5) Marca 'finished' + scores aleatorios los partidos cuyo kickoff ya pasó (< NOW - 110min)
 *   6) Llama calcular_puntos_partido para cada partido terminado
 *
 * USO:
 *   node simulate-full-world-cup.cjs          → Simula
 *   node simulate-full-world-cup.cjs reset    → Sólo resetea todo a estado limpio
 */

require('dotenv').config({ path: '.env.dev' });
const { createClient } = require('@supabase/supabase-js');

// ─── Credenciales ─────────────────────────────────────────────────────────────
const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.EXPO_PUBLIC_SUPABASE_URL;

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Faltan credenciales de Supabase en .env.dev');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const rand  = (n)     => Math.floor(Math.random() * n);       // 0..n-1
const score = ()      => rand(5);                              // 0..4
const pick  = (arr)   => arr[rand(arr.length)];

/** Devuelve un ISO string desplazado offsetMs milisegundos desde ahora */
const nowPlus = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/** Número de partidos por fase */
const PHASE_COUNTS = {
  group:  72,
  R32:    16,
  R16:     8,
  QF:      4,
  SF:      2,
  '3rd':   1,
  final:   1,
};

const PHASE_ORDER = ['group', 'R32', 'R16', 'QF', 'SF', '3rd', 'final'];

const H = 3_600_000; // 1 hora en ms
const M = 60_000;    // 1 minuto en ms

/**
 * Construye un mapa phase → [isoString, isoString, ...]
 *
 * ORDEN CRONOLÓGICO GARANTIZADO (todo cabe antes de mañana 15:00):
 *   group (+0h)  → 72 partidos, cada 7.5 min  → termina en +8h52m
 *   R32   (+9h)  → 16 partidos, cada 6 min    → termina en +10h30m
 *   R16   (+11h) →  8 partidos, cada 6 min    → termina en +11h42m
 *   QF    (+12h) →  4 partidos, cada 10 min   → termina en +12h30m
 *   SF    (+13h) →  2 partidos, cada 20 min   → termina en +13h20m
 *   3rd   (+13h45m)  → 1 partido
 *   final → mañana 15:00 hora local            ← SIEMPRE LA ÚLTIMA
 */
function buildKickoffSchedule() {
  const schedule = {};

  // Fase de grupos: 72 partidos desde NOW, cada 7.5 min → termina en +8h52m
  schedule.group = Array.from({ length: 72 }, (_, i) => nowPlus(i * 7.5 * M));

  // R32: 16 partidos desde +9h, cada 6 min → termina en +10h30m
  schedule.R32 = Array.from({ length: 16 }, (_, i) => nowPlus(9 * H + i * 6 * M));

  // R16: 8 partidos desde +11h, cada 6 min → termina en +11h42m
  schedule.R16 = Array.from({ length: 8 }, (_, i) => nowPlus(11 * H + i * 6 * M));

  // QF: 4 partidos desde +12h, cada 10 min → termina en +12h30m
  schedule.QF = Array.from({ length: 4 }, (_, i) => nowPlus(12 * H + i * 10 * M));

  // SF: 2 partidos desde +13h, cada 20 min → termina en +13h20m
  schedule.SF = Array.from({ length: 2 }, (_, i) => nowPlus(13 * H + i * 20 * M));

  // 3er puesto: +13h45m (bien después de la última Semi)
  schedule['3rd'] = [nowPlus(13 * H + 45 * M)];

  // Final: mañana a las 15:00 hora local (siempre la última en orden cronológico)
  const tomorrow15 = new Date();
  tomorrow15.setDate(tomorrow15.getDate() + 1);
  tomorrow15.setHours(15, 0, 0, 0);
  schedule.final = [tomorrow15.toISOString()];

  return schedule;
}

// ─── 1. RESET ─────────────────────────────────────────────────────────────────
async function resetAll() {
  console.log('\n🔄 PASO 1 — Reseteando datos de prueba...');

  const [rPred, rLead, rMatches, rPicks] = await Promise.all([
    supabase.from('predictions').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
    supabase.from('leaderboard').update({
      total_points: 0, exact_scores: 0, correct_winners: 0,
      bonus_points: 0, matches_predicted: 0
    }).neq('id', '00000000-0000-0000-0000-000000000000'),
    supabase.from('matches').update({
      home_score: null, away_score: null, status: 'scheduled'
    }).neq('id', '00000000-0000-0000-0000-000000000000'),
    supabase.from('pre_tournament_picks').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
  ]);

  const errors = [rPred.error, rLead.error, rMatches.error, rPicks.error].filter(Boolean);
  if (errors.length) {
    errors.forEach(e => console.error('  ⚠️', e.message));
  } else {
    console.log('  ✅ Predicciones eliminadas');
    console.log('  ✅ Leaderboard reiniciado a 0');
    console.log('  ✅ Scores y status de partidos reseteados');
    console.log('  ✅ Pre-tournament picks eliminados');
  }
}

// ─── 2. CARGAR DATOS BASE ─────────────────────────────────────────────────────
async function loadBaseData() {
  console.log('\n📦 PASO 2 — Cargando datos base...');

  const [{ data: matches }, { data: users }, { data: groupMembers }, { data: teams }] = await Promise.all([
    supabase.from('matches').select('id, match_number, round').order('match_number'),
    supabase.from('users').select('id'),
    supabase.from('group_members').select('user_id, group_id'),
    supabase.from('teams').select('id'),
  ]);

  console.log(`  ✅ ${matches.length} partidos | ${users.length} usuarios | ${groupMembers.length} membresías | ${teams.length} equipos`);
  return { matches, users, groupMembers, teams };
}

// ─── 3. ACTUALIZAR KICKOFFS ───────────────────────────────────────────────────
async function updateKickoffs(matches) {
  console.log('\n📅 PASO 3 — Asignando kickoff_utc comprimidos...');

  const schedule = buildKickoffSchedule();
  const phaseIndex = {};
  PHASE_ORDER.forEach(p => { phaseIndex[p] = 0; });

  // Agrupar partidos por fase en el orden de match_number
  const updates = matches.map(m => {
    const phase = m.round;
    const idx   = phaseIndex[phase] ?? 0;
    const times = schedule[phase] || [];
    const kickoff = times[idx] || times[times.length - 1] || new Date().toISOString();
    phaseIndex[phase] = idx + 1;
    return { id: m.id, kickoff_utc: kickoff };
  });

  // Enviar en lotes de 20
  const BATCH = 20;
  let updated = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    await Promise.all(batch.map(u =>
      supabase.from('matches').update({ kickoff_utc: u.kickoff_utc }).eq('id', u.id)
    ));
    updated += batch.length;
  }

  console.log(`  ✅ ${updated} kickoffs actualizados`);

  // Mostrar resumen por fase
  PHASE_ORDER.forEach(phase => {
    const times = schedule[phase];
    const first = times[0] ? new Date(times[0]).toLocaleString() : '-';
    const last  = times[times.length - 1] ? new Date(times[times.length - 1]).toLocaleString() : '-';
    console.log(`     ${phase.padEnd(6)} (${PHASE_COUNTS[phase]}) → ${first} … ${last}`);
  });

  return updates; // retorna el mapa id → kickoff_utc
}

// ─── 4. GENERAR PREDICCIONES ──────────────────────────────────────────────────
async function generatePredictions(matches, groupMembers) {
  console.log('\n🎯 PASO 4 — Generando predicciones aleatorias...');

  const rows = [];
  for (const { user_id, group_id } of groupMembers) {
    for (const match of matches) {
      rows.push({
        user_id,
        match_id:        match.id,
        group_id,
        home_score_pred: score(),
        away_score_pred: score(),
        is_locked:       false,
        points_earned:   0,
      });
    }
  }

  console.log(`  ⏳ Insertando ${rows.length} predicciones en lotes...`);

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from('predictions').insert(rows.slice(i, i + BATCH));
    if (error) console.error(`  ⚠️ Error al insertar predicciones:`, error.message);
    else inserted += Math.min(BATCH, rows.length - i);
  }

  console.log(`  ✅ ${inserted} predicciones generadas`);
}

// ─── 5. GENERAR EARLY PICKS ───────────────────────────────────────────────────
async function generateEarlyPicks(groupMembers, teams) {
  console.log('\n🏆 PASO 5 — Generando early picks aleatorios...');

  const teamIds = teams.map(t => t.id);
  const rows = [];

  // Por cada combinación user/grupo única
  const seen = new Set();
  for (const { user_id, group_id } of groupMembers) {
    const key = `${user_id}:${group_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Elegir 6 equipos distintos aleatoriamente
    const shuffled = [...teamIds].sort(() => Math.random() - 0.5);
    rows.push({
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

  const { error } = await supabase.from('pre_tournament_picks').insert(rows);
  if (error) console.error('  ⚠️ Error al insertar early picks:', error.message);
  else       console.log(`  ✅ ${rows.length} early picks generados`);
}

// ─── 6. FINALIZAR PARTIDOS PASADOS + CALCULAR PUNTOS ─────────────────────────
async function finishPastMatches(kickoffMap) {
  console.log('\n🏁 PASO 6 — Finalizando partidos cuyo kickoff ya pasó...');

  const cutoff = new Date(Date.now() - 110 * M).toISOString(); // NOW - 110 min

  // Obtener partidos cuyo kickoff actualizado ya pasó el umbral
  const pastMatches = kickoffMap.filter(m => m.kickoff_utc < cutoff);

  if (pastMatches.length === 0) {
    console.log('  ℹ️  Ningún partido ha superado el umbral de 110 min. Todos están en el futuro.');
    return;
  }

  console.log(`  ⏳ ${pastMatches.length} partidos para finalizar...`);

  let finished = 0;
  let pointsOk = 0;

  for (const m of pastMatches) {
    const hs = score();
    const as = score();

    const { error: updateErr } = await supabase.from('matches')
      .update({ home_score: hs, away_score: as, status: 'finished' })
      .eq('id', m.id);

    if (updateErr) {
      console.error(`  ❌ Error al finalizar partido ${m.id}:`, updateErr.message);
      continue;
    }
    finished++;

    const { error: rpcErr } = await supabase.rpc('calcular_puntos_partido', { p_match_id: m.id });
    if (rpcErr) console.error(`  ⚠️ RPC error partido ${m.id}:`, rpcErr.message);
    else pointsOk++;
  }

  console.log(`  ✅ ${finished} partidos finalizados`);
  console.log(`  ✅ ${pointsOk} llamadas a calcular_puntos_partido exitosas`);
}

// ─── 7. AUXILIARES PARA ELIMINATORIAS Y TABLAS ────────────────────────────────
function calculateGroupStandings(groupMatches) {
  const stats = {};
  const ensureTeam = (teamId) => {
    if (!stats[teamId]) {
      stats[teamId] = { id: teamId, pj: 0, g: 0, e: 0, p: 0, gf: 0, gc: 0, dg: 0, pts: 0 };
    }
  };

  groupMatches.forEach(m => {
    if (m.home_team_id && m.away_team_id && m.home_score !== null && m.away_score !== null) {
      ensureTeam(m.home_team_id);
      ensureTeam(m.away_team_id);

      const h = stats[m.home_team_id];
      const a = stats[m.away_team_id];
      const hs = m.home_score;
      const as = m.away_score;

      h.pj++; a.pj++;
      h.gf += hs; h.gc += as; h.dg = h.gf - h.gc;
      a.gf += as; a.gc += hs; a.dg = a.gf - a.gc;

      if (hs > as) {
        h.g++; h.pts += 3; a.p++;
      } else if (hs < as) {
        a.g++; a.pts += 3; h.p++;
      } else {
        h.e++; h.pts++; a.e++; a.pts++;
      }
    }
  });

  return Object.values(stats).sort((a, b) =>
    b.pts - a.pts || b.dg - a.dg || b.gf - a.gf
  );
}

async function updateNextMatchTeams(match, homeTeamId, awayTeamId) {
  const { error } = await supabase
    .from('matches')
    .update({
      home_team_id: homeTeamId,
      away_team_id: awayTeamId
    })
    .eq('id', match.id);

  if (error) {
    console.error(`❌ Error al sembrar partido #${match.match_number}:`, error.message);
  } else {
    match.home_team_id = homeTeamId;
    match.away_team_id = awayTeamId;
  }
}

// ─── 8. FINALIZAR MUNDIAL COMPLETO (finish-all) ──────────────────────────────
async function finishAll() {
  console.log('\n🏁 Iniciando finalización del Mundial completo (finish-all)...');

  // Cargar todos los partidos ordenados por match_number
  const { data: allMatches, error: fetchError } = await supabase
    .from('matches')
    .select('id, match_number, round, group_name, home_team_id, away_team_id, home_score, away_score, status')
    .order('match_number', { ascending: true });

  if (fetchError) {
    console.error('❌ Error al obtener partidos:', fetchError.message);
    return;
  }

  // Agrupar partidos por ronda
  const byRound = {};
  for (const m of allMatches) {
    if (!byRound[m.round]) byRound[m.round] = [];
    byRound[m.round].push(m);
  }

  // Score knockout: sin empates (eliminatoria debe tener ganador)
  const koScore = () => {
    let hs, as;
    do { hs = rand(5); as = rand(5); } while (hs === as);
    return { hs, as };
  };

  // Finalizar un lote de partidos y calcular puntos para cada uno
  const playMatches = async (matches, isKnockout = false) => {
    let finished = 0, pointsOk = 0;
    for (const m of matches) {
      const { hs, as } = isKnockout ? koScore() : { hs: score(), as: score() };
      m.home_score = hs;
      m.away_score = as;
      const { error: upErr } = await supabase.from('matches')
        .update({ home_score: hs, away_score: as, status: 'finished' })
        .eq('id', m.id);
      if (upErr) { console.error(`  ❌ Error partido #${m.match_number}:`, upErr.message); continue; }
      finished++;
      const { error: rpcErr } = await supabase.rpc('calcular_puntos_partido', { p_match_id: m.id });
      if (rpcErr) console.error(`  ⚠️ RPC #${m.match_number}:`, rpcErr.message);
      else pointsOk++;
    }
    return { finished, pointsOk };
  };

  const getWinner = (m) => m.home_score > m.away_score ? m.home_team_id : m.away_team_id;
  const getLoser  = (m) => m.home_score > m.away_score ? m.away_team_id : m.home_team_id;

  // ── A: FASE DE GRUPOS ──────────────────────────────────────────────────────
  console.log('\n⚽ [1/8] Finalizando Fase de Grupos (72 partidos)...');
  const groupMatches = byRound['group'] || [];
  const { finished: gFin, pointsOk: gOk } = await playMatches(groupMatches, false);
  console.log(`   ✅ ${gFin} partidos finalizados | ${gOk} cálculos de puntos`);

  // ── B: CALCULAR CLASIFICADOS ───────────────────────────────────────────────
  console.log('\n📊 [2/8] Calculando clasificados de los 12 grupos...');
  const byGroup = {};
  for (const m of groupMatches) {
    const g = m.group_name || '?';
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(m);
  }

  const GROUPS = ['A','B','C','D','E','F','G','H','I','J','K','L'];
  const winners   = [];   // 12 ganadores de grupo
  const runnersUp = [];   // 12 subcampeones
  const thirdsAll = [];   // 12 terceros (se eligen los 8 mejores)

  for (const g of GROUPS) {
    const standings = calculateGroupStandings(byGroup[g] || []);
    if (standings[0]) winners.push(standings[0].id);
    if (standings[1]) runnersUp.push(standings[1].id);
    if (standings[2]) thirdsAll.push({ id: standings[2].id, pts: standings[2].pts, dg: standings[2].dg, gf: standings[2].gf });
    console.log(`   Grupo ${g}: W=${standings[0]?.id.slice(-6) || '???'}  RU=${standings[1]?.id.slice(-6) || '???'}  3°=${standings[2]?.id.slice(-6) || '???'}`);
  }

  // Seleccionar los 8 mejores terceros (por puntos, luego DG, luego GF)
  const best8Thirds = thirdsAll
    .sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf)
    .slice(0, 8)
    .map(t => t.id);

  // 32 clasificados para R32: [W_A..W_L, RU_A..RU_L, T3_1..T3_8]
  const qualified = [...winners, ...runnersUp, ...best8Thirds];
  console.log(`   ✅ ${winners.length}W + ${runnersUp.length}RU + ${best8Thirds.length} mejores 3°  →  ${qualified.length} clasificados`);

  // ── C: ROUND OF 32 ─────────────────────────────────────────────────────────
  console.log('\n🏆 [3/8] Sembrando y jugando Round of 32 (16 partidos)...');
  const r32 = byRound['R32'] || [];
  // Bracket: partido[i] = qualified[i] vs qualified[31-i]
  for (let i = 0; i < r32.length; i++) {
    await updateNextMatchTeams(r32[i], qualified[i], qualified[31 - i]);
  }
  const { finished: r32Fin, pointsOk: r32Ok } = await playMatches(r32, true);
  console.log(`   ✅ R32: ${r32Fin} partidos | ${r32Ok} puntos calculados`);

  // ── D: ROUND OF 16 ─────────────────────────────────────────────────────────
  console.log('\n🏆 [4/8] Sembrando y jugando Round of 16 (8 partidos)...');
  const r16 = byRound['R16'] || [];
  // Ganadores de R32 en pares consecutivos → R16
  for (let i = 0; i < r16.length; i++) {
    await updateNextMatchTeams(r16[i], getWinner(r32[i * 2]), getWinner(r32[i * 2 + 1]));
  }
  const { finished: r16Fin, pointsOk: r16Ok } = await playMatches(r16, true);
  console.log(`   ✅ R16: ${r16Fin} partidos | ${r16Ok} puntos calculados`);

  // ── E: CUARTOS DE FINAL ────────────────────────────────────────────────────
  console.log('\n🏆 [5/8] Sembrando y jugando Cuartos de Final (4 partidos)...');
  const qf = byRound['QF'] || [];
  for (let i = 0; i < qf.length; i++) {
    await updateNextMatchTeams(qf[i], getWinner(r16[i * 2]), getWinner(r16[i * 2 + 1]));
  }
  const { finished: qfFin, pointsOk: qfOk } = await playMatches(qf, true);
  console.log(`   ✅ QF: ${qfFin} partidos | ${qfOk} puntos calculados`);

  // ── F: SEMIFINALES ─────────────────────────────────────────────────────────
  console.log('\n🏆 [6/8] Sembrando y jugando Semifinales (2 partidos)...');
  const sf = byRound['SF'] || [];
  for (let i = 0; i < sf.length; i++) {
    await updateNextMatchTeams(sf[i], getWinner(qf[i * 2]), getWinner(qf[i * 2 + 1]));
  }
  const { finished: sfFin, pointsOk: sfOk } = await playMatches(sf, true);
  console.log(`   ✅ SF: ${sfFin} partidos | ${sfOk} puntos calculados`);

  // ── G: TERCER LUGAR ────────────────────────────────────────────────────────
  console.log('\n🥉 [7/8] Sembrando y jugando Tercer Lugar...');
  const thirdMatch = (byRound['3rd'] || [])[0];
  let t3Fin = 0;
  if (thirdMatch && sf.length >= 2) {
    await updateNextMatchTeams(thirdMatch, getLoser(sf[0]), getLoser(sf[1]));
    const r = await playMatches([thirdMatch], true);
    t3Fin = r.finished;
  }
  console.log(`   ✅ 3er lugar: ${t3Fin} partido jugado`);

  // ── H: GRAN FINAL ──────────────────────────────────────────────────────────
  console.log('\n🥇 [8/8] Sembrando y jugando la Gran Final...');
  const finalMatch = (byRound['final'] || [])[0];
  let finFin = 0;
  if (finalMatch && sf.length >= 2) {
    await updateNextMatchTeams(finalMatch, getWinner(sf[0]), getWinner(sf[1]));
    const r = await playMatches([finalMatch], true);
    finFin = r.finished;
  }
  console.log(`   ✅ Gran Final: ${finFin} partido jugado`);

  // ── RESUMEN ────────────────────────────────────────────────────────────────
  const total = gFin + r32Fin + r16Fin + qfFin + sfFin + t3Fin + finFin;
  const totalPts = gOk + r32Ok + r16Ok + qfOk + sfOk;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('🎉 MUNDIAL COMPLETO SIMULADO CON ÉXITO');
  console.log(`   Grupos:${gFin} | R32:${r32Fin} | R16:${r16Fin} | QF:${qfFin} | SF:${sfFin} | 3°:${t3Fin} | Final:${finFin}`);
  console.log(`   Total partidos: ${total}/104 | Puntos calculados: ${totalPts}`);
  console.log('══════════════════════════════════════════════════════════════');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║   simulate-full-world-cup.cjs — TikiTaka WC2026       ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`  Supabase: ${supabaseUrl}`);
  console.log(`  Hora local actual: ${new Date().toLocaleString()}`);
  console.log(`  Final programada: mañana 15:00 hora local\n`);

  const t0 = Date.now();

  await resetAll();
  const { matches, users, groupMembers, teams } = await loadBaseData();
  const kickoffMap = await updateKickoffs(matches);
  await generatePredictions(matches, groupMembers);
  await generateEarlyPicks(groupMembers, teams);
  await finishPastMatches(kickoffMap);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n🎉 ¡Simulación completa en ${elapsed}s!`);
  console.log('   La app ahora muestra el Mundial comprimido en tiempo real.');
  console.log('   El job de Railway detectará automáticamente los partidos futuros.');
  console.log('\n💡 Para limpiar todo: node simulate-full-world-cup.cjs reset\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('reset')) {
  resetAll().then(() => console.log('\n✅ Reset completado.\n'));
} else if (args.includes('finish-all')) {
  finishAll().then(() => console.log('\n✅ Proceso finish-all completado.\n'));
} else {
  main();
}
