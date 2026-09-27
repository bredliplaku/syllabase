// EIS timetable proxy — Supabase Edge Function (Deno).
//
// Why this exists: eis.epoka.edu.al sends no CORS headers, so the browser
// cannot fetch it directly from the course page. Supabase's REST API can't
// help either — it only queries the database. This function runs server-side,
// fetches the EIS timetable fragment, extracts the <table>, and returns it as
// HTML the frontend drops straight into #native-timetable-container.
//
// Deploy:
//   supabase functions deploy eis-timetable --project-ref sreqxyznaymvksygradu
//
// verify_jwt is OFF for this function (toggled in the Supabase dashboard). It
// must be: a CORS preflight (OPTIONS) request never carries an Authorization
// header, so if the platform-level JWT check were on, it would reject the
// preflight itself before this code ever runs — the exact "preflight doesn't
// pass access control check" error browsers report. That's fine here: this
// proxies a public EIS timetable page with no user-specific data, read-only,
// with input validated as digits-only below.
//
// Why GET /{tId}/show/programgrade/{cId}/ instead of POSTing the form: the
// POST to /publictimetable only returns the picker page. The actual table is
// loaded by EIS's own frontend from this endpoint, which returns a
// self-contained fragment (a namespaced <style> block + one <table>, no
// scripts). We proxy that directly.

const EIS_BASE = "https://eis.epoka.edu.al/publictimetable";
const CACHE_SECONDS = 1800; // 30 min — timetables change rarely mid-semester

// Keep the central origins. Portable lecturer pages also work on other origins
// by supplying an active public lecturer ID; this is public content, not sign-in.
const ALLOWED_ORIGINS = new Set([
  "https://bredliplaku.com",
  "https://www.bredliplaku.com",
  "https://bredliplaku.github.io",
]);

// Any port: local dev servers (VS Code Live Server, `python -m http.server`,
// etc.) don't run on a fixed port. Safe to allow broadly — this only ever
// matches a server actually running on the caller's own machine, and the
// response has nothing sensitive in it either way.
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const registeredOrigins = new Map<string, { allowed: boolean; expires: number }>();

async function lecturerPageAllowed(origin: string, lecturerId: string | null): Promise<boolean> {
  try {
    const url = new URL(origin);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin) return false;
    if (lecturerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lecturerId)) return false;
    const cacheKey = lecturerId ? `lecturer:${lecturerId}` : `host:${url.hostname}`;
    const cached = registeredOrigins.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.allowed;
    const apiUrl = Deno.env.get("SUPABASE_URL");
    const legacyAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const apiKey = legacyAnonKey || JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}").default;
    if (!apiUrl || !apiKey) return false;
    const endpoint = lecturerId ? "teaching_resolve_lecturer" : "teaching_site_origin_allowed";
    const response = await fetch(`${apiUrl}/rest/v1/rpc/${endpoint}`, {
      method: "POST",
      headers: { apikey: apiKey, "Content-Type": "application/json",
        ...(legacyAnonKey ? { Authorization: `Bearer ${legacyAnonKey}` } : {}) },
      body: JSON.stringify(lecturerId ? { p_id: lecturerId } : { p_hostname: url.hostname }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    const allowed = lecturerId ? result?.id === lecturerId.toLowerCase() : result === true;
    if (registeredOrigins.size >= 500) registeredOrigins.clear();
    registeredOrigins.set(cacheKey, { allowed, expires: Date.now() + (allowed ? 300000 : 30000) });
    return allowed;
  } catch { return false; }
}

async function corsHeaders(req: Request): Promise<Record<string, string>> {
  const origin = req.headers.get("origin");
  const lecturerId = new URL(req.url).searchParams.get("lecturer");
  const allowed = !!origin && (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN.test(origin)
    || await lecturerPageAllowed(origin, lecturerId));
  return {
    // Omitted (rather than "*") for a disallowed/absent origin — the browser
    // then has no matching header to accept, exactly as if CORS were denied.
    ...(allowed ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

const errorHtml = (msg: string) => `<div class="tt-error">${msg}</div>`;

/**
 * Keeps the fragment's own <style> block (it carries the timetable colours and
 * responsive breakpoints) through the final </table>, and strips scripts.
 */
function extractFragment(body: string): string {
  const tableStart = body.indexOf("<table");
  const tableEnd = body.lastIndexOf("</table>");
  if (tableStart === -1 || tableEnd === -1) return "";

  const styleStart = body.indexOf("<style");
  const start = styleStart !== -1 && styleStart < tableStart ? styleStart : tableStart;

  return body
    .substring(start, tableEnd + "</table>".length)
    .replace(/<script[\s\S]*?(<\/script>|$)/gi, "");
}

Deno.serve(async (req: Request) => {
  const cors = await corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
  if (req.headers.has("origin") && !cors["Access-Control-Allow-Origin"]) {
    return new Response("Origin not allowed", { status: 403, headers: cors });
  }

  const htmlHeaders = { ...cors, "Content-Type": "text/html; charset=utf-8" };

  const url = new URL(req.url);
  const tId = (url.searchParams.get("tId") ?? "").trim();
  const cId = (url.searchParams.get("cId") ?? "").trim();

  if (!/^\d+$/.test(tId) || !/^\d+$/.test(cId)) {
    return new Response(errorHtml("Invalid timetable request."), { headers: htmlHeaders });
  }

  try {
    const res = await fetch(`${EIS_BASE}/${tId}/show/programgrade/${cId}/`, { redirect: "follow" });
    if (!res.ok) throw new Error(`EIS returned HTTP ${res.status}`);

    const table = extractFragment(await res.text());
    if (!table) {
      // Valid-but-empty (wrong class id, or timetable no longer published).
      // Not cached, so it recovers as soon as EIS does.
      return new Response(errorHtml("No timetable found for this class."), { headers: htmlHeaders });
    }

    return new Response(table, {
      headers: { ...htmlHeaders, "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
    });
  } catch (_err) {
    return new Response(errorHtml("The timetable could not be loaded from EIS."), { headers: htmlHeaders });
  }
});
