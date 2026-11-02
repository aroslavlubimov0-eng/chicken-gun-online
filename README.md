# CHICKEN GUN ONLINE — TOWN 3F

Browser multiplayer prototype using Cloudflare Workers, Durable Objects and WebSockets.

## Files
- `worker.js` — API, public room list, room creation, WebSocket movement, chat, simple server-side hit checks and respawn.
- `public/index.html` — game client (upload this from the provided battle-update ZIP).
- `wrangler.jsonc` — Workers assets and Durable Objects configuration.

## Local commands
```bash
npm install
npm run dev
npm run deploy
```

## Cloudflare Git integration
Set the project root to `/`. Build command may be left blank. Deploy command: `npx wrangler deploy`.
The repository must contain `worker.js`, `wrangler.jsonc`, `package.json`, and `public/index.html`.

## Health checks
- `/api/health` returns JSON with `ok: true`.
- `/api/rooms` returns the live room list.

Rooms allow up to 8 players. This is an early prototype: shooting is server-checked against player positions but does not yet account for line-of-sight through walls. Build placement is local-only and is not synchronized between players.
