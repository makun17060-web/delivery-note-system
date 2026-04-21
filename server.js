'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const COMPANY_NAME = process.env.COMPANY_NAME || '合同会社 磯屋コマース';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

function nowJstDateString() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10).replace(/-/g, '');
}

function makeToken(size = 24) {
  return crypto.randomBytes(size).toString('hex');
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseBasicAuth(header = '') {
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

function requireAdmin(req, res, next) {
  const auth = parseBasicAuth(req.headers.authorization || '');
  const ok = auth && auth.user === process.env.ADMIN_BASIC_USER && auth.pass === process.env.ADMIN_BASIC_PASS;
  if (ok) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="delivery-admin"');
  return res.status(401).json({ ok: false, error: 'admin auth required' });
}

async function nextRunningNo(prefix, client, table, column) {
  const today = nowJstDateString();
  const base = `${prefix}-${today}`;
  const { rows } = await client.query(
    `select count(*)::int as cnt from ${table} where ${column} like $1`,
    [`${base}-%`]
  );
  const seq = String((rows[0]?.cnt || 0) + 1).padStart(4, '0');
  return `${base}-${seq}`;
}

function calcAmounts(items) {
  let subtotal = 0;
  let taxAmount = 0;
  const normalized = items.map((item) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unit_price || item.unitPrice || 0);
    const taxRate = Number(item.tax_rate || item.taxRate || 8);
    const lineAmount = Number((quantity * unitPrice).toFixed(2));
    const lineTax = Number((lineAmount * (taxRate / 100)).toFixed(2));
    subtotal += lineAmount;
    taxAmount += lineTax;
    return {
      product_id: item.product_id || null,
      product_code: item.product_code || item.productCode || '',
      product_name: item.product_name || item.productName || '',
      unit: item.unit || '袋',
      quantity,
      unit_price: unitPrice,
      tax_rate: taxRate,
      line_amount: lineAmount,
    };
  });
  return {
    items: normalized,
    subtotal: Number(subtotal.toFixed(2)),
    taxAmount: Number(taxAmount.toFixed(2)),
    totalAmount: Number((subtotal + taxAmount).toFixed(2)),
  };
}

