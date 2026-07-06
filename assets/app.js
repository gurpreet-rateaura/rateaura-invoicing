/* ================= CONFIG ================= */
const CONFIG = {
  // Paste your Google Apps Script Web App URL here (ends with /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbx3Pd2V28JEy_nnxZnemYYMhcTjTHIssGNvRdKlMHUNUSaF7djNw2cnufUEr-fSF3Jakg/exec'
};

/* ================= STATE ================= */
let DATA = { config:{}, customers:[], vendors:[], invoices:[], payments:[], payables:[], paysettlements:[] };
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
async function apiGet(){
  const res = await fetch(CONFIG.API_URL + '?action=bootstrap');
  return res.json();
}
async function apiPost(action, payload){
  const res = await fetch(CONFIG.API_URL, {
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body: JSON.stringify({action, payload})
  });
  return res.json();
}
async function reloadData(){
  DATA = await apiGet();
}

/* ================= AUTH ================= */
async function initApp(){
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  try{
    await reloadData();
  }catch(err){
    document.getElementById('login-error').textContent = 'Could not reach the backend. Check API_URL in app.js.';
    return;
  }
  if(sessionStorage.getItem('rateaura_authed') === '1'){
    enterApp();
  }else{
    document.getElementById('login-screen').style.display = 'flex';
  }
}

async function handleLogin(e){
  e.preventDefault();
  const pwd = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if(!DATA.config.passwordHash){
    // First run: set a new password
    if(pwd.length < 4){ errEl.textContent = 'Choose a password with at least 4 characters.'; return; }
    const hash = await sha256hex(pwd);
    await apiPost('saveConfig', {passwordHash: hash});
    DATA.config.passwordHash = hash;
    sessionStorage.setItem('rateaura_authed','1');
    enterApp();
    return;
  }
  const hash = await sha256hex(pwd);
  if(hash === DATA.config.passwordHash){
    sessionStorage.setItem('rateaura_authed','1');
    enterApp();
  }else{
    errEl.textContent = 'Incorrect password.';
  }
}

