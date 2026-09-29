/* Anime Season Board — AniList for show data, Supabase for accounts and watchlists. */
(() => {
"use strict";

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const FMT = { TV: "TV", TV_SHORT: "TV short", ONA: "Web", OVA: "OVA", MOVIE: "Film", SPECIAL: "Special" };
const STATUS = { RELEASING: "Airing", NOT_YET_RELEASED: "Upcoming", FINISHED: "Finished", HIATUS: "On hiatus", CANCELLED: "Cancelled" };
const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
const SEASON_NAME = { WINTER: "Winter", SPRING: "Spring", SUMMER: "Summer", FALL: "Fall" };
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const longFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });

const store = {
  get(k) { try { const v = JSON.parse(sessionStorage.getItem(k)); return v && v.exp > Date.now() ? v.data : null; } catch { return null; } },
  set(k, data, ttl) { try { sessionStorage.setItem(k, JSON.stringify({ exp: Date.now() + ttl, data })); } catch {} },
};
const pref = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let toastT;
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2200); }

// ---------- seasons ----------
// The board rolls over to the next season from the 15th of a season's last month,
// because most new shows premiere in the first week of the next one.
function defaultSeason(now = new Date()) {
  let idx = Math.floor(now.getMonth() / 3), year = now.getFullYear();
  if (now.getMonth() % 3 === 2 && now.getDate() >= 15) { idx++; if (idx > 3) { idx = 0; year++; } }
  return { season: SEASONS[idx], year };
}
function shiftSeason({ season, year }, n) {
  let i = SEASONS.indexOf(season) + n;
  year += Math.floor(i / 4); i = ((i % 4) + 4) % 4;
  return { season: SEASONS[i], year };
}
const seasonKey = s => `${s.season}-${s.year}`;
const seasonLabel = s => `${SEASON_NAME[s.season]} ${s.year}`;

// ---------- AniList ----------
const FIELDS = `id title{romaji english} format status episodes season seasonYear startDate{year month day}
  description(asHtml:false) coverImage{extraLarge large color} bannerImage genres studios(isMain:true){nodes{name}}
  averageScore popularity siteUrl trailer{id site thumbnail} nextAiringEpisode{episode airingAt}`;

async function anilist(query, variables, attempt = 0) {
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 429 && attempt < 2) {
    const wait = (Number(r.headers.get("Retry-After")) || 5) * 1000;
    await new Promise(res => setTimeout(res, wait));
    return anilist(query, variables, attempt + 1);
  }
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error((j.errors && j.errors[0]?.message) || `AniList error ${r.status}`);
  return j.data;
}

async function pagedMedia(filter, vars, maxPages = 6) {
  const q = `query($p:Int${Object.keys(vars).map(k => `,$${k}:${VAR_TYPES[k]}`).join("")}){Page(page:$p,perPage:50){pageInfo{hasNextPage}
    media(${filter},type:ANIME,isAdult:false,sort:POPULARITY_DESC,format_in:[TV,TV_SHORT,ONA]){${FIELDS}}}}`;
  const out = [];
  for (let p = 1; p <= maxPages; p++) {
    const d = await anilist(q, { p, ...vars });
    out.push(...d.Page.media);
    if (!d.Page.pageInfo.hasNextPage) break;
  }
  return out;
}
const VAR_TYPES = { s: "MediaSeason", y: "Int", ids: "[Int]" };

async function fetchSeason(s) {
  const key = "season:" + seasonKey(s);
  const hit = store.get(key); if (hit) return hit;
  const list = (await pagedMedia("season:$s,seasonYear:$y", { s: s.season, y: s.year })).map(normalize);
  store.set(key, list, 15 * 60e3);
  return list;
}
async function fetchContinuing(s) {
  const key = "cont:" + seasonKey(s);
  const hit = store.get(key); if (hit) return hit;
  const list = (await pagedMedia("status:RELEASING", {}, 4)).map(normalize)
    .filter(a => !(a.season === s.season && a.seasonYear === s.year));
  store.set(key, list, 15 * 60e3);
  return list;
}
async function fetchByIds(ids) {
  const need = ids.filter(id => !S.byId.has(id));
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    const d = await anilist(`query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){${FIELDS}}}}`, { ids: chunk });
    d.Page.media.map(normalize).forEach(a => S.byId.set(a.id, a));
  }
}
function normalize(m) {
  const desc = (m.description || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#039;/g, "'")
    .replace(/\n*\(?Source:[^)\n]*\)?\s*$/i, "").replace(/\n{3,}/g, "\n\n").trim();
  const sd = m.startDate || {};
  return {
    id: m.id, title: m.title.english || m.title.romaji, romaji: m.title.romaji, format: m.format, status: m.status,
    episodes: m.episodes, season: m.season, seasonYear: m.seasonYear,
    start: sd.year ? [sd.year, sd.month, sd.day] : null, synopsis: desc,
    cover: m.coverImage?.extraLarge || m.coverImage?.large, color: m.coverImage?.color, banner: m.bannerImage,
    genres: m.genres || [], studios: (m.studios?.nodes || []).map(n => n.name), score: m.averageScore,
    popularity: m.popularity || 0, url: m.siteUrl,
    trailer: m.trailer && m.trailer.site === "youtube" ? m.trailer.id : null,
    nextEp: m.nextAiringEpisode?.episode ?? null, nextAt: m.nextAiringEpisode?.airingAt ?? null,
  };
}

// ---------- state ----------
const S = {
  season: defaultSeason(), list: [], continuing: [], byId: new Map(),
  marks: new Map(), // anime_id -> "watch" | "ignore"
  view: "all", q: "", sort: pref.get("sort", "next"), genre: null, withContinuing: pref.get("continuing", false),
  user: null, loading: true, error: null,
};

// ---------- Supabase ----------
const cfg = window.APP_CONFIG || {};
const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.startsWith("PASTE") && window.supabase;
const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

async function loadMarks() {
  S.marks.clear();
  if (!sb || !S.user) { render(); return; }
  const { data, error } = await sb.from("user_anime").select("anime_id,status");
  if (error) { toast("Couldn’t load your watchlist. Reload to try again."); return; }
  data.forEach(r => S.marks.set(r.anime_id, r.status));
  await fetchByIds([...S.marks.keys()]).catch(() => {});
  render();
}

async function setMark(id, status) {
  if (!S.user) { openAuth("signin", "Sign in to build your watchlist."); render(); return; }
  const prev = S.marks.get(id);
  if (status) S.marks.set(id, status); else S.marks.delete(id);
  render();
  toast(status === "watch" ? "Added to watchlist" : status === "ignore" ? "Ignored" : prev === "watch" ? "Removed from watchlist" : "Back in the list");
  const req = status
    ? sb.from("user_anime").upsert({ user_id: S.user.id, anime_id: id, status, updated_at: new Date().toISOString() }, { onConflict: "user_id,anime_id" })
    : sb.from("user_anime").delete().eq("user_id", S.user.id).eq("anime_id", id);
  const { error } = await req;
  if (error) {
    if (prev) S.marks.set(id, prev); else S.marks.delete(id);
    render(); toast("Couldn’t save that change. Check your connection and try again.");
  }
}

// ---------- airing maths ----------
function nextOf(a) {
  if (!a.nextAt) return null;
  return { t: a.nextAt * 1000, ep: a.nextEp };
}
function until(t) {
  const d = t - Date.now(); if (d <= 0) return "airing now";
  const m = Math.round(d / 6e4), h = Math.floor(m / 60), dd = Math.floor(h / 24);
  if (dd >= 1) return `in ${dd}d ${h % 24}h`; if (h >= 1) return `in ${h}h ${m % 60}m`; return `in ${m}m`;
}
function startLabel(a) {
  if (!a.start) return "date TBA";
  const [y, m, d] = a.start;
  if (!m) return String(y);
  if (!d) return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
  return dayFmt.format(new Date(y, m - 1, d));
}

