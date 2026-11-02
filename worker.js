import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 8;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const safeName = (v) => String(v || "Игрок").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 18) || "Игрок";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, game: "CHICKEN GUN ONLINE" });
    if (url.pathname === "/api/rooms" && request.method === "GET") {
      return env.LOBBY.get(env.LOBBY.idFromName("global")).fetch("https://lobby/list");
    }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Ожидается JSON" }, 400); }
      return env.LOBBY.get(env.LOBBY.idFromName("global")).fetch("https://lobby/create", {
        method: "POST", headers: JSON_HEADERS,
        body: JSON.stringify({ name: safeName(body.name || "TOWN 3F · Комната"), maxPlayers: Math.min(MAX_PLAYERS, Math.max(2, Number(body.maxPlayers) || MAX_PLAYERS)) })
      });
    }
    const match = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]{3,40})\/ws$/i);
    if (match) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "Нужен WebSocket" }, 426);
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "API route not found" }, 404);
    return env.ASSETS.fetch(request);
  }
};

export class GameLobby extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  async rooms() {
    let rooms = await this.ctx.storage.get("rooms") || [];
    if (!rooms.some(r => r.id === "town3f-main")) {
      rooms.unshift({ id: "town3f-main", name: "TOWN 3F · PUBLIC #1", map: "town3f", players: 0, maxPlayers: MAX_PLAYERS, createdAt: Date.now(), updatedAt: Date.now(), isPublic: true });
      await this.ctx.storage.put("rooms", rooms);
    }
    const now = Date.now();
    rooms = rooms.filter(r => r.id === "town3f-main" || r.players > 0 || now - (r.updatedAt || r.createdAt || now) < 86400000);
    await this.ctx.storage.put("rooms", rooms);
    return rooms;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/list") return json({ rooms: await this.rooms() });
    if (url.pathname === "/create" && request.method === "POST") {
      const body = await request.json();
      const rooms = await this.rooms();
      if (rooms.length >= 40) return json({ error: "Сейчас слишком много комнат. Попробуй позже." }, 429);
      const room = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 10), name: safeName(body.name || "TOWN 3F · Комната"), map: "town3f", players: 0, maxPlayers: Math.min(MAX_PLAYERS, Math.max(2, Number(body.maxPlayers) || MAX_PLAYERS)), createdAt: Date.now(), updatedAt: Date.now(), isPublic: true };
      rooms.push(room);
      await this.ctx.storage.put("rooms", rooms);
      return json({ room }, 201);
    }
    if (url.pathname === "/update" && request.method === "POST") {
      const body = await request.json(), rooms = await this.rooms(), room = rooms.find(r => r.id === body.id);
      if (room) { room.players = Math.max(0, Math.min(MAX_PLAYERS, Number(body.players) || 0)); room.updatedAt = Date.now(); await this.ctx.storage.put("rooms", rooms); }
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  players() {
    return this.ctx.getWebSockets().map(ws => {
      try { const p = ws.deserializeAttachment(); return p && ({ id:p.id, name:p.name, x:p.x, y:p.y, z:p.z, yaw:p.yaw, hp:p.hp }); } catch { return null; }
    }).filter(Boolean);
  }
  broadcast(data, except = null) {
    const message = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) { try { ws.send(message); } catch {} }
  }
  async updateLobby(roomId) {
    try {
      await this.env.LOBBY.get(this.env.LOBBY.idFromName("global")).fetch("https://lobby/update", {
        method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id: roomId, players: this.ctx.getWebSockets().length })
      });
    } catch (e) { console.error("Lobby update failed", e); }
  }
  async fetch(request) {
    const url = new URL(request.url);
    const id = url.pathname.split("/").filter(Boolean).at(-2) || "town3f-main";
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) return json({ error: "Комната заполнена" }, 409);
    const p = { id: crypto.randomUUID().slice(0, 8), roomId:id, name:safeName(url.searchParams.get("name")), x:-78+(sockets.length%4)*2.8, y:0, z:45+Math.floor(sockets.length/4)*2.8, yaw:0, hp:100, lastShot:0, deadAt:0, lastChat:0 };
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    server.serializeAttachment(p);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type:"welcome", id:p.id, hp:p.hp, spawn:{x:p.x,y:p.y,z:p.z,yaw:p.yaw}, players:this.players() }));
    this.broadcast({ type:"players", players:this.players() });
    await this.updateLobby(id);
    return new Response(null, { status:101, webSocket:client });
  }
  async webSocketMessage(ws, raw) {
    let data; try { data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const p = ws.deserializeAttachment(); if (!p) return;
    if (data.type === "pos") {
      if (p.hp <= 0) return;
      p.x = Number.isFinite(+data.x) ? Math.max(-112,Math.min(112,+data.x)) : p.x;
      p.y = Number.isFinite(+data.y) ? Math.max(0,Math.min(25,+data.y)) : p.y;
      p.z = Number.isFinite(+data.z) ? Math.max(-84,Math.min(84,+data.z)) : p.z;
      p.yaw = Number.isFinite(+data.yaw) ? +data.yaw : p.yaw;
      ws.serializeAttachment(p); this.broadcast({type:"players",players:this.players()}); return;
    }
    if (data.type === "shoot") {
      const now = Date.now(); if (p.hp <= 0 || now - p.lastShot < 320) return; p.lastShot = now;
      const yaw = Number.isFinite(+data.yaw) ? +data.yaw : p.yaw;
      const pitch = Math.max(-1.1,Math.min(1.1,Number.isFinite(+data.pitch)?+data.pitch:0));
      const dir = {x:-Math.sin(yaw)*Math.cos(pitch), y:-Math.sin(pitch), z:-Math.cos(yaw)*Math.cos(pitch)};
      let hit = null, bestT = 38;
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        let t; try { t = other.deserializeAttachment(); } catch { continue; }
        if (!t || t.hp <= 0) continue;
        const rx=t.x-p.x, ry=(t.y+1.2)-(p.y+1.58), rz=t.z-p.z;
        const along=rx*dir.x+ry*dir.y+rz*dir.z;
        if (along<=0 || along>=bestT) continue;
        const dx=rx-dir.x*along, dy=ry-dir.y*along, dz=rz-dir.z*along;
        if (dx*dx+dy*dy+dz*dz<=1.25*1.25) { hit={ws:other,p:t}; bestT=along; }
      }
      if (hit) {
        hit.p.hp=Math.max(0,hit.p.hp-25); if(hit.p.hp===0) hit.p.deadAt=now;
        hit.ws.serializeAttachment(hit.p);
        this.broadcast({type:"shot",shooterId:p.id,targetId:hit.p.id,targetHp:hit.p.hp,killed:hit.p.hp===0,at:now});
        this.broadcast({type:"players",players:this.players()});
      } else this.broadcast({type:"shot",shooterId:p.id,targetId:null,at:now});
      ws.serializeAttachment(p); return;
    }
    if (data.type === "respawn") {
      const now=Date.now(); if(p.hp>0 || !p.deadAt || now-p.deadAt<3000) return;
      const i=this.ctx.getWebSockets().indexOf(ws); p.x=-78+(Math.max(0,i)%4)*2.8; p.y=0; p.z=45+Math.floor(Math.max(0,i)/4)*2.8; p.yaw=0; p.hp=100; p.deadAt=0; p.lastShot=0;
      ws.serializeAttachment(p); ws.send(JSON.stringify({type:"respawn",hp:100,spawn:{x:p.x,y:p.y,z:p.z,yaw:p.yaw}})); this.broadcast({type:"players",players:this.players()}); return;
    }
    if (data.type === "chat") {
      const now=Date.now(); if(now-p.lastChat<650) return; p.lastChat=now; ws.serializeAttachment(p);
      const text=String(data.text||"").replace(/[<>\u0000-\u001f]/g,"").trim().slice(0,180);
      if(text) this.broadcast({type:"chat",id:p.id,name:p.name,text,at:now}); return;
    }
  }
  async webSocketClose(ws) {
    const p=ws.deserializeAttachment();
    this.broadcast({type:"players",players:this.players()},ws);
    if(p) await this.updateLobby(p.roomId);
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
}
