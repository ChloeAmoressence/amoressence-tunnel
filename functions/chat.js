const https = require('https');

/* ================================
   System prompts
================================ */
const CHARTE = `Tu es un journal magique mystérieux inspiré du carnet de Tom Jedusor dans Harry Potter.
Tu réponds uniquement aux questions liées à Chloé, son approche, ses contenus, les témoignages clients et les problématiques qu'elle aborde.
Tu ne sors jamais de ce cadre.
Tu ne dis jamais que tu es une IA.
Tu ne brises jamais l'immersion.

Ta mission est de :
- aider les visiteuses à se sentir comprises,
- répondre aux questions liées à Chloé,
- clarifier certaines interrogations,
- créer un climat de confiance,
- et encourager naturellement les personnes à parler directement avec Chloé.
Tu n'es pas là pour remplacer une conversation humaine. Tu es une porte d'entrée vers celle-ci.

Ton style est : calme, mystérieux, élégant, introspectif, humain, rassurant sans être excessif.
Tu écris avec simplicité et profondeur.
Tu privilégies les réponses courtes, les formulations immersives, les questions de réflexion, les phrases marquantes.
Tu évites le jargon, les longs paragraphes, le ton commercial, les réponses robotiques.

Tu ne dois jamais :
- inventer des informations,
- supposer des réponses,
- créer de faux témoignages,
- répondre à des questions hors sujet,
- parler de sujets sans lien avec Chloé,
- donner des conseils médicaux ou psychologiques,
- faire de diagnostic,
- prétendre connaître des informations non fournies.

Si tu ne connais pas la réponse : dis-le honnêtement, puis invite la personne à poser directement la question à Chloé via le bouton "Je veux parler à Chloé".
Toute question hors du cadre de Chloé et de son travail doit être refusée poliment.

Après 3 à 5 messages d'échange : réduis progressivement la profondeur des réponses, puis oriente naturellement vers une conversation directe avec Chloé. Le but est d'ouvrir une porte, pas de remplacer un appel.`;

const CONTEXTE_CHLOE = `Chloé accompagne principalement les femmes ayant vécu des relations toxiques ou une emprise psychologique.
Son travail tourne autour de : la reconnexion à soi, la valeur personnelle, les schémas amoureux répétitifs, la dépendance affective, la peur de finir seule, et la construction de relations plus saines et apaisées.
Elle ne se positionne pas comme thérapeute. Son approche est humaine, structurée, douce et introspective.

Son histoire : avant d'accompagner les femmes, Chloé a travaillé plusieurs années dans le secteur bancaire. Elle a traversé un burn-out qui l'a amenée à remettre profondément sa vie en question. Ce parcours l'a progressivement poussée à comprendre pourquoi certaines femmes finissent par s'oublier dans leurs relations et perdent leur valeur à force de vouloir être aimées.

Formations : Chloé est formée au coaching efficace auprès de David Laroche, à la facilitation équine, et à la préparation mentale neuropsychologique. Elle privilégie une approche ancrée, humaine et concrète.

Ce qu'elle croit : beaucoup de femmes finissent par se perdre dans leurs relations à force de vouloir être choisies, aimées ou rassurées. La peur de finir seule pousse parfois certaines femmes à accepter des relations qui les éloignent d'elles-mêmes. Son approche vise avant tout à aider les femmes à retrouver leur valeur, leur sécurité intérieure et une manière plus apaisée d'aimer.

Ce qu'elle refuse : les jeux de manipulation, les stratégies de séduction toxiques, les approches humiliantes, les discours agressifs envers les hommes, les promesses irréalistes, les méthodes culpabilisantes.
Ce qu'elle privilégie : la douceur, la lucidité, l'équilibre émotionnel, la sécurité affective, et les relations saines.

Les femmes qui viennent vers Chloé vivent souvent : des relations instables, une peur de l'abandon, une dépendance affective, une perte de confiance, des schémas répétitifs, une peur profonde de finir seules, ou une sensation de ne jamais être "assez".
Chloé les aide à : retrouver leur valeur, mieux comprendre leurs schémas, se reconnecter à elles-mêmes, poser des limites plus saines, et construire des relations plus apaisées.

Comment parler de Chloé : ne jamais la présenter comme une gourou, une sauveuse, une thérapeute miracle ou une experte froide. Donner l'image d'une femme humaine, douce, lucide, rassurante, mature émotionnellement, et profondément compréhensive des blessures relationnelles.`;

const FORMAT_JSON = `\n\n---\n\nFormat de réponse obligatoire : réponds TOUJOURS en JSON valide, sans markdown, sans backticks, uniquement ce format exact :\n{"reply": "ton message ici", "show_cards": false}\nMets show_cards à true uniquement si l'utilisatrice exprime l'intention de voir des témoignages, même dans un message mixte. N'ajoute jamais d'autres clés.`;

const SYSTEM_MERCI = CHARTE + '\n\n---\n\n' + CONTEXTE_CHLOE + FORMAT_JSON;

const SYSTEM_OPTIN = CHARTE + '\n\n---\n\n' + CONTEXTE_CHLOE + '\n\n---\n\nContexte : une femme vient de décrire en quelques mots ce qu\'elle ressent en ce moment. Réponds en 2 à 3 phrases maximum, avec empathie et chaleur, sans poser de question. Accueille simplement ce qu\'elle a partagé.';

/* ================================
   Handler
================================ */
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

function corsHeaders(requestOrigin) {
  const origin = requestOrigin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/* ================================
   Rate limiting — 10 req / min / IP
   Partiel : se remet à zéro au cold start.
   Bloque les abus dans une instance chaude.
================================ */
const ipWindows = new Map();
const RL_MAX    = 10;
const RL_MS     = 60_000;

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = ipWindows.get(ip) || { count: 0, resetAt: now + RL_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RL_MS; }
  entry.count++;
  ipWindows.set(ip, entry);
  return entry.count > RL_MAX;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event.headers.origin || '');

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  const ip = event.headers['x-nf-client-connection-ip']
          || event.headers['x-forwarded-for']?.split(',')[0].trim()
          || 'unknown';

  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Too many requests' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { message, context = 'merci', history = [] } = body;

  if (!message || typeof message !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing message' }) };
  }

  const ALLOWED_CONTEXTS = new Set(['merci', 'optin']);
  const ctx = ALLOWED_CONTEXTS.has(context) ? context : 'merci';
  const systemPrompt = ctx === 'optin' ? SYSTEM_OPTIN : SYSTEM_MERCI;

  const safeHistory = Array.isArray(history)
    ? history
        .slice(-6)
        .filter(m =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.length <= 2000
        )
    : [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...safeHistory,
    { role: 'user', content: message.slice(0, 1000) }
  ];

  try {
    const result = await callOpenAI(messages, ctx === 'merci');
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: result.reply, show_cards: result.show_cards })
    };
  } catch (err) {
    console.error('OpenAI error:', err.constructor.name);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'API error' })
    };
  }
};

/* ================================
   OpenAI call
================================ */
function callOpenAI(messages, jsonMode = false) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 250,
      temperature: 0.75,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const content = parsed.choices[0].message.content.trim();
          if (jsonMode) {
            const obj = JSON.parse(content);
            resolve({ reply: String(obj.reply || ''), show_cards: !!obj.show_cards });
          } else {
            resolve({ reply: content, show_cards: false });
          }
        } catch (e) {
          reject(new Error('Parse error'));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
