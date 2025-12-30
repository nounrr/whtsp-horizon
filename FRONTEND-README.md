# Interface d'envoi en masse WhatsApp

## Fonctionnalités

L'interface web permet d'envoyer des messages WhatsApp en masse avec les fonctionnalités suivantes :

### 1. Upload de fichier CSV
- Glissez-déposez ou cliquez pour sélectionner un fichier CSV
- Le fichier doit contenir une colonne nommée `phone`, `telephone` ou `numero`
- Formats de numéros acceptés :
  - International avec + : `+212659595284`
  - International avec 00 : `00212659595284`
  - National : `0659595284` (sera converti selon DEFAULT_CC)
  - Direct : `212659595284`

### 2. Validation automatique
- Les numéros sont validés automatiquement
- Les numéros invalides sont affichés dans une section dédiée
- Statistiques en temps réel :
  - Numéros valides
  - Numéros invalides
  - Total

### 3. Composition du message
- Zone de texte pour écrire votre message
- Possibilité d'ajouter une image (formats : jpg, png, gif, etc.)
- Possibilité d'ajouter un document (formats : pdf, doc, docx, xls, xlsx)
- Prévisualisation des fichiers attachés

### 4. Envoi en masse
- Bouton pour envoyer à tous les numéros valides
- Indicateur de progression
- Délai automatique de 1 seconde entre chaque envoi
- Vérification que chaque numéro est enregistré sur WhatsApp avant envoi

## Utilisation

1. **Démarrer le serveur**
   ```bash
   npm start
   ```

2. **Ouvrir l'interface**
   - Accédez à `http://localhost:3000` dans votre navigateur
   - Scannez le QR code WhatsApp si nécessaire

3. **Charger les numéros**
   - Cliquez sur la zone d'upload ou glissez-déposez votre fichier CSV
   - Vérifiez les statistiques et les numéros invalides

4. **Composer le message**
   - Écrivez votre message dans la zone de texte
   - Ajoutez une image ou un document si nécessaire (optionnel)

5. **Envoyer**
   - Cliquez sur "Envoyer à tous les numéros"
   - Attendez la confirmation de l'envoi

## Exemple de fichier CSV

Voir `exemple-phones.csv` pour un exemple de format :

```csv
phone
212659595284
212612345678
0659595284
+212659595285
```

## API Endpoint

L'endpoint `/api/send-bulk` accepte :

### Méthode : POST

### Paramètres (multipart/form-data) :
- `message` (string, requis) : Le message à envoyer
- `phones` (string JSON array, requis) : Liste des numéros au format JSON
- `image` (file, optionnel) : Image à joindre
- `document` (file, optionnel) : Document à joindre

### Exemple avec cURL :

```bash
curl -X POST http://localhost:3000/api/send-bulk \
  -F "message=Bonjour depuis l'API!" \
  -F 'phones=["212659595284","212612345678"]' \
  -F "image=@image.jpg" \
  -F "document=@document.pdf"
```

### Réponse :

```json
{
  "ok": true,
  "sent": 2,
  "failed": 0,
  "total": 2,
  "errors": []
}
```

## Logs

Tous les envois sont enregistrés automatiquement et peuvent être consultés via :
- Interface web : `http://localhost:3000/logs.html`
- API : `GET /api/logs`

## Notes importantes

1. **Limites WhatsApp** : Ne pas envoyer trop de messages trop rapidement pour éviter d'être bloqué
2. **Délai entre envois** : Un délai de 1 seconde est appliqué automatiquement
3. **Vérification des numéros** : Chaque numéro est vérifié avant envoi
4. **Taille des fichiers** : Limite de 10 MB par fichier
5. **Session WhatsApp** : Assurez-vous que le client WhatsApp est connecté avant d'envoyer

## Sécurité

L'endpoint `/api/send-bulk` est public pour faciliter l'utilisation via l'interface web. 

Si vous souhaitez le sécuriser, ajoutez `requireApiKey` comme middleware :

```javascript
app.post('/api/send-bulk', requireApiKey, upload.fields([...]), async (req, res) => {
  // ...
});
```

Puis ajoutez le header `x-api-key` avec votre clé API dans les requêtes.
