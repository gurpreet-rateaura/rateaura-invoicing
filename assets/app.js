/* ================= CONFIG ================= */
const CONFIG = {
  // Paste your Google Apps Script Web App URL here (ends with /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbylMR1hO1-oPJA6-Z7XyQWs9YCkc5Xyq3SddPjyMb0Pid5SgkX1qDHiABKTinyrjjUGEA/exec'
};
/* ================= STATE ================= */
let DATA = { config:{}, customers:[], vendors:[], invoices:[], payments:[], payables:[], paysettlements:[], expenses:[], customerAdvances:[], vendorAdvances:[] };
let CURRENT_VIEW = 'dashboard';
let EDIT_INVOICE_ID = null;
let INVOICE_ITEMS = [];

/* ================= UTIL ================= */
async function sha256hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function fmtMoney(amount, currency){
  const n = Number(amount)||0;
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return new Intl.NumberFormat(locale, {minimumFractionDigits:2, maximumFractionDigits:2}).format(n);
}
function symbolFor(currency){
  return currency === 'INR' ? (DATA.config.currencySymbolINR || '₹') : (DATA.config.currencySymbolUSD || '$');
}
function fmtDate(d){
  if(!d) return '—';
  const dt = new Date(d);
  if(isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'});
}
function todayISO(){ return new Date().toISOString().slice(0,10); }
function uidTmp(){ return 'tmp_'+Math.random().toString(36).slice(2); }
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ================= API ================= */
let AUTH_KEY = null;

class ApiAuthError extends Error {
  constructor(reason, lockUntil){
    super('auth_error');
    this.reason = reason;
    this.lockUntil = lockUntil;
  }
}

async function apiAuthStatus(){
  const res = await fetch(CONFIG.API_URL + '?action=authstatus');
  return res.json();
}
async function apiGet(){
  const res = await fetch(CONFIG.API_URL + '?action=bootstrap&authKey=' + encodeURIComponent(AUTH_KEY||''));
  return res.json();
}
async function apiPost(action, payload){
  const res = await fetch(CONFIG.API_URL, {
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body: JSON.stringify({action, payload, authKey: AUTH_KEY})
  });
  return res.json();
}
async function reloadData(){
  const result = await apiGet();
  if(result && result.error === 'unauthorized'){
    handleSessionInvalid();
    throw new ApiAuthError(result.reason, result.lockUntil);
  }
  if(result && result.error){
    throw new Error(result.error);
  }
  DATA = result;
}
// If a request comes back unauthorized while the app is already open (session went
// stale, password changed elsewhere, etc.), drop back to the login screen instead of
// leaving the UI in a broken half-loaded state.
function handleSessionInvalid(){
  sessionStorage.removeItem('rateaura_auth_key');
  AUTH_KEY = null;
  if(document.getElementById('app').classList.contains('active')){
    alert('Your session is no longer valid — please log in again.');
    location.reload();
  }
}

/* ================= AUTH ================= */
async function initApp(){
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  const storedKey = sessionStorage.getItem('rateaura_auth_key');
  if(storedKey){
    AUTH_KEY = storedKey;
    try{
      await reloadData();
      enterApp();
      return;
    }catch(err){
      if(err instanceof ApiAuthError){
        sessionStorage.removeItem('rateaura_auth_key');
        AUTH_KEY = null;
        // fall through to show the normal login screen below
      }else{
        showConnectionRetry();
        return;
      }
    }
  }
  await prepareLoginScreen();
}
async function prepareLoginScreen(){
  const hintEl = document.querySelector('.login-hint');
  try{
    const status = await apiAuthStatus();
    if(hintEl) hintEl.textContent = status.hasPassword
      ? 'Enter your password to continue.'
      : "First time here? Just set a password above — it'll become your login going forward.";
  }catch(err){
    document.getElementById('login-error').textContent = 'Could not reach the backend. Check API_URL in app.js.';
  }
  document.getElementById('login-screen').style.display = 'flex';
}
function showConnectionRetry(){
  const errEl = document.getElementById('login-error');
  errEl.innerHTML = 'Connection problem — could not verify your session. <a href="#" onclick="location.reload();return false;" style="color:var(--brass);text-decoration:underline;">Retry</a>';
  document.getElementById('login-screen').style.display = 'flex';
}

async function handleLogin(e){
  e.preventDefault();
  const pwd = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  const hash = await sha256hex(pwd);

  try{
    const status = await apiAuthStatus();
    if(!status.hasPassword){
      if(pwd.length < 6){ errEl.textContent = 'Choose a password with at least 6 characters.'; return; }
      const setRes = await apiPost('setInitialPassword', {passwordHash: hash});
      if(setRes && setRes.error){ errEl.textContent = setRes.error; return; }
      AUTH_KEY = hash;
      await reloadData();
      sessionStorage.setItem('rateaura_auth_key', hash);
      enterApp();
      return;
    }

    AUTH_KEY = hash;
    await reloadData();
    sessionStorage.setItem('rateaura_auth_key', hash);
    enterApp();
  }catch(err){
    AUTH_KEY = null;
    if(err instanceof ApiAuthError){
      if(err.reason === 'locked'){
        const until = err.lockUntil ? new Date(err.lockUntil).toLocaleTimeString() : 'a few minutes';
        errEl.textContent = 'Too many failed attempts. Try again after ' + until + '.';
      }else{
        errEl.textContent = 'Incorrect password.';
      }
    }else{
      errEl.textContent = 'Could not reach the backend. Check your connection and try again.';
    }
  }
}

function logout(){
  sessionStorage.removeItem('rateaura_auth_key');
  AUTH_KEY = null;
  location.reload();
}

function enterApp(){
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('active');
  navigate('dashboard');
}

/* ================= NAVIGATION ================= */
function navigate(view){
  CURRENT_VIEW = view;
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active', el.dataset.view===view));
  const main = document.getElementById('main-content');
  const renderers = {
    dashboard: renderDashboard,
    invoices: renderInvoices,
    customers: renderCustomers,
    payables: renderPayables,
    vendors: renderVendors,
    forex: renderForexReport,
    expenses: renderExpenses,
    pnl: renderProfitLoss,
    advances: renderAdvances,
    ledger: renderLedger,
    settings: renderSettings
  };
  main.innerHTML = '';
  (renderers[view] || renderDashboard)(main);
}

/* ================= COMPUTED HELPERS ================= */
function paidForInvoice(invId){
  return DATA.payments.filter(p=>p.invoiceId===invId).reduce((s,p)=>s+Number(p.amount||0),0);
}
function paidForPayable(payId){
  return DATA.paysettlements.filter(p=>p.payableId===payId).reduce((s,p)=>s+Number(p.amount||0),0);
}
// The single "amount owed in USD" for a payable, regardless of vendor type —
// USD vendors are billed directly in USD; INR vendors are booked in INR but
// the systemUsdBuying figure (incl. FX buffer) is what will actually be remitted.
function payableTotalUSD(p){
  return p.vendorType === 'INR' ? Number(p.systemUsdBuying||0) : Number(p.usdAmount||0);
}
/* ---- Advances ---- */
function customerAdvanceTotal(customerId, currency){
  return DATA.customerAdvances.filter(a=>a.customerId===customerId && a.currency===currency).reduce((s,a)=>s+Number(a.amount||0),0);
}
function customerAdvanceApplied(customerId, currency){
  return DATA.payments.filter(p=>{
    if(p.source !== 'advance') return false;
    const inv = DATA.invoices.find(i=>i.id===p.invoiceId);
    return inv && inv.customerId===customerId && inv.currency===currency;
  }).reduce((s,p)=>s+Number(p.amount||0),0);
}
function customerAdvanceAvailable(customerId, currency){
  return customerAdvanceTotal(customerId, currency) - customerAdvanceApplied(customerId, currency);
}
function vendorAdvanceTotal(vendorId){
  return DATA.vendorAdvances.filter(a=>a.vendorId===vendorId).reduce((s,a)=>s+Number(a.amount||0),0);
}
function vendorAdvanceApplied(vendorId){
  return DATA.paysettlements.filter(s=>{
    if(s.source !== 'advance') return false;
    const p = DATA.payables.find(x=>x.id===s.payableId);
    return p && p.vendorId===vendorId;
  }).reduce((s,x)=>s+Number(x.amount||0),0);
}
function vendorAdvanceAvailable(vendorId){
  return vendorAdvanceTotal(vendorId) - vendorAdvanceApplied(vendorId);
}
// Remaining USD balance on ONE specific advance batch (used for INR vendors, where each
// batch carries its own locked FX rate and must be drawn down precisely, not pooled).
function vendorAdvanceRemaining(advanceId){
  const adv = DATA.vendorAdvances.find(a=>a.id===advanceId);
  if(!adv) return 0;
  const used = DATA.paysettlements.filter(s=>s.advanceId===advanceId).reduce((s,x)=>s+Number(x.amount||0),0);
  return Number(adv.amount||0) - used;
}
function vendorAdvancesForDropdown(vendorId){
  return DATA.vendorAdvances.filter(a=>a.vendorId===vendorId && vendorAdvanceRemaining(a.id) > 0.004);
}
function remainingInrForPayable(p){
  const settledInr = DATA.paysettlements.filter(s=>s.payableId===p.id).reduce((s,x)=>s+Number(x.inrAmountSettled||0),0);
  return Number(p.inrAmount||0) - settledInr;
}
function vendorTypeOf(vendorId){
  const v = DATA.vendors.find(v=>v.id===vendorId);
  return v ? (v.vendorType||'USD') : 'USD';
}
function fxGainLossForPayable(p){
  return DATA.paysettlements.filter(s=>s.payableId===p.id).reduce((s,x)=>s+Number(x.forexGainLoss||0),0);
}
function isFxSettlement(s){
  // A settlement carries FX data only if it belongs to an INR-vendor payable
  const p = DATA.payables.find(x=>x.id===s.payableId);
  return p && p.vendorType === 'INR';
}
function forexTotals(){
  const inrPayables = DATA.payables.filter(p=>p.vendorType==='INR');
  const fxSettlements = DATA.paysettlements.filter(isFxSettlement);
  const bufferBooked = inrPayables.reduce((s,p)=>s+Number(p.bufferAmountUsd||0),0);
  const bufferRealized = fxSettlements.reduce((s,x)=>s+Number(x.allocatedBufferUsd||0),0);
  const forexRealized = fxSettlements.reduce((s,x)=>s+Number(x.forexGainLoss||0),0); // stored: +ve = loss, -ve = gain
  const fxProfitRealized = -forexRealized; // flipped for display: +ve = profit, -ve = loss (this is the headline number)
  const rawFxDifferenceRealized = fxSettlements.reduce((s,x)=>s+Number(x.fxDifference||0),0); // raw currency movement, before buffer
  return { bufferBooked, bufferRealized, forexRealized, fxProfitRealized, rawFxDifferenceRealized, settlementCount: fxSettlements.length };
}
function monthlyForexSummary(){
  const map = {};
  DATA.paysettlements.filter(isFxSettlement).forEach(s=>{
    const key = (s.date||'').slice(0,7) || 'Unknown';
    if(!map[key]) map[key] = {month:key, gainLoss:0, buffer:0, count:0};
    map[key].gainLoss += Number(s.forexGainLoss||0);
    map[key].buffer += Number(s.allocatedBufferUsd||0);
    map[key].count += 1;
  });
  return Object.values(map).sort((a,b)=> b.month.localeCompare(a.month));
}
function vendorForexSummary(){
  const map = {};
  DATA.paysettlements.filter(isFxSettlement).forEach(s=>{
    const p = DATA.payables.find(x=>x.id===s.payableId);
    const vId = p ? p.vendorId : 'unknown';
    if(!map[vId]) map[vId] = {vendorId:vId, gainLoss:0, buffer:0, count:0};
    map[vId].gainLoss += Number(s.forexGainLoss||0);
    map[vId].buffer += Number(s.allocatedBufferUsd||0);
    map[vId].count += 1;
  });
  return Object.values(map).sort((a,b)=> b.gainLoss - a.gainLoss);
}
function invoiceStatus(inv){
  const paid = paidForInvoice(inv.id);
  const total = Number(inv.total||0);
  if(paid <= 0) return 'Unpaid';
  if(paid < total) return 'Partially Paid';
  return 'Paid';
}
function payableStatus(p){
  if(p.vendorType === 'INR'){
    const remainingInr = remainingInrForPayable(p);
    const totalInr = Number(p.inrAmount||0);
    if(remainingInr <= 0.01) return 'Paid';
    if(remainingInr < totalInr - 0.01) return 'Partially Paid';
    return 'Unpaid';
  }
  const paid = paidForPayable(p.id);
  const total = payableTotalUSD(p);
  if(paid <= 0) return 'Unpaid';
  if(paid < total - 0.004) return 'Partially Paid';
  return 'Paid';
}
// The USD figure to show as "outstanding" — for an INR vendor this is driven by the
// remaining INR balance (not the USD paid-so-far, which will legitimately differ from
// the booking estimate whenever there's forex gain/loss — that's not still-owed money).
function payableOutstandingUSD(p){
  if(p.vendorType === 'INR'){
    const remainingInr = remainingInrForPayable(p);
    if(remainingInr <= 0.01) return 0;
    const rate = Number(p.bookingFxRate||0);
    return rate>0 ? remainingInr/rate : 0;
  }
  return payableTotalUSD(p) - paidForPayable(p.id);
}
function statusBadge(status){
  const map = {'Paid':'badge-success','Partially Paid':'badge-warn','Unpaid':'badge-danger'};
  return `<span class="badge ${map[status]||'badge-muted'}">${status}</span>`;
}
function customerName(id){ const c = DATA.customers.find(c=>c.id===id); return c ? c.name : '—'; }
function vendorName(id){ const v = DATA.vendors.find(v=>v.id===id); return v ? v.name : '—'; }

/* ================= DASHBOARD ================= */
function renderDashboard(main){
  let recUSD=0, recINR=0, payUSD=0, overdueCount=0;
  DATA.invoices.forEach(inv=>{
    const outstanding = Number(inv.total||0) - paidForInvoice(inv.id);
    if(outstanding > 0.004){
      if(inv.currency==='INR') recINR += outstanding; else recUSD += outstanding;
      if(inv.dueDate && new Date(inv.dueDate) < new Date()) overdueCount++;
    }
  });
  DATA.payables.forEach(p=>{
    const outstanding = payableOutstandingUSD(p);
    if(outstanding > 0.004) payUSD += outstanding;
  });
  const fx = forexTotals();
  const pnl = pnlTotals(DATA.config.businessStartDate || '2026-02-01', todayISO());

  main.innerHTML = `
    <div class="page-header">
      <div><h2>Dashboard</h2><p>Overview of what's owed to you and what you owe.</p></div>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Receivable — USD</div><div class="kpi-value amount">$${fmtMoney(recUSD,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Receivable — INR</div><div class="kpi-value amount">₹${fmtMoney(recINR,'INR')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Payable Outstanding — USD</div><div class="kpi-value danger amount">$${fmtMoney(payUSD,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">FX Profit/Loss (Realized)</div><div class="kpi-value amount ${fx.fxProfitRealized>=0?'success':'danger'}">${fx.fxProfitRealized>=0?'+':'-'}$${fmtMoney(Math.abs(fx.fxProfitRealized),'USD')}</div></div>
      <div class="kpi-card" style="cursor:pointer;border-color:${pnl.netProfit>=0?'var(--success)':'var(--danger)'};" onclick="navigate('pnl')">
        <div class="kpi-label">Net ${pnl.netProfit>=0?'Profit':'Loss'} (Since Inception) →</div>
        <div class="kpi-value amount ${pnl.netProfit>=0?'success':'danger'}">$${fmtMoney(Math.abs(pnl.netProfit),'USD')}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Recent Invoices</h3><button class="btn" onclick="navigate('invoices')">View all</button></div>
      <table>
        <thead><tr><th>Invoice #</th><th>Customer</th><th>Issue Date</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>${recentInvoicesRows()}</tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-head"><h3>Upcoming / Overdue Payables</h3><button class="btn" onclick="navigate('payables')">View all</button></div>
      <table>
        <thead><tr><th>Bill #</th><th>Vendor</th><th>Due Date</th><th>Amount (USD)</th><th>Status</th></tr></thead>
        <tbody>${recentPayablesRows()}</tbody>
      </table>
    </div>
  `;
}
function recentInvoicesRows(){
  const list = [...DATA.invoices].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5);
  if(!list.length) return `<tr class="empty-row"><td colspan="5">No invoices yet.</td></tr>`;
  return list.map(inv=>`
    <tr>
      <td class="invoice-number">${escapeHtml(inv.invoiceNumber)}</td>
      <td>${escapeHtml(customerName(inv.customerId))}</td>
      <td>${fmtDate(inv.issueDate)}</td>
      <td class="amount">${symbolFor(inv.currency)}${fmtMoney(inv.total, inv.currency)}</td>
      <td>${statusBadge(invoiceStatus(inv))}</td>
    </tr>`).join('');
}
function recentPayablesRows(){
  const list = [...DATA.payables].sort((a,b)=> new Date(a.dueDate||0)-new Date(b.dueDate||0)).slice(0,5);
  if(!list.length) return `<tr class="empty-row"><td colspan="5">No payables yet.</td></tr>`;
  return list.map(p=>`
    <tr>
      <td class="mono">${escapeHtml(p.billNumber||'—')}</td>
      <td>${escapeHtml(vendorName(p.vendorId))}</td>
      <td>${fmtDate(p.dueDate)}</td>
      <td class="amount">$${fmtMoney(payableTotalUSD(p), 'USD')}</td>
      <td>${statusBadge(payableStatus(p))}</td>
    </tr>`).join('');
}

