# Service WhatsApp LASTIC

Petit service qui reçoit les demandes de l'application Android et envoie les messages
WhatsApp via l'API Cloud de Meta. Aucune dépendance npm : Node.js 18 ou plus suffit.

## 1. Lancer en local

```bash
cd whatsapp-service
cp .env.example .env        # puis renseigner les valeurs
export $(grep -v '^#' .env | xargs)   # Linux/macOS ; sous Windows, définir les variables manuellement
node server.js
```

Le service écoute sur `http://localhost:3000`. Depuis l'émulateur Android, l'hôte est `10.0.2.2`.

## 2. Routes

Toutes les routes sont en `POST`, avec l'en-tête `x-api-key` égal à `SERVICE_API_KEY`.

| Route | Corps JSON | Message envoyé |
|---|---|---|
| `/payment-confirmation` | `{"phone":"+2250701020304","name":"M. Kouassi","amount":5000}` | Confirmation de paiement |
| `/late-reminder` | `{"phone":"+2250701020304","name":"M. Kouassi","remaining":2000}` | Relance de retard |

Exemple de test :

```bash
curl -X POST http://localhost:3000/payment-confirmation \
  -H "Content-Type: application/json" -H "x-api-key: MA_CLE" \
  -d '{"phone":"+2250701020304","name":"M. Kouassi","amount":5000}'
```

## 3. Modèles de message à créer chez Meta

Dans WhatsApp Manager → Modèles de message, catégorie **Utilité**, langue **Français** :

- **confirmation_paiement** (nom à mettre dans `TEMPLATE_PAYMENT`) :
  `Bonjour {{1}}, votre paiement de {{2}} pour la mutuelle LASTIC a bien été enregistré. Merci.`
- **relance_retard** (nom à mettre dans `TEMPLATE_LATE`) :
  `Bonjour {{1}}, votre cotisation mutuelle est en retard. Il reste {{2}} à régler. Merci de régulariser.`

L'ordre des variables `{{1}}` et `{{2}}` doit correspondre à celui envoyé par le service.

## 4. Hébergement

Déployer le dossier sur un service Node (Render, Railway, Cloud Run…) et définir les mêmes
variables d'environnement dans le tableau de bord de l'hébergeur. Renseigner ensuite l'URL
publique dans l'application (voir `WHATSAPP_SERVICE_URL` dans `app/build.gradle.kts`).

## Sécurité

- Le jeton `WHATSAPP_TOKEN` reste uniquement dans les variables d'environnement du serveur.
- La clé `SERVICE_API_KEY` est aussi présente dans l'application : elle protège le service contre
  les appels anonymes, mais elle peut être extraite d'un APK. Pour une mise en production,
  ajoute une authentification par utilisateur.
- Envoie uniquement aux adhérents qui ont accepté d'être contactés sur WhatsApp.
