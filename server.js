const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== הגדרות =====
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || '6c09db2d1d854002ab54fabd19b664b0';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bkudwbvudclnhlfxqdyi.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Service Role Key - מ-Supabase
const WC2026_COMPETITION_ID = 2000; // World Cup ב-football-data.org

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_COAkdRbcmMWrMk0x9eWyrg_nzYnGJz0');

// ===== Static files =====
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== פונקציית fetch מה-API =====
async function fetchFromFootballAPI(endpoint) {
    const url = `https://api.football-data.org/v4/${endpoint}`;
    const response = await fetch(url, {
        headers: { 'X-Auth-Token': FOOTBALL_API_KEY }
    });
    
    // בדוק rate limit headers
    const remaining = response.headers.get('X-Requests-Available-Minute');
    console.log(`API calls remaining this minute: ${remaining}`);
    
    if (!response.ok) {
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

// ===== מיפוי שמות קבוצות מאנגלית לעברית =====
const TEAM_NAMES_HE = {
    'Mexico': 'מקסיקו', 'South Africa': 'דרום אפריקה', 'Korea Republic': 'דרום קוריאה',
    'Czechia': "צ'כיה", 'Canada': 'קנדה', 'Bosnia and Herzegovina': 'בוסניה',
    'USA': "ארה\"ב", 'United States': "ארה\"ב", 'Paraguay': 'פרגוואי',
    'Qatar': 'קטאר', 'Switzerland': 'שוויץ', 'Brazil': 'ברזיל', 'Morocco': 'מרוקו',
    'Haiti': 'האיטי', 'Scotland': 'סקוטלנד', 'Australia': 'אוסטרליה', 'Turkey': 'טורקיה',
    'Germany': 'גרמניה', 'Curaçao': 'קוראסאו', 'Netherlands': 'הולנד', 'Japan': 'יפן',
    "Côte d'Ivoire": 'חוף השנהב', 'Ecuador': 'אקוודור', 'Sweden': 'שבדיה',
    'Tunisia': 'תוניסיה', 'Spain': 'ספרד', 'Cabo Verde': 'כף ורדה', 'Belgium': 'בלגיה',
    'Egypt': 'מצרים', 'Saudi Arabia': 'ערב הסעודית', 'Uruguay': 'אורוגוואי',
    'Iran': 'איראן', 'New Zealand': 'ניו זילנד', 'France': 'צרפת', 'Senegal': 'סנגל',
    'Iraq': 'עיראק', 'Norway': 'נורווגיה', 'Argentina': 'ארגנטינה', 'Algeria': "אלג'יריה",
    'Austria': 'אוסטריה', 'Jordan': 'ירדן', 'England': 'אנגליה', 'Portugal': 'פורטוגל',
    'Croatia': 'קרואטיה', 'Colombia': 'קולומביה', 'Ghana': 'גאנה', 'Cameroon': 'קמרון',
    'Panama': 'פנמה', 'Korea DPR': 'קוריאה הצפונית', 'Serbia': 'סרביה',
    'Denmark': 'דנמרק', 'Poland': 'פולין', 'Ukraine': 'אוקראינה',
};

function hebrewName(englishName) {
    return TEAM_NAMES_HE[englishName] || englishName;
}

// ===== שאיבת משחקים ועדכון Supabase =====
async function syncMatches() {
    console.log('🔄 Syncing matches from football-data.org...');
    try {
        const data = await fetchFromFootballAPI(`competitions/${WC2026_COMPETITION_ID}/matches`);
        const matches = data.matches || [];
        console.log(`Found ${matches.length} matches`);

        for (const match of matches) {
            const homeHe = hebrewName(match.homeTeam.name);
            const awayHe = hebrewName(match.awayTeam.name);
            const matchDate = new Date(match.utcDate);
            // המרה לשעון ישראל (UTC+3)
            const israelDate = new Date(matchDate.getTime() + 3 * 60 * 60 * 1000);
            const dateStr = `${String(israelDate.getDate()).padStart(2,'0')}/${String(israelDate.getMonth()+1).padStart(2,'0')}`;
            const timeStr = `${String(israelDate.getHours()).padStart(2,'0')}:${String(israelDate.getMinutes()).padStart(2,'0')}`;

            // קבע שלב
            let stage = 'group';
            const stageRaw = match.stage || '';
            if (stageRaw.includes('ROUND_OF_16')) stage = '16';
            else if (stageRaw.includes('QUARTER')) stage = '8';
            else if (stageRaw.includes('SEMI')) stage = '4';
            else if (stageRaw.includes('FINAL') && !stageRaw.includes('SEMI')) stage = 'final';

            // שמור/עדכן משחק
            await sb.from('matches').upsert({
                id: `fd-${match.id}`,
                api_id: match.id,
                home: homeHe,
                away: awayHe,
                date: dateStr,
                time: timeStr,
                stage: stage,
                group_name: match.group ? match.group.replace('GROUP_', 'בית ') : null,
                status: match.status,
                home_score: match.score?.fullTime?.home ?? null,
                away_score: match.score?.fullTime?.away ?? null,
                updated_at: new Date().toISOString()
            }, { onConflict: 'api_id' });

            // אם המשחק נגמר - חשב ניקוד
            if (match.status === 'FINISHED' &&
                match.score?.fullTime?.home !== null &&
                match.score?.fullTime?.away !== null) {
                await calculateScores(`fd-${match.id}`, match.score.fullTime.home, match.score.fullTime.away, stage);
            }
        }
        console.log('✅ Matches synced successfully');
    } catch (err) {
        console.error('❌ Error syncing matches:', err.message);
    }
}

// ===== חישוב ניקוד =====
async function calculateScores(matchId, homeScore, awayScore, stage) {
    // בדוק אם כבר חושב
    const { data: existing } = await sb.from('match_results')
        .select('calculated')
        .eq('match_id', matchId)
        .single();
    
    if (existing?.calculated) return; // כבר חושב, דלג

    const actualDir = homeScore > awayScore ? 'home' : homeScore < awayScore ? 'away' : 'draw';
    const exactPts = { group:3, '16':4, '8':5, '4':8, final:10 }[stage] || 3;
    const dirPts =   { group:1, '16':2, '8':3, '4':4, final:5  }[stage] || 1;

    // שלוף ניחושים
    const { data: preds } = await sb.from('predictions')
        .select('user_id, home_score, away_score')
        .eq('match_id', matchId)
        .not('home_score', 'is', null);

    for (const pred of preds || []) {
        const predDir = pred.home_score > pred.away_score ? 'home' : pred.home_score < pred.away_score ? 'away' : 'draw';
        let pts = 0;
        if (pred.home_score === homeScore && pred.away_score === awayScore) pts = exactPts;
        else if (predDir === actualDir) pts = dirPts;

        if (pts > 0) {
            await sb.from('predictions')
                .update({ points_earned: pts })
                .eq('user_id', pred.user_id)
                .eq('match_id', matchId);
            
            const { data: profile } = await sb.from('profiles')
                .select('total_score')
                .eq('id', pred.user_id)
                .single();
            
            await sb.from('profiles')
                .update({ total_score: (profile?.total_score || 0) + pts })
                .eq('id', pred.user_id);
        }
    }

    // ניקוד בוטים
    const { data: botPreds } = await sb.from('bot_predictions')
        .select('bot_id, home_score, away_score')
        .eq('match_id', matchId);

    for (const bp of botPreds || []) {
        const predDir = bp.home_score > bp.away_score ? 'home' : bp.home_score < bp.away_score ? 'away' : 'draw';
        let pts = 0;
        if (bp.home_score === homeScore && bp.away_score === awayScore) pts = exactPts;
        else if (predDir === actualDir) pts = dirPts;

        if (pts > 0) {
            const { data: bs } = await sb.from('bot_scores').select('total_score').eq('bot_id', bp.bot_id).single();
            await sb.from('bot_scores').update({ total_score: (bs?.total_score || 0) + pts }).eq('bot_id', bp.bot_id);
        }
    }

    // סמן כחושב
    await sb.from('match_results').upsert({
        match_id: matchId,
        home_score: homeScore,
        away_score: awayScore,
        calculated: true,
        updated_at: new Date().toISOString()
    }, { onConflict: 'match_id' });

    console.log(`✅ Scores calculated for match ${matchId}`);
}

// ===== Endpoint ידני לסנכרון (לבדיקה) =====
app.get('/api/sync', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== process.env.SYNC_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    await syncMatches();
    res.json({ ok: true, time: new Date().toISOString() });
});

// ===== הפעל סנכרון כל שעה =====
const HOUR = 60 * 60 * 1000;
function startSyncLoop() {
    // סנכרון ראשוני בהפעלה
    syncMatches();
    // כל שעה
    setInterval(syncMatches, HOUR);
    // כל 5 דקות בשעות משחק (06:00-02:00 שעון ישראל)
    setInterval(() => {
        const hour = new Date().getHours();
        if (hour >= 18 || hour <= 2) {
            console.log('⚽ Match hours - syncing every 5 min');
            syncMatches();
        }
    }, 5 * 60 * 1000);
}

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    startSyncLoop();
});
