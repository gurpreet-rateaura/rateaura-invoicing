/* ================= CONFIG ================= */
const CONFIG = {
  // Paste your Google Apps Script Web App URL here (ends with /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbylMR1hO1-oPJA6-Z7XyQWs9YCkc5Xyq3SddPjyMb0Pid5SgkX1qDHiABKTinyrjjUGEA/exec'
};

/* ================= STATE ================= */
let DATA = { config:{}, customers:[], vendors:[], invoices:[], payments:[], payables:[], paysettlements:[], expenses:[] };
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
  const forexRealized = fxSettlements.reduce((s,x)=>s+Number(x.forexGainLoss||0),0); // +ve = net loss, -ve = net gain
  const netPosition = bufferBooked - forexRealized;
  return { bufferBooked, bufferRealized, forexRealized, netPosition, settlementCount: fxSettlements.length };
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
  const paid = paidForPayable(p.id);
  const total = payableTotalUSD(p);
  if(paid <= 0) return 'Unpaid';
  if(paid < total - 0.004) return 'Partially Paid';
  return 'Paid';
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
    const outstanding = payableTotalUSD(p) - paidForPayable(p.id);
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
      <div class="kpi-card"><div class="kpi-label">Net Forex Position</div><div class="kpi-value amount ${fx.netPosition>=0?'success':'danger'}">$${fmtMoney(Math.abs(fx.netPosition),'USD')} ${fx.netPosition>=0?'favorable':'unfavorable'}</div></div>
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
    <div class="settle-list">
      <div class="section-title" style="margin:0 0 8px;">Payment History</div>
      ${history.length ? history.map(h=>`<div class="settle-row"><span>${fmtDate(h.date)} — ${escapeHtml(h.method||'')} ${escapeHtml(h.note?('— '+h.note):'')}</span><span class="amount">${symbolFor(inv.currency)}${fmtMoney(h.amount,inv.currency)}</span></div>`).join('') : '<div class="settle-row"><span>No payments recorded yet.</span></div>'}
    </div>
  `;
  openModal('Settle Invoice', body, [
    {label:'Close', cls:'btn', onClick:closeModal},
    {label:'Record Payment', cls:'btn btn-gold', onClick: async ()=>{
      const amount = parseFloat(document.getElementById('s-amount').value)||0;
      if(amount<=0){ alert('Enter a valid amount.'); return; }
      await apiPost('addPayment', {invoiceId:invId, date:document.getElementById('s-date').value, amount, method:document.getElementById('s-method').value, note:document.getElementById('s-note').value});
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
    const paid = paidForPayable(p.id);
    const outstanding = total - paid;
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
    <div class="settle-list">
      <div class="section-title" style="margin:0 0 8px;">Settlement History</div>
      ${history.length ? history.map(h=>`<div class="settle-row"><span>${fmtDate(h.date)} — ${escapeHtml(h.method||'')}</span><span class="amount">$${fmtMoney(h.amount,'USD')}</span></div>`).join('') : '<div class="settle-row"><span>No settlements yet.</span></div>'}
    </div>
  `;
  openModal('Settle Bill', body, [
    {label:'Close', cls:'btn', onClick:closeModal},
    {label:'Record Payment', cls:'btn btn-gold', onClick: async ()=>{
      const amount = parseFloat(document.getElementById('ps-amount').value)||0;
      if(amount<=0){ alert('Enter a valid amount.'); return; }
      await apiPost('addPaySettlement', {payableId:p.id, date:document.getElementById('ps-date').value, amount, method:document.getElementById('ps-method').value, note:document.getElementById('ps-note').value});
      await reloadData();
      closeModal();
      navigate('payables');
    }}
  ]);
}
function openPaySettleModalINR(p){
  const remainingInr = remainingInrForPayable(p);
  const paidUsd = paidForPayable(p.id);
  const outstandingUsd = payableTotalUSD(p) - paidUsd;
  const history = DATA.paysettlements.filter(s=>s.payableId===p.id);
  const body = `
    <p style="margin-top:0;color:var(--muted);font-size:0.9rem;">
      Bill <strong>${escapeHtml(p.billNumber||'—')}</strong> — Remaining <strong>₹${fmtMoney(remainingInr,'INR')}</strong>
      (≈ <strong>$${fmtMoney(outstandingUsd,'USD')}</strong> at booking rate)
    </p>
    <div class="form-row">
      <div class="form-group"><label>INR Amount Being Settled</label><input type="number" id="ps-inr" step="0.01" value="${remainingInr>0?remainingInr.toFixed(2):''}" oninput="updateSettlePreview('${p.id}')"></div>
      <div class="form-group"><label>Payment Date</label><input type="date" id="ps-date" value="${todayISO()}"></div>
    </div>
    <div class="form-group"><label>Today's FX Rate (INR per USD)</label><input type="number" id="ps-fxrate" step="0.0001" oninput="updateSettlePreview('${p.id}')"></div>
    <div class="card" style="background:var(--paper);box-shadow:none;margin:10px 0;">
      <div style="padding:14px 18px;font-size:0.88rem;">
        <div class="settle-row"><span>USD Remitted</span><span class="amount" id="prev-usdpaid">$0.00</span></div>
        <div class="settle-row"><span>Allocated Actual USD Buying</span><span class="amount" id="prev-allocactual">$0.00</span></div>
        <div class="settle-row"><span>Allocated Buffer</span><span class="amount" id="prev-allocbuffer">$0.00</span></div>
        <div class="settle-row"><span>FX Difference</span><span class="amount" id="prev-fxdiff">$0.00</span></div>
        <div class="settle-row" style="font-weight:600;color:var(--ink);"><span>Actual Forex Gain/Loss</span><span class="amount" id="prev-forexgl">$0.00</span></div>
      </div>
    </div>
    <div class="form-group"><label>Method</label><input type="text" id="ps-method"></div>
    <div class="form-group full"><label>Note</label><input type="text" id="ps-note"></div>
    <div class="settle-list">
      <div class="section-title" style="margin:0 0 8px;">Settlement History</div>
      ${history.length ? history.map(h=>{
        const gl = Number(h.forexGainLoss||0);
        return `<div class="settle-row"><span>${fmtDate(h.date)} — ₹${fmtMoney(h.inrAmountSettled,'INR')} @ ${h.paymentFxRate}</span><span class="amount" style="color:${gl>0?'var(--danger)':'var(--success)'};">${gl>0?'-':'+'}$${fmtMoney(Math.abs(gl),'USD')}</span></div>`;
      }).join('') : '<div class="settle-row"><span>No settlements yet.</span></div>'}
    </div>
  `;
  openModal('Settle Bill — INR Vendor (FX Tracked)', body, [
    {label:'Close', cls:'btn', onClick:closeModal},
    {label:'Record Payment', cls:'btn btn-gold', onClick: async ()=>{
      const inrAmountSettled = parseFloat(document.getElementById('ps-inr').value)||0;
      const paymentFxRate = parseFloat(document.getElementById('ps-fxrate').value)||0;
      if(inrAmountSettled<=0 || paymentFxRate<=0){ alert('Enter a valid INR amount and FX rate.'); return; }
      const inrAmount = Number(p.inrAmount||0);
      const share = inrAmount>0 ? (inrAmountSettled/inrAmount) : 0;
      const allocatedActualUsdBuying = Number(p.actualUsdBuying||0) * share;
      const allocatedBufferUsd = Number(p.bufferAmountUsd||0) * share;
      const paymentAmountUsd = inrAmountSettled / paymentFxRate;
      const fxDifference = paymentAmountUsd - allocatedActualUsdBuying;
      const forexGainLoss = fxDifference - allocatedBufferUsd;
      await apiPost('addPaySettlement', {
        payableId: p.id,
        date: document.getElementById('ps-date').value,
        amount: paymentAmountUsd,
        inrAmountSettled, paymentFxRate,
        allocatedActualUsdBuying, allocatedBufferUsd, fxDifference, forexGainLoss,
        method: document.getElementById('ps-method').value,
        note: document.getElementById('ps-note').value
      });
      await reloadData();
      closeModal();
      navigate('payables');
    }}
  ]);
  updateSettlePreview(p.id);
}
function updateSettlePreview(payableId){
  const p = DATA.payables.find(x=>x.id===payableId);
  if(!p) return;
  const inrAmountSettled = parseFloat(document.getElementById('ps-inr')?.value)||0;
  const paymentFxRate = parseFloat(document.getElementById('ps-fxrate')?.value)||0;
  const inrAmount = Number(p.inrAmount||0);
  const share = inrAmount>0 ? (inrAmountSettled/inrAmount) : 0;
  const allocatedActualUsdBuying = Number(p.actualUsdBuying||0) * share;
  const allocatedBufferUsd = Number(p.bufferAmountUsd||0) * share;
  const paymentAmountUsd = paymentFxRate>0 ? inrAmountSettled/paymentFxRate : 0;
  const fxDifference = paymentAmountUsd - allocatedActualUsdBuying;
  const forexGainLoss = fxDifference - allocatedBufferUsd;
  const set = (id,val)=>{ const el=document.getElementById(id); if(el) el.textContent = val; };
  set('prev-usdpaid', '$'+fmtMoney(paymentAmountUsd,'USD'));
  set('prev-allocactual', '$'+fmtMoney(allocatedActualUsdBuying,'USD'));
  set('prev-allocbuffer', '$'+fmtMoney(allocatedBufferUsd,'USD'));
  set('prev-fxdiff', '$'+fmtMoney(fxDifference,'USD'));
  const glEl = document.getElementById('prev-forexgl');
  if(glEl){
    glEl.textContent = (forexGainLoss>0?'Loss ':'Gain ') + '$'+fmtMoney(Math.abs(forexGainLoss),'USD');
    glEl.style.color = forexGainLoss>0 ? 'var(--danger)' : 'var(--success)';
  }
}