/* ================= INVOICES ================= */
function renderInvoices(main){
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Invoices</h2><p>Create, download and track settlement of client invoices.</p></div>
      <button class="btn btn-gold" onclick="openInvoiceModal()">+ New Invoice</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Invoice #</th><th>Customer</th><th>Issue Date</th><th>Due Date</th><th>Total</th><th>Outstanding</th><th>Status</th><th></th></tr></thead>
        <tbody>${invoiceRows()}</tbody>
      </table>
    </div>
  `;
}
function invoiceRows(){
  const list = [...DATA.invoices].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  if(!list.length) return `<tr class="empty-row"><td colspan="8">No invoices yet. Create your first one.</td></tr>`;
  return list.map(inv=>{
    const paid = paidForInvoice(inv.id);
    const outstanding = Number(inv.total||0) - paid;
    return `<tr>
      <td class="invoice-number">${escapeHtml(inv.invoiceNumber)}</td>
      <td>${escapeHtml(customerName(inv.customerId))}</td>
      <td>${fmtDate(inv.issueDate)}</td>
      <td>${fmtDate(inv.dueDate)}</td>
      <td class="amount">${symbolFor(inv.currency)}${fmtMoney(inv.total, inv.currency)}</td>
      <td class="amount">${symbolFor(inv.currency)}${fmtMoney(outstanding, inv.currency)}</td>
      <td>${statusBadge(invoiceStatus(inv))}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" onclick="downloadInvoicePDF('${inv.id}')">PDF</button>
        <button class="btn btn-sm" onclick="openSettleModal('${inv.id}')">Settle</button>
        <button class="btn btn-sm" onclick="openInvoiceModal('${inv.id}')">Edit</button>
        <button class="btn btn-sm btn-ghost" onclick="removeInvoice('${inv.id}')">✕</button>
      </td>
    </tr>`;
  }).join('');
}
async function removeInvoice(id){
  if(!confirm('Delete this invoice? This cannot be undone.')) return;
  await apiPost('deleteInvoice', {id});
  await reloadData();
  navigate('invoices');
}

function openInvoiceModal(id){
  EDIT_INVOICE_ID = id || null;
  const inv = id ? DATA.invoices.find(i=>i.id===id) : null;
  INVOICE_ITEMS = inv ? JSON.parse(inv.itemsJson || '[]') : [{description:'', quantity:1, rate:0}];

  const customerOptions = DATA.customers.map(c=>`<option value="${c.id}" ${inv&&inv.customerId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
  const body = `
    <div class="form-row">
      <div class="form-group">
        <label>Customer</label>
        <select id="f-customer">${customerOptions || '<option value="">No customers yet — add one first</option>'}</select>
      </div>
      <div class="form-group">
        <label>Currency</label>
        <select id="f-currency">
          <option value="USD" ${inv&&inv.currency==='USD'?'selected':''}>USD</option>
          <option value="INR" ${inv&&inv.currency==='INR'?'selected':''}>INR</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Issue Date</label><input type="date" id="f-issuedate" value="${inv?inv.issueDate:todayISO()}"></div>
      <div class="form-group"><label>Due Date</label><input type="date" id="f-duedate" value="${inv?inv.dueDate:''}"></div>
    </div>
    <div class="section-title">Line Items</div>
    <table class="items-table">
      <thead><tr><th style="width:50%">Description</th><th>Qty</th><th>Rate</th><th>Amount</th><th></th></tr></thead>
      <tbody id="items-body"></tbody>
    </table>
    <button class="btn btn-sm" onclick="addItemRow()">+ Add line</button>
    <div class="totals-box">
      <div>Total: <span class="grand amount" id="f-total">0.00</span></div>
    </div>
    <div class="form-group full" style="margin-top:14px;">
      <label>Notes (payment terms, thank-you note, etc.)</label>
      <textarea id="f-notes">${inv ? escapeHtml(inv.notes||'') : ''}</textarea>
    </div>
  `;
  openModal(id ? 'Edit Invoice' : 'New Invoice', body, [
    {label:'Cancel', cls:'btn', onClick:closeModal},
    {label:'Save Invoice', cls:'btn btn-gold', onClick:saveInvoiceForm}
  ], true);
  renderItemRows();
}
function renderItemRows(){
  const tbody = document.getElementById('items-body');
  tbody.innerHTML = INVOICE_ITEMS.map((it,i)=>`
    <tr>
      <td><input type="text" value="${escapeHtml(it.description)}" oninput="INVOICE_ITEMS[${i}].description=this.value"></td>
      <td style="width:70px"><input type="number" min="0" step="1" value="${it.quantity}" oninput="INVOICE_ITEMS[${i}].quantity=parseFloat(this.value)||0;updateTotals()"></td>
      <td style="width:110px"><input type="number" min="0" step="0.01" value="${it.rate}" oninput="INVOICE_ITEMS[${i}].rate=parseFloat(this.value)||0;updateTotals()"></td>
      <td style="width:100px" class="amount">${fmtMoney((it.quantity||0)*(it.rate||0))}</td>
      <td><button class="remove-item" onclick="removeItemRow(${i})">✕</button></td>
    </tr>`).join('');
  updateTotals();
}
function addItemRow(){ INVOICE_ITEMS.push({description:'', quantity:1, rate:0}); renderItemRows(); }
function removeItemRow(i){ INVOICE_ITEMS.splice(i,1); renderItemRows(); }
function updateTotals(){
  renderItemRowsAmountsOnly();
  const total = INVOICE_ITEMS.reduce((s,it)=>s+(Number(it.quantity)||0)*(Number(it.rate)||0),0);
  document.getElementById('f-total').textContent = fmtMoney(total);
}
function renderItemRowsAmountsOnly(){
  const rows = document.querySelectorAll('#items-body tr');
  rows.forEach((row,i)=>{
    const amtCell = row.children[3];
    const it = INVOICE_ITEMS[i];
    if(amtCell && it) amtCell.textContent = fmtMoney((it.quantity||0)*(it.rate||0));
  });
}
async function saveInvoiceForm(){
  const customerId = document.getElementById('f-customer').value;
  if(!customerId){ alert('Please select a customer.'); return; }
  const currency = document.getElementById('f-currency').value;
  const issueDate = document.getElementById('f-issuedate').value;
  const dueDate = document.getElementById('f-duedate').value;
  const notes = document.getElementById('f-notes').value;
  const items = INVOICE_ITEMS.filter(it=>it.description.trim() !== '');
  if(!items.length){ alert('Add at least one line item.'); return; }
  const total = items.reduce((s,it)=>s+(Number(it.quantity)||0)*(Number(it.rate)||0),0);
  const payload = {
    id: EDIT_INVOICE_ID || undefined,
    customerId, currency, issueDate, dueDate, notes,
    itemsJson: JSON.stringify(items),
    subtotal: total, total: total
  };
  await apiPost('saveInvoice', payload);
  await reloadData();
  closeModal();
  navigate('invoices');
}

/* ---- Settlement (invoice) ---- */
function openSettleModal(invId){
  const inv = DATA.invoices.find(i=>i.id===invId);
  const paid = paidForInvoice(invId);
  const outstanding = Number(inv.total) - paid;
  const history = DATA.payments.filter(p=>p.invoiceId===invId);
  const availableAdvance = customerAdvanceAvailable(inv.customerId, inv.currency);
  const body = `
    <p style="margin-top:0;color:var(--muted);font-size:0.9rem;">
      Invoice <strong class="invoice-number">${escapeHtml(inv.invoiceNumber)}</strong> —
      Total ${symbolFor(inv.currency)}${fmtMoney(inv.total,inv.currency)},
      Outstanding <strong>${symbolFor(inv.currency)}${fmtMoney(outstanding,inv.currency)}</strong>
    </p>
    <div class="form-row">
      <div class="form-group"><label>Amount Received</label><input type="number" id="s-amount" step="0.01" value="${outstanding>0?outstanding.toFixed(2):''}"></div>
      <div class="form-group"><label>Date</label><input type="date" id="s-date" value="${todayISO()}"></div>
    </div>
    <div class="form-group"><label>Method (wire, PayPal, etc.)</label><input type="text" id="s-method"></div>
    <div class="form-group full"><label>Note</label><input type="text" id="s-note"></div>
    ${availableAdvance > 0.004 ? `
    <div class="card" style="background:var(--paper);box-shadow:none;margin:6px 0 14px;">
      <div style="padding:12px 16px;font-size:0.85rem;">
        <label style="display:flex;align-items:center;gap:8px;font-weight:500;color:var(--ink);cursor:pointer;">
          <input type="checkbox" id="s-from-advance" style="width:auto;">
          Apply from advance balance instead of new cash — available ${symbolFor(inv.currency)}${fmtMoney(availableAdvance,inv.currency)}
        </label>
      </div>
    </div>` : ''}
    <div class="settle-list">
      <div class="section-title" style="margin:0 0 8px;">Payment History</div>
      ${history.length ? history.map(h=>`<div class="settle-row"><span>${fmtDate(h.date)} — ${escapeHtml(h.method||'')} ${escapeHtml(h.note?('— '+h.note):'')}${h.source==='advance'?' <em>(from advance)</em>':''}</span><span class="amount">${symbolFor(inv.currency)}${fmtMoney(h.amount,inv.currency)}</span></div>`).join('') : '<div class="settle-row"><span>No payments recorded yet.</span></div>'}
    </div>
  `;
  openModal('Settle Invoice', body, [
    {label:'Close', cls:'btn', onClick:closeModal},
    {label:'Record Payment', cls:'btn btn-gold', onClick: async ()=>{
      const amount = parseFloat(document.getElementById('s-amount').value)||0;
      if(amount<=0){ alert('Enter a valid amount.'); return; }
      const fromAdvance = document.getElementById('s-from-advance')?.checked;
      if(fromAdvance && amount > availableAdvance + 0.005){ alert('Amount exceeds available advance balance.'); return; }
      await apiPost('addPayment', {
        invoiceId:invId, date:document.getElementById('s-date').value, amount,
        method: fromAdvance ? 'Advance Balance' : document.getElementById('s-method').value,
        note:document.getElementById('s-note').value,
        source: fromAdvance ? 'advance' : ''
      });
      await reloadData();
      closeModal();
      navigate('invoices');
    }}
  ]);
}

/* ================= CUSTOMERS ================= */
function renderCustomers(main){
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Customers</h2><p>Your master list of billing contacts.</p></div>
      <button class="btn btn-gold" onclick="openCustomerModal()">+ New Customer</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Contact</th><th>Country</th><th>Default Currency</th><th></th></tr></thead>
        <tbody>${customerRows()}</tbody>
      </table>
    </div>
  `;
}
function customerRows(){
  if(!DATA.customers.length) return `<tr class="empty-row"><td colspan="5">No customers yet.</td></tr>`;
  return DATA.customers.map(c=>`
    <tr>
      <td><strong>${escapeHtml(c.name)}</strong><div style="color:var(--muted);font-size:0.8rem;">${escapeHtml(c.email||'')}</div></td>
      <td>${escapeHtml(c.contactPerson||'—')}${c.phone?(' · '+escapeHtml(c.phone)):''}</td>
      <td>${escapeHtml(c.country||'—')}</td>
      <td>${escapeHtml(c.defaultCurrency||'USD')}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" onclick="openCustomerModal('${c.id}')">Edit</button>
        <button class="btn btn-sm btn-ghost" onclick="removeCustomer('${c.id}')">✕</button>
      </td>
    </tr>`).join('');
}
async function removeCustomer(id){
  if(!confirm('Delete this customer?')) return;
  await apiPost('deleteCustomer', {id});
  await reloadData();
  navigate('customers');
}
function openCustomerModal(id){
  const c = id ? DATA.customers.find(x=>x.id===id) : null;
  const body = `
    <div class="form-row">
      <div class="form-group full"><label>Company / Customer Name</label><input type="text" id="c-name" value="${c?escapeHtml(c.name):''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Contact Person</label><input type="text" id="c-contact" value="${c?escapeHtml(c.contactPerson||''):''}"></div>
      <div class="form-group"><label>Email</label><input type="email" id="c-email" value="${c?escapeHtml(c.email||''):''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Phone</label><input type="text" id="c-phone" value="${c?escapeHtml(c.phone||''):''}"></div>
      <div class="form-group"><label>Country</label><input type="text" id="c-country" value="${c?escapeHtml(c.country||''):''}"></div>
    </div>
    <div class="form-group full"><label>Billing Address</label><textarea id="c-address">${c?escapeHtml(c.address||''):''}</textarea></div>
    <div class="form-group"><label>Default Currency</label>
      <select id="c-currency"><option value="USD" ${c&&c.defaultCurrency==='USD'?'selected':''}>USD</option><option value="INR" ${c&&c.defaultCurrency==='INR'?'selected':''}>INR</option></select>
    </div>
  `;
  openModal(id?'Edit Customer':'New Customer', body, [
    {label:'Cancel', cls:'btn', onClick:closeModal},
    {label:'Save', cls:'btn btn-gold', onClick: async ()=>{
      const name = document.getElementById('c-name').value.trim();
      if(!name){ alert('Name is required.'); return; }
      await apiPost('upsertCustomer', {
        id, name,
        contactPerson: document.getElementById('c-contact').value,
        email: document.getElementById('c-email').value,
        phone: document.getElementById('c-phone').value,
        country: document.getElementById('c-country').value,
        address: document.getElementById('c-address').value,
        defaultCurrency: document.getElementById('c-currency').value
      });
      await reloadData();
      closeModal();
      navigate('customers');
    }}
  ]);
}

/* ================= VENDORS ================= */
function renderVendors(main){
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Vendors</h2><p>Who you owe money to. Mark each vendor as a USD Vendor (billed &amp; settled directly in USD) or an INR Vendor (booked in INR, remitted in USD — tracked for FX gain/loss).</p></div>
      <button class="btn btn-gold" onclick="openVendorModal()">+ New Vendor</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Contact</th><th>Country</th><th>Type</th><th></th></tr></thead>
        <tbody>${vendorRows()}</tbody>
      </table>
    </div>
  `;
}
function vendorTypeBadge(type){
  return type==='INR'
    ? `<span class="badge badge-warn">INR Vendor</span>`
    : `<span class="badge badge-muted">USD Vendor</span>`;
}
function vendorRows(){
  if(!DATA.vendors.length) return `<tr class="empty-row"><td colspan="5">No vendors yet.</td></tr>`;
  return DATA.vendors.map(v=>`
    <tr>
      <td><strong>${escapeHtml(v.name)}</strong><div style="color:var(--muted);font-size:0.8rem;">${escapeHtml(v.email||'')}</div></td>
      <td>${escapeHtml(v.contactPerson||'—')}${v.phone?(' · '+escapeHtml(v.phone)):''}</td>
      <td>${escapeHtml(v.country||'—')}</td>
      <td>${vendorTypeBadge(v.vendorType||'USD')}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" onclick="openVendorModal('${v.id}')">Edit</button>
        <button class="btn btn-sm btn-ghost" onclick="removeVendor('${v.id}')">✕</button>
      </td>
    </tr>`).join('');
}
async function removeVendor(id){
  if(!confirm('Delete this vendor?')) return;
  await apiPost('deleteVendor', {id});
  await reloadData();
  navigate('vendors');
}
function openVendorModal(id){
  const v = id ? DATA.vendors.find(x=>x.id===id) : null;
  const body = `
    <div class="form-row">
      <div class="form-group full"><label>Vendor Name</label><input type="text" id="v-name" value="${v?escapeHtml(v.name):''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Contact Person</label><input type="text" id="v-contact" value="${v?escapeHtml(v.contactPerson||''):''}"></div>
      <div class="form-group"><label>Email</label><input type="email" id="v-email" value="${v?escapeHtml(v.email||''):''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Phone</label><input type="text" id="v-phone" value="${v?escapeHtml(v.phone||''):''}"></div>
      <div class="form-group"><label>Country</label><input type="text" id="v-country" value="${v?escapeHtml(v.country||''):''}"></div>
    </div>
    <div class="form-group full"><label>Address</label><textarea id="v-address">${v?escapeHtml(v.address||''):''}</textarea></div>
    <div class="form-group">
      <label>Vendor Type</label>
      <select id="v-type">
        <option value="USD" ${(!v||v.vendorType==='USD')?'selected':''}>USD Vendor — purchase &amp; settle in USD</option>
        <option value="INR" ${v&&v.vendorType==='INR'?'selected':''}>INR Vendor — purchase in INR, remit in USD (FX tracked)</option>
      </select>
    </div>
  `;
  openModal(id?'Edit Vendor':'New Vendor', body, [
    {label:'Cancel', cls:'btn', onClick:closeModal},
    {label:'Save', cls:'btn btn-gold', onClick: async ()=>{
      const name = document.getElementById('v-name').value.trim();
      if(!name){ alert('Name is required.'); return; }
      await apiPost('upsertVendor', {
        id, name,
        contactPerson: document.getElementById('v-contact').value,
        email: document.getElementById('v-email').value,
        phone: document.getElementById('v-phone').value,
        country: document.getElementById('v-country').value,
        address: document.getElementById('v-address').value,
        vendorType: document.getElementById('v-type').value
      });
      await reloadData();
      closeModal();
      navigate('vendors');
    }}
  ]);
}

/* ================= PAYABLES ================= */
function renderPayables(main){
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Payables</h2><p>Vendor bills you owe, and what's been settled. INR-vendor bills track FX buffer &amp; forex gain/loss automatically.</p></div>
      <button class="btn btn-gold" onclick="openPayableModal()">+ New Bill</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Bill #</th><th>Vendor</th><th>Type</th><th>Due Date</th><th>Amount (USD)</th><th>Outstanding (USD)</th><th>FX Gain/Loss</th><th>Status</th><th></th></tr></thead>
        <tbody>${payableRows()}</tbody>
      </table>
    </div>
  `;
}
function fxGainLossCell(p){
  if(p.vendorType !== 'INR') return `<span style="color:var(--muted);">—</span>`;
  const gl = fxGainLossForPayable(p);
  if(Math.abs(gl) < 0.005) return `<span style="color:var(--muted);">—</span>`;
  const isLoss = gl > 0;
  return `<span class="amount" style="color:${isLoss?'var(--danger)':'var(--success)'};">${isLoss?'-':'+'}$${fmtMoney(Math.abs(gl),'USD')}</span>`;
}
function payableRows(){
  if(!DATA.payables.length) return `<tr class="empty-row"><td colspan="9">No payables yet.</td></tr>`;
  return [...DATA.payables].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt)).map(p=>{
    const total = payableTotalUSD(p);
    const outstanding = payableOutstandingUSD(p);
    return `<tr>
      <td class="mono">${escapeHtml(p.billNumber||'—')}</td>
      <td>${escapeHtml(vendorName(p.vendorId))}</td>
      <td>${vendorTypeBadge(p.vendorType||'USD')}</td>
      <td>${fmtDate(p.dueDate)}</td>
      <td class="amount">$${fmtMoney(total,'USD')}</td>
      <td class="amount">$${fmtMoney(outstanding,'USD')}</td>
      <td>${fxGainLossCell(p)}</td>
      <td>${statusBadge(payableStatus(p))}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" onclick="openPaySettleModal('${p.id}')">Settle</button>
        <button class="btn btn-sm" onclick="openPayableModal('${p.id}')">Edit</button>
        <button class="btn btn-sm btn-ghost" onclick="removePayable('${p.id}')">✕</button>
      </td>
    </tr>`;
  }).join('');
}
async function removePayable(id){
  if(!confirm('Delete this payable?')) return;
  await apiPost('deletePayable', {id});
  await reloadData();
  navigate('payables');
}

function openPayableModal(id){
  const p = id ? DATA.payables.find(x=>x.id===id) : null;
  const vendorOptions = DATA.vendors.map(v=>`<option value="${v.id}" data-type="${v.vendorType||'USD'}" ${p&&p.vendorId===v.id?'selected':''}>${escapeHtml(v.name)} (${v.vendorType==='INR'?'INR':'USD'})</option>`).join('');
  const initialType = p ? (p.vendorType||'USD') : (DATA.vendors[0] ? (DATA.vendors[0].vendorType||'USD') : 'USD');

  const body = `
    <div class="form-row">
      <div class="form-group"><label>Vendor</label><select id="p-vendor" onchange="onPayableVendorChange()">${vendorOptions || '<option value="">Add a vendor first</option>'}</select></div>
      <div class="form-group"><label>Bill / Reference #</label><input type="text" id="p-billnumber" value="${p?escapeHtml(p.billNumber||''):''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Bill Date</label><input type="date" id="p-billdate" value="${p?p.billDate:todayISO()}"></div>
      <div class="form-group"><label>Due Date</label><input type="date" id="p-duedate" value="${p?p.dueDate:''}"></div>
    </div>

    <div id="p-usd-fields" style="display:${initialType==='USD'?'block':'none'};">
      <div class="section-title" style="margin-top:6px;">USD Bill</div>
      <div class="form-group"><label>Amount (USD)</label><input type="number" step="0.01" id="p-usdamount" value="${p&&p.vendorType==='USD'?p.usdAmount:''}"></div>
    </div>

    <div id="p-inr-fields" style="display:${initialType==='INR'?'block':'none'};">
      <div class="section-title" style="margin-top:6px;">INR Bill — Booking Details</div>
      <div class="form-row">
        <div class="form-group"><label>INR Buying Amount</label><input type="number" step="0.01" id="p-inramount" value="${p&&p.vendorType==='INR'?p.inrAmount:''}" oninput="updatePayablePreview()"></div>
        <div class="form-group"><label>System USD Amount (booked, incl. buffer)</label><input type="number" step="0.01" id="p-systemusd" value="${p&&p.vendorType==='INR'?p.systemUsdBuying:''}" oninput="updatePayablePreview()"></div>
      </div>
      <div class="form-group"><label>FX Buffer % (default 0.3%)</label><input type="number" step="0.01" id="p-bufferpct" value="${p&&p.vendorType==='INR'&&p.bufferPct!==''?p.bufferPct:'0.3'}" oninput="updatePayablePreview()"></div>
      <div class="card" style="background:var(--paper);box-shadow:none;">
        <div style="padding:14px 18px;font-size:0.88rem;">
          <div class="settle-row"><span>Buffer Amount</span><span class="amount" id="prev-buffer">$0.00</span></div>
          <div class="settle-row"><span>Actual USD Buying (excl. buffer)</span><span class="amount" id="prev-actual">$0.00</span></div>
          <div class="settle-row" style="font-weight:600;color:var(--ink);"><span>Effective Booking FX Rate</span><span class="amount" id="prev-rate">—</span></div>
        </div>
      </div>
    </div>

    <div class="form-group full" style="margin-top:14px;"><label>Remarks</label><textarea id="p-remarks">${p?escapeHtml(p.remarks||''):''}</textarea></div>
  `;
  openModal(id?'Edit Bill':'New Bill', body, [
    {label:'Cancel', cls:'btn', onClick:closeModal},
    {label:'Save', cls:'btn btn-gold', onClick: async ()=>{
      const vendorId = document.getElementById('p-vendor').value;
      if(!vendorId){ alert('Select a vendor.'); return; }
      const vendorType = vendorTypeOf(vendorId);
      const payload = {
        id, vendorId, vendorType,
        billNumber: document.getElementById('p-billnumber').value,
        billDate: document.getElementById('p-billdate').value,
        dueDate: document.getElementById('p-duedate').value,
        remarks: document.getElementById('p-remarks').value
      };
      if(vendorType === 'INR'){
        const inrAmount = parseFloat(document.getElementById('p-inramount').value)||0;
        const systemUsdBuying = parseFloat(document.getElementById('p-systemusd').value)||0;
        const bufferPct = parseFloat(document.getElementById('p-bufferpct').value)||0;
        if(inrAmount<=0 || systemUsdBuying<=0){ alert('Enter a valid INR amount and System USD amount.'); return; }
        const bufferAmountUsd = systemUsdBuying * (bufferPct/100);
        const actualUsdBuying = systemUsdBuying - bufferAmountUsd;
        const bookingFxRate = actualUsdBuying > 0 ? inrAmount / actualUsdBuying : 0;
        Object.assign(payload, { inrAmount, bookingFxRate, bufferPct, actualUsdBuying, bufferAmountUsd, systemUsdBuying, usdAmount:'' });
      }else{
        const usdAmount = parseFloat(document.getElementById('p-usdamount').value)||0;
        if(usdAmount<=0){ alert('Enter a valid USD amount.'); return; }
        Object.assign(payload, { usdAmount, inrAmount:'', bookingFxRate:'', bufferPct:'', actualUsdBuying:'', bufferAmountUsd:'', systemUsdBuying:'' });
      }
      await apiPost('savePayable', payload);
      await reloadData();
      closeModal();
      navigate('payables');
    }}
  ]);
  updatePayablePreview();
}
function onPayableVendorChange(){
  const sel = document.getElementById('p-vendor');
  const type = vendorTypeOf(sel.value);
  document.getElementById('p-usd-fields').style.display = type==='USD' ? 'block' : 'none';
  document.getElementById('p-inr-fields').style.display = type==='INR' ? 'block' : 'none';
}
function updatePayablePreview(){
  const inrAmount = parseFloat(document.getElementById('p-inramount')?.value)||0;
  const systemUsdBuying = parseFloat(document.getElementById('p-systemusd')?.value)||0;
  const bufferPct = parseFloat(document.getElementById('p-bufferpct')?.value)||0;
  const buffer = systemUsdBuying * (bufferPct/100);
  const actual = systemUsdBuying - buffer;
  const rate = actual>0 ? inrAmount/actual : 0;
  const a = document.getElementById('prev-actual'); if(a) a.textContent = '$'+fmtMoney(actual,'USD');
  const b = document.getElementById('prev-buffer'); if(b) b.textContent = '$'+fmtMoney(buffer,'USD');
  const r = document.getElementById('prev-rate'); if(r) r.textContent = rate>0 ? rate.toFixed(4) : '—';
}

/* ---- Settlement (payable) ---- */
function openPaySettleModal(payId){
  const p = DATA.payables.find(x=>x.id===payId);
  if(p.vendorType === 'INR') return openPaySettleModalINR(p);
  return openPaySettleModalUSD(p);
}
function openPaySettleModalUSD(p){
  const paid = paidForPayable(p.id);
  const outstanding = payableTotalUSD(p) - paid;
  const history = DATA.paysettlements.filter(s=>s.payableId===p.id);
  const availableAdvance = vendorAdvanceAvailable(p.vendorId);
  const body = `
    <p style="margin-top:0;color:var(--muted);font-size:0.9rem;">
      Bill <strong>${escapeHtml(p.billNumber||'—')}</strong> — Outstanding <strong>$${fmtMoney(outstanding,'USD')}</strong>
    </p>
    <div class="form-row">
      <div class="form-group"><label>Amount Paid (USD)</label><input type="number" id="ps-amount" step="0.01" value="${outstanding>0?outstanding.toFixed(2):''}"></div>
      <div class="form-group"><label>Date</label><input type="date" id="ps-date" value="${todayISO()}"></div>
    </div>
    <div class="form-group"><label>Method</label><input type="text" id="ps-method"></div>
    <div class="form-group full"><label>Note</label><input type="text" id="ps-note"></div>
    ${availableAdvance > 0.004 ? `
    <div class="card" style="background:var(--paper);box-shadow:none;margin:6px 0 14px;">
      <div style="padding:12px 16px;font-size:0.85rem;">
        <label style="display:flex;align-items:center;gap:8px;font-weight:500;color:var(--ink);cursor:pointer;">
          <input type="checkbox" id="ps-from-advance" style="width:auto;">
          Pay from vendor advance balance instead of new remittance — available $${fmtMoney(availableAdvance,'USD')}
        </label>
      </div>
    </div>` : ''}
    <div class="settle-list">
      <div class="section-title" style="margin:0 0 8px;">Settlement History</div>
      ${history.length ? history.map(h=>`<div class="settle-row"><span>${fmtDate(h.date)} — ${escapeHtml(h.method||'')}${h.source==='advance'?' <em>(from advance)</em>':''}</span><span class="amount">$${fmtMoney(h.amount,'USD')}</span></div>`).join('') : '<div class="settle-row"><span>No settlements yet.</span></div>'}
    </div>
  `;
  openModal('Settle Bill', body, [
    {label:'Close', cls:'btn', onClick:closeModal},
    {label:'Record Payment', cls:'btn btn-gold', onClick: async ()=>{
      const amount = parseFloat(document.getElementById('ps-amount').value)||0;
      if(amount<=0){ alert('Enter a valid amount.'); return; }
      const fromAdvance = document.getElementById('ps-from-advance')?.checked;
      if(fromAdvance && amount > availableAdvance + 0.005){ alert('Amount exceeds available advance balance.'); return; }
      await apiPost('addPaySettlement', {
        payableId:p.id, date:document.getElementById('ps-date').value, amount,
        method: fromAdvance ? 'Advance Balance' : document.getElementById('ps-method').value,
        note:document.getElementById('ps-note').value,
        source: fromAdvance ? 'advance' : ''
      });
      await reloadData();
      closeModal();
      navigate('payables');
    }}
  ]);
}
let SETTLE_LINES = [];
function openPaySettleModalINR(p){
  const remainingInr = remainingInrForPayable(p);
  const paidUsd = paidForPayable(p.id);
  const outstandingUsd = payableTotalUSD(p) - paidUsd;
  const history = DATA.paysettlements.filter(s=>s.payableId===p.id);
  SETTLE_LINES = [{source:'', inr: remainingInr>0?Number(remainingInr.toFixed(2)):0, fx:''}];
  const body = `
    <p style="margin-top:0;color:var(--muted);font-size:0.9rem;">
      Bill <strong>${escapeHtml(p.billNumber||'—')}</strong> — Remaining <strong>₹${fmtMoney(remainingInr,'INR')}</strong>
      (≈ <strong>$${fmtMoney(outstandingUsd,'USD')}</strong> at booking rate)
    </p>
    <div class="form-group"><label>Payment Date</label><input type="date" id="ps-date" value="${todayISO()}"></div>
    <div class="section-title" style="margin-top:4px;">Allocation — split across advance batches and/or a new payment if needed</div>
    <table class="items-table">
      <thead><tr><th style="width:38%">Pay From</th><th>INR Amount</th><th>FX Rate</th><th>USD</th><th></th></tr></thead>
      <tbody id="settle-lines-body"></tbody>
    </table>
    <button class="btn btn-sm" onclick="addSettleLine('${p.id}')">+ Add line</button>
    <div class="totals-box">
      <div>INR Allocated: <span class="amount" id="settle-inr-total">0.00</span> / ₹${fmtMoney(remainingInr,'INR')} remaining</div>
      <div>Total USD: <span class="amount grand" id="settle-usd-total">0.00</span></div>
    </div>
    <div class="card" style="background:var(--paper);box-shadow:none;margin:14px 0;">
      <div style="padding:14px 18px;font-size:0.88rem;">
        <div class="settle-row" style="font-weight:600;color:var(--ink);"><span>Combined Actual Forex Gain/Loss</span><span class="amount" id="prev-forexgl">$0.00</span></div>
      </div>
    </div>
    <div class="form-group"><label>Method (for any new-payment lines)</label><input type="text" id="ps-method"></div>
    <div class="form-group full"><label>Note</label><input type="text" id="ps-note"></div>
    <div class="settle-list">
      <div class="section-title" style="margin:0 0 8px;">Settlement History</div>
      ${history.length ? history.map(h=>{
        const gl = Number(h.forexGainLoss||0);
        return `<div class="settle-row"><span>${fmtDate(h.date)} — ₹${fmtMoney(h.inrAmountSettled,'INR')} @ ${h.paymentFxRate}${h.source==='advance'?' <em>(from advance)</em>':''}</span><span class="amount" style="color:${(-gl)>=0?'var(--success)':'var(--danger)'};">${(-gl)>=0?'+':'-'}$${fmtMoney(Math.abs(gl),'USD')}</span></div>`;
      }).join('') : '<div class="settle-row"><span>No settlements yet.</span></div>'}
    </div>
  `;
  openModal('Settle Bill — INR Vendor (FX Tracked)', body, [
    {label:'Close', cls:'btn', onClick:closeModal},
    {label:'Record Payment', cls:'btn btn-gold', onClick: async ()=>{ await saveSettleLines(p); }}
  ], true);
  renderSettleLines(p.id);
}
function addSettleLine(payableId){
  SETTLE_LINES.push({source:'', inr:0, fx:''});
  renderSettleLines(payableId);
}
function removeSettleLine(i, payableId){
  SETTLE_LINES.splice(i,1);
  renderSettleLines(payableId);
}
function renderSettleLines(payableId){
  const p = DATA.payables.find(x=>x.id===payableId);
  const advanceOptions = vendorAdvancesForDropdown(p.vendorId);
  const tbody = document.getElementById('settle-lines-body');
  tbody.innerHTML = SETTLE_LINES.map((line,i)=>{
    const isAdvance = !!line.source;
    return `<tr>
      <td>
        <select onchange="onSettleLineSourceChange(${i},'${payableId}')" id="sl-source-${i}">
          <option value="" ${!isAdvance?'selected':''}>New payment</option>
          ${advanceOptions.map(a=>`<option value="${a.id}" ${line.source===a.id?'selected':''}>${fmtDate(a.date)} — $${fmtMoney(vendorAdvanceRemaining(a.id),'USD')} @ ${Number(a.fxRateAtPayment).toFixed(4)}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" step="0.01" value="${line.inr}" oninput="SETTLE_LINES[${i}].inr=parseFloat(this.value)||0;updateSettleLineTotals('${payableId}')"></td>
      <td><input type="number" step="0.0001" value="${line.fx}" ${isAdvance?'readonly style="background:#EEEDE8;"':''} id="sl-fx-${i}" oninput="SETTLE_LINES[${i}].fx=parseFloat(this.value)||0;updateSettleLineTotals('${payableId}')"></td>
      <td class="amount" id="sl-usd-${i}">0.00</td>
      <td>${SETTLE_LINES.length>1?`<button class="remove-item" onclick="removeSettleLine(${i},'${payableId}')">✕</button>`:''}</td>
    </tr>`;
  }).join('');
  updateSettleLineTotals(payableId);
}
function onSettleLineSourceChange(i, payableId){
  const sel = document.getElementById('sl-source-'+i);
  const advanceId = sel.value;
  SETTLE_LINES[i].source = advanceId;
  if(advanceId){
    const adv = DATA.vendorAdvances.find(a=>a.id===advanceId);
    SETTLE_LINES[i].fx = adv ? Number(adv.fxRateAtPayment) : '';
  }
  renderSettleLines(payableId);
}
function updateSettleLineTotals(payableId){
  const p = DATA.payables.find(x=>x.id===payableId);
  const inrAmount = Number(p.inrAmount||0);
  let inrTotal = 0, usdTotal = 0, glTotal = 0;
  SETTLE_LINES.forEach((line,i)=>{
    const share = inrAmount>0 ? (line.inr/inrAmount) : 0;
    const allocActual = Number(p.actualUsdBuying||0) * share;
    const allocBuffer = Number(p.bufferAmountUsd||0) * share;
    const usd = line.fx>0 ? line.inr/line.fx : 0;
    const fxDiff = usd - allocActual;
    const gl = fxDiff - allocBuffer;
    inrTotal += line.inr||0;
    usdTotal += usd;
    glTotal += gl;
    const cell = document.getElementById('sl-usd-'+i);
    if(cell) cell.textContent = fmtMoney(usd,'USD');
  });
  const inrTotalEl = document.getElementById('settle-inr-total'); if(inrTotalEl) inrTotalEl.textContent = fmtMoney(inrTotal,'INR');
  const usdTotalEl = document.getElementById('settle-usd-total'); if(usdTotalEl) usdTotalEl.textContent = fmtMoney(usdTotal,'USD');
  const glEl = document.getElementById('prev-forexgl');
  if(glEl){
    const profit = -glTotal;
    glEl.textContent = (profit>=0?'+':'-') + '$' + fmtMoney(Math.abs(profit),'USD');
    glEl.style.color = profit>=0 ? 'var(--success)' : 'var(--danger)';
  }
}
async function saveSettleLines(p){
  const inrAmount = Number(p.inrAmount||0);
  const date = document.getElementById('ps-date').value;
  const method = document.getElementById('ps-method').value;
  const note = document.getElementById('ps-note').value;
  const usedByAdvance = {}; // tracks cumulative use within this save, across lines drawing the same batch

  for(const line of SETTLE_LINES){
    if(!(line.inr > 0)){ continue; }
    if(!(line.fx > 0)){ alert('Enter an FX rate for every allocation line.'); return; }
    if(line.source){
      const remaining = vendorAdvanceRemaining(line.source) - (usedByAdvance[line.source]||0);
      const share = inrAmount>0 ? (line.inr/inrAmount) : 0;
      const usdForLine = line.inr/line.fx;
      if(usdForLine > remaining + 0.005){
        alert('One of the allocation lines ($' + fmtMoney(usdForLine,'USD') + ') exceeds the remaining balance on that advance batch ($' + fmtMoney(remaining,'USD') + ').');
        return;
      }
    }
  }

  const validLines = SETTLE_LINES.filter(l=>l.inr>0);
  if(!validLines.length){ alert('Enter at least one allocation with an INR amount.'); return; }
  const totalInr = validLines.reduce((s,l)=>s+l.inr,0);
  if(totalInr > remainingInrForPayable(p) + 0.5){
    if(!confirm('The total allocated (₹' + fmtMoney(totalInr,'INR') + ') is more than what remains on this bill. Continue anyway?')) return;
  }

  for(const line of validLines){
    const share = inrAmount>0 ? (line.inr/inrAmount) : 0;
    const allocatedActualUsdBuying = Number(p.actualUsdBuying||0) * share;
    const allocatedBufferUsd = Number(p.bufferAmountUsd||0) * share;
    const paymentAmountUsd = line.inr/line.fx;
    const fxDifference = paymentAmountUsd - allocatedActualUsdBuying;
    const forexGainLoss = fxDifference - allocatedBufferUsd;
    usedByAdvance[line.source] = (usedByAdvance[line.source]||0) + paymentAmountUsd;
    await apiPost('addPaySettlement', {
      payableId: p.id, date, amount: paymentAmountUsd,
      inrAmountSettled: line.inr, paymentFxRate: line.fx,
      allocatedActualUsdBuying, allocatedBufferUsd, fxDifference, forexGainLoss,
      method: line.source ? 'Advance Balance' : method,
      note, source: line.source ? 'advance' : '', advanceId: line.source || ''
    });
  }
  await reloadData();
  closeModal();
  navigate('payables');
}

/* ================= FOREX REPORT ================= */
function renderForexReport(main){
  const fx = forexTotals();
  const monthly = monthlyForexSummary();
  const byVendor = vendorForexSummary();
  const utilizationPct = fx.bufferRealized > 0.004 ? (fx.rawFxDifferenceRealized / fx.bufferRealized * 100) : null;
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Forex Report</h2><p>How much you've actually gained or lost from currency movement on settled INR-vendor bills, and whether your FX buffer is covering it.</p></div>
    </div>
    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
      <div class="kpi-card" style="border-color:${fx.fxProfitRealized>=0?'var(--success)':'var(--danger)'};">
        <div class="kpi-label">FX Profit/Loss (Realized)</div>
        <div class="kpi-value amount ${fx.fxProfitRealized>=0?'success':'danger'}">${fx.fxProfitRealized>=0?'+':'-'}$${fmtMoney(Math.abs(fx.fxProfitRealized),'USD')}</div>
      </div>
    </div>
    <p style="color:var(--muted);font-size:0.82rem;margin:-14px 0 20px;">
      This is the sum of "Actual Forex Gain/Loss" across every settlement you've made against an INR-vendor bill — positive means currency movement (after your buffer) has worked in your favor so far; negative means it's cost you more than the buffer covered.
    </p>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Total Buffer Booked (all bills)</div><div class="kpi-value amount">$${fmtMoney(fx.bufferBooked,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Buffer Realized (settled)</div><div class="kpi-value amount">$${fmtMoney(fx.bufferRealized,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Raw FX Movement (settled, pre-buffer)</div><div class="kpi-value amount ${fx.rawFxDifferenceRealized>0?'danger':'success'}">${fx.rawFxDifferenceRealized>0?'+':'-'}$${fmtMoney(Math.abs(fx.rawFxDifferenceRealized),'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Buffer Utilization</div><div class="kpi-value amount ${utilizationPct===null?'':(utilizationPct<=100?'success':'danger')}">${utilizationPct===null?'—':utilizationPct.toFixed(0)+'%'}</div></div>
    </div>
    <p style="color:var(--muted);font-size:0.82rem;margin-top:-14px;">
      Buffer Utilization = how much of your realized buffer got eaten up by actual currency movement. Under 100% means your 0.3% buffer is comfortably covering FX swings so far; over 100% means real movement is exceeding what the buffer collects, and the % is worth revisiting.
    </p>

    <div class="card">
      <div class="card-head"><h3>Monthly Forex Gain/Loss Summary</h3></div>
      <table>
        <thead><tr><th>Month</th><th>Settlements</th><th>Buffer Allocated</th><th>FX Profit/Loss</th></tr></thead>
        <tbody>${monthly.length ? monthly.map(m=>`
          <tr>
            <td>${escapeHtml(m.month)}</td>
            <td>${m.count}</td>
            <td class="amount">$${fmtMoney(m.buffer,'USD')}</td>
            <td class="amount" style="color:${(-m.gainLoss)>=0?'var(--success)':'var(--danger)'};">${(-m.gainLoss)>=0?'+':'-'}$${fmtMoney(Math.abs(m.gainLoss),'USD')}</td>
          </tr>`).join('') : '<tr class="empty-row"><td colspan="4">No INR-vendor settlements recorded yet.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-head"><h3>Vendor-wise Forex Gain/Loss</h3></div>
      <table>
        <thead><tr><th>Vendor</th><th>Settlements</th><th>Buffer Allocated</th><th>FX Profit/Loss</th></tr></thead>
        <tbody>${byVendor.length ? byVendor.map(v=>`
          <tr>
            <td>${escapeHtml(vendorName(v.vendorId))}</td>
            <td>${v.count}</td>
            <td class="amount">$${fmtMoney(v.buffer,'USD')}</td>
            <td class="amount" style="color:${(-v.gainLoss)>=0?'var(--success)':'var(--danger)'};">${(-v.gainLoss)>=0?'+':'-'}$${fmtMoney(Math.abs(v.gainLoss),'USD')}</td>
          </tr>`).join('') : '<tr class="empty-row"><td colspan="4">No INR-vendor settlements recorded yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

/* ================= EXPENSES ================= */
const EXPENSE_CATEGORIES = ['Salaries','IT & Server','Rent','Marketing','Travel','Bank Charges','Professional Fees','Software & Subscriptions','Office Supplies','Other'];

function expenseUsdEquivalent(exp){
  return Number(exp.usdEquivalent||0);
}
function renderExpenses(main){
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Expenses</h2><p>Salaries, server/IT costs, and every other operating expense — feeds directly into Profit &amp; Loss.</p></div>
      <button class="btn btn-gold" onclick="openExpenseModal()">+ New Expense</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Paid To</th><th>Amount</th><th>USD Equivalent</th><th></th></tr></thead>
        <tbody>${expenseRows()}</tbody>
      </table>
    </div>
  `;
}
function expenseRows(){
  if(!DATA.expenses.length) return `<tr class="empty-row"><td colspan="7">No expenses recorded yet.</td></tr>`;
  return [...DATA.expenses].sort((a,b)=> new Date(b.date)-new Date(a.date)).map(e=>`
    <tr>
      <td>${fmtDate(e.date)}</td>
      <td><span class="badge badge-muted">${escapeHtml(e.category||'Other')}</span></td>
      <td>${escapeHtml(e.description||'—')}</td>
      <td>${escapeHtml(e.paidTo||'—')}</td>
      <td class="amount">${symbolFor(e.currency)}${fmtMoney(e.amount, e.currency)}</td>
      <td class="amount">$${fmtMoney(expenseUsdEquivalent(e),'USD')}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" onclick="openExpenseModal('${e.id}')">Edit</button>
        <button class="btn btn-sm btn-ghost" onclick="removeExpense('${e.id}')">✕</button>
      </td>
    </tr>`).join('');
}
async function removeExpense(id){
  if(!confirm('Delete this expense?')) return;
  await apiPost('deleteExpense', {id});
  await reloadData();
  navigate('expenses');
}
function openExpenseModal(id){
  const e = id ? DATA.expenses.find(x=>x.id===id) : null;
  const catOptions = EXPENSE_CATEGORIES.map(c=>`<option value="${c}" ${e&&e.category===c?'selected':''}>${c}</option>`).join('');
  const currency = e ? e.currency : 'USD';
  const body = `
    <div class="form-row">
      <div class="form-group"><label>Category</label><select id="ex-category">${catOptions}</select></div>
      <div class="form-group"><label>Date</label><input type="date" id="ex-date" value="${e?e.date:todayISO()}"></div>
    </div>
    <div class="form-group full"><label>Description</label><input type="text" id="ex-description" value="${e?escapeHtml(e.description||''):''}" placeholder="e.g. July server hosting — AWS"></div>
    <div class="form-row">
      <div class="form-group"><label>Currency</label><select id="ex-currency" onchange="onExpenseCurrencyChange()">
        <option value="USD" ${currency==='USD'?'selected':''}>USD</option>
        <option value="INR" ${currency==='INR'?'selected':''}>INR</option>
      </select></div>
      <div class="form-group"><label>Amount</label><input type="number" step="0.01" id="ex-amount" value="${e?e.amount:''}" oninput="updateExpensePreview()"></div>
    </div>
    <div class="form-group" id="ex-fxrate-group" style="display:${currency==='INR'?'block':'none'};">
      <label>FX Rate Used (INR per USD)</label><input type="number" step="0.0001" id="ex-fxrate" value="${e?e.fxRate:''}" oninput="updateExpensePreview()">
    </div>
    <div class="settle-row" style="border-top:1px solid var(--border);padding-top:10px;">
      <span>USD Equivalent</span><span class="amount" id="ex-usdpreview" style="font-weight:600;">$0.00</span>
    </div>
    <div class="form-row" style="margin-top:14px;">
      <div class="form-group full"><label>Paid To (optional)</label><input type="text" id="ex-paidto" value="${e?escapeHtml(e.paidTo||''):''}"></div>
    </div>
    <div class="form-group full"><label>Remarks</label><textarea id="ex-remarks">${e?escapeHtml(e.remarks||''):''}</textarea></div>
  `;
  openModal(id?'Edit Expense':'New Expense', body, [
    {label:'Cancel', cls:'btn', onClick:closeModal},
    {label:'Save', cls:'btn btn-gold', onClick: async ()=>{
      const currency = document.getElementById('ex-currency').value;
      const amount = parseFloat(document.getElementById('ex-amount').value)||0;
      if(amount<=0){ alert('Enter a valid amount.'); return; }
      let fxRate = '', usdEquivalent = amount;
      if(currency==='INR'){
        fxRate = parseFloat(document.getElementById('ex-fxrate').value)||0;
        if(fxRate<=0){ alert('Enter the FX rate used for this INR expense.'); return; }
        usdEquivalent = amount / fxRate;
      }
      await apiPost('upsertExpense', {
        id,
        category: document.getElementById('ex-category').value,
        description: document.getElementById('ex-description').value,
        date: document.getElementById('ex-date').value,
        currency, amount, fxRate, usdEquivalent,
        paidTo: document.getElementById('ex-paidto').value,
        remarks: document.getElementById('ex-remarks').value
      });
      await reloadData();
      closeModal();
      navigate('expenses');
    }}
  ]);
  updateExpensePreview();
}
function onExpenseCurrencyChange(){
  const currency = document.getElementById('ex-currency').value;
  document.getElementById('ex-fxrate-group').style.display = currency==='INR' ? 'block' : 'none';
  updateExpensePreview();
}
function updateExpensePreview(){
  const currency = document.getElementById('ex-currency')?.value;
  const amount = parseFloat(document.getElementById('ex-amount')?.value)||0;
  const fxRate = parseFloat(document.getElementById('ex-fxrate')?.value)||0;
  const usd = currency==='INR' ? (fxRate>0 ? amount/fxRate : 0) : amount;
  const el = document.getElementById('ex-usdpreview');
  if(el) el.textContent = '$'+fmtMoney(usd,'USD');
}

/* ================= PROFIT & LOSS ================= */
function inRange(dateStr, from, to){
  if(!dateStr) return false;
  return dateStr >= from && dateStr <= to;
}
// A received payment's USD value — looks up the parent invoice's currency,
// since Payments themselves don't store a currency (they're always in the
// invoice's currency).
function paymentUsdAmount(payment){
  const reportingFxRate = Number(DATA.config.reportingFxRate||85);
  const inv = DATA.invoices.find(i=>i.id===payment.invoiceId);
  const amt = Number(payment.amount||0);
  if(inv && inv.currency==='INR') return amt/reportingFxRate;
  return amt;
}
// CASH / SETTLEMENT BASIS: revenue only counts once a client has actually paid,
// and vendor cost only counts once you've actually remitted payment — not the
// moment an invoice is issued or a bill is booked. This matches real cash P&L.
function pnlTotals(from, to){
  let revenue = 0, cogs = 0, opex = 0;
  DATA.payments.forEach(pay=>{
    if(pay.source === 'advance') return; // already counted as revenue when the advance itself came in
    if(!inRange(pay.date, from, to)) return;
    revenue += paymentUsdAmount(pay);
  });
  DATA.customerAdvances.forEach(a=>{
    if(!inRange(a.date, from, to)) return;
    revenue += a.currency==='INR' ? Number(a.amount||0)/Number(DATA.config.reportingFxRate||85) : Number(a.amount||0);
  });
  DATA.paysettlements.forEach(s=>{
    if(s.source === 'advance') return; // already counted as cost when the advance itself was paid out
    if(!inRange(s.date, from, to)) return;
    cogs += Number(s.amount||0); // already USD, for both USD- and INR-vendor settlements
  });
  DATA.vendorAdvances.forEach(a=>{
    if(!inRange(a.date, from, to)) return;
    cogs += Number(a.amount||0);
  });
  DATA.expenses.forEach(e=>{
    if(!inRange(e.date, from, to)) return;
    opex += expenseUsdEquivalent(e);
  });
  const grossProfit = revenue - cogs;
  const netProfit = grossProfit - opex;
  const margin = revenue > 0 ? (netProfit/revenue*100) : 0;
  return { revenue, cogs, opex, grossProfit, netProfit, margin };
}
function pnlMonthlyBreakdown(from, to){
  const map = {};
  const touch = (key)=>{ if(!map[key]) map[key] = {month:key, revenue:0, cogs:0, opex:0}; return map[key]; };
  DATA.payments.forEach(pay=>{
    if(pay.source === 'advance') return;
    if(!inRange(pay.date, from, to)) return;
    touch(pay.date.slice(0,7)).revenue += paymentUsdAmount(pay);
  });
  DATA.customerAdvances.forEach(a=>{
    if(!inRange(a.date, from, to)) return;
    const usd = a.currency==='INR' ? Number(a.amount||0)/Number(DATA.config.reportingFxRate||85) : Number(a.amount||0);
    touch(a.date.slice(0,7)).revenue += usd;
  });
  DATA.paysettlements.forEach(s=>{
    if(s.source === 'advance') return;
    if(!inRange(s.date, from, to)) return;
    touch(s.date.slice(0,7)).cogs += Number(s.amount||0);
  });
  DATA.vendorAdvances.forEach(a=>{
    if(!inRange(a.date, from, to)) return;
    touch(a.date.slice(0,7)).cogs += Number(a.amount||0);
  });
  DATA.expenses.forEach(e=>{
    if(!inRange(e.date, from, to)) return;
    touch(e.date.slice(0,7)).opex += expenseUsdEquivalent(e);
  });
  return Object.values(map).sort((a,b)=> a.month.localeCompare(b.month));
}
function expenseCategoryBreakdown(from, to){
  const map = {};
  DATA.expenses.forEach(e=>{
    if(!inRange(e.date, from, to)) return;
    const key = e.category || 'Other';
    if(!map[key]) map[key] = {category:key, total:0, count:0};
    map[key].total += expenseUsdEquivalent(e);
    map[key].count += 1;
  });
  return Object.values(map).sort((a,b)=> b.total - a.total);
}
function renderProfitLoss(main, fromOverride, toOverride){
  const defaultFrom = DATA.config.businessStartDate || '2026-02-01';
  const from = fromOverride || defaultFrom;
  const to = toOverride || todayISO();
  const t = pnlTotals(from, to);
  const monthly = pnlMonthlyBreakdown(from, to);
  const byCategory = expenseCategoryBreakdown(from, to);

  main.innerHTML = `
    <div class="page-header">
      <div><h2>Profit &amp; Loss</h2><p>Cash basis — only counts money you've actually <strong>received</strong> from customers and actually <strong>paid</strong> to vendors (not just invoiced/booked amounts), since business inception or any range you choose.</p></div>
    </div>
    <div class="card">
      <div style="padding:16px 20px;display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;">
        <div class="form-group" style="margin-bottom:0;"><label>From</label><input type="date" id="pnl-from" value="${from}"></div>
        <div class="form-group" style="margin-bottom:0;"><label>To</label><input type="date" id="pnl-to" value="${to}"></div>
        <button class="btn btn-gold btn-sm" onclick="applyPnlFilter()">Apply</button>
        <button class="btn btn-sm" onclick="setPnlRange('${defaultFrom}','${todayISO()}')">Since Inception</button>
        <button class="btn btn-sm" onclick="setPnlRangeThisMonth()">This Month</button>
        <button class="btn btn-sm" onclick="setPnlRangeThisYear()">This Year</button>
      </div>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Revenue Received</div><div class="kpi-value amount">$${fmtMoney(t.revenue,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Vendor Payments Made</div><div class="kpi-value amount danger">$${fmtMoney(t.cogs,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Gross Profit</div><div class="kpi-value amount ${t.grossProfit>=0?'success':'danger'}">$${fmtMoney(t.grossProfit,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Operating Expenses</div><div class="kpi-value amount danger">$${fmtMoney(t.opex,'USD')}</div></div>
    </div>
    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
      <div class="kpi-card" style="border-color:${t.netProfit>=0?'var(--success)':'var(--danger)'};">
        <div class="kpi-label">Net ${t.netProfit>=0?'Profit':'Loss'}</div>
        <div class="kpi-value amount ${t.netProfit>=0?'success':'danger'}">$${fmtMoney(Math.abs(t.netProfit),'USD')}</div>
      </div>
      <div class="kpi-card"><div class="kpi-label">Profit Margin</div><div class="kpi-value amount ${t.margin>=0?'success':'danger'}">${t.margin.toFixed(1)}%</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Monthly Trend</h3></div>
      <table>
        <thead><tr><th>Month</th><th>Revenue</th><th>Vendor Cost</th><th>Gross Profit</th><th>OpEx</th><th>Net P&amp;L</th></tr></thead>
        <tbody>${monthly.length ? monthly.map(m=>{
          const gp = m.revenue - m.cogs; const net = gp - m.opex;
          return `<tr>
            <td>${escapeHtml(m.month)}</td>
            <td class="amount">$${fmtMoney(m.revenue,'USD')}</td>
            <td class="amount">$${fmtMoney(m.cogs,'USD')}</td>
            <td class="amount">$${fmtMoney(gp,'USD')}</td>
            <td class="amount">$${fmtMoney(m.opex,'USD')}</td>
            <td class="amount" style="color:${net>=0?'var(--success)':'var(--danger)'};font-weight:600;">${net>=0?'':'-'}$${fmtMoney(Math.abs(net),'USD')}</td>
          </tr>`;
        }).join('') : '<tr class="empty-row"><td colspan="6">No activity in this range.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-head"><h3>Expenses by Category</h3></div>
      <table>
        <thead><tr><th>Category</th><th>Entries</th><th>Total (USD)</th></tr></thead>
        <tbody>${byCategory.length ? byCategory.map(c=>`
          <tr><td>${escapeHtml(c.category)}</td><td>${c.count}</td><td class="amount">$${fmtMoney(c.total,'USD')}</td></tr>
        `).join('') : '<tr class="empty-row"><td colspan="3">No expenses in this range.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}
function applyPnlFilter(){
  const from = document.getElementById('pnl-from').value;
  const to = document.getElementById('pnl-to').value;
  renderProfitLoss(document.getElementById('main-content'), from, to);
}
function setPnlRange(from, to){
  renderProfitLoss(document.getElementById('main-content'), from, to);
}
function setPnlRangeThisMonth(){
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  setPnlRange(from, todayISO());
}
function setPnlRangeThisYear(){
  const now = new Date();
  const from = new Date(now.getFullYear(), 0, 1).toISOString().slice(0,10);
  setPnlRange(from, todayISO());
}

/* ================= ADVANCES ================= */
let ADV_FILTER_CUSTOMER = {customerId:'', from:'', to:''};
let ADV_FILTER_VENDOR = {vendorId:'', from:'', to:''};

function renderAdvances(main){
  const customerOptions = DATA.customers.map(c=>`<option value="${c.id}" ${ADV_FILTER_CUSTOMER.customerId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
  const vendorOptions = DATA.vendors.map(v=>`<option value="${v.id}" ${ADV_FILTER_VENDOR.vendorId===v.id?'selected':''}>${escapeHtml(v.name)}</option>`).join('');
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Advances</h2><p>Prepayments received from customers or sent to vendors, ahead of any specific invoice or bill — apply them later when you settle.</p></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Customer Advances (money received in advance)</h3><button class="btn btn-gold btn-sm" onclick="openCustomerAdvanceModal()">+ Record Advance</button></div>
      <div style="padding:14px 20px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;border-bottom:1px solid var(--border);">
        <div class="form-group" style="margin-bottom:0;"><label>Customer</label><select id="caf-customer"><option value="">All customers</option>${customerOptions}</select></div>
        <div class="form-group" style="margin-bottom:0;"><label>From</label><input type="date" id="caf-from" value="${ADV_FILTER_CUSTOMER.from}"></div>
        <div class="form-group" style="margin-bottom:0;"><label>To</label><input type="date" id="caf-to" value="${ADV_FILTER_CUSTOMER.to}"></div>
        <button class="btn btn-gold btn-sm" onclick="applyCustomerAdvanceFilter()">Apply</button>
        ${(ADV_FILTER_CUSTOMER.customerId||ADV_FILTER_CUSTOMER.from||ADV_FILTER_CUSTOMER.to) ? `<button class="btn btn-sm" onclick="clearCustomerAdvanceFilter()">Clear</button>` : ''}
      </div>
      <table>
        <thead><tr><th>Customer</th><th>Currency</th><th>Total Received</th><th>Applied</th><th>Available</th></tr></thead>
        <tbody>${customerAdvanceSummaryRows()}</tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-head"><h3>Customer Advance Entries</h3></div>
      <table>
        <thead><tr><th>Date</th><th>Customer</th><th>Currency</th><th>Amount</th><th>Method</th><th>Note</th><th></th></tr></thead>
        <tbody>${customerAdvanceRows()}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-head"><h3>Vendor Advances (money you've paid in advance)</h3><button class="btn btn-gold btn-sm" onclick="openVendorAdvanceModal()">+ Record Advance</button></div>
      <div style="padding:14px 20px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;border-bottom:1px solid var(--border);">
        <div class="form-group" style="margin-bottom:0;"><label>Vendor</label><select id="vaf-vendor"><option value="">All vendors</option>${vendorOptions}</select></div>
        <div class="form-group" style="margin-bottom:0;"><label>From</label><input type="date" id="vaf-from" value="${ADV_FILTER_VENDOR.from}"></div>
        <div class="form-group" style="margin-bottom:0;"><label>To</label><input type="date" id="vaf-to" value="${ADV_FILTER_VENDOR.to}"></div>
        <button class="btn btn-gold btn-sm" onclick="applyVendorAdvanceFilter()">Apply</button>
        ${(ADV_FILTER_VENDOR.vendorId||ADV_FILTER_VENDOR.from||ADV_FILTER_VENDOR.to) ? `<button class="btn btn-sm" onclick="clearVendorAdvanceFilter()">Clear</button>` : ''}
      </div>
      <table>
        <thead><tr><th>Vendor</th><th>Total Paid</th><th>Applied</th><th>Available</th></tr></thead>
        <tbody>${vendorAdvanceSummaryRows()}</tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-head"><h3>Vendor Advance Entries</h3></div>
      <table>
        <thead><tr><th>Date</th><th>Vendor</th><th>Amount (USD)</th><th>FX Rate</th><th>Remaining</th><th>Method</th><th>Note</th><th></th></tr></thead>
        <tbody>${vendorAdvanceRows()}</tbody>
      </table>
    </div>
  `;
}
function applyCustomerAdvanceFilter(){
  ADV_FILTER_CUSTOMER = {
    customerId: document.getElementById('caf-customer').value,
    from: document.getElementById('caf-from').value,
    to: document.getElementById('caf-to').value
  };
  navigate('advances');
}
function clearCustomerAdvanceFilter(){
  ADV_FILTER_CUSTOMER = {customerId:'', from:'', to:''};
  navigate('advances');
}
function applyVendorAdvanceFilter(){
  ADV_FILTER_VENDOR = {
    vendorId: document.getElementById('vaf-vendor').value,
    from: document.getElementById('vaf-from').value,
    to: document.getElementById('vaf-to').value
  };
  navigate('advances');
}
function clearVendorAdvanceFilter(){
  ADV_FILTER_VENDOR = {vendorId:'', from:'', to:''};
  navigate('advances');
}
function matchesCustomerAdvanceFilter(a){
  if(ADV_FILTER_CUSTOMER.customerId && a.customerId !== ADV_FILTER_CUSTOMER.customerId) return false;
  if(ADV_FILTER_CUSTOMER.from && a.date < ADV_FILTER_CUSTOMER.from) return false;
  if(ADV_FILTER_CUSTOMER.to && a.date > ADV_FILTER_CUSTOMER.to) return false;
  return true;
}
function matchesVendorAdvanceFilter(a){
  if(ADV_FILTER_VENDOR.vendorId && a.vendorId !== ADV_FILTER_VENDOR.vendorId) return false;
  if(ADV_FILTER_VENDOR.from && a.date < ADV_FILTER_VENDOR.from) return false;
  if(ADV_FILTER_VENDOR.to && a.date > ADV_FILTER_VENDOR.to) return false;
  return true;
}

function customerAdvanceSummaryRows(){
  const map = {};
  DATA.customerAdvances.filter(matchesCustomerAdvanceFilter).forEach(a=>{
    const key = a.customerId+'|'+a.currency;
    if(!map[key]) map[key] = {customerId:a.customerId, currency:a.currency};
  });
  const keys = Object.values(map);
  if(!keys.length) return `<tr class="empty-row"><td colspan="5">No customer advances match this filter.</td></tr>`;
  return keys.map(k=>{
    const total = customerAdvanceTotal(k.customerId, k.currency);
    const applied = customerAdvanceApplied(k.customerId, k.currency);
    const available = total - applied;
    return `<tr>
      <td>${escapeHtml(customerName(k.customerId))}</td>
      <td>${k.currency}</td>
      <td class="amount">${symbolFor(k.currency)}${fmtMoney(total,k.currency)}</td>
      <td class="amount">${symbolFor(k.currency)}${fmtMoney(applied,k.currency)}</td>
      <td class="amount" style="font-weight:600;color:${available>0.004?'var(--success)':'var(--muted)'};">${symbolFor(k.currency)}${fmtMoney(available,k.currency)}</td>
    </tr>`;
  }).join('');
}
function customerAdvanceRows(){
  const filtered = DATA.customerAdvances.filter(matchesCustomerAdvanceFilter);
  if(!filtered.length) return `<tr class="empty-row"><td colspan="7">No entries match this filter.</td></tr>`;
  return [...filtered].sort((a,b)=> new Date(b.date)-new Date(a.date)).map(a=>`
    <tr>
      <td>${fmtDate(a.date)}</td>
      <td>${escapeHtml(customerName(a.customerId))}</td>
      <td>${a.currency}</td>
      <td class="amount">${symbolFor(a.currency)}${fmtMoney(a.amount,a.currency)}</td>
      <td>${escapeHtml(a.method||'—')}</td>
      <td>${escapeHtml(a.note||'—')}</td>
      <td><button class="btn btn-sm btn-ghost" onclick="removeCustomerAdvance('${a.id}')">✕</button></td>
    </tr>`).join('');
}
async function removeCustomerAdvance(id){
  if(!confirm('Delete this advance record? If any of it has already been applied to invoices, the available balance may go negative — check before deleting.')) return;
  await apiPost('deleteCustomerAdvance', {id});
  await reloadData();
  navigate('advances');
}
function openCustomerAdvanceModal(){
  const customerOptions = DATA.customers.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const body = `
    <div class="form-row">
      <div class="form-group"><label>Customer</label><select id="ca-customer">${customerOptions || '<option value="">Add a customer first</option>'}</select></div>
      <div class="form-group"><label>Date</label><input type="date" id="ca-date" value="${todayISO()}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Currency</label><select id="ca-currency"><option value="USD">USD</option><option value="INR">INR</option></select></div>
      <div class="form-group"><label>Amount</label><input type="number" step="0.01" id="ca-amount"></div>
    </div>
    <div class="form-group"><label>Method</label><input type="text" id="ca-method" placeholder="e.g. Wire, PayPal"></div>
    <div class="form-group full"><label>Note</label><input type="text" id="ca-note"></div>
  `;
  openModal('Record Customer Advance', body, [
    {label:'Cancel', cls:'btn', onClick:closeModal},
    {label:'Save', cls:'btn btn-gold', onClick: async ()=>{
      const customerId = document.getElementById('ca-customer').value;
      if(!customerId){ alert('Select a customer.'); return; }
      const amount = parseFloat(document.getElementById('ca-amount').value)||0;
      if(amount<=0){ alert('Enter a valid amount.'); return; }
      await apiPost('upsertCustomerAdvance', {
        customerId,
        date: document.getElementById('ca-date').value,
        currency: document.getElementById('ca-currency').value,
        amount,
        method: document.getElementById('ca-method').value,
        note: document.getElementById('ca-note').value
      });
      await reloadData();
      closeModal();
      navigate('advances');
    }}
  ]);
}

function vendorAdvanceSummaryRows(){
  const vendorIds = [...new Set(DATA.vendorAdvances.filter(matchesVendorAdvanceFilter).map(a=>a.vendorId))];
  if(!vendorIds.length) return `<tr class="empty-row"><td colspan="4">No vendor advances match this filter.</td></tr>`;
  return vendorIds.map(vId=>{
    const total = vendorAdvanceTotal(vId);
    const applied = vendorAdvanceApplied(vId);
    const available = total - applied;
    return `<tr>
      <td>${escapeHtml(vendorName(vId))}</td>
      <td class="amount">$${fmtMoney(total,'USD')}</td>
      <td class="amount">$${fmtMoney(applied,'USD')}</td>
      <td class="amount" style="font-weight:600;color:${available>0.004?'var(--success)':'var(--muted)'};">$${fmtMoney(available,'USD')}</td>
    </tr>`;
  }).join('');
}
function vendorAdvanceRows(){
  const filtered = DATA.vendorAdvances.filter(matchesVendorAdvanceFilter);
  if(!filtered.length) return `<tr class="empty-row"><td colspan="8">No entries match this filter.</td></tr>`;
  return [...filtered].sort((a,b)=> new Date(b.date)-new Date(a.date)).map(a=>{
    const remaining = vendorAdvanceRemaining(a.id);
    return `<tr>
      <td>${fmtDate(a.date)}</td>
      <td>${escapeHtml(vendorName(a.vendorId))}</td>
      <td class="amount">$${fmtMoney(a.amount,'USD')}</td>
      <td class="mono">${a.fxRateAtPayment ? Number(a.fxRateAtPayment).toFixed(4) : '—'}</td>
      <td class="amount" style="color:${remaining>0.004?'var(--success)':'var(--muted)'};">$${fmtMoney(remaining,'USD')}</td>
      <td>${escapeHtml(a.method||'—')}</td>
      <td>${escapeHtml(a.note||'—')}</td>
      <td><button class="btn btn-sm btn-ghost" onclick="removeVendorAdvance('${a.id}')">✕</button></td>
    </tr>`;
  }).join('');
}
async function removeVendorAdvance(id){
  if(!confirm('Delete this advance record? If any of it has already been applied to bills, the available balance may go negative — check before deleting.')) return;
  await apiPost('deleteVendorAdvance', {id});
  await reloadData();
  navigate('advances');
}
function onVendorAdvanceVendorChange(){
  const type = vendorTypeOf(document.getElementById('va-vendor').value);
  const grp = document.getElementById('va-fxrate-group');
  if(grp) grp.style.display = type==='INR' ? 'block' : 'none';
}
function openVendorAdvanceModal(){
  const vendorOptions = DATA.vendors.map(v=>`<option value="${v.id}" data-type="${v.vendorType||'USD'}">${escapeHtml(v.name)} (${v.vendorType==='INR'?'INR':'USD'})</option>`).join('');
  const initialType = DATA.vendors[0] ? (DATA.vendors[0].vendorType||'USD') : 'USD';
  const body = `
    <div class="form-row">
      <div class="form-group"><label>Vendor</label><select id="va-vendor" onchange="onVendorAdvanceVendorChange()">${vendorOptions || '<option value="">Add a vendor first</option>'}</select></div>
      <div class="form-group"><label>Date</label><input type="date" id="va-date" value="${todayISO()}"></div>
    </div>
    <div class="form-group"><label>Amount (USD — the actual amount remitted)</label><input type="number" step="0.01" id="va-amount"></div>
    <div class="form-group" id="va-fxrate-group" style="display:${initialType==='INR'?'block':'none'};">
      <label>FX Rate at Payment (INR per USD)</label>
      <input type="number" step="0.0001" id="va-fxrate">
      <p style="color:var(--muted);font-size:0.78rem;margin:6px 0 0;">This rate gets locked to this advance batch — when you later apply it to a bill, this exact rate is reused automatically, so forex gain/loss stays accurate.</p>
    </div>
    <div class="form-group"><label>Method</label><input type="text" id="va-method" placeholder="e.g. Wire, SWIFT"></div>
    <div class="form-group full"><label>Note</label><input type="text" id="va-note"></div>
  `;
  openModal('Record Vendor Advance', body, [
    {label:'Cancel', cls:'btn', onClick:closeModal},
    {label:'Save', cls:'btn btn-gold', onClick: async ()=>{
      const vendorId = document.getElementById('va-vendor').value;
      if(!vendorId){ alert('Select a vendor.'); return; }
      const amount = parseFloat(document.getElementById('va-amount').value)||0;
      if(amount<=0){ alert('Enter a valid amount.'); return; }
      const vendorType = vendorTypeOf(vendorId);
      let fxRateAtPayment = '';
      if(vendorType === 'INR'){
        fxRateAtPayment = parseFloat(document.getElementById('va-fxrate').value)||0;
        if(fxRateAtPayment<=0){ alert('Enter the FX rate this advance was paid at.'); return; }
      }
      await apiPost('upsertVendorAdvance', {
        vendorId,
        date: document.getElementById('va-date').value,
        amount, fxRateAtPayment,
        method: document.getElementById('va-method').value,
        note: document.getElementById('va-note').value
      });
      await reloadData();
      closeModal();
      navigate('advances');
    }}
  ]);
}

/* ================= LEDGER ================= */
let LEDGER_STATE = null;

function buildVendorLedgerEntries(vendorId){
  const entries = [];
  DATA.payables.filter(p=>p.vendorId===vendorId).forEach(p=>{
    entries.push({
      date: p.billDate || p.createdAt,
      particulars: 'Bill' + (p.billNumber?(' — '+p.billNumber):'') + (p.remarks?(' — '+p.remarks):''),
      vchType: 'Bill', vchNo: p.billNumber || '—',
      debit: 0, credit: payableTotalUSD(p)
    });
  });
  DATA.paysettlements.forEach(s=>{
    if(s.source === 'advance') return; // already represented by the advance-paid entry
    const p = DATA.payables.find(x=>x.id===s.payableId);
    if(!p || p.vendorId!==vendorId) return;
    entries.push({
      date: s.date,
      particulars: 'Payment' + (p.billNumber?(' — Bill '+p.billNumber):'') + (s.method?(' — '+s.method):'') + (s.note?(' — '+s.note):''),
      vchType: 'Payment', vchNo: p.billNumber || '—',
      debit: Number(s.amount||0), credit: 0
    });
  });
  DATA.vendorAdvances.filter(a=>a.vendorId===vendorId).forEach(a=>{
    entries.push({
      date: a.date,
      particulars: 'Advance Paid' + (a.method?(' — '+a.method):'') + (a.note?(' — '+a.note):''),
      vchType: 'Advance', vchNo: '—',
      debit: Number(a.amount||0), credit: 0
    });
  });
  return entries.sort((a,b)=> new Date(a.date)-new Date(b.date));
}

function buildCustomerLedgerEntries(customerId, currency){
  const entries = [];
  DATA.invoices.filter(i=>i.customerId===customerId && i.currency===currency).forEach(inv=>{
    entries.push({
      date: inv.issueDate,
      particulars: 'Invoice' + (inv.notes?(' — '+inv.notes):''),
      vchType: 'Invoice', vchNo: inv.invoiceNumber,
      debit: Number(inv.total||0), credit: 0
    });
  });
  DATA.payments.forEach(p=>{
    if(p.source === 'advance') return;
    const inv = DATA.invoices.find(i=>i.id===p.invoiceId);
    if(!inv || inv.customerId!==customerId || inv.currency!==currency) return;
    entries.push({
      date: p.date,
      particulars: 'Payment Received' + (' — '+inv.invoiceNumber) + (p.method?(' — '+p.method):'') + (p.note?(' — '+p.note):''),
      vchType: 'Receipt', vchNo: inv.invoiceNumber,
      debit: 0, credit: Number(p.amount||0)
    });
  });
  DATA.customerAdvances.filter(a=>a.customerId===customerId && a.currency===currency).forEach(a=>{
    entries.push({
      date: a.date,
      particulars: 'Advance Received' + (a.method?(' — '+a.method):'') + (a.note?(' — '+a.note):''),
      vchType: 'Advance', vchNo: '—',
      debit: 0, credit: Number(a.amount||0)
    });
  });
  return entries.sort((a,b)=> new Date(a.date)-new Date(b.date));
}

// balanceSign: +1 for a customer/debtor ledger (balance = cumulative debit − credit,
// i.e. what they owe us) | -1 for a vendor/creditor ledger (balance = cumulative
// credit − debit, i.e. what we owe them)
function computeLedger(entries, from, to, balanceSign){
  let opening = 0;
  entries.forEach(e=>{ if(e.date < from) opening += balanceSign*(e.debit - e.credit); });
  let running = opening;
  const rows = entries.filter(e=> e.date>=from && e.date<=to).map(e=>{
    running += balanceSign*(e.debit - e.credit);
    return Object.assign({}, e, {balance: running});
  });
  const totalDebit = rows.reduce((s,r)=>s+r.debit,0);
  const totalCredit = rows.reduce((s,r)=>s+r.credit,0);
  return { opening, rows, totalDebit, totalCredit, closing: running };
}

function renderLedger(main){
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Ledger</h2><p>A statement of account for any customer or vendor — every debit, credit, and running balance, ready to share.</p></div>
    </div>
    <div class="card">
      <div style="padding:16px 20px;display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;">
        <div class="form-group" style="margin-bottom:0;"><label>Party Type</label>
          <select id="ldg-type" onchange="onLedgerTypeChange()">
            <option value="customer">Customer</option>
            <option value="vendor">Vendor</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0;"><label>Party</label><select id="ldg-party"></select></div>
        <div class="form-group" id="ldg-currency-group" style="margin-bottom:0;"><label>Currency</label>
          <select id="ldg-currency"><option value="USD">USD</option><option value="INR">INR</option></select>
        </div>
        <div class="form-group" style="margin-bottom:0;"><label>From</label><input type="date" id="ldg-from" value="${DATA.config.businessStartDate||'2026-02-01'}"></div>
        <div class="form-group" style="margin-bottom:0;"><label>To</label><input type="date" id="ldg-to" value="${todayISO()}"></div>
        <button class="btn btn-gold btn-sm" onclick="generateLedger()">Generate</button>
      </div>
    </div>
    <div id="ledger-output"></div>
  `;
  onLedgerTypeChange();
}
function onLedgerTypeChange(){
  const type = document.getElementById('ldg-type').value;
  const partySelect = document.getElementById('ldg-party');
  const options = type==='customer'
    ? DATA.customers.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : DATA.vendors.map(v=>`<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('');
  partySelect.innerHTML = options || '<option value="">None yet</option>';
  document.getElementById('ldg-currency-group').style.display = type==='customer' ? 'block' : 'none';
}
function generateLedger(){
  const type = document.getElementById('ldg-type').value;
  const partyId = document.getElementById('ldg-party').value;
  const from = document.getElementById('ldg-from').value;
  const to = document.getElementById('ldg-to').value;
  if(!partyId){ document.getElementById('ledger-output').innerHTML = `<p style="color:var(--muted);">Add a ${type} first.</p>`; return; }

  let entries, balanceSign, currency, partyName;
  if(type==='customer'){
    currency = document.getElementById('ldg-currency').value;
    entries = buildCustomerLedgerEntries(partyId, currency);
    balanceSign = 1;
    partyName = customerName(partyId);
  }else{
    currency = 'USD';
    entries = buildVendorLedgerEntries(partyId);
    balanceSign = -1;
    partyName = vendorName(partyId);
  }
  const ledger = computeLedger(entries, from, to, balanceSign);
  LEDGER_STATE = { type, partyId, partyName, currency, from, to, ledger };

  const sym = symbolFor(currency);
  const balanceLabel = type==='customer' ? 'owes you' : 'you owe';
  document.getElementById('ledger-output').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>${escapeHtml(partyName)} — ${fmtDate(from)} to ${fmtDate(to)}</h3>
        <button class="btn btn-sm" onclick="downloadLedgerPDF()">Download PDF</button>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Particulars</th><th>Vch Type</th><th>Vch No.</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
        <tbody>
          <tr style="background:var(--paper);">
            <td colspan="6" style="font-style:italic;color:var(--muted);">Opening Balance</td>
            <td class="amount" style="font-weight:600;">${sym}${fmtMoney(Math.abs(ledger.opening),currency)} ${ledger.opening>=0?balanceLabel:'(credit)'}</td>
          </tr>
          ${ledger.rows.length ? ledger.rows.map(r=>`
            <tr>
              <td>${fmtDate(r.date)}</td>
              <td>${escapeHtml(r.particulars)}</td>
              <td>${escapeHtml(r.vchType)}</td>
              <td class="mono">${escapeHtml(r.vchNo)}</td>
              <td class="amount">${r.debit>0.004?sym+fmtMoney(r.debit,currency):''}</td>
              <td class="amount">${r.credit>0.004?sym+fmtMoney(r.credit,currency):''}</td>
              <td class="amount">${sym}${fmtMoney(Math.abs(r.balance),currency)}</td>
            </tr>`).join('') : '<tr class="empty-row"><td colspan="7">No transactions in this range.</td></tr>'}
          <tr style="border-top:2px solid var(--ink);font-weight:600;">
            <td colspan="4">Totals / Closing Balance</td>
            <td class="amount">${sym}${fmtMoney(ledger.totalDebit,currency)}</td>
            <td class="amount">${sym}${fmtMoney(ledger.totalCredit,currency)}</td>
            <td class="amount">${sym}${fmtMoney(Math.abs(ledger.closing),currency)} ${ledger.closing>=0?balanceLabel:'(credit)'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function downloadLedgerPDF(){
  if(!LEDGER_STATE) return;
  const { partyName, currency, from, to, ledger, type } = LEDGER_STATE;
  const c = DATA.config;
  const sym = symbolFor(currency);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({unit:'pt', format:'a4'});
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 48;
  const brass = [184,134,59]; const ink = [20,33,61]; const muted = [107,114,128];

  let y = 56;
  let logoOk = false;
  if(c.logoBase64){
    try{
      const dims = doc.getImageProperties(c.logoBase64);
      const boxW = 110, boxH = 50;
      let w = boxW, h = boxW * (dims.height/dims.width);
      if(h > boxH){ h = boxH; w = boxH * (dims.width/dims.height); }
      doc.addImage(c.logoBase64, 'PNG', margin, y-22, w, h, undefined, 'FAST');
      logoOk = true;
    }catch(e){}
  }
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...ink);
  doc.text(c.companyName || 'Company Name', margin, y + (logoOk?44:0));
  let leftY = y + (logoOk?60:16);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...muted);
  [c.addressLine1, c.addressLine2, [c.city,c.state,c.postalCode].filter(Boolean).join(', '), c.country].filter(Boolean).forEach(line=>{ doc.text(line, margin, leftY); leftY += 12; });

  doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.setTextColor(...ink);
  doc.text('LEDGER STATEMENT', pageWidth-margin, 60, {align:'right'});
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...muted);
  doc.text((type==='customer'?'Customer: ':'Vendor: ') + partyName, pageWidth-margin, 80, {align:'right'});
  doc.text(fmtDate(from) + ' to ' + fmtDate(to), pageWidth-margin, 94, {align:'right'});

  const ruleY = Math.max(leftY, 120) + 12;
  doc.setDrawColor(...brass); doc.setLineWidth(1.4);
  doc.line(margin, ruleY, pageWidth-margin, ruleY);

  const balanceLabel = type==='customer' ? 'Dr' : 'Cr';
  const rows = [
    ['', 'Opening Balance', '', '', '', '', sym+fmtMoney(Math.abs(ledger.opening),currency)],
    ...ledger.rows.map(r=>[fmtDate(r.date), r.particulars, r.vchType, r.vchNo, r.debit>0.004?sym+fmtMoney(r.debit,currency):'', r.credit>0.004?sym+fmtMoney(r.credit,currency):'', sym+fmtMoney(Math.abs(r.balance),currency)])
  ];

  doc.autoTable({
    startY: ruleY + 18,
    margin: {left: margin, right: margin},
    head: [['Date','Particulars','Vch Type','Vch No.','Debit','Credit','Balance']],
    body: rows,
    theme: 'plain',
    styles: { font:'helvetica', fontSize:8.5, textColor: ink, cellPadding:{top:6,bottom:6,left:4,right:4} },
    headStyles: { textColor: muted, fontStyle:'bold', fontSize:7.5, halign:'left' },
    columnStyles: { 4:{halign:'right'}, 5:{halign:'right'}, 6:{halign:'right'} },
    didParseCell: function(data){
      if(data.section==='head'){ data.cell.styles.lineWidth = {bottom:1}; data.cell.styles.lineColor = brass; }
    },
    tableLineColor: [228,225,217], tableLineWidth: 0.3,
    foot: [['','Totals','','', sym+fmtMoney(ledger.totalDebit,currency), sym+fmtMoney(ledger.totalCredit,currency), sym+fmtMoney(Math.abs(ledger.closing),currency)+' '+balanceLabel]],
    footStyles: { fontStyle:'bold', textColor: ink, fillColor: [246,245,241], fontSize:8.5 },
  });

  doc.save('Ledger — ' + partyName + ' — ' + from + ' to ' + to + '.pdf');
}

/* ================= SETTINGS (Company Master) ================= */
function renderSettings(main){
  const c = DATA.config;
  main.innerHTML = `
    <div class="page-header"><div><h2>Company Settings</h2><p>These details appear on every invoice PDF.</p></div></div>
    <div class="card">
      <div class="card-head"><h3>Company Master</h3></div>
      <div style="padding:20px 24px;">
        <div class="section-title" style="margin-top:0;">Identity</div>
        <div class="form-row">
          <div class="form-group full"><label>Company Name</label><input type="text" id="s-companyName" value="${escapeHtml(c.companyName||'')}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Email</label><input type="text" id="s-email" value="${escapeHtml(c.email||'')}"></div>
          <div class="form-group"><label>Phone</label><input type="text" id="s-phone" value="${escapeHtml(c.phone||'')}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Website</label><input type="text" id="s-website" value="${escapeHtml(c.website||'')}"></div>
          <div class="form-group"><label>Logo</label><input type="file" id="s-logoFile" accept="image/png,image/jpeg,image/webp">
            <img id="logo-preview-img" src="${c.logoBase64||''}" class="logo-preview" style="display:${c.logoBase64?'block':'none'}">
            <div id="logo-status" style="color:var(--muted);font-size:0.78rem;margin-top:6px;"></div>
          </div>
        </div>
        <div class="section-title">Address</div>
        <div class="form-row">
          <div class="form-group full"><label>Address Line 1</label><input type="text" id="s-addressLine1" value="${escapeHtml(c.addressLine1||'')}"></div>
        </div>
        <div class="form-row">
          <div class="form-group full"><label>Address Line 2</label><input type="text" id="s-addressLine2" value="${escapeHtml(c.addressLine2||'')}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>City</label><input type="text" id="s-city" value="${escapeHtml(c.city||'')}"></div>
          <div class="form-group"><label>State</label><input type="text" id="s-state" value="${escapeHtml(c.state||'')}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Postal Code</label><input type="text" id="s-postalCode" value="${escapeHtml(c.postalCode||'')}"></div>
          <div class="form-group"><label>Country</label><input type="text" id="s-country" value="${escapeHtml(c.country||'')}"></div>
        </div>
        <div class="section-title">Bank Details (shown on invoice for wire transfer)</div>
        <div class="form-row">
          <div class="form-group"><label>Bank Name</label><input type="text" id="s-bankName" value="${escapeHtml(c.bankName||'')}"></div>
          <div class="form-group"><label>Account Name</label><input type="text" id="s-bankAccountName" value="${escapeHtml(c.bankAccountName||'')}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Account Number</label><input type="text" id="s-bankAccountNumber" value="${escapeHtml(c.bankAccountNumber||'')}"></div>
          <div class="form-group"><label>IFSC (for INR)</label><input type="text" id="s-bankIFSC" value="${escapeHtml(c.bankIFSC||'')}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>SWIFT (for USD)</label><input type="text" id="s-bankSwift" value="${escapeHtml(c.bankSwift||'')}"></div>
          <div class="form-group"><label>Bank Address</label><input type="text" id="s-bankAddress" value="${escapeHtml(c.bankAddress||'')}"></div>
        </div>
        <div class="section-title">Invoice Numbering</div>
        <div class="form-row">
          <div class="form-group"><label>Prefix</label><input type="text" id="s-invoicePrefix" value="${escapeHtml(c.invoicePrefix||'RA-INV-')}"></div>
          <div class="form-group"><label>Next Number</label><input type="number" id="s-invoiceNextNumber" value="${escapeHtml(c.invoiceNextNumber||'1001')}"></div>
        </div>
        <div class="section-title">Profit &amp; Loss Reporting</div>
        <div class="form-row">
          <div class="form-group"><label>Business Start Date</label><input type="date" id="s-businessStartDate" value="${escapeHtml(c.businessStartDate||'2026-02-01')}"></div>
          <div class="form-group"><label>Reporting FX Rate (INR per USD)</label><input type="number" step="0.01" id="s-reportingFxRate" value="${escapeHtml(c.reportingFxRate||'85')}"></div>
        </div>
        <p style="color:var(--muted);font-size:0.78rem;margin-top:-8px;">The Reporting FX Rate is only used to convert any INR-currency <em>customer invoices</em> into USD for the consolidated Profit &amp; Loss report — it does not affect individual invoices or payables.</p>
        <div class="section-title">Change Password</div>
        <div class="form-row">
          <div class="form-group full"><label>New Password (leave blank to keep current)</label><input type="password" id="s-newPassword"></div>
        </div>
        <button class="btn btn-gold" onclick="saveSettings()">Save Company Settings</button>
        <span id="settings-saved" style="margin-left:12px;color:var(--success);font-size:0.85rem;"></span>
      </div>
    </div>
  `;
  document.getElementById('s-logoFile').addEventListener('change', handleLogoUpload);
}
function handleLogoUpload(e){
  const file = e.target.files[0];
  if(!file) return;
  const statusEl = document.getElementById('logo-status');
  if(statusEl) statusEl.textContent = 'Processing logo…';

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const dataUrl = shrinkImageToFit(img, 420, 200, 42000);
      DATA.config.logoBase64 = dataUrl;
      const previewImg = document.getElementById('logo-preview-img');
      if(previewImg){
        previewImg.src = dataUrl;
        previewImg.style.display = 'block';
      }
      if(statusEl) statusEl.textContent = 'Logo ready — click "Save Company Settings" below to save it.';
    };
    img.onerror = () => { if(statusEl) statusEl.textContent = 'Could not read that image file.'; };
    img.src = reader.result;
  };
  reader.onerror = () => { if(statusEl) statusEl.textContent = 'Could not read that file.'; };
  reader.readAsDataURL(file);
}

// Draws the image onto a canvas, scaling it down until both its pixel
// dimensions and its base64 size are small enough to store in one
// Google Sheets cell (50,000 char limit) and to embed cleanly in the PDF.
function shrinkImageToFit(img, maxWidth, maxHeight, maxChars){
  let scale = Math.min(1, maxWidth / img.width, maxHeight / img.height);
  let dataUrl = '';
  for(let attempt=0; attempt<8; attempt++){
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,w,h);
    ctx.drawImage(img, 0, 0, w, h);
    dataUrl = canvas.toDataURL('image/png');
    if(dataUrl.length <= maxChars) break;
    scale *= 0.75; // still too big — shrink further and try again
  }
  return dataUrl;
}
async function saveSettings(){
  const ids = ['companyName','email','phone','website','addressLine1','addressLine2','city','state','postalCode','country','bankName','bankAccountName','bankAccountNumber','bankIFSC','bankSwift','bankAddress','invoicePrefix','invoiceNextNumber','businessStartDate','reportingFxRate'];
  const payload = {};
  ids.forEach(id=> payload[id] = document.getElementById('s-'+id).value);
  if(DATA.config.logoBase64) payload.logoBase64 = DATA.config.logoBase64;
  const statusEl = document.getElementById('settings-saved');

  const newPwd = document.getElementById('s-newPassword').value;
  let newHash = null;
  if(newPwd){
    if(newPwd.length < 6){
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = 'New password must be at least 6 characters.';
      return;
    }
    newHash = await sha256hex(newPwd);
    payload.passwordHash = newHash;
  }

  const result = await apiPost('saveConfig', payload);
  if(result && result.error){
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Could not save: ' + result.error;
    return;
  }
  if(newHash){
    AUTH_KEY = newHash;
    sessionStorage.setItem('rateaura_auth_key', newHash);
    document.getElementById('s-newPassword').value = '';
  }
  await reloadData();
  statusEl.style.color = 'var(--success)';
  statusEl.textContent = 'Saved ✓';
  setTimeout(()=>{ if(statusEl) statusEl.textContent=''; }, 2500);
}

/* ================= MODAL ================= */
function openModal(title, bodyHtml, buttons, wide){
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="modal ${wide?'wide':''}">
      <div class="modal-head"><h3>${title}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-foot">${buttons.map((b,i)=>`<button class="${b.cls}" id="modal-btn-${i}">${b.label}</button>`).join('')}</div>
    </div>
  `;
  buttons.forEach((b,i)=> document.getElementById('modal-btn-'+i).addEventListener('click', b.onClick));
  overlay.classList.add('active');
}
function closeModal(){
  document.getElementById('modal-overlay').classList.remove('active');
}

/* ================= PDF GENERATION ================= */
function downloadInvoicePDF(invId){
  const inv = DATA.invoices.find(i=>i.id===invId);
  const customer = DATA.customers.find(c=>c.id===inv.customerId);
  const c = DATA.config;
  const items = JSON.parse(inv.itemsJson||'[]');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({unit:'pt', format:'a4'});
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 48;
  const brass = [184,134,59];
  const ink = [20,33,61];
  const muted = [107,114,128];

  let y = 56;
  let logoOk = false;
  // Logo + company block (left) — preserve aspect ratio inside a bounding box
  if(c.logoBase64){
    try{
      const fmtMatch = /^data:image\/(png|jpeg|jpg|webp);base64,/i.exec(c.logoBase64);
      const fmt = fmtMatch ? fmtMatch[1].toUpperCase().replace('JPG','JPEG') : 'PNG';
      const dims = doc.getImageProperties(c.logoBase64);
      const boxW = 120, boxH = 54;
      let w = boxW, h = boxW * (dims.height/dims.width);
      if(h > boxH){ h = boxH; w = boxH * (dims.width/dims.height); }
      doc.addImage(c.logoBase64, fmt, margin, y-24, w, h, undefined, 'FAST');
      logoOk = true;
    }catch(e){}
  }
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...ink);
  doc.text(c.companyName || 'Company Name', margin, y + (logoOk? 48 : 0));
  let leftY = y + (logoOk? 64 : 18);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...muted);
  const addrLines = [c.addressLine1, c.addressLine2, [c.city,c.state,c.postalCode].filter(Boolean).join(', '), c.country].filter(Boolean);
  addrLines.forEach(line=>{ doc.text(line, margin, leftY); leftY += 12; });
  if(c.email){ doc.text(c.email, margin, leftY); leftY += 12; }
  if(c.phone){ doc.text(c.phone, margin, leftY); leftY += 12; }

  // Invoice title block (right)
  doc.setFont('helvetica','bold'); doc.setFontSize(22); doc.setTextColor(...ink);
  doc.text('INVOICE', pageWidth - margin, 60, {align:'right'});
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...brass);
  doc.text(inv.invoiceNumber, pageWidth - margin, 78, {align:'right'});
  doc.setTextColor(...muted); doc.setFontSize(9);
  doc.text('Issue Date: ' + fmtDate(inv.issueDate), pageWidth - margin, 96, {align:'right'});
  doc.text('Due Date: ' + fmtDate(inv.dueDate), pageWidth - margin, 110, {align:'right'});

  // Brass rule
  let ruleY = Math.max(leftY, 126) + 14;
  doc.setDrawColor(...brass); doc.setLineWidth(1.4);
  doc.line(margin, ruleY, pageWidth - margin, ruleY);

  // Bill To
  let by = ruleY + 26;
  doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...muted);
  doc.text('BILL TO', margin, by);
  by += 16;
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...ink);
  doc.text(customer ? customer.name : '—', margin, by);
  by += 14;
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...muted);
  if(customer){
    if(customer.address){ customer.address.split('\n').forEach(l=>{ doc.text(l, margin, by); by+=12; }); }
    if(customer.country){ doc.text(customer.country, margin, by); by+=12; }
    if(customer.email){ doc.text(customer.email, margin, by); by+=12; }
  }

  // Items table
  const tableY = by + 16;
  const rows = items.map(it=>[
    it.description,
    String(it.quantity),
    symbolFor(inv.currency) + fmtMoney(it.rate, inv.currency),
    symbolFor(inv.currency) + fmtMoney((it.quantity||0)*(it.rate||0), inv.currency)
  ]);
  doc.autoTable({
    startY: tableY,
    margin: {left: margin, right: margin},
    head: [['Description','Qty','Rate','Amount']],
    body: rows,
    theme: 'plain',
    styles: { font:'helvetica', fontSize:9.5, textColor: ink, cellPadding:{top:8,bottom:8,left:4,right:4} },
    headStyles: { textColor: muted, fontStyle:'bold', fontSize:8, halign:'left' },
    columnStyles: { 1:{halign:'right', cellWidth:50}, 2:{halign:'right', cellWidth:90}, 3:{halign:'right', cellWidth:100} },
    didParseCell: function(data){
      if(data.section==='head'){ data.cell.styles.lineWidth = {bottom:1}; data.cell.styles.lineColor = brass; }
    },
    tableLineColor: [228,225,217],
    tableLineWidth: 0.3,
  });

  let afterTableY = doc.lastAutoTable.finalY + 20;
  const paid = paidForInvoice(inv.id);

  // Totals box (right aligned)
  const boxRight = pageWidth - margin;
  doc.setFontSize(9.5); doc.setTextColor(...muted); doc.setFont('helvetica','normal');
  doc.text('Subtotal', boxRight - 140, afterTableY);
  doc.text(symbolFor(inv.currency) + fmtMoney(inv.total, inv.currency), boxRight, afterTableY, {align:'right'});
  afterTableY += 18;
  doc.setDrawColor(228,225,217); doc.line(boxRight-160, afterTableY-10, boxRight, afterTableY-10);
  doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(...ink);
  doc.text('Total Due', boxRight - 140, afterTableY);
  doc.text(symbolFor(inv.currency) + fmtMoney(inv.total, inv.currency), boxRight, afterTableY, {align:'right'});

  if(paid > 0){
    afterTableY += 18;
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(...[47,125,91]);
    doc.text('Paid', boxRight - 140, afterTableY);
    doc.text(symbolFor(inv.currency) + fmtMoney(paid, inv.currency), boxRight, afterTableY, {align:'right'});
    afterTableY += 16;
    const bal = Number(inv.total) - paid;
    doc.setFont('helvetica','bold'); doc.setTextColor(...(bal>0.004 ? [179,69,47] : [47,125,91]));
    doc.text('Balance Due', boxRight - 140, afterTableY);
    doc.text(symbolFor(inv.currency) + fmtMoney(bal, inv.currency), boxRight, afterTableY, {align:'right'});
  }

  // Notes
  if(inv.notes){
    afterTableY += 34;
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...muted);
    doc.text('NOTES', margin, afterTableY);
    afterTableY += 14;
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(...ink);
    const split = doc.splitTextToSize(inv.notes, pageWidth - margin*2);
    doc.text(split, margin, afterTableY);
    afterTableY += split.length * 12;
  }

  // Bank details footer
  const pageHeight = doc.internal.pageSize.getHeight();
  let fy = pageHeight - 110;
  doc.setDrawColor(...brass); doc.setLineWidth(1);
  doc.line(margin, fy, pageWidth-margin, fy);
  fy += 20;
  doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...muted);
  doc.text('PAYMENT DETAILS', margin, fy);
  fy += 14;
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...ink);
  const bankLine1 = [c.bankName, c.bankAccountName].filter(Boolean).join('  ·  ');
  const bankLine2 = [c.bankAccountNumber && ('A/C: '+c.bankAccountNumber), c.bankIFSC && ('IFSC: '+c.bankIFSC), c.bankSwift && ('SWIFT: '+c.bankSwift)].filter(Boolean).join('   ');
  if(bankLine1) { doc.text(bankLine1, margin, fy); fy += 13; }
  if(bankLine2) { doc.text(bankLine2, margin, fy); fy += 13; }
  if(c.bankAddress) { doc.text(c.bankAddress, margin, fy); }

  doc.save(inv.invoiceNumber + '.pdf');
}

/* ================= INIT ================= */
window.addEventListener('DOMContentLoaded', initApp);
