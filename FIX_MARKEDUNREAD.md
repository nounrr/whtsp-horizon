# 🚨 CORRECTION URGENTE - Erreur "markedUnread"

## Sur le serveur Linux (148.230.125.221):

```bash
cd /var/www/whtsapdct

# Donner les permissions
chmod +x fix-markedunread.sh

# Exécuter le fix
./fix-markedunread.sh
```

## OU Manuel (rapide):

```bash
cd /var/www/whtsapdct

# Arrêter
pm2 stop whtsp-service

# Supprimer la session et cache
rm -rf .wwebjs_auth .wwebjs_cache

# Redémarrer
pm2 restart whtsp-service --update-env

# Voir les logs
pm2 logs whtsp-service
```

## Après le redémarrage:

1. **Scanner le QR code** qui apparaît dans les logs
2. Attendre le message **"Client prêt ✅"**
3. Tester:

```bash
curl -X POST http://localhost:3400/send-text \
  -H "x-api-key: Q9Kx6Q2f5pQAU1uYIY0YyWJp2Zb7e1w60H8rFf3yERZ3" \
  -H "Content-Type: application/json" \
  -d '{"phone":"212659595284","text":"Test après fix"}'
```

## Pourquoi cette erreur ?

L'erreur `Cannot read properties of undefined (reading 'markedUnread')` se produit quand:
- WhatsApp Web a été mis à jour par Facebook/Meta
- La session a été créée avec une ancienne version
- Il y a incompatibilité entre whatsapp-web.js et WhatsApp Web

## La solution appliquée:

Dans `server.js`, on force maintenant l'utilisation d'une **version stable et fixe** de WhatsApp Web:

```javascript
webVersionCache: {
  type: 'remote',
  remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
}
```

Mais pour que cela fonctionne, **la session doit être recréée** après avoir appliqué cette configuration.

## Si le problème persiste:

```bash
# Mettre à jour whatsapp-web.js
npm install whatsapp-web.js@latest

# Reset complet
rm -rf .wwebjs_auth .wwebjs_cache node_modules
npm install

# Redémarrer
pm2 restart whtsp-service
pm2 logs whtsp-service
```

## Vérification:

```bash
# État du service
pm2 status

# Logs en temps réel
pm2 logs whtsp-service

# Status API
curl http://localhost:3400/status | jq

# Devrait retourner: "ready": true
```
