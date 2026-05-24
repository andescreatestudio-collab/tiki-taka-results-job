/**
 * jobs/sync-api-ids.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sincroniza los fixture IDs de API-Football con nuestra base de datos en Supabase,
 * poblando el campo `wc_api_id` de cada partido en la tabla `matches`.
 *
 * Mapeo robusto:
 *   1. Busca por coincidencia de equipos (home y away) usando un mapeo de nombres a códigos ISO.
 *   2. Si no coincide por equipos, ofrece una estrategia cronológica de respaldo.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://ruwnxeyrfvuyzddmygkd.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const API_FOOTBALL_KEY     = process.env.API_FOOTBALL_KEY     || '';
const API_FOOTBALL_BASE    = 'https://v3.football.api-sports.io';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const teamCodeMap = {
  'Mexico': 'MEX', 'South Africa': 'RSA', 'South Korea': 'KOR', 'Korea Republic': 'KOR', 'Czechia': 'CZE', 'Czech Republic': 'CZE',
  'Canada': 'CAN', 'Bosnia and Herzegovina': 'BIH', 'Bosnia-Herzegovina': 'BIH', 'Qatar': 'QAT', 'Switzerland': 'SUI',
  'Brazil': 'BRA', 'Morocco': 'MAR', 'Haiti': 'HAI', 'Scotland': 'SCO',
  'USA': 'USA', 'Paraguay': 'PAR', 'Australia': 'AUS', 'Turkey': 'TUR',
  'Germany': 'GER', 'Curacao': 'CUW', 'Curaçao': 'CUW', 'Ivory Coast': 'CIV', "Côte d'Ivoire": 'CIV', 'Ecuador': 'ECU',
  'Netherlands': 'NED', 'Japan': 'JPN', 'Sweden': 'SWE', 'Tunisia': 'TUN',
  'Belgium': 'BEL', 'Egypt': 'EGY', 'Iran': 'IRN', 'IR Iran': 'IRN', 'New Zealand': 'NZL',
  'Spain': 'ESP', 'Cape Verde': 'CPV', 'Cabo Verde': 'CPV', 'Saudi Arabia': 'KSA', 'Uruguay': 'URU',
  'France': 'FRA', 'Senegal': 'SEN', 'Iraq': 'IRQ', 'Norway': 'NOR',
  'Argentina': 'ARG', 'Algeria': 'ALG', 'Austria': 'AUT', 'Jordan': 'JOR',
  'Portugal': 'POR', 'DR Congo': 'COD', 'Congo DR': 'COD', 'Uzbekistan': 'UZB', 'Colombia': 'COL',
  'England': 'ENG', 'Croatia': 'CRO', 'Ghana': 'GHA', 'Panama': 'PAN'
};

async function syncApiIds() {
  console.log('📡 Obteniendo partidos locales desde Supabase...');
  const { data: dbMatches, error: dbErr } = await supabase
    .from('matches')
    .select(`
      id,
      match_number,
      round,
      kickoff_utc,
      home_team:teams!home_team_id(id, code, name),
      away_team:teams!away_team_id(id, code, name)
    `)
    .order('match_number', { ascending: true });

  if (dbErr) {
    console.error('❌ Error al obtener partidos de Supabase:', dbErr.message);
    process.exit(1);
  }

  console.log(`✅ Se encontraron ${dbMatches.length} partidos en Supabase.`);

  console.log('📡 Obteniendo fixtures desde API-Football (Mundial 2026)...');
  const url = `${API_FOOTBALL_BASE}/fixtures?league=1&season=2026`;
  const apiRes = await fetch(url, {
    headers: {
      'x-apisports-key': API_FOOTBALL_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!apiRes.ok) {
    console.error(`❌ Error en la API-Football: ${apiRes.status} ${apiRes.statusText}`);
    process.exit(1);
  }

  const apiData = await apiRes.json();
  const apiFixtures = apiData.response || [];
  console.log(`✅ Se encontraron ${apiFixtures.length} fixtures en API-Football.`);

  if (apiFixtures.length === 0) {
    console.warn('⚠️ No se recibieron partidos de la API externa.');
    process.exit(0);
  }

  // Ordenar API fixtures cronológicamente para tener un respaldo estable
  apiFixtures.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

  let updatedCount = 0;

  for (const fixture of apiFixtures) {
    const fixtureIdStr = String(fixture.fixture.id);
    const apiHomeName = fixture.teams.home.name;
    const apiAwayName = fixture.teams.away.name;

    const apiHomeCode = teamCodeMap[apiHomeName] || apiHomeName;
    const apiAwayCode = teamCodeMap[apiAwayName] || apiAwayName;

    // Buscar partido correspondiente por equipos
    let matchedDbMatch = dbMatches.find(m => {
      const dbHomeCode = m.home_team?.code;
      const dbAwayCode = m.away_team?.code;
      return (
        (dbHomeCode === apiHomeCode && dbAwayCode === apiAwayCode) ||
        (dbHomeCode === apiAwayCode && dbAwayCode === apiHomeCode) // por si acaso
      );
    });

    if (matchedDbMatch) {
      console.log(`🔗 [Mapeo Equipos] API Fixture ${fixtureIdStr} (${apiHomeName} vs ${apiAwayName})` +
                  ` matched with local Match #${matchedDbMatch.match_number}`);
    } else {
      // Respaldo cronológico si no coincide por nombre de equipo
      // (ej. si la API es para rondas eliminatorias genéricas que aún no tienen equipos asignados)
      const index = apiFixtures.indexOf(fixture);
      // Para fase de grupos, el orden cronológico debería coincidir 1 a 1 con match_number
      const matchNumFallback = index + 1;
      matchedDbMatch = dbMatches.find(m => m.match_number === matchNumFallback);

      if (matchedDbMatch) {
        console.log(`⏳ [Mapeo Cronológico de Respaldo] API Fixture ${fixtureIdStr} (${apiHomeName} vs ${apiAwayName})` +
                    ` matched with local Match #${matchedDbMatch.match_number}`);
      }
    }

    if (matchedDbMatch) {
      // Actualizar wc_api_id en Supabase
      const { error: updateErr } = await supabase
        .from('matches')
        .update({ wc_api_id: fixtureIdStr })
        .eq('id', matchedDbMatch.id);

      if (updateErr) {
        console.error(`❌ Error actualizando Partido #${matchedDbMatch.match_number}:`, updateErr.message);
      } else {
        updatedCount++;
      }
    } else {
      console.warn(`⚠️ No se pudo emparejar la Fixture de la API ${fixtureIdStr} (${apiHomeName} vs ${apiAwayName})`);
    }
  }

  console.log(`\n\x1b[32m🎉 ¡Sincronización completada!\x1b[0m`);
  console.log(`📊 Partidos actualizados con wc_api_id: ${updatedCount} de ${apiFixtures.length}`);
}

syncApiIds();
