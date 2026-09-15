// public/js/bidder.js — OPEN LINK → NAME + WHATSAPP → VERIFY → BID

const cfg = window.APP_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const FN_BASE = `${cfg.SUPABASE_URL}/functions/v1`;

const params = new URLSearchParams(location.search);
const auctionId = params.get("a");

const SESSION_KEY = "auction_session_token";
const MY_BID_KEY = `auction_my_bid_${auctionId}`;
const el = (id) => document.getElementById(id);

let auction = null;
let bidder = null; // { id, name }
let countdownTimer = null;
let myLastBid = Number(localStorage.getItem(MY_BID_KEY)) || null;

// -------------------------------------------------------- country codes
// A practical, not-exhaustive list covering common regions. Defaults to US.
// Users can also just type a full "+<code> number" and it's respected as-is.
const COUNTRY_CODES = [
  { code: "1", label: "🇺🇸 +1", iso: "us" },
  { code: "1", label: "🇨🇦 +1", iso: "ca" },
  { code: "44", label: "🇬🇧 +44", iso: "gb" },
  { code: "972", label: "🇮🇱 +972", iso: "il" },
  { code: "61", label: "🇦🇺 +61", iso: "au" },
  { code: "49", label: "🇩🇪 +49", iso: "de" },
  { code: "33", label: "🇫🇷 +33", iso: "fr" },
  { code: "34", label: "🇪🇸 +34", iso: "es" },
  { code: "39", label: "🇮🇹 +39", iso: "it" },
  { code: "31", label: "🇳🇱 +31", iso: "nl" },
  { code: "52", label: "🇲🇽 +52", iso: "mx" },
  { code: "55", label: "🇧🇷 +55", iso: "br" },
  { code: "27", label: "🇿🇦 +27", iso: "za" },
  { code: "91", label: "🇮🇳 +91", iso: "in" },
  { code: "65", label: "🇸🇬 +65", iso: "sg" },
  { code: "81", label: "🇯🇵 +81", iso: "jp" },
  { code: "82", label: "🇰🇷 +82", iso: "kr" },
  { code: "971", label: "🇦🇪 +971", iso: "ae" },
  { code: "353", label: "🇮🇪 +353", iso: "ie" },
  { code: "64", label: "🇳🇿 +64", iso: "nz" },
];

function initPhoneField() {
  const select = el("phone-country");
  select.innerHTML = COUNTRY_CODES.map((c, i) => `<option value="${c.code}" ${i === 0 ? "selected" : ""}>${c.label}</option>`).join("");

  // If the user pastes/types a full "+..." number, treat it as authoritative
  // and grey out the country picker's influence rather than fighting them.
  el("phone-input").addEventListener("input", (e) => {
    if (e.target.value.trim().startsWith("+")) {
      select.disabled = true;
    } else {
      select.disabled = false;
    }
  });
}

function buildE164Phone() {
  const raw = el("phone-input").value.trim();
  if (raw.startsWith("+")) {
    return raw.replace(/[^\d+]/g, "");
  }
  const digits = raw.replace(/\D/g, "");
  const dialCode = el("phone-country").value;
  return `+${dialCode}${digits}`;
}

function isValidE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

// ---------------------------------------------------------------- fetch API
async function callFn(name, body, extraHeaders = {}) {
  const res = await fetch(`${FN_BASE}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: cfg.SUPABASE_ANON_KEY, ...extraHeaders },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

// -------------------------------------------------------------------- init
async function init() {
  initPhoneField();

  if (!auctionId) {
    el("item-block").classList.add("hidden");
    return showScreen("notfound");
  }

  const { data, error } = await sb.from("auctions").select("*").eq("id", auctionId).single();
  if (error || !data) {
    el("item-block").classList.add("hidden");
    return showScreen("notfound");
  }
  auction = data;

  renderItem();
  startCountdown();
  await loadBidHistory();

  sb.channel(`auction-${auctionId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "auctions", filter: `id=eq.${auctionId}` }, (payload) => {
      auction = payload.new;
      renderItem();
      flashPrice();
      loadBidHistory();
      if (currentStep() === "bid") renderBidStep();
    })
    .subscribe();

  const storedToken = localStorage.getItem(SESSION_KEY);
  if (storedToken) {
    const result = await callFn("resolve-session", {}, { "x-session-token": storedToken });
    if (result.ok) {
      bidder = result.bidder;
      return showScreen("bid");
    }
    localStorage.removeItem(SESSION_KEY);
  }
  showScreen("identify");
}

