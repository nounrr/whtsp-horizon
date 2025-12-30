# WhatsApp Service (whtsp-service)

A small Node.js service to send WhatsApp messages using whatsapp-web.js. It can render message templates by calling the Laravel API.

## Prereqs
- Node.js 18+
- A phone number with WhatsApp installed (to pair via QR)

## Setup

```powershell
cd c:\xampp\htdocs\RH\whtsp-service
npm install
npm install whatsapp-web.js qrcode-terminal express node-fetch@3
```

Optional env vars (create a `.env` if using a process manager like PM2):
- `PORT` (default `3085`)
- `API_BASE` (e.g. `http://localhost/sirh-back/public`)
- `API_TOKEN` (Bearer token if your API requires auth)

## Run

```powershell
npm run start
# or during development
npm run dev
```

On first start, scan the QR displayed in the terminal. The session is saved in a local folder by whatsapp-web.js LocalAuth.

## API
- `GET /health` → `{ status: 'ok' }`
- `POST /send-text` → `{ phone, text }`
- `POST /send-template` → `{ phone, templateKey, params }`

`/send-template` calls the Laravel endpoint `/api/templates/render` expected to return `{ text: string }`.
# whtsapdct