function logout(){
  sessionStorage.removeItem('rateaura_authed');
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
function invoiceStatus(inv){
  const paid = paidForInvoice(inv.id);
  const total = Number(inv.total||0);
  if(paid <= 0) return 'Unpaid';
  if(paid < total) return 'Partially Paid';
  return 'Paid';
}
function payableStatus(p){
  const paid = paidForPayable(p.id);
  const total = Number(p.amount||0);
  if(paid <= 0) return 'Unpaid';
  if(paid < total) return 'Partially Paid';
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
  let recUSD=0, recINR=0, payUSD=0, payINR=0, overdueCount=0;
  DATA.invoices.forEach(inv=>{
    const outstanding = Number(inv.total||0) - paidForInvoice(inv.id);
    if(outstanding > 0.004){
      if(inv.currency==='INR') recINR += outstanding; else recUSD += outstanding;
      if(inv.dueDate && new Date(inv.dueDate) < new Date()) overdueCount++;
    }
  });
  DATA.payables.forEach(p=>{
    const outstanding = Number(p.amount||0) - paidForPayable(p.id);
    if(outstanding > 0.004){
      if(p.currency==='INR') payINR += outstanding; else payUSD += outstanding;
    }
  });

  main.innerHTML = `
    <div class="page-header">
      <div><h2>Dashboard</h2><p>Overview of what's owed to you and what you owe.</p></div>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Receivable — USD</div><div class="kpi-value amount">$${fmtMoney(recUSD,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Receivable — INR</div><div class="kpi-value amount">₹${fmtMoney(recINR,'INR')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Payable — USD</div><div class="kpi-value danger amount">$${fmtMoney(payUSD,'USD')}</div></div>
      <div class="kpi-card"><div class="kpi-label">Payable — INR</div><div class="kpi-value danger amount">₹${fmtMoney(payINR,'INR')}</div></div>
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
        <thead><tr><th>Bill #</th><th>Vendor</th><th>Due Date</th><th>Amount</th><th>Status</th></tr></thead>
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
      <td class="amount">${symbolFor(p.currency)}${fmtMoney(p.amount, p.currency)}</td>
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
      <div><h2>Vendors</h2><p>Who you owe money to.</p></div>
      <button class="btn btn-gold" onclick="openVendorModal()">+ New Vendor</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Contact</th><th>Country</th><th>Default Currency</th><th></th></tr></thead>
        <tbody>${vendorRows()}</tbody>
      </table>
    </div>
  `;
}
function vendorRows(){
  if(!DATA.vendors.length) return `<tr class="empty-row"><td colspan="5">No vendors yet.</td></tr>`;
  return DATA.vendors.map(v=>`
    <tr>
      <td><strong>${escapeHtml(v.name)}</strong><div style="color:var(--muted);font-size:0.8rem;">${escapeHtml(v.email||'')}</div></td>
      <td>${escapeHtml(v.contactPerson||'—')}${v.phone?(' · '+escapeHtml(v.phone)):''}</td>
      <td>${escapeHtml(v.country||'—')}</td>
      <td>${escapeHtml(v.defaultCurrency||'USD')}</td>
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
    <div class="form-group"><label>Default Currency</label>
      <select id="v-currency"><option value="USD" ${v&&v.defaultCurrency==='USD'?'selected':''}>USD</option><option value="INR" ${v&&v.defaultCurrency==='INR'?'selected':''}>INR</option></select>
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
        defaultCurrency: document.getElementById('v-currency').value
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
      <div><h2>Payables</h2><p>Vendor bills you owe, and what's been settled.</p></div>
      <button class="btn btn-gold" onclick="openPayableModal()">+ New Bill</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Bill #</th><th>Vendor</th><th>Due Date</th><th>Amount</th><th>Outstanding</th><th>Status</th><th></th></tr></thead>
        <tbody>${payableRows()}</tbody>
      </table>
    </div>
  `;
}
function payableRows(){
  if(!DATA.payables.length) return `<tr class="empty-row"><td colspan="7">No payables yet.</td></tr>`;
  return [...DATA.payables].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt)).map(p=>{
    const paid = paidForPayable(p.id);
    const outstanding = Number(p.amount) - paid;
    return `<tr>
      <td class="mono">${escapeHtml(p.billNumber||'—')}</td>
      <td>${escapeHtml(vendorName(p.vendorId))}</td>
      <td>${fmtDate(p.dueDate)}</td>
      <td class="amount">${symbolFor(p.currency)}${fmtMoney(p.amount,p.currency)}</td>
      <td class="amount">${symbolFor(p.currency)}${fmtMoney(outstanding,p.currency)}</td>
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
  const vendorOptions = DATA.vendors.map(v=>`<option value="${v.id}" ${p&&p.vendorId===v.id?'selected':''}>${escapeHtml(v.name)}</option>`).join('');
  const body = `
    <div class="form-row">
      <div class="form-group"><label>Vendor</label><select id="p-vendor">${vendorOptions || '<option value="">Add a vendor first</option>'}</select></div>
      <div class="form-group"><label>Bill / Reference #</label><input type="text" id="p-billnumber" value="${p?escapeHtml(p.billNumber||''):''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Bill Date</label><input type="date" id="p-billdate" value="${p?p.billDate:todayISO()}"></div>
      <div class="form-group"><label>Due Date</label><input type="date" id="p-duedate" value="${p?p.dueDate:''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Amount</label><input type="number" step="0.01" id="p-amount" value="${p?p.amount:''}"></div>
      <div class="form-group"><label>Currency</label><select id="p-currency"><option value="USD" ${p&&p.currency==='USD'?'selected':''}>USD</option><option value="INR" ${p&&p.currency==='INR'?'selected':''}>INR</option></select></div>
    </div>
    <div class="form-group full"><label>Description</label><textarea id="p-description">${p?escapeHtml(p.description||''):''}</textarea></div>
  `;
  openModal(id?'Edit Bill':'New Bill', body, [
    {label:'Cancel', cls:'btn', onClick:closeModal},
    {label:'Save', cls:'btn btn-gold', onClick: async ()=>{
      const vendorId = document.getElementById('p-vendor').value;
      if(!vendorId){ alert('Select a vendor.'); return; }
      const amount = parseFloat(document.getElementById('p-amount').value)||0;
      await apiPost('savePayable', {
        id, vendorId,
        billNumber: document.getElementById('p-billnumber').value,
        billDate: document.getElementById('p-billdate').value,
        dueDate: document.getElementById('p-duedate').value,
        amount, currency: document.getElementById('p-currency').value,
        description: document.getElementById('p-description').value
      });
      await reloadData();
      closeModal();
      navigate('payables');
    }}
  ]);
}
function openPaySettleModal(payId){
  const p = DATA.payables.find(x=>x.id===payId);
  const paid = paidForPayable(payId);
  const outstanding = Number(p.amount) - paid;
  const history = DATA.paysettlements.filter(s=>s.payableId===payId);
  const body = `
    <p style="margin-top:0;color:var(--muted);font-size:0.9rem;">
      Bill <strong>${escapeHtml(p.billNumber||'—')}</strong> — Outstanding <strong>${symbolFor(p.currency)}${fmtMoney(outstanding,p.currency)}</strong>
    </p>
    <div class="form-row">
      <div class="form-group"><label>Amount Paid</label><input type="number" id="ps-amount" step="0.01" value="${outstanding>0?outstanding.toFixed(2):''}"></div>
      <div class="form-group"><label>Date</label><input type="date" id="ps-date" value="${todayISO()}"></div>
    </div>
    <div class="form-group"><label>Method</label><input type="text" id="ps-method"></div>
    <div class="form-group full"><label>Note</label><input type="text" id="ps-note"></div>
    <div class="settle-list">
      <div class="section-title" style="margin:0 0 8px;">Settlement History</div>
      ${history.length ? history.map(h=>`<div class="settle-row"><span>${fmtDate(h.date)} — ${escapeHtml(h.method||'')}</span><span class="amount">${symbolFor(p.currency)}${fmtMoney(h.amount,p.currency)}</span></div>`).join('') : '<div class="settle-row"><span>No settlements yet.</span></div>'}
    </div>
  `;
  openModal('Settle Bill', body, [
    {label:'Close', cls:'btn', onClick:closeModal},
    {label:'Record Payment', cls:'btn btn-gold', onClick: async ()=>{
      const amount = parseFloat(document.getElementById('ps-amount').value)||0;
      if(amount<=0){ alert('Enter a valid amount.'); return; }
      await apiPost('addPaySettlement', {payableId:payId, date:document.getElementById('ps-date').value, amount, method:document.getElementById('ps-method').value, note:document.getElementById('ps-note').value});
      await reloadData();
      closeModal();
      navigate('payables');
    }}
  ]);
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
          <div class="form-group"><label>Logo</label><input type="file" id="s-logoFile" accept="image/*">
            ${c.logoBase64 ? `<img src="${c.logoBase64}" class="logo-preview">` : ''}
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
  const reader = new FileReader();
  reader.onload = ()=>{ DATA.config.logoBase64 = reader.result; };
  reader.readAsDataURL(file);
}
async function saveSettings(){
  const ids = ['companyName','email','phone','website','addressLine1','addressLine2','city','state','postalCode','country','bankName','bankAccountName','bankAccountNumber','bankIFSC','bankSwift','bankAddress','invoicePrefix','invoiceNextNumber'];
  const payload = {};
  ids.forEach(id=> payload[id] = document.getElementById('s-'+id).value);
  if(DATA.config.logoBase64) payload.logoBase64 = DATA.config.logoBase64;
  const newPwd = document.getElementById('s-newPassword').value;
  if(newPwd && newPwd.length>=4) payload.passwordHash = await sha256hex(newPwd);
  await apiPost('saveConfig', payload);
  await reloadData();
  document.getElementById('settings-saved').textContent = 'Saved ✓';
  setTimeout(()=>{ const el=document.getElementById('settings-saved'); if(el) el.textContent=''; }, 2500);
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
  // Logo + company block (left)
  if(c.logoBase64){
    try{ doc.addImage(c.logoBase64, 'PNG', margin, y-20, 110, 50, undefined, 'FAST'); }catch(e){}
  }
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...ink);
  doc.text(c.companyName || 'Company Name', margin, y + (c.logoBase64? 48 : 0));
  let leftY = y + (c.logoBase64? 64 : 18);
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