async function logEvent(client, deliveryNoteId, eventType, actorType, actorId, detail = {}) {
  await client.query(
    `insert into delivery_events (delivery_note_id, event_type, actor_type, actor_id, detail)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [deliveryNoteId, eventType, actorType, actorId || null, JSON.stringify(detail || {})]
  );
}

async function getOrderById(orderId) {
  const orderQ = await pool.query(
    `select o.*, c.customer_code, c.name as customer_name, c.contact_name, c.phone, c.email,
            c.pref, c.city, c.addr1, c.addr2
       from orders o
       join customers c on c.id = o.customer_id
      where o.id = $1`,
    [orderId]
  );
  if (!orderQ.rowCount) return null;
  const itemsQ = await pool.query(
    `select * from order_items where order_id = $1 order by id`,
    [orderId]
  );
  return { ...orderQ.rows[0], items: itemsQ.rows };
}

async function getDeliveryNoteFullById(deliveryNoteId) {
  const noteQ = await pool.query(
    `select dn.*, c.customer_code, c.name as customer_name, c.contact_name, c.phone, c.email,
            c.pref, c.city, c.addr1, c.addr2, o.order_no
       from delivery_notes dn
       join customers c on c.id = dn.customer_id
  left join orders o on o.id = dn.order_id
      where dn.id = $1`,
    [deliveryNoteId]
  );
  if (!noteQ.rowCount) return null;
  const itemsQ = await pool.query(
    `select * from delivery_note_items where delivery_note_id = $1 order by id`,
    [deliveryNoteId]
  );
  const receiptQ = await pool.query(
    `select * from delivery_receipts where delivery_note_id = $1`,
    [deliveryNoteId]
  );
  return {
    ...noteQ.rows[0],
    items: itemsQ.rows,
    receipt: receiptQ.rows[0] || null,
    view_url: `${APP_BASE_URL}/view/${noteQ.rows[0].view_token}`,
    sign_url: `${APP_BASE_URL}/sign/${noteQ.rows[0].view_token}`,
  };
}

function deliveryNoteHtml(doc) {
  const itemRows = doc.items.map((it, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(it.product_code || '')}</td>
      <td>${escapeHtml(it.product_name)}</td>
      <td class="num">${Number(it.quantity).toLocaleString('ja-JP')}</td>
      <td>${escapeHtml(it.unit)}</td>
      <td class="num">${Number(it.unit_price).toLocaleString('ja-JP')}</td>
      <td class="num">${Number(it.line_amount).toLocaleString('ja-JP')}</td>
    </tr>
  `).join('');

  const signBlock = doc.receipt?.signature_data_url
    ? `<div class="sign-block"><div class="label">受領サイン</div><img src="${doc.receipt.signature_data_url}" alt="signature"></div>`
    : '<div class="sign-block"><div class="label">受領サイン</div><div class="unsigned">未署名</div></div>';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>納品書 ${escapeHtml(doc.delivery_note_no)}</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7f8;margin:0;color:#222}
.wrap{max-width:980px;margin:24px auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
.head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}
h1{margin:0;font-size:28px}
.meta,.addr,.summary{font-size:14px;line-height:1.8}
.table{width:100%;border-collapse:collapse;margin-top:20px}
.table th,.table td{border:1px solid #ddd;padding:10px;font-size:14px}
.table th{background:#f2f2f3}
.num{text-align:right}
.summary{margin-top:16px;display:grid;justify-content:end}
.summary table{border-collapse:collapse;min-width:280px}
.summary td{border:1px solid #ddd;padding:8px 10px}
.sign-area{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;margin-top:24px;flex-wrap:wrap}
.sign-block img{max-width:240px;border:1px solid #ddd;background:#fff}
.unsigned{width:240px;height:100px;border:1px dashed #bbb;display:flex;align-items:center;justify-content:center;color:#777}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:12px 16px;border-radius:10px;border:0;background:#111;color:#fff;text-decoration:none;cursor:pointer}
.btn.secondary{background:#ececef;color:#111}
.label{font-weight:700;margin-bottom:8px}
.small{color:#666;font-size:12px}
@media print {.actions{display:none} body{background:#fff} .wrap{box-shadow:none;margin:0;padding:0;border-radius:0}}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div>
      <div class="small">${escapeHtml(COMPANY_NAME)}</div>
      <h1>納品書</h1>
      <div class="meta">
        納品書番号: ${escapeHtml(doc.delivery_note_no)}<br>
        発行日: ${escapeHtml(doc.issue_date)}<br>
        納品日: ${escapeHtml(doc.delivery_date || '')}<br>
        注文番号: ${escapeHtml(doc.order_no || '')}
      </div>
    </div>
    <div class="addr">
      <strong>${escapeHtml(doc.customer_name)} 御中</strong><br>
      担当: ${escapeHtml(doc.contact_name || '')}<br>
      ${escapeHtml([doc.pref, doc.city, doc.addr1, doc.addr2].filter(Boolean).join(' '))}<br>
      TEL: ${escapeHtml(doc.phone || '')}
    </div>
  </div>

  <table class="table">
    <thead>
      <tr>
        <th>#</th><th>商品コード</th><th>商品名</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div class="summary">
    <table>
      <tr><td>小計</td><td class="num">${Number(doc.subtotal).toLocaleString('ja-JP')} 円</td></tr>
      <tr><td>消費税</td><td class="num">${Number(doc.tax_amount).toLocaleString('ja-JP')} 円</td></tr>
      <tr><td><strong>合計</strong></td><td class="num"><strong>${Number(doc.total_amount).toLocaleString('ja-JP')} 円</strong></td></tr>
    </table>
  </div>

  <div class="sign-area">
    <div>
      <div class="label">備考</div>
      <div>${escapeHtml(doc.memo || '') || '―'}</div>
      <div class="small">状態: ${escapeHtml(doc.status)}</div>
    </div>
    <div>
      <div class="label">受領者</div>
      <div>${escapeHtml(doc.receipt?.received_by || doc.receipt?.signer_name || '未入力')}</div>
      <div class="small">${escapeHtml(doc.receipt?.received_at || '')}</div>
      ${signBlock}
    </div>
  </div>

  <div class="actions">
    <button class="btn" onclick="window.print()">印刷 / PDF保存</button>
    <a class="btn secondary" href="/sign/${escapeHtml(doc.view_token)}">受領サイン</a>
    <a class="btn secondary" href="/public/portal.html">履歴画面</a>
  </div>
</div>
</body>
</html>`;
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, app: 'delivery-note-system' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => {
  res.redirect('/public/order.html');
});

app.get('/view/:token', async (req, res) => {
  const q = await pool.query('select id from delivery_notes where view_token = $1', [req.params.token]);
  if (!q.rowCount) return res.status(404).send('not found');
  const doc = await getDeliveryNoteFullById(q.rows[0].id);
  await pool.query(
    `insert into delivery_events (delivery_note_id, event_type, actor_type, actor_id, detail)
     values ($1, 'viewed', 'customer', $2, $3::jsonb)`,
    [doc.id, req.ip, JSON.stringify({ ip: req.ip, ua: req.headers['user-agent'] || '' })]
  );
  res.send(deliveryNoteHtml(doc));
});

app.get('/sign/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

app.get('/api/customers', async (req, res) => {
  const { rows } = await pool.query(
    'select * from customers where is_active = true order by customer_code'
  );
  res.json({ ok: true, customers: rows });
});

app.get('/api/products', async (req, res) => {
  const { rows } = await pool.query(
    'select * from products where is_active = true order by product_code'
  );
  res.json({ ok: true, products: rows });
});

app.post('/api/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_code, order_date, delivery_date, memo, items } = req.body || {};
    if (!customer_code) return res.status(400).json({ ok: false, error: 'customer_code required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'items required' });

    await client.query('begin');
    const cQ = await client.query('select * from customers where customer_code = $1 and is_active = true', [customer_code]);
    if (!cQ.rowCount) throw new Error('customer not found');

    const orderNo = await nextRunningNo('OD', client, 'orders', 'order_no');
    const amounts = calcAmounts(items);

    const orderQ = await client.query(
      `insert into orders (order_no, customer_id, order_date, delivery_date, status, memo)
       values ($1, $2, $3, $4, 'confirmed', $5)
       returning *`,
      [orderNo, cQ.rows[0].id, order_date, delivery_date || null, memo || null]
    );
    for (const item of amounts.items) {
      await client.query(
        `insert into order_items
         (order_id, product_id, product_code, product_name, unit, quantity, unit_price, tax_rate, line_amount)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          orderQ.rows[0].id,
          item.product_id,
          item.product_code,
          item.product_name,
          item.unit,
          item.quantity,
          item.unit_price,
          item.tax_rate,
          item.line_amount,
        ]
      );
    }
    await client.query('commit');
    res.json({ ok: true, order_id: orderQ.rows[0].id, order_no: orderNo, amounts });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `select o.*, c.customer_code, c.name as customer_name
       from orders o join customers c on c.id = o.customer_id
      order by o.id desc limit 200`
  );
  res.json({ ok: true, orders: rows });
});

app.get('/api/orders/:id', requireAdmin, async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'order not found' });
  res.json({ ok: true, order });
});

app.post('/api/delivery-notes/from-order/:orderId', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const orderQ = await client.query('select * from orders where id = $1', [req.params.orderId]);
    if (!orderQ.rowCount) throw new Error('order not found');
    const order = orderQ.rows[0];

    const existsQ = await client.query('select id, delivery_note_no, view_token from delivery_notes where order_id = $1', [order.id]);
    if (existsQ.rowCount) {
      await client.query('rollback');
      return res.json({
        ok: true,
        already_exists: true,
        delivery_note_id: existsQ.rows[0].id,
        delivery_note_no: existsQ.rows[0].delivery_note_no,
        view_url: `${APP_BASE_URL}/view/${existsQ.rows[0].view_token}`,
      });
    }

    const itemsQ = await client.query('select * from order_items where order_id = $1 order by id', [order.id]);
    const amounts = calcAmounts(itemsQ.rows);
    const deliveryNoteNo = await nextRunningNo('DN', client, 'delivery_notes', 'delivery_note_no');
    const viewToken = makeToken(16);

    const dnQ = await client.query(
      `insert into delivery_notes
       (delivery_note_no, order_id, customer_id, issue_date, delivery_date, status, subtotal, tax_amount, total_amount, view_token, memo)
       values ($1,$2,$3,current_date,$4,'issued',$5,$6,$7,$8,$9)
       returning *`,
      [
        deliveryNoteNo,
        order.id,
        order.customer_id,
        order.delivery_date || null,
        amounts.subtotal,
        amounts.taxAmount,
        amounts.totalAmount,
        viewToken,
        order.memo || null,
      ]
    );
    for (const item of amounts.items) {
      await client.query(
        `insert into delivery_note_items
         (delivery_note_id, product_code, product_name, unit, quantity, unit_price, tax_rate, line_amount)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          dnQ.rows[0].id,
          item.product_code,
          item.product_name,
          item.unit,
          item.quantity,
          item.unit_price,
          item.tax_rate,
          item.line_amount,
        ]
      );
    }
    await logEvent(client, dnQ.rows[0].id, 'issued', 'admin', req.headers['x-admin-user'] || 'basic-auth', {
      order_id: order.id,
    });
    await client.query("update orders set status = 'delivered', updated_at = now() where id = $1", [order.id]);
    await client.query('commit');

    res.json({
      ok: true,
      delivery_note_id: dnQ.rows[0].id,
      delivery_note_no: dnQ.rows[0].delivery_note_no,
      view_token: viewToken,
      view_url: `${APP_BASE_URL}/view/${viewToken}`,
      sign_url: `${APP_BASE_URL}/sign/${viewToken}`,
    });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/delivery-notes', requireAdmin, async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'where dn.status = $1';
  }
  const { rows } = await pool.query(
    `select dn.*, c.customer_code, c.name as customer_name
       from delivery_notes dn join customers c on c.id = dn.customer_id
       ${where}
      order by dn.id desc limit 200`,
    params
  );
  res.json({ ok: true, delivery_notes: rows });
});

app.get('/api/delivery-notes/:id', async (req, res) => {
  const auth = parseBasicAuth(req.headers.authorization || '');
  const isAdmin = auth && auth.user === process.env.ADMIN_BASIC_USER && auth.pass === process.env.ADMIN_BASIC_PASS;
  if (!isAdmin && req.query.public !== '1') return res.status(401).json({ ok: false, error: 'admin auth required' });
  const doc = await getDeliveryNoteFullById(req.params.id);
  if (!doc) return res.status(404).json({ ok: false, error: 'delivery note not found' });
  res.json({ ok: true, delivery_note: doc });
});

app.get('/api/delivery-notes/view/:token', async (req, res) => {
  const q = await pool.query('select id from delivery_notes where view_token = $1', [req.params.token]);
  if (!q.rowCount) return res.status(404).json({ ok: false, error: 'not found' });
  const doc = await getDeliveryNoteFullById(q.rows[0].id);
  res.json({ ok: true, delivery_note: doc });
});

app.post('/api/delivery-notes/:id/sign', async (req, res) => {
  const client = await pool.connect();
  try {
    const { received_by, signer_name, signature_data_url, token } = req.body || {};
    if (!signature_data_url) return res.status(400).json({ ok: false, error: 'signature_data_url required' });

    const dnQ = await client.query('select * from delivery_notes where id = $1', [req.params.id]);
    if (!dnQ.rowCount) return res.status(404).json({ ok: false, error: 'delivery note not found' });
    if (token && dnQ.rows[0].view_token !== token) return res.status(403).json({ ok: false, error: 'invalid token' });

    await client.query('begin');
    await client.query(
      `insert into delivery_receipts
       (delivery_note_id, received_by, signer_name, signature_data_url, signed_device, signed_ip, received_at)
       values ($1,$2,$3,$4,$5,$6,now())
       on conflict (delivery_note_id)
       do update set received_by = excluded.received_by,
                     signer_name = excluded.signer_name,
                     signature_data_url = excluded.signature_data_url,
                     signed_device = excluded.signed_device,
                     signed_ip = excluded.signed_ip,
                     received_at = now()`,
      [
        req.params.id,
        received_by || signer_name || '',
        signer_name || received_by || '',
        signature_data_url,
        req.headers['user-agent'] || '',
        req.ip,
      ]
    );
    await client.query(
      `update delivery_notes set status = 'signed', updated_at = now() where id = $1`,
      [req.params.id]
    );
    await logEvent(client, req.params.id, 'signed', token ? 'customer' : 'admin', req.ip, {
      received_by,
      signer_name,
      ip: req.ip,
    });
    await client.query('commit');
    res.json({ ok: true });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/delivery-notes/:id/receipt', async (req, res) => {
  const q = await pool.query('select * from delivery_receipts where delivery_note_id = $1', [req.params.id]);
  res.json({ ok: true, receipt: q.rows[0] || null });
});

app.get('/api/delivery-notes/:id/events', requireAdmin, async (req, res) => {
  const q = await pool.query(
    'select * from delivery_events where delivery_note_id = $1 order by id desc',
    [req.params.id]
  );
  res.json({ ok: true, events: q.rows });
});

app.get('/api/customer-portal/delivery-notes', async (req, res) => {
  const customerCode = req.query.customer_code;
  if (!customerCode) return res.status(400).json({ ok: false, error: 'customer_code required' });
  const q = await pool.query(
    `select dn.id, dn.delivery_note_no, dn.issue_date, dn.delivery_date, dn.status, dn.total_amount,
            dn.view_token, c.customer_code, c.name as customer_name
       from delivery_notes dn
       join customers c on c.id = dn.customer_id
      where c.customer_code = $1
      order by dn.id desc limit 200`,
    [customerCode]
  );
  const rows = q.rows.map((r) => ({
    ...r,
    view_url: `${APP_BASE_URL}/view/${r.view_token}`,
    sign_url: `${APP_BASE_URL}/sign/${r.view_token}`,
  }));
  res.json({ ok: true, delivery_notes: rows });
});

app.get('/api/export/delivery-notes.csv', requireAdmin, async (req, res) => {
  const from = req.query.from || '1900-01-01';
  const to = req.query.to || '2999-12-31';
  const q = await pool.query(
    `select dn.delivery_note_no, dn.issue_date, dn.delivery_date, c.customer_code, c.name as customer_name,
            i.product_code, i.product_name, i.quantity, i.unit, i.unit_price, i.line_amount, i.tax_rate
       from delivery_notes dn
       join customers c on c.id = dn.customer_id
       join delivery_note_items i on i.delivery_note_id = dn.id
      where dn.issue_date between $1 and $2
      order by dn.id desc, i.id asc`,
    [from, to]
  );
  const header = ['納品書番号','発行日','納品日','得意先コード','得意先名','商品コード','商品名','数量','単位','単価','金額','税率'];
  const lines = [header.join(',')].concat(q.rows.map((r) => [
    r.delivery_note_no, r.issue_date, r.delivery_date || '', r.customer_code, r.customer_name,
    r.product_code || '', r.product_name, r.quantity, r.unit, r.unit_price, r.line_amount, r.tax_rate,
  ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="delivery-notes.csv"');
  res.send('\uFEFF' + lines.join('\n'));
});

app.get('/api/export/billing-summary.csv', requireAdmin, async (req, res) => {
  const month = req.query.month;
  if (!month) return res.status(400).json({ ok: false, error: 'month=YYYY-MM required' });
  const q = await pool.query(
    `select to_char(date_trunc('month', dn.issue_date), 'YYYY-MM') as billing_month,
            c.customer_code, c.name as customer_name,
            count(*)::int as delivery_count,
            sum(dn.subtotal) as subtotal,
            sum(dn.tax_amount) as tax_amount,
            sum(dn.total_amount) as total_amount
       from delivery_notes dn
       join customers c on c.id = dn.customer_id
      where to_char(dn.issue_date, 'YYYY-MM') = $1
      group by 1,2,3
      order by c.customer_code`,
    [month]
  );
  const header = ['請求月','得意先コード','得意先名','納品件数','小計','税額','合計'];
  const lines = [header.join(',')].concat(q.rows.map((r) => [
    r.billing_month, r.customer_code, r.customer_name, r.delivery_count, r.subtotal, r.tax_amount, r.total_amount,
  ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="billing-summary.csv"');
  res.send('\uFEFF' + lines.join('\n'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || 'server error' });
});

app.listen(PORT, () => {
  console.log(`delivery-note-system listening on ${PORT}`);
});
