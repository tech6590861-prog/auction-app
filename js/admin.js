// public/js/admin.js — admin dashboard (Supabase Auth + direct table access via RLS)

const cfg = window.APP_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const el = (id) => document.getElementById(id);
const app = el("app");

let session = null;
let auctionsCache = [];

// -------------------------------------------------------------------- init
async function init() {
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_event, s) => {
    session = s;
  });
  session ? renderDashboard() : renderLogin();
}

function formatMoney(n) {
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Assumes the standard layout: <base>/index.html (bidder page) + <base>/admin/index.html
// (this page), both served from the same origin — where <base> can be the site root OR a
// subpath (e.g. GitHub Pages project sites like /your-repo/). Derived from this page's own
// pathname rather than hardcoding "/", so it works no matter where the site is hosted, and
// works on hosts with clean URLs (no ".html" in the address bar) too.
function shareLink(auctionId) {
  const basePath = location.pathname.replace(/admin\/?(index\.html)?$/, "");
  return `${location.origin}${basePath}index.html?a=${auctionId}`;
}

// ------------------------------------------------------------------- login
function renderLogin() {
  app.innerHTML = `
    <div class="screen admin-body">
      <div class="admin-header"><span class="mark">Auction admin</span></div>
      <div class="center-flow">
        <p class="step-title">Sign in</p>
        <div id="login-error" class="error-box hidden"></div>
        <form id="login-form">
          <div class="field"><label>Email</label><input id="login-email" type="email" required /></div>
          <div class="field"><label>Password</label><input id="login-password" type="password" required /></div>
          <button class="btn-primary" type="submit">Sign in</button>
        </form>
        <p class="text-muted" style="margin-top:16px;font-size:13px;">
          Admin accounts are created in the Supabase dashboard under Authentication → Users. See the README for setup.
        </p>
      </div>
    </div>`;

  el("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = el("login-email").value.trim();
    const password = el("login-password").value;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      el("login-error").textContent = error.message;
      el("login-error").classList.remove("hidden");
      return;
    }
    session = data.session;
    renderDashboard();
  });
}

// --------------------------------------------------------------- dashboard
async function renderDashboard(tab = "open") {
  app.innerHTML = `
    <div class="screen admin-body">
      <div class="admin-header">
        <span class="mark">Auction admin</span>
        <button class="btn-text" id="logout-btn" style="width:auto;">Sign out</button>
      </div>
      <button class="btn-primary" id="new-auction-btn" style="margin-bottom:20px;">Create auction</button>
      <div class="tabs">
        <button class="tab-btn ${tab === "open" ? "active" : ""}" data-tab="open">Active</button>
        <button class="tab-btn ${tab === "closed" ? "active" : ""}" data-tab="closed">Closed</button>
      </div>
      <div id="auction-list" class="table-list"><p class="text-muted">Loading…</p></div>
    </div>`;

  el("logout-btn").addEventListener("click", async () => { await sb.auth.signOut(); renderLogin(); });
  el("new-auction-btn").addEventListener("click", () => renderEditor(null));
  document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => renderDashboard(b.dataset.tab)));

  const status = tab === "open" ? "open" : "closed";
  const { data, error } = await sb.from("auctions").select("*").eq("status", status).order("created_at", { ascending: false });
  const list = el("auction-list");
  if (error) { list.innerHTML = `<p class="text-muted">Could not load auctions.</p>`; return; }
  if (!data.length) { list.innerHTML = `<p class="text-muted">No ${status} auctions yet.</p>`; return; }

  auctionsCache = data;
  list.innerHTML = data.map((a) => `
    <div class="table-row" data-id="${a.id}" style="cursor:pointer;">
      <div>
        <div class="t-title">${escapeHtml(a.title)}</div>
        <div class="t-meta">${formatMoney(a.current_bid > 0 ? a.current_bid : a.starting_bid)} · ends ${new Date(a.ending_time).toLocaleString()}</div>
      </div>
      <span class="badge ${a.status === "open" ? "open" : ""}">${a.status}</span>
    </div>`).join("");

  list.querySelectorAll(".table-row").forEach((row) => {
    row.addEventListener("click", () => renderDetail(row.dataset.id));
  });
}

