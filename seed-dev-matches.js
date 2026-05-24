import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Cargar variables de entorno específicas de dev
dotenv.config({ path: '.env.dev', override: true });

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, WC_API_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !WC_API_KEY) {
  console.error('❌ Faltan variables de entorno en jobs/.env.dev');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const teamCodeMap = {
  'Mexico': 'MEX', 'South Africa': 'RSA', 'South Korea': 'KOR', 'Korea Republic': 'KOR', 'Czechia': 'CZE',
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

async function seedDevMatches() {
  console.log('📡 Obteniendo partidos de la WC2026 API...');
  
  try {
    const response = await fetch('https://api.wc2026api.com/matches', {
      headers: { 'Authorization': `Bearer ${WC_API_KEY}` }
    });

    if (!response.ok) throw new Error(`Error API: ${response.statusText}`);
    const matches = await response.json();
    console.log(`✅ ${matches.length} partidos recibidos.`);

    // Obtener equipos del proyecto dev para mapear códigos a UUIDs
    const { data: teams, error: teamsError } = await supabase.from('teams').select('id, code');
    if (teamsError) {
        console.error('❌ Error al obtener equipos. ¿Ya ejecutaste el SQL en el editor de Supabase?');
        throw teamsError;
    }
    console.log(`✅ Se encontraron ${teams.length} equipos en la base de datos.`);

    const codeToId = {};
    teams.forEach(t => codeToId[t.code] = t.id);

    console.log('🔄 Mapeando partidos a IDs de equipos...');
    const seen = new Set();
    const duplicates = [];
    const matchesToInsert = matches.map(m => {
      const homeCode = teamCodeMap[m.home_team] || m.home_team;
      const awayCode = teamCodeMap[m.away_team] || m.away_team;

      if (seen.has(m.match_number)) {
        duplicates.push(m.match_number);
      }
      seen.add(m.match_number);

      return {
        match_number: m.match_number,
        round: m.round,
        group_name: m.group_name || null,
        home_team_id: codeToId[homeCode] || null,
        away_team_id: codeToId[awayCode] || null,
        kickoff_utc: m.kickoff_utc,
        stadium: m.stadium,
        city: m.city,
        status: m.status,
        wc_api_id: String(m.id)
      };
    });

    if (duplicates.length > 0) {
      console.warn('⚠️ Duplicados encontrados en la API:', duplicates);
    }

    console.log('🗑️ Limpiando tablas antes de re-sembrar...');
    await supabase.from('predictions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    
    const { error: delError } = await supabase.from('matches').delete().gt('match_number', -1);
    if (delError) console.error('❌ Error al borrar partidos:', delError.message);

    console.log(`📤 Insertando ${matchesToInsert.length} partidos en Supabase dev...`);
    const { error: insertError } = await supabase.from('matches').insert(matchesToInsert);
    
    if (insertError) throw insertError;
    console.log('🚀 ¡Sembrado exitoso de 104 partidos en el ambiente de dev!');

  } catch (error) {
    console.error('❌ Error en el proceso:', error.message);
  }
}

seedDevMatches();