function currentStep() {
  return document.querySelector(".step:not(.hidden)")?.dataset.step ?? null;
}

// ---------------------------------------------------------------- rendering
function renderItem() {
  el("item-photo").src = auction.image_url || "";
  el("item-photo").classList.toggle("hidden", !auction.image_url);
  el("item-title").textContent = auction.title;
  el("item-desc").textContent = auction.description || "";

  const isOpen = auction.status === "open" && new Date(auction.ending_time) > new Date();
  const pill = el("status-pill");
  pill.textContent = isOpen ? "Live" : "Closed";
  pill.className = `status-pill ${isOpen ? "live" : "closed"}`;

  el("price-value").textContent = formatMoney(auction.current_bid > 0 ? auction.current_bid : auction.starting_bid);
  el("price-label").textContent = auction.current_bid > 0 ? "Current bid" : "Starting bid";

  const minNext = auction.current_bid > 0 ? Number(auction.current_bid) + Number(auction.minimum_increment) : Number(auction.starting_bid);
  el("min-next").textContent = `Minimum next bid: ${formatMoney(minNext)}`;
}

function flashPrice() {
  const p = el("price-value");
  p.classList.remove("flash");
  void p.offsetWidth;
  p.classList.add("flash");
}

function formatMoney(n) {
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function startCountdown() {
  clearInterval(countdownTimer);
  const update = () => {
    const diff = new Date(auction.ending_time) - new Date();
    const box = el("countdown");
    if (diff <= 0) {
      box.innerHTML = `Auction <strong>closed</strong>`;
      box.classList.remove("ending-soon");
      clearInterval(countdownTimer);
      return;
    }
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    const hrs = Math.floor(mins / 60);
    const label = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m ${secs}s`;
    box.innerHTML = `Ends in <strong>${label}</strong>`;
    box.classList.toggle("ending-soon", diff < 5 * 60000);
  };
  update();
  countdownTimer = setInterval(update, 1000);
}

async function loadBidHistory() {
  const { data } = await sb
    .from("v_public_bids")
    .select("*")
    .eq("auction_id", auctionId)
    .order("created_at", { ascending: false })
    .limit(20);

  const list = el("bid-list");
  list.innerHTML = "";
  if (!data || data.length === 0) {
    list.innerHTML = `<p class="empty-note">No bids yet — be the first.</p>`;
    return;
  }
  for (const row of data) {
    const div = document.createElement("div");
    div.className = "bid-row";
    const time = new Date(row.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    div.innerHTML = row.bidder_display_name
      ? `<span class="name">${escapeHtml(row.bidder_display_name)} <span class="time">${time}</span></span><span class="amount">${formatMoney(row.amount)}</span>`
      : `<span class="name">Bid <span class="time">${time}</span></span><span class="amount">${formatMoney(row.amount)}</span>`;
    list.appendChild(div);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- screens
function showScreen(step) {
  document.querySelectorAll(".step").forEach((s) => s.classList.add("hidden"));
  el(`step-${step}`).classList.remove("hidden");
  if (step === "bid") renderBidStep();
}

function renderBidStep() {
  const isOpen = auction.status === "open" && new Date(auction.ending_time) > new Date();
  el("bid-bar").classList.toggle("hidden", !isOpen);
  el("bidder-greeting").textContent = bidder ? `Bidding as ${bidder.name}` : "";
  const minNext = auction.current_bid > 0 ? Number(auction.current_bid) + Number(auction.minimum_increment) : Number(auction.starting_bid);
  el("bid-amount-input").min = minNext;
  if (!el("bid-amount-input").value) el("bid-amount-input").placeholder = minNext.toFixed(0);
  renderMyStatus();
}

function renderMyStatus() {
  const box = el("my-status");
  if (!myLastBid) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const current = Number(auction.current_bid);
  if (current.toFixed(2) === Number(myLastBid).toFixed(2)) {
    box.textContent = "You're currently the highest bidder.";
    box.className = "my-status winning";
  } else if (current > myLastBid) {
    box.textContent = "You've been outbid — place a new bid to get back in the lead.";
    box.className = "my-status outbid";
  } else {
    box.classList.add("hidden");
  }
}

// ---------------------------------------------------------------- identify
el("identify-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError("identify-error");
  const name = el("name-input").value.trim();
  const phone = buildE164Phone();
  const email = el("email-input").value.trim();

  if (!name) return showError("identify-error", "Please enter your name.");
  if (!isValidE164(phone)) return showError("identify-error", "Please enter a valid WhatsApp number.");

  setLoading("identify-submit", true);
  const result = await callFn("send-verification", { auction_id: auctionId, name, phone, email });
  setLoading("identify-submit", false);

  if (!result.ok) return showError("identify-error", result.message || "Something went wrong.");

  pendingPhone = phone;
  el("verify-phone-label").textContent = phone;
  if (result.test_mode) {
    el("test-mode-note").classList.remove("hidden");
    el("test-mode-note").textContent = `TEST MODE — your code is ${result.dev_code}`;
  } else {
    el("test-mode-note").classList.add("hidden");
  }
  showScreen("verify");
});

// ---------------------------------------------------------------- verify
let pendingPhone = null;

el("verify-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError("verify-error");
  const code = el("code-input").value.trim();
  if (!code) return showError("verify-error", "Enter the code you received.");

  setLoading("verify-submit", true);
  const result = await callFn("verify-code", { phone: pendingPhone, code });
  setLoading("verify-submit", false);

  if (!result.ok) return showError("verify-error", result.message || "Incorrect code.");

  localStorage.setItem(SESSION_KEY, result.session_token);
  bidder = result.bidder;
  showScreen("bid");
});

el("resend-code").addEventListener("click", async () => {
  el("identify-form").requestSubmit();
});

el("back-to-identify").addEventListener("click", () => showScreen("identify"));

// ---------------------------------------------------------------- bidding
el("bid-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError("bid-error");
  const amount = Number(el("bid-amount-input").value);
  if (!amount || amount <= 0) return showError("bid-error", "Enter a bid amount.");

  const token = localStorage.getItem(SESSION_KEY);
  setLoading("bid-submit", true);
  const result = await callFn("place-bid", { auction_id: auctionId, amount }, { "x-session-token": token });
  setLoading("bid-submit", false);

  if (!result.ok) {
    if (result.error === "invalid_session" || result.error === "not_verified" || result.error === "session_expired") {
      localStorage.removeItem(SESSION_KEY);
      showScreen("identify");
      return;
    }
    let msg = result.message || "Could not place bid.";
    if (result.minimum_allowed) msg = `Minimum allowed bid: ${formatMoney(result.minimum_allowed)}`;
    return showError("bid-error", msg);
  }

  el("bid-amount-input").value = "";
  clearError("bid-error");
  myLastBid = amount;
  localStorage.setItem(MY_BID_KEY, String(amount));
  if (result.current_bid !== undefined) {
    auction.current_bid = result.current_bid;
    renderItem();
    flashPrice();
  }
  renderMyStatus();
});

// ---------------------------------------------------------------- helpers
function showError(id, msg) {
  const box = el(id);
  box.textContent = msg;
  box.classList.remove("hidden");
}
function clearError(id) {
  el(id).classList.add("hidden");
  el(id).textContent = "";
}
function setLoading(btnId, loading) {
  const btn = el(btnId);
  btn.disabled = loading;
  btn.textContent = loading ? "Please wait…" : btn.dataset.label;
}

init();