// ---------- views ----------
function pool() {
  if (S.view === "all") {
    const base = S.withContinuing ? [...S.list, ...S.continuing] : S.list;
    return base.filter(a => S.marks.get(a.id) !== "ignore");
  }
  return [...S.marks.entries()].filter(([, st]) => st === S.view).map(([id]) => S.byId.get(id)).filter(Boolean);
}
function visible() {
  let xs = pool().filter(a => {
    if (S.genre && !a.genres.includes(S.genre)) return false;
    if (S.q) { const q = S.q.toLowerCase(); if (!(a.title + " " + a.romaji + " " + a.studios.join(" ")).toLowerCase().includes(q)) return false; }
    return true;
  });
  const nt = a => nextOf(a)?.t ?? Infinity;
  if (S.sort === "pop") xs.sort((a, b) => b.popularity - a.popularity);
  else if (S.sort === "score") xs.sort((a, b) => (b.score || 0) - (a.score || 0) || b.popularity - a.popularity);
  else if (S.sort === "title") xs.sort((a, b) => a.title.localeCompare(b.title));
  else xs.sort((a, b) => nt(a) - nt(b) || b.popularity - a.popularity);
  return xs;
}

function cardHTML(a) {
  const n = nextOf(a), mark = S.marks.get(a.id), w = mark === "watch";
  let shade = "", when;
  if (n) {
    const soon = n.t - Date.now() < 864e5;
    shade = `<div class="shade"><span class="ep">EP ${n.ep}</span><span class="in${soon ? " soon" : ""}">${until(n.t)}</span></div>`;
    when = `<div class="when">${esc(dayFmt.format(n.t))} · ${esc(timeFmt.format(n.t))}</div>`;
  } else if (a.status === "FINISHED") when = `<div class="when tba">Finished airing</div>`;
  else if (a.status === "RELEASING") when = `<div class="when tba">Airing · next date TBA</div>`;
  else when = `<div class="when tba">Premieres ${esc(startLabel(a))}</div>`;
  return `<article class="card${w ? " on" : ""}" data-id="${a.id}" tabindex="0" aria-label="${esc(a.title)}">
    <div class="poster" style="--c:${esc(a.color || "")}">
      ${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : ""}
      ${w ? '<span class="pin">ON LIST</span>' : ""}${shade}
    </div>
    <div class="cbody">
      <div class="meta"><span>${esc(FMT[a.format] || a.format || "")}</span><span>·</span><span>${esc(STATUS[a.status] || "")}</span>${a.score ? `<span>·</span><span>${a.score}%</span>` : ""}</div>
      <h3 class="title">${esc(a.title)}</h3>
      ${when}
      ${a.studios.length ? `<div class="studio">${esc(a.studios.join(", "))}</div>` : ""}
    </div>
    <div class="actions">
      <label class="check"><input type="checkbox" data-act="watch" id="w-${a.id}" ${w ? "checked" : ""}> Watchlist</label>
      <button class="ghost" data-act="ignore">${mark === "ignore" ? "Unignore" : "Ignore"}</button>
    </div>
  </article>`;
}

function render() {
  const allCount = (S.withContinuing ? [...S.list, ...S.continuing] : S.list).filter(a => S.marks.get(a.id) !== "ignore").length;
  $("ct-all").textContent = allCount;
  $("ct-watch").textContent = [...S.marks.values()].filter(v => v === "watch").length;
  $("ct-ignore").textContent = [...S.marks.values()].filter(v => v === "ignore").length;
  const L = $("list");
  if (S.error) { L.innerHTML = `<div class="empty"><b>Couldn’t reach AniList</b>${esc(S.error)}. Reload the page to try again.</div>`; return; }
  if (S.loading && S.view === "all") return;
  const xs = visible();
  if (!xs.length) {
    const msg = S.view === "watch"
      ? (S.user ? ["Your watchlist is empty", "Tick “Watchlist” on any show to add it here."] : ["Sign in to keep a watchlist", "Create a free account, then tick “Watchlist” on any show."])
      : S.view === "ignore" ? ["Nothing ignored", "Shows you ignore move here, out of the main list."]
      : ["No matches", "Try a different search or genre."];
    L.innerHTML = `<div class="empty"><b>${msg[0]}</b>${msg[1]}</div>`; return;
  }
  if (S.sort === "day") {
    const groups = new Map();
    for (const a of xs) { const n = nextOf(a); const k = n ? wdFmt.format(n.t) : "Time not announced"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
    const idx = k => { const n = nextOf(groups.get(k)[0]); return n ? (new Date(n.t).getDay() + 6) % 7 : 99; };
    const mins = a => { const n = nextOf(a); if (!n) return 0; const d = new Date(n.t); return d.getHours() * 60 + d.getMinutes(); };
    L.innerHTML = [...groups.keys()].sort((a, b) => idx(a) - idx(b)).map(k => {
      const g = groups.get(k).sort((a, b) => mins(a) - mins(b));
      return `<section class="day"><h2>${esc(k)} <span>${g.length} show${g.length > 1 ? "s" : ""}</span></h2><div class="grid">${g.map(cardHTML).join("")}</div></section>`;
    }).join("");
  } else L.innerHTML = `<div class="grid">${xs.map(cardHTML).join("")}</div>`;
}

function renderGenres() {
  const count = new Map();
  S.list.forEach(a => a.genres.forEach(g => count.set(g, (count.get(g) || 0) + 1)));
  const gs = [...count.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  $("genres").innerHTML = [`<button class="gchip" data-g="" aria-pressed="${!S.genre}">All genres</button>`,
    ...gs.map(g => `<button class="gchip" data-g="${esc(g)}" aria-pressed="${S.genre === g}">${esc(g)}</button>`)].join("");
}

function renderHeader() {
  $("seasonTitle").textContent = seasonLabel(S.season);
  document.title = `${seasonLabel(S.season)} · Anime Season Board`;
  if (S.loading) { $("sub").textContent = "Loading the season…"; return; }
  const airing = S.list.filter(a => a.status === "RELEASING").length;
  const upcoming = S.list.filter(a => a.status === "NOT_YET_RELEASED").length;
  $("sub").textContent = `${S.list.length} shows · ${airing} airing · ${upcoming} still to premiere`;
}

function renderSeasonPicker() {
  const d = defaultSeason();
  const opts = [-2, -1, 0, 1].map(n => shiftSeason(d, n));
  $("season").innerHTML = opts.map(s => `<option value="${seasonKey(s)}" ${seasonKey(s) === seasonKey(S.season) ? "selected" : ""}>${seasonLabel(s)}${seasonKey(s) === seasonKey(d) ? " (current)" : ""}</option>`).join("");
}

// ---------- detail ----------
function openDetail(id) {
  const a = S.byId.get(id); if (!a) return;
  const n = nextOf(a), mark = S.marks.get(a.id);
  const ytWatch = a.trailer ? `https://www.youtube.com/watch?v=${encodeURIComponent(a.trailer)}` : `https://www.youtube.com/results?search_query=${encodeURIComponent(a.title + " anime trailer")}`;
  $("detail").innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="dt">
    <div class="banner" style="--c:${esc(a.color || "")};${a.banner ? `background-image:url('${esc(a.banner)}')` : ""}"></div>
    <div class="shead"><div><div class="eyebrow">${esc(FMT[a.format] || "")} · ${esc(STATUS[a.status] || "")}${a.studios.length ? " · " + esc(a.studios.join(", ")) : ""}</div><h3 id="dt">${esc(a.title)}</h3></div>
      <button class="x" data-close aria-label="Close">×</button></div>
    <div class="sbody">
      <div class="dtop">
        ${a.cover ? `<img src="${esc(a.cover)}" alt="">` : "<div></div>"}
        <div class="facts">
          <div class="fact"><div class="k">Next episode</div><div class="v">${n ? `Ep ${n.ep}` : a.status === "FINISHED" ? "Finished" : "TBA"}</div></div>
          <div class="fact"><div class="k">Airs</div><div class="v">${n ? esc(longFmt.format(n.t)) : esc("Premieres " + startLabel(a))}</div></div>
          <div class="fact"><div class="k">Countdown</div><div class="v">${n ? until(n.t) : "—"}</div></div>
          <div class="fact"><div class="k">Episodes</div><div class="v">${a.episodes || "TBA"}</div></div>
        </div>
      </div>
      ${a.trailer ? `<div class="video" id="video"><button type="button" id="playTrailer" aria-label="Play trailer" style="background-image:url('https://i.ytimg.com/vi/${esc(a.trailer)}/hqdefault.jpg')"><span class="playbig"></span></button></div>` : ""}
      <div class="btns">
        <a class="btn primary" href="${esc(ytWatch)}" target="_blank" rel="noopener">${a.trailer ? "Open trailer on YouTube" : "Search YouTube for a trailer"}</a>
        <a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">AniList page ↗</a>
      </div>
      ${a.synopsis ? `<p class="syn">${esc(a.synopsis)}</p>` : `<p class="syn none">No synopsis published yet.</p>`}
      ${a.genres.length ? `<div class="tags">${a.genres.map(g => `<span class="tag">${esc(g)}</span>`).join("")}</div>` : ""}
      <div class="btns">
        <label class="check"><input type="checkbox" id="dw" ${mark === "watch" ? "checked" : ""}> Add to watchlist</label>
        <button class="ghost" id="dig">${mark === "ignore" ? "Unignore this show" : "Ignore this show"}</button>
      </div>
    </div></div>`;
  $("detail").hidden = false;
  $("detail").querySelector("[data-close]").focus();
  const play = $("playTrailer");
  if (play) play.onclick = () => {
    $("video").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(a.trailer)}?autoplay=1&rel=0" title="Trailer" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  };
  $("dw").onchange = e => setMark(a.id, e.target.checked ? "watch" : null);
  $("dig").onclick = () => { setMark(a.id, S.marks.get(a.id) === "ignore" ? null : "ignore"); closeModal($("detail")); };
}
function closeModal(el) { el.hidden = true; if (el.id === "detail") el.innerHTML = ""; }
document.querySelectorAll(".scrim").forEach(el => el.addEventListener("click", e => {
  if (e.target === el || e.target.closest("[data-close]")) closeModal(el);
}));
document.addEventListener("keydown", e => { if (e.key === "Escape") document.querySelectorAll(".scrim:not([hidden])").forEach(closeModal); });

// ---------- auth UI ----------
let authMode = "signin";
function openAuth(mode, hint) {
  if (!sb) { toast("Accounts aren’t set up on this site yet."); return; }
  setAuthMode(mode, hint);
  $("authModal").hidden = false;
  setTimeout(() => (authMode === "newpass" ? $("password") : $("email")).focus(), 30);
}
function setAuthMode(mode, hint) {
  authMode = mode;
  $("authTabs").hidden = mode === "reset" || mode === "newpass";
  document.querySelectorAll("#authTabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.mode === mode));
  $("emailField").hidden = mode === "newpass";
  $("passField").hidden = mode === "reset";
  $("forgot").hidden = mode !== "signin";
  $("password").autocomplete = mode === "signin" ? "current-password" : "new-password";
  $("authError").hidden = true;
  const T = {
    signin: ["Sign in", "Sign in", "Sign in to keep your watchlist on every device."],
    signup: ["Create account", "Create account", "Free. Use any email; you’ll get a link to confirm it."],
    reset: ["Reset password", "Send reset link", "We’ll email you a link to choose a new password."],
    newpass: ["Choose a new password", "Save password", "Enter a new password for your account."],
  }[mode];
  $("authTitle").textContent = T[0]; $("authSubmit").textContent = T[1]; $("authHint").textContent = hint || T[2];
}
$("authTabs").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setAuthMode(b.dataset.mode); });
$("forgot").addEventListener("click", () => setAuthMode("reset"));
$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("email").value.trim(), password = $("password").value;
  const err = m => { $("authError").textContent = m; $("authError").hidden = false; };
  if (authMode !== "newpass" && !/^\S+@\S+\.\S+$/.test(email)) return err("Enter a valid email address.");
  if (authMode !== "reset" && password.length < 6) return err("Passwords need at least 6 characters.");
  const btn = $("authSubmit"); btn.disabled = true;
  const back = location.origin + location.pathname;
  try {
    if (authMode === "signin") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return err(error.message === "Invalid login credentials" ? "That email and password don’t match an account." : error.message);
      closeModal($("authModal")); toast("Signed in");
    } else if (authMode === "signup") {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: back } });
      if (error) return err(error.message);
      if (data.session) { closeModal($("authModal")); toast("Account created"); }
      else { setAuthMode("signin", `Check ${email} for a confirmation link, then sign in here.`); }
    } else if (authMode === "reset") {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: back });
      if (error) return err(error.message);
      setAuthMode("signin", `If ${email} has an account, a reset link is on its way.`);
    } else if (authMode === "newpass") {
      const { error } = await sb.auth.updateUser({ password });
      if (error) return err(error.message);
      closeModal($("authModal")); toast("Password updated");
    }
  } finally { btn.disabled = false; }
});
$("signInBtn").addEventListener("click", () => openAuth("signin"));
$("signOutBtn").addEventListener("click", async () => { await sb.auth.signOut(); toast("Signed out"); });

function renderAccount() {
  $("signInBtn").hidden = !sb || !!S.user;
  $("who").hidden = !S.user;
  if (S.user) {
    const email = S.user.email || "";
    $("whoName").textContent = email;
    $("avatar").textContent = (email[0] || "?").toUpperCase();
  }
}

// ---------- events ----------
$("list").addEventListener("click", e => {
  const card = e.target.closest(".card"); if (!card) return;
  const id = Number(card.dataset.id), act = e.target.closest("[data-act]");
  if (act) {
    if (act.dataset.act === "watch") setMark(id, act.checked ? "watch" : null);
    else setMark(id, S.marks.get(id) === "ignore" ? null : "ignore");
    return;
  }
  if (e.target.closest("label")) return;
  openDetail(id);
});
$("list").addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) { e.preventDefault(); openDetail(Number(e.target.dataset.id)); }
});
document.querySelector(".controls .tabs").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  S.view = b.dataset.v;
  document.querySelectorAll(".controls .tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
  render();
});
$("q").addEventListener("input", e => { S.q = e.target.value.trim(); render(); });
$("sort").value = S.sort;
$("sort").addEventListener("change", e => { S.sort = e.target.value; pref.set("sort", S.sort); render(); });
$("continuing").checked = S.withContinuing;
$("continuing").addEventListener("change", async e => {
  S.withContinuing = e.target.checked; pref.set("continuing", S.withContinuing);
  if (S.withContinuing && !S.continuing.length) await loadContinuing();
  render();
});
$("genres").addEventListener("click", e => { const b = e.target.closest(".gchip"); if (!b) return; S.genre = b.dataset.g || null; renderGenres(); render(); });
$("season").addEventListener("change", e => {
  const [season, year] = e.target.value.split("-"); S.season = { season, year: Number(year) };
  S.continuing = []; loadSeason();
});
setInterval(() => { if (document.visibilityState === "visible" && $("detail").hidden) render(); }, 60e3);

// ---------- boot ----------
async function loadSeason() {
  S.loading = true; S.error = null; S.genre = null; renderHeader();
  $("list").innerHTML = `<div class="empty"><b>Loading ${esc(seasonLabel(S.season))}</b>Pulling the latest schedule from AniList.</div>`;
  try {
    S.list = await fetchSeason(S.season);
    S.list.forEach(a => S.byId.set(a.id, a));
    if (S.withContinuing) await loadContinuing();
  } catch (err) { S.error = err.message || "Network error"; }
  S.loading = false; renderHeader(); renderGenres(); render();
}
async function loadContinuing() {
  try { S.continuing = await fetchContinuing(S.season); S.continuing.forEach(a => S.byId.set(a.id, a)); }
  catch { toast("Couldn’t load continuing shows."); }
}

renderSeasonPicker();
loadSeason();

if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    const prevId = S.user?.id;
    S.user = session?.user || null;
    renderAccount();
    if (event === "PASSWORD_RECOVERY") openAuth("newpass");
    if ((S.user?.id || null) !== (prevId || null)) setTimeout(loadMarks, 0);
  });
} else {
  renderAccount();
}
})();
