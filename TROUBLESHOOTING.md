# 🔧 Guide de dépannage WhatsApp

## Erreur: "Cannot read properties of undefined (reading 'markedUnread')"

Cette erreur se produit quand whatsapp-web.js n'est pas compatible avec la dernière version de WhatsApp Web.

### Solutions (dans l'ordre):

### ✅ **Solution 1: Réinitialiser la session (Rapide)**

```powershell
# Arrêter le service
pm2 stop whtsp-service

# Exécuter le script de reset
cd c:\xampp\htdocs\RH\whtsp-service
.\reset-session.ps1

# Redémarrer le service
pm2 start whtsp-service

# Voir les logs et scanner le QR
pm2 logs whtsp-service
```

### ✅ **Solution 2: Mise à jour manuelle de whatsapp-web.js**

```powershell
cd c:\xampp\htdocs\RH\whtsp-service

# Arrêter le service
pm2 stop whtsp-service

# Mettre à jour whatsapp-web.js
npm install whatsapp-web.js@latest

# Nettoyer la session
.\reset-session.ps1

# Redémarrer
pm2 restart whtsp-service
pm2 logs whtsp-service
```

### ✅ **Solution 3: Utiliser une version stable de WhatsApp Web**

La configuration a été mise à jour dans `server.js` pour utiliser une version fixe et stable de WhatsApp Web:

```javascript
webVersionCache: {
  type: 'remote',
  remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
}
```

Cette configuration force l'utilisation d'une version testée et stable.

### ✅ **Solution 4: Vérifier l'état du service**

```powershell
# Voir les logs en temps réel
pm2 logs whtsp-service

# Vérifier l'état via l'API
curl http://localhost:3400/status

# Voir le QR code si disponible
curl http://localhost:3400/qr
```

## 📊 Diagnostic des problèmes

### 1. Service ne démarre pas

```powershell
# Vérifier les logs
pm2 logs whtsp-service --lines 50

# Vérifier si le port est occupé
netstat -ano | findstr :3400

# Redémarrer complètement
pm2 delete whtsp-service
pm2 start ecosystem.config.js
```

### 2. QR code ne s'affiche pas

```powershell
# Vérifier les logs
pm2 logs whtsp-service --lines 100

# Accéder via le navigateur
# Ouvrir: http://localhost:3400/qr
```

### 3. Messages ne s'envoient pas

```powershell
# Vérifier l'état de la connexion
curl http://localhost:3400/status

# Vérifier les logs d'erreur
curl http://localhost:3400/api/logs
```

## 🔄 Redémarrage complet (Solution ultime)

Si rien ne fonctionne, voici un reset complet:

```powershell
cd c:\xampp\htdocs\RH\whtsp-service

# 1. Arrêter complètement
pm2 delete whtsp-service

# 2. Nettoyer tout
Remove-Item -Path ".wwebjs_auth" -Recurse -Force
Remove-Item -Path ".wwebjs_cache" -Recurse -Force
Remove-Item -Path "node_modules" -Recurse -Force
Remove-Item -Path "package-lock.json" -Force

# 3. Réinstaller
npm install

# 4. Redémarrer
pm2 start ecosystem.config.js
pm2 logs whtsp-service
```

## 📝 Vérifications après redémarrage

1. ✅ Le service démarre sans erreur
2. ✅ Le QR code s'affiche
3. ✅ Après scan: "Client prêt ✅"
4. ✅ Status API retourne `ready: true`

```powershell
# Tester l'envoi d'un message
curl -X POST http://localhost:3400/send-text `
  -H "x-api-key: Q9Kx6Q2f5pQAU1uYIY0YyWJp2Zb7e1w60H8rFf3yERZ3" `
  -H "Content-Type: application/json" `
  -d '{"phone":"212659595284","text":"Test message"}'
```

## 🆘 Erreurs courantes

### "wa_not_ready"
- Scanner le QR code
- Vérifier que WhatsApp est connecté sur le téléphone

### "Evaluation failed"
- Réinitialiser la session avec `reset-session.ps1`
- Mettre à jour whatsapp-web.js

### "EADDRINUSE"
- Un autre processus utilise le port 3400
- Arrêter l'autre processus ou changer le port dans `.env`

### "auth_failure"
- Supprimer la session: `Remove-Item .wwebjs_auth -Recurse -Force`
- Rescanner le QR code

## 📞 Support

Si le problème persiste:
1. Vérifier les logs: `pm2 logs whtsp-service --lines 100`
2. Vérifier la version: `npm list whatsapp-web.js`
3. Vérifier Chrome: Assurez-vous que Chrome est à jour