/* ================= FOREX REPORT ================= */
function renderForexReport(main){
  const fx = forexTotals();
  const monthly = monthlyForexSummary();
  const byVendor = vendorForexSummary();
  main.innerHTML = `
    <div class="page-header">
      <div><h2>Forex Report</h2><p>How your FX buffer compares to actual currency movement on INR-vendor settlements.</p></div>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Total Buffer Booked</div><div class="kpi-value amount">$${fmtMoney(fx.bufferBooked,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Buffer Realized</div><div class="kpi-value amount">$${fmtMoney(fx.bufferRealized,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Forex Gain/Loss (Realized)</div><div class="kpi-value amount ${fx.forexRealized>0?'danger':'success'}">${fx.forexRealized>0?'-':'+'}$${fmtMoney(Math.abs(fx.forexRealized),'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Net Forex Position</div><div class="kpi-value amount ${fx.netPosition>=0?'success':'danger'}">$${fmtMoney(Math.abs(fx.netPosition),'USD')} ${fx.netPosition>=0?'favorable':'unfavorable'}</div></div>
    </div>
    <p style="color:var(--muted);font-size:0.82rem;margin-top:-14px;">
      Net Forex Position = Total Buffer Booked − Total Forex Gain/Loss (Realized). Positive means your buffer has, on net, covered realized currency movement so far; negative means realized losses have exceeded the buffer collected.
    </p>

    <div class="card">
      <div class="card-head"><h3>Monthly Forex Gain/Loss Summary</h3></div>
      <table>
        <thead><tr><th>Month</th><th>Settlements</th><th>Buffer Allocated</th><th>Forex Gain/Loss</th></tr></thead>
        <tbody>${monthly.length ? monthly.map(m=>`
          <tr>
            <td>${escapeHtml(m.month)}</td>
            <td>${m.count}</td>
            <td class="amount">$${fmtMoney(m.buffer,'USD')}</td>
            <td class="amount" style="color:${m.gainLoss>0?'var(--danger)':'var(--success)'};">${m.gainLoss>0?'-':'+'}$${fmtMoney(Math.abs(m.gainLoss),'USD')}</td>
          </tr>`).join('') : '<tr class="empty-row"><td colspan="4">No INR-vendor settlements recorded yet.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-head"><h3>Vendor-wise Forex Gain/Loss</h3></div>
      <table>
        <thead><tr><th>Vendor</th><th>Settlements</th><th>Buffer Allocated</th><th>Forex Gain/Loss</th></tr></thead>
        <tbody>${byVendor.length ? byVendor.map(v=>`
          <tr>
            <td>${escapeHtml(vendorName(v.vendorId))}</td>
            <td>${v.count}</td>
            <td class="amount">$${fmtMoney(v.buffer,'USD')}</td>
            <td class="amount" style="color:${v.gainLoss>0?'var(--danger)':'var(--success)'};">${v.gainLoss>0?'-':'+'}$${fmtMoney(Math.abs(v.gainLoss),'USD')}</td>
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
    if(!inRange(pay.date, from, to)) return;
    revenue += paymentUsdAmount(pay);
  });
  DATA.paysettlements.forEach(s=>{
    if(!inRange(s.date, from, to)) return;
    cogs += Number(s.amount||0); // already USD, for both USD- and INR-vendor settlements
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
    if(!inRange(pay.date, from, to)) return;
    touch(pay.date.slice(0,7)).revenue += paymentUsdAmount(pay);
  });
  DATA.paysettlements.forEach(s=>{
    if(!inRange(s.date, from, to)) return;
    touch(s.date.slice(0,7)).cogs += Number(s.amount||0);
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
