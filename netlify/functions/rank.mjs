// Room ranking for 학생회 키우기.
// One record per player per room: key "r/<room>/<uid>" -> {name, char, g, score, t}.
// "room" is Telegram's chat_instance: the same value for everyone who opens the game
// from a link inside the same group chat, and unknown to anyone outside that chat.
//
//   GET  /api/rank?room=..&uid=..   -> { top: [...10], me, total }
//   POST /api/rank  {room, uid, name, char, g, score, init}  -> same shape
//
// If the BOT_TOKEN environment variable is set, POSTs must carry Telegram's signed
// initData and room/uid are taken from it, so nobody can post as someone else.
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const ROOM_RE = /^-?[0-9A-Za-z_]{1,40}$/, UID_RE = /^[0-9]{1,20}$/;
const CHARS = ["str", "int", "bal"], GRADES = ["F", "D", "C", "B", "A", "S"];

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// Telegram Mini App initData check: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function verifyInit(init, token) {
  const p = new URLSearchParams(init || ""), hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", token);
  if (hex(await hmac(secret, check)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 86400) return null;
  let user = null; try { user = JSON.parse(p.get("user") || "null"); } catch {}
  return { room: p.get("chat_instance"), uid: user && String(user.id) };
}

async function board(store, room, uid) {
  const { blobs } = await store.list({ prefix: `r/${room}/` });
  const rows = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).then((v) => v && { ...v, uid: b.key.split("/").pop() }))))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.t - b.t);
  const out = rows.map((r, i) => ({ rank: i + 1, name: r.name, char: r.char, g: r.g, score: r.score, me: r.uid === uid }));
  const mine = out.find((r) => r.me) || null;
  return { top: out.slice(0, 10), me: mine, total: out.length };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const store = getStore({ name: "rank", consistency: "strong" });
  try {
    if (req.method === "GET") {
      const u = new URL(req.url), room = u.searchParams.get("room") || "", uid = u.searchParams.get("uid") || "";
      if (!ROOM_RE.test(room)) return json({ error: "room" }, 400);
      return json(await board(store, room, UID_RE.test(uid) ? uid : ""));
    }
    if (req.method !== "POST") return json({ error: "method" }, 405);

    const b = JSON.parse(await req.text());
    let room = String(b.room || ""), uid = String(b.uid || "");
    const token = globalThis.Netlify?.env?.get("BOT_TOKEN") || process.env.BOT_TOKEN;
    if (token) {
      const v = await verifyInit(b.init, token);
      if (!v || !v.room || !v.uid) return json({ error: "auth" }, 401);
      room = v.room; uid = v.uid;
    }
    const score = Math.round(Number(b.score));
    if (!ROOM_RE.test(room) || !UID_RE.test(uid) || !(score >= 0 && score <= 800) || !CHARS.includes(b.char) || !GRADES.includes(b.g))
      return json({ error: "input" }, 400);
    const name = String(b.name || "학생").replace(/[<>&"'\u0000-\u001f]/g, "").trim().slice(0, 10) || "학생";

    const key = `r/${room}/${uid}`, old = await store.get(key, { type: "json" });
    if (!old || score > old.score) await store.setJSON(key, { name, char: b.char, g: b.g, score, t: Date.now() });
    else if (old.name !== name) await store.setJSON(key, { ...old, name });  // keep best score, follow name changes
    return json({ ...(await board(store, room, uid)), improved: !old || score > old.score });
  } catch (e) {
    return json({ error: "server" }, 500);
  }
};

export const config = { path: "/api/rank" };
