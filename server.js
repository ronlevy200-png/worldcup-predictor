const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ===== הגדרות =====
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || '6c09db2d1d854002ab54fabd19b664b0';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bkudwbvudclnhlfxqdyi.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WC2026_COMPETITION_ID = 2000;

// PayPal
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'AbahceklvygZ1eZxJueCDo1IYfMsQGGaty_ml0RnWePB7Q1ObAvn8WCrFcwQpzkDe6NDcEihiyhz0MAY';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || 'ECVKZs66DyXP7OkeLQkkH87vvt32uBqRuOGGBkDpXo6PgmOe7RxxmKlWB43eFpseGFO-JA91cYikDkXK';
const PAYPAL_BASE = 'https://api-m.paypal.com'; // Live

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || 'sb_publishable_COAkdRbcmMWrMk0x9eWyrg_nzYnGJz0');

// ===== Static files =====
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== PayPal Token =====
async function getPayPalToken() {
    const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });
    const data = await res.json();
    return data.access_token;
}

// ===== יצירת PayPal Order =====
app.post('/api/paypal/create-order', async (req, res) => {
    try {
        const { amount, credits, userId } = req.body;
        if (!amount || !credits || !userId) return res.status(400).json({ error: 'Missing params' });

        const token = await getPayPalToken();
        const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: { currency_code: 'ILS', value: amount.toString() },
                    description: `${credits} קרדיטים - World Cup 2026`,
                    custom_id: `${userId}|${credits}`
                }],
                application_context: {
                    brand_name: 'World Cup 2026 Predictor',
                    locale: 'he-IL',
                    user_action: 'PAY_NOW'
                }
            })
        });

        const order = await response.json();
        res.json({ orderId: order.id });
    } catch (e) {
        console.error('PayPal create order error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ===== אישור PayPal Order ומתן קרדיטים =====
app.post('/api/paypal/capture-order', async (req, res) => {
    try {
        const { orderId, userId } = req.body;
        if (!orderId || !userId) return res.status(400).json({ error: 'Missing params' });

        const token = await getPayPalToken();
        const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        const capture = await response.json();

        if (capture.status === 'COMPLETED') {
            // שלוף כמה קרדיטים לתת
            const customId = capture.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id || '';
            const credits = parseInt(customId.split('|')[1]) || 0;

            if (credits > 0) {
                const { data: profile } = await sb.from('profiles').select('credits_balance').eq('id', userId).single();
                const current = profile?.credits_balance || 0;
                const newBalance = credits === 999 ? 9999 : current + credits; // 999 = unlimited
                await sb.from('profiles').update({ credits_balance: newBalance }).eq('id', userId);
                console.log(`✅ Added ${credits} credits to user ${userId}`);
            }

            res.json({ success: true, credits });
        } else {
            res.status(400).json({ error: 'Payment not completed', status: capture.status });
        }
    } catch (e) {
        console.error('PayPal capture error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ===== מיפוי שמות קבוצות =====
const TEAM_NAMES_HE = {
    'Mexico': 'מקסיקו', 'United States': 'ארה"ב', 'USA': 'ארה"ב', 'Canada': 'קנדה',
    'South Africa': 'דרום אפריקה', 'Morocco': 'מרוקו', 'Senegal': 'סנגל',
    'Egypt': 'מצרים', 'Ghana': 'גאנה',
    "Cote d'Ivoire": 'חוף השנהב', "Côte d'Ivoire": 'חוף השנהב',
    'Ivory Coast': 'חוף השנהב', 'Tunisia': 'תוניסיה', 'Algeria': "אלג'יריה",
    'Cameroon': 'קמרון', 'Cabo Verde': 'כף ורדה', 'Cape Verde': 'כף ורדה',
    'Cape Verde Islands': 'כף ורדה', 'Nigeria': 'ניגריה', 'Mali': 'מאלי',
    'Zambia': 'זמביה', 'Tanzania': 'טנזניה', 'Uganda': 'אוגנדה',
    'Congo DR': 'קונגו', 'DR Congo': 'קונגו', 'Democratic Republic of Congo': 'קונגו',
    'Korea Republic': 'דרום קוריאה', 'South Korea': 'דרום קוריאה',
    'Japan': 'יפן', 'Australia': 'אוסטרליה', 'Iran': 'איראן',
    'Saudi Arabia': 'ערב הסעודית', 'Qatar': 'קטאר', 'Jordan': 'ירדן',
    'Iraq': 'עיראק', 'Uzbekistan': 'אוזבקיסטן', 'China PR': 'סין',
    'Indonesia': 'אינדונזיה', 'Oman': 'עומאן', 'Bahrain': 'בחריין',
    'United Arab Emirates': 'איחוד האמירויות', 'Kuwait': 'כווית',
    'Germany': 'גרמניה', 'Spain': 'ספרד', 'France': 'צרפת',
    'England': 'אנגליה', 'Portugal': 'פורטוגל', 'Netherlands': 'הולנד',
    'Belgium': 'בלגיה', 'Croatia': 'קרואטיה', 'Austria': 'אוסטריה',
    'Switzerland': 'שוויץ', 'Scotland': 'סקוטלנד', 'Sweden': 'שבדיה',
    'Denmark': 'דנמרק', 'Norway': 'נורווגיה', 'Poland': 'פולין',
    'Ukraine': 'אוקראינה', 'Serbia': 'סרביה', 'Turkey': 'טורקיה',
    'Czechia': "צ'כיה", 'Czech Republic': "צ'כיה",
    'Bosnia and Herzegovina': 'בוסניה', 'Bosnia-Herzegovina': 'בוסניה',
    'Slovakia': 'סלובקיה', 'Hungary': 'הונגריה', 'Romania': 'רומניה',
    'Slovenia': 'סלובניה', 'Albania': 'אלבניה', 'Greece': 'יוון',
    'Finland': 'פינלנד', 'Iceland': 'איסלנד', 'Wales': 'ויילס',
    'Northern Ireland': 'צפון אירלנד', 'Republic of Ireland': 'אירלנד',
    'Kosovo': 'קוסובו', 'Montenegro': 'מונטנגרו', 'North Macedonia': 'מקדוניה',
    'Luxembourg': 'לוקסמבורג', 'Azerbaijan': "אזרבייג'אן",
    'Belarus': 'בלארוס', 'Georgia': 'גאורגיה',
    'Brazil': 'ברזיל', 'Argentina': 'ארגנטינה', 'Uruguay': 'אורוגוואי',
    'Colombia': 'קולומביה', 'Ecuador': 'אקוודור', 'Paraguay': 'פרגוואי',
    'Chile': "צ'ילה", 'Peru': 'פרו', 'Venezuela': 'ונצואלה', 'Bolivia': 'בוליביה',
    'Haiti': 'האיטי', 'Panama': 'פנמה', 'Curacao': 'קוראסאו', 'Curaçao': 'קוראסאו',
    'Honduras': 'הונדורס', 'Costa Rica': 'קוסטה ריקה',
    'El Salvador': 'אל סלבדור', 'Jamaica': "ג'מייקה",
    'Trinidad and Tobago': 'טרינידד וטובגו', 'Guatemala': 'גואטמלה',
    'New Zealand': 'ניו זילנד', 'Korea DPR': 'קוריאה הצפונית',
};

function hebrewName(name) { return TEAM_NAMES_HE[name] || name; }

// ===== שאיבת משחקים =====
async function syncMatches() {
    console.log('🔄 Syncing matches...');
    try {
        const data = await fetchFromFootballAPI(`competitions/${WC2026_COMPETITION_ID}/matches`);
        const matches = data.matches || [];
        console.log(`Found ${matches.length} matches`);

        for (const match of matches) {
            const homeHe = hebrewName(match.homeTeam.name);
            const awayHe = hebrewName(match.awayTeam.name);
            const israelDate = new Date(new Date(match.utcDate).getTime() + 3 * 60 * 60 * 1000);
            const dateStr = `${String(israelDate.getDate()).padStart(2,'0')}/${String(israelDate.getMonth()+1).padStart(2,'0')}`;
            const timeStr = `${String(israelDate.getHours()).padStart(2,'0')}:${String(israelDate.getMinutes()).padStart(2,'0')}`;

            let stage = 'group';
            const sr = match.stage || '';
            if (sr.includes('ROUND_OF_16')) stage = '16';
            else if (sr.includes('QUARTER')) stage = '8';
            else if (sr.includes('SEMI')) stage = '4';
            else if (sr.includes('FINAL') && !sr.includes('SEMI')) stage = 'final';

            await sb.from('matches').upsert({
                id: `fd-${match.id}`, api_id: match.id,
                home: homeHe, away: awayHe,
                date: dateStr, time: timeStr, stage,
                group_name: match.group ? match.group.replace('GROUP_', 'בית ').replace('_', ' ') : null,
                status: match.status,
                home_score: match.score?.fullTime?.home ?? null,
                away_score: match.score?.fullTime?.away ?? null,
                updated_at: new Date().toISOString()
            }, { onConflict: 'api_id' });

            if (match.status === 'FINISHED' && match.score?.fullTime?.home !== null) {
                await calculateScores(`fd-${match.id}`, match.score.fullTime.home, match.score.fullTime.away, stage);
            }
        }
        console.log('✅ Matches synced');
    } catch (err) { console.error('❌ Sync error:', err.message); }
}

async function fetchFromFootballAPI(endpoint) {
    const res = await fetch(`https://api.football-data.org/v4/${endpoint}`, {
        headers: { 'X-Auth-Token': FOOTBALL_API_KEY }
    });
    const remaining = res.headers.get('X-Requests-Available-Minute');
    console.log(`API calls remaining: ${remaining}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
}

// ===== חישוב ניקוד =====
async function calculateScores(matchId, homeScore, awayScore, stage) {
    const { data: existing } = await sb.from('match_results').select('calculated').eq('match_id', matchId).single();
    if (existing?.calculated) return;

    const actualDir = homeScore > awayScore ? 'home' : homeScore < awayScore ? 'away' : 'draw';
    const exactPts = { group:3, '16':4, '8':5, '4':8, final:10 }[stage] || 3;
    const dirPts   = { group:1, '16':2, '8':3, '4':4, final:5  }[stage] || 1;

    const { data: preds } = await sb.from('predictions').select('user_id, home_score, away_score').eq('match_id', matchId).not('home_score', 'is', null);
    for (const pred of preds || []) {
        const predDir = pred.home_score > pred.away_score ? 'home' : pred.home_score < pred.away_score ? 'away' : 'draw';
        let pts = 0;
        if (pred.home_score === homeScore && pred.away_score === awayScore) pts = exactPts;
        else if (predDir === actualDir) pts = dirPts;
        if (pts > 0) {
            await sb.from('predictions').update({ points_earned: pts }).eq('user_id', pred.user_id).eq('match_id', matchId);
            const { data: p } = await sb.from('profiles').select('total_score').eq('id', pred.user_id).single();
            await sb.from('profiles').update({ total_score: (p?.total_score || 0) + pts }).eq('id', pred.user_id);
        }
    }

    const { data: bots } = await sb.from('bot_predictions').select('bot_id, home_score, away_score').eq('match_id', matchId);
    for (const bp of bots || []) {
        const predDir = bp.home_score > bp.away_score ? 'home' : bp.home_score < bp.away_score ? 'away' : 'draw';
        let pts = 0;
        if (bp.home_score === homeScore && bp.away_score === awayScore) pts = exactPts;
        else if (predDir === actualDir) pts = dirPts;
        if (pts > 0) {
            const { data: bs } = await sb.from('bot_scores').select('total_score').eq('bot_id', bp.bot_id).single();
            await sb.from('bot_scores').update({ total_score: (bs?.total_score || 0) + pts }).eq('bot_id', bp.bot_id);
        }
    }

    await sb.from('match_results').upsert({ match_id: matchId, home_score: homeScore, away_score: awayScore, calculated: true, updated_at: new Date().toISOString() }, { onConflict: 'match_id' });
    console.log(`✅ Scores calculated for ${matchId}`);
}

// ===== Sync endpoint =====
app.get('/api/sync', async (req, res) => {
    if (req.query.secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    await syncMatches();
    res.json({ ok: true, time: new Date().toISOString() });
});

// ===== Start =====
const HOUR = 60 * 60 * 1000;
function startSyncLoop() {
    syncMatches();
    setInterval(syncMatches, HOUR);
    setInterval(() => {
        const h = new Date().getHours();
        if (h >= 18 || h <= 2) syncMatches();
    }, 5 * 60 * 1000);
}

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    startSyncLoop();
});
