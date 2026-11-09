const nodemailer = require("nodemailer");
 
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://nhpudstyikrrcqrnxhhy.supabase.co").trim().replace(/\/+$/, "");
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "sb_publishable_zGeE0BEgPvPansDlp91iIg_pueLBy0S").trim();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_ROLES = ["viewer", "editor", "admin"];
const MAX_AGE_MS = 5 * 60 * 1000; // only notify for replies posted in the last 5 minutes
 
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
 
// Talks to Supabase as the signed-in user, so the same row-level security as the app applies.
async function sb(path, token) {
  const r = await fetch(SUPABASE_URL + path, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token } });
  if (!r.ok) throw Object.assign(new Error("Supabase " + r.status), { status: r.status });
  return r.json();
}
 
module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "POST only" }); }
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return res.status(500).json({ error: "Email isn't set up: add GMAIL_USER and GMAIL_APP_PASSWORD in Vercel." });
 
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const commentId = String(body.comment_id || "");
  if (!token || !UUID_RE.test(commentId)) return res.status(400).json({ error: "Missing sign-in or comment_id." });
 
  try {
    // 1. Who is calling?
    const user = await sb("/auth/v1/user", token);
 
    // 2. The reply must exist, be theirs, and be new (stops anyone re-sending old notifications).
    const [c] = await sb(`/rest/v1/comments?id=eq.${commentId}&select=id,author,body,mentions,order_id,created_at`, token);
    if (!c) return res.status(404).json({ error: "Reply not found." });
    if (c.author !== user.id) return res.status(403).json({ error: "Not your reply." });
    if (Date.now() - Date.parse(c.created_at) > MAX_AGE_MS) return res.status(409).json({ error: "Reply is too old to notify." });
 
    const mentioned = [...new Set((c.mentions || []).filter((id) => UUID_RE.test(id) && id !== user.id))];
    if (!mentioned.length) return res.status(200).json({ sent: 0 });
 
    // 3. Look up the order and the people named in the reply.
    const inBody = (String(c.body).match(/<@([0-9a-f-]{36})>/gi) || []).map((m) => m.slice(2, -1));
    const ids = [...new Set([user.id, ...mentioned, ...inBody])].filter((id) => UUID_RE.test(id));
    const [orders, people] = await Promise.all([
      sb(`/rest/v1/orders?id=eq.${c.order_id}&select=name,order_no,status`, token),
      sb(`/rest/v1/profiles?id=in.(${ids.join(",")})&select=id,name,email,role`, token),
    ]);
    const order = orders[0] || {};
    const byId = Object.fromEntries(people.map((p) => [p.id, p]));
    const nameOf = (id) => (byId[id] && (byId[id].name || byId[id].email)) || "someone";
    const author = nameOf(user.id);
    const text = String(c.body).replace(/<@([0-9a-f-]{36})>/gi, (_, id) => "@" + nameOf(id));
    const orderLabel = [order.order_no ? "#" + order.order_no : null, order.name || "an order"].filter(Boolean).join(" · ");
    const appUrl = (process.env.APP_URL || req.headers.origin || "").replace(/\/+$/, "");
 
    const recipients = mentioned.map((id) => byId[id]).filter((p) => p && p.email && ACTIVE_ROLES.includes(p.role));
    if (!recipients.length) return res.status(200).json({ sent: 0 });
 
    // 4. Send one email per tagged person.
    const mail = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, "") } });
    const results = await Promise.allSettled(recipients.map((p) => mail.sendMail({
      from: `"MRPH Tracker" <${process.env.GMAIL_USER}>`,
      to: p.email,
      replyTo: user.email || undefined,
      subject: `${author} tagged you on ${orderLabel}`,
      text: `Hi ${p.name || ""},\n\n${author} mentioned you on ${orderLabel}${order.status ? " (" + order.status + ")" : ""}:\n\n"${text}"\n\n${appUrl ? "Open the tracker: " + appUrl + "\n\n" : ""}— MRPH Tracker`,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:560px">
        <p>Hi ${esc(p.name || "")},</p>
        <p><b>${esc(author)}</b> mentioned you on <b>${esc(orderLabel)}</b>${order.status ? " <span style=\"color:#666\">(" + esc(order.status) + ")</span>" : ""}:</p>
        <blockquote style="margin:12px 0;padding:10px 14px;background:#f5f5f5;border-left:3px solid #e0b400;white-space:pre-wrap">${esc(text)}</blockquote>
        ${appUrl ? `<p><a href="${esc(appUrl)}" style="background:#222;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open the tracker</a></p>` : ""}
        <p style="color:#888;font-size:12px">You got this because you were @mentioned in the MRPH Tracker.</p></div>`,
    })));
    const sent = results.filter((r) => r.status === "fulfilled").length;
    results.forEach((r) => { if (r.status === "rejected") console.error("send failed:", r.reason && r.reason.message); });
    return res.status(200).json({ sent, failed: results.length - sent });
  } catch (e) {
    console.error(e);
    return res.status(e.status === 401 ? 401 : 500).json({ error: e.status === 401 ? "Sign-in expired." : "Couldn't send notifications." });
  }
};
 
