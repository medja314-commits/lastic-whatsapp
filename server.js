// Service intermédiaire LASTIC : reçoit les demandes de l'application Android
// et envoie les messages WhatsApp via l'API Cloud de Meta.
// Aucun identifiant n'est écrit dans ce fichier : tout vient des variables d'environnement.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v23.0';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const SERVICE_API_KEY = process.env.SERVICE_API_KEY;
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || 'fr';
// Noms des modèles approuvés par Meta (à créer dans WhatsApp Manager)
const TEMPLATE_PAYMENT = process.env.TEMPLATE_PAYMENT || 'confirmation_paiement';
const TEMPLATE_LATE = process.env.TEMPLATE_LATE || 'relance_retard';

// Stockage local : journal des envois et liste des références déjà envoyées
const DATA_DIR = path.join(__dirname, 'data');
const JOURNAL_FILE = path.join(DATA_DIR, 'journal.jsonl');
const SENT_FILE = path.join(DATA_DIR, 'envois.json');

const missing = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'SERVICE_API_KEY'].filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.warn(`Variables manquantes : ${missing.join(', ')}. Les envois échoueront tant qu'elles ne sont pas définies.`);
}

function loadSentKeys() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveSentKeys(keys) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SENT_FILE, JSON.stringify([...keys], null, 2));
}

function journaliser(entree) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ date: new Date().toISOString(), ...entree }) + '\n');
}

const sentKeys = loadSentKeys();

// Numéro au format international sans + ni espaces (ex. 2250701020304)
function normalizePhone(raw) {
  return String(raw || '').replace(/[\s+\-()]/g, '');
}

function isValidPhone(phone) {
  return /^\d{8,15}$/.test(phone);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function sendTemplate(to, templateName, bodyParams) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    throw new HttpError(500, 'Service mal configuré : token ou Phone Number ID manquant');
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: TEMPLATE_LANG },
      components: [
        {
          type: 'body',
          parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })),
        },
      ],
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HttpError(502, data?.error?.message || `Erreur Meta HTTP ${res.status}`);
  }
  return data;
}

// Envoie un modèle, enregistre le résultat dans le journal et bloque les doublons
async function envoyerUnique({ route, type, phone, name, reference, templateName, params }) {
  const cle = `${route}|${reference}`;
  if (sentKeys.has(cle)) {
    throw new HttpError(409, `Message déjà envoyé pour la référence « ${reference} »`);
  }
  try {
    const data = await sendTemplate(phone, templateName, params);
    sentKeys.add(cle);
    saveSentKeys(sentKeys);
    journaliser({
      type,
      phone,
      name,
      reference,
      statut: 'envoye',
      message_id: data?.messages?.[0]?.id || null,
    });
    return data;
  } catch (err) {
    journaliser({ type, phone, name, reference, statut: 'echec', erreur: err.message });
    throw err;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new HttpError(413, 'Requête trop volumineuse'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    // Contrôle de santé (utilisé par l'hébergeur)
    if (req.method === 'GET' && req.url === '/') {
      return send(res, 200, { ok: true, service: 'lastic-whatsapp' });
    }
    if (req.method !== 'POST') {
      throw new HttpError(405, 'Méthode non autorisée');
    }
    if (!SERVICE_API_KEY || req.headers['x-api-key'] !== SERVICE_API_KEY) {
      throw new HttpError(401, 'Clé API invalide');
    }

    const body = await readJson(req);
    const phone = normalizePhone(body.phone);
    if (!isValidPhone(phone)) {
      throw new HttpError(400, 'Numéro de téléphone invalide');
    }
    const name = String(body.name || '').trim();
    if (!name) {
      throw new HttpError(400, 'Nom manquant');
    }
    // Référence unique par envoi, ex. "paiement-12-2026-10" : sert à éviter les doublons
    const reference = String(body.reference || '').trim();
    if (!reference) {
      throw new HttpError(400, 'Référence manquante (ex. paiement-12-2026-10)');
    }

    if (req.url === '/payment-confirmation') {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, 'Montant invalide');
      }
      // Ordre des variables : {{1}} = nom, {{2}} = montant payé
      const data = await envoyerUnique({
        route: req.url,
        type: 'confirmation_paiement',
        phone,
        name,
        reference,
        templateName: TEMPLATE_PAYMENT,
        params: [name, `${Math.round(amount)} CFA`],
      });
      return send(res, 200, { ok: true, data });
    }

    if (req.url === '/late-reminder') {
      const remaining = Number(body.remaining);
      if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new HttpError(400, 'Montant restant invalide');
      }
      // Ordre des variables : {{1}} = nom, {{2}} = montant restant
      const data = await envoyerUnique({
        route: req.url,
        type: 'relance_retard',
        phone,
        name,
        reference,
        templateName: TEMPLATE_LATE,
        params: [name, `${Math.round(remaining)} CFA`],
      });
      return send(res, 200, { ok: true, data });
    }

    throw new HttpError(404, 'Route inconnue');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    send(res, status, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Service WhatsApp LASTIC à l'écoute sur le port ${PORT}`);
});