// ----------------------------------------------------------------- editor
function renderEditor(auction) {
  const isEdit = !!auction;
  app.innerHTML = `
    <div class="screen admin-body">
      <div class="admin-header">
        <button class="btn-text" id="back-btn" style="width:auto;">← Back</button>
      </div>
      <p class="step-title">${isEdit ? "Edit auction" : "Create auction"}</p>
      <div id="editor-error" class="error-box hidden"></div>
      <form id="editor-form">
        <div class="field"><label>Item title</label><input id="f-title" required value="${escapeHtml(auction?.title ?? "")}" /></div>
        <div class="field"><label>Description</label><input id="f-desc" value="${escapeHtml(auction?.description ?? "")}" /></div>
        <div class="field">
          <label>Item photo</label>
          <img id="photo-preview" class="photo-upload-preview ${auction?.image_url ? "show" : ""}" src="${auction?.image_url ?? ""}" alt="" />
          <label class="file-input-btn" id="file-input-label">
            <span id="file-input-text">${auction?.image_url ? "Change photo" : "Take or choose a photo"}</span>
            <input id="f-photo-file" type="file" accept="image/*" capture="environment" />
          </label>
          <input type="hidden" id="f-image" value="${escapeHtml(auction?.image_url ?? "")}" />
        </div>
        <div class="field"><label>Starting bid</label><input id="f-start" type="number" step="0.01" min="0" required value="${auction?.starting_bid ?? ""}" /></div>
        <div class="field"><label>Minimum bid increment</label><input id="f-incr" type="number" step="0.01" min="0.01" required value="${auction?.minimum_increment ?? "5"}" /></div>
        <div class="field"><label>Ending date &amp; time</label><input id="f-end" type="datetime-local" required value="${auction ? toLocalInput(auction.ending_time) : ""}" /></div>
        <div class="checkbox-row">
          <input id="f-identity" type="checkbox" ${auction?.show_bidder_identity !== false ? "checked" : ""} />
          <label for="f-identity">Show bidder identity publicly</label>
        </div>
        <button class="btn-primary" type="submit">${isEdit ? "Save changes" : "Create auction"}</button>
      </form>
    </div>`;

  el("back-btn").addEventListener("click", () => (isEdit ? renderDetail(auction.id) : renderDashboard()));

  el("f-photo-file").addEventListener("change", () => {
    const file = el("f-photo-file").files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      el("photo-preview").src = reader.result;
      el("photo-preview").classList.add("show");
      el("file-input-text").textContent = "Change photo";
    };
    reader.readAsDataURL(file);
  });

  el("editor-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    el("editor-error").classList.add("hidden");

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";

    let imageUrl = el("f-image").value || null;
    const file = el("f-photo-file").files[0];
    if (file) {
      const path = `${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9.\-]/g, "_")}`;
      const { error: uploadErr } = await sb.storage.from("auction-photos").upload(path, file, { upsert: false });
      if (uploadErr) {
        submitBtn.disabled = false;
        submitBtn.textContent = isEdit ? "Save changes" : "Create auction";
        return showEditorError(`Photo upload failed: ${uploadErr.message}`);
      }
      const { data: pub } = sb.storage.from("auction-photos").getPublicUrl(path);
      imageUrl = pub.publicUrl;
    }

    const payload = {
      title: el("f-title").value.trim(),
      description: el("f-desc").value.trim(),
      image_url: imageUrl,
      starting_bid: Number(el("f-start").value),
      minimum_increment: Number(el("f-incr").value),
      ending_time: new Date(el("f-end").value).toISOString(),
      show_bidder_identity: el("f-identity").checked,
    };
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? "Save changes" : "Create auction";

    if (!payload.title) return showEditorError("Item title is required.");
    if (payload.starting_bid < 0) return showEditorError("Starting bid cannot be negative.");
    if (payload.minimum_increment <= 0) return showEditorError("Minimum increment must be greater than zero.");
    if (new Date(payload.ending_time) <= new Date()) return showEditorError("Ending time must be in the future.");

    if (isEdit) {
      const { error } = await sb.from("auctions").update(payload).eq("id", auction.id);
      if (error) return showEditorError(error.message);
      renderDetail(auction.id);
    } else {
      payload.current_bid = 0;
      payload.status = "open";
      payload.created_by = session?.user?.id ?? null;
      const { data, error } = await sb.from("auctions").insert(payload).select("id").single();
      if (error) return showEditorError(error.message);
      renderDetail(data.id);
    }
  });
}
function showEditorError(msg) {
  const box = el("editor-error");
  box.textContent = msg;
  box.classList.remove("hidden");
}
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ----------------------------------------------------------------- detail
async function renderDetail(auctionId) {
  const { data: auction } = await sb.from("auctions").select("*").eq("id", auctionId).single();
  if (!auction) return renderDashboard();

  const { data: bids } = await sb
    .from("bids")
    .select("id, amount, created_at, bidders ( id, name, phone, email, phone_verified )")
    .eq("auction_id", auctionId)
    .order("created_at", { ascending: false });

  const uniqueBidders = new Map();
  (bids ?? []).forEach((b) => { if (b.bidders) uniqueBidders.set(b.bidders.id, b.bidders); });

  app.innerHTML = `
    <div class="screen admin-body">
      <div class="admin-header">
        <button class="btn-text" id="back-btn" style="width:auto;">← Back</button>
        <button class="btn-text" id="edit-btn" style="width:auto;">Edit</button>
      </div>
      <p class="step-title" style="margin-bottom:4px;">${escapeHtml(auction.title)}</p>
      <span class="badge ${auction.status === "open" ? "open" : ""}">${auction.status}</span>

      <div class="stat-grid">
        <div class="stat-box"><div class="n">${formatMoney(auction.current_bid > 0 ? auction.current_bid : auction.starting_bid)}</div><div class="l">Highest bid</div></div>
        <div class="stat-box"><div class="n">${uniqueBidders.size}</div><div class="l">Bidders</div></div>
        <div class="stat-box"><div class="n">${(bids ?? []).length}</div><div class="l">Bids</div></div>
      </div>

      <div class="section-title">Share link</div>
      <div class="link-row">
        <input id="share-link" readonly value="${shareLink(auction.id)}" />
        <button id="copy-link-btn">Copy</button>
      </div>

      ${auction.status === "open" ? `<button class="btn-primary" id="close-btn" style="margin-top:20px;background:var(--live);color:#fff;">Close auction now</button>` : ""}

      <div class="section-title">Bidders</div>
      <div class="table-list">
        ${uniqueBidders.size === 0 ? `<p class="text-muted">No bidders yet.</p>` : Array.from(uniqueBidders.values()).map((b) => `
          <div class="table-row">
            <div>
              <div class="t-title">${escapeHtml(b.name)}</div>
              <div class="t-meta">${escapeHtml(b.phone)}${b.email ? " · " + escapeHtml(b.email) : ""}</div>
            </div>
            <span class="badge ${b.phone_verified ? "open" : ""}">${b.phone_verified ? "verified" : "unverified"}</span>
          </div>`).join("")}
      </div>

      <div class="section-title">Bid history</div>
      <div class="table-list">
        ${(bids ?? []).length === 0 ? `<p class="text-muted">No bids yet.</p>` : (bids ?? []).map((b) => `
          <div class="table-row">
            <div>
              <div class="t-title">${escapeHtml(b.bidders?.name ?? "Unknown")}</div>
              <div class="t-meta">${new Date(b.created_at).toLocaleString()}</div>
            </div>
            <span class="amount" style="color:var(--gold-bright);font-variant-numeric:tabular-nums;">${formatMoney(b.amount)}</span>
          </div>`).join("")}
      </div>
    </div>`;

  el("back-btn").addEventListener("click", () => renderDashboard(auction.status === "open" ? "open" : "closed"));
  el("edit-btn").addEventListener("click", () => renderEditor(auction));
  el("copy-link-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(el("share-link").value);
    el("copy-link-btn").textContent = "Copied";
    setTimeout(() => (el("copy-link-btn").textContent = "Copy"), 1500);
  });
  const closeBtn = el("close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", async () => {
      if (!confirm("Close this auction now? Bidders will no longer be able to place bids.")) return;
      await sb.from("auctions").update({ status: "closed" }).eq("id", auction.id);
      renderDetail(auction.id);
    });
  }
}

init();