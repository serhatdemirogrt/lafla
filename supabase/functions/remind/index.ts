// Lafla hatırlatma bildirimi.
// - Saatlik zamanlayıcı (pg_cron) x-cron-secret başlığıyla çağırır: hatırlatma saati gelen ve
//   bugünkü hedefini tamamlamamış kişilere bildirim gönderir.
// - Uygulama {test:true, code, endpoint} ile çağırırsa o cihaza deneme bildirimi gönderir.
import webpush from "npm:web-push@3.6.7";
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function istanbulNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const y = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day - 1));
  const yesterday = y.toISOString().slice(0, 10);
  return { today, yesterday, hour: +parts.hour };
}

async function send(sub: unknown, payload: Record<string, string>) {
  try {
    await webpush.sendNotification(sub as webpush.PushSubscription, JSON.stringify(payload), { TTL: 3600 });
    return "sent";
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    return code === 404 || code === 410 ? "gone" : `error ${code ?? (e as Error).message}`;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const cfg = Object.fromEntries((await sql`select key, value from private.config`).map((r) => [r.key, r.value]));
  webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
  const body = await req.json().catch(() => ({}));

  // Deneme bildirimi: kod ve cihaz kaydı eşleşmeli
  if (body.test) {
    const rows = await sql`
      select s.sub from private.push_subs s join private.families f on f.id = s.family_id
      where s.endpoint = ${String(body.endpoint ?? "")} and f.code = ${String(body.code ?? "").trim().toUpperCase()}`;
    if (!rows.length) return json({ ok: false, error: "not found" }, 404);
    const r = await send(rows[0].sub, { title: "Lafla", body: "Bildirimler açık ✅ Hatırlatma saatinde haber vereceğim.", url: "./" });
    return json({ ok: r === "sent", result: r });
  }

  // Zamanlayıcı çağrısı
  if (req.headers.get("x-cron-secret") !== cfg.cron_secret) return json({ ok: false }, 401);
  const { today, yesterday, hour } = istanbulNow();
  const due = await sql`
    select s.endpoint, s.sub, s.name, p.data from private.push_subs s
    left join private.profiles p on p.family_id = s.family_id and p.name = s.name
    where s.remind_hour = ${hour} and (s.last_sent is null or s.last_sent < ${today}::date)`;
  const results: Record<string, number> = {};
  for (const row of due) {
    const d = row.data ?? {};
    const goal = d.goal || 10;
    const done = (d.days && d.days[today]) || 0;
    let r = "skipped";
    if (done < goal) {
      const streak = d.last === today || d.last === yesterday ? d.streak || 0 : 0;
      const text = done === 0
        ? `Bugün henüz pratik yapmadın.${streak ? ` 🔥 ${streak} günlük serini koru!` : " Birkaç cümleyle başla!"}`
        : `Hedefine ${goal - done} cümle kaldı. Hadi bitirelim!`;
      r = await send(row.sub, { title: `${row.name}, Lafla zamanı 🗣️`, body: text, url: "./" });
    }
    if (r === "gone") await sql`delete from private.push_subs where endpoint = ${row.endpoint}`;
    else await sql`update private.push_subs set last_sent = ${today}::date where endpoint = ${row.endpoint}`;
    results[r] = (results[r] || 0) + 1;
  }
  return json({ ok: true, hour, today, checked: due.length, results });
});
