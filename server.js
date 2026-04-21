'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 3000);

// Render の External PostgreSQL は SSL 必須になりやすい。
// Internal DB の場合も rejectUnauthorized=false で通す。
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* =========================
   Helpers
========================= */

function todayYmd() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function randomToken(len = 32) {
  return crypto.randomBytes(len).toString('hex');
}

function calcAmounts(items) {
  let subtotal = 0;
  let taxAmount = 0;

  for (const item of items) {
    const qty = Number(item.quantity || 0);
    const unitPrice = Number(item.unit_price || 0);
    const taxRate = Number(item.tax_rate ?? 8.0);

    const lineAmount = Math.round(qty * unitPrice);
    const lineTax = Math.round(lineAmount * (taxRate / 100));

    subtotal += lineAmount;
    taxAmount += lineTax;
  }

  return {
    subtotal,
    taxAmount,
    totalAmount: subtotal + taxAmount,
  };
}

async function nextSeq(prefix) {
  const ymd = todayYmd();
  const likeValue = `${prefix}-${ymd}-%`;

  const sql = `
    SELECT delivery_note_no AS no
    FROM dn_delivery_notes
    WHERE delivery_note_no LIKE $1
    UNION ALL
    SELECT order_no AS no
    FROM dn_orders
    WHERE order_no LIKE $1
  `;
  const { rows } = await pool.query(sql, [likeValue]);

  let max = 0;
  for (const r of rows) {
    const no = String(r.no || '');
    const last = no.split('-').pop();
    const n = Number(last);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return String(max + 1).padStart(4, '0');
}

async function generateOrderNo() {
  const seq = await nextSeq('DNO');
  return `DNO-${todayYmd()}-${seq}`;
}

async function generateDeliveryNoteNo() {
  const seq = await nextSeq('DND');
  return `DND-${todayYmd()}-${seq}`;
}

async function logDnEvent(client, deliveryNoteId, eventType, actorType, actorId, detail) {
  await client.query(
    `
      INSERT INTO dn_delivery_events
      (delivery_note_id, event_type, actor_type, actor_id, detail)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [deliveryNoteId, eventType, actorType, actorId || null, detail ? JSON.stringify(detail) : null]
  );
}

function badRequest(res, message) {
  return res.status(400).json({ ok: false, error: message });
}

/* =========================
   Health
========================= */

app.get('/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'db_error' });
  }
});

/* =========================
   Customers
========================= */

app.get('/api/dn/customers', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM dn_customers
      ORDER BY id DESC
    `);
    res.json({ ok: true, customers: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'customers_list_failed' });
  }
});

app.get('/api/dn/customers/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT * FROM dn_customers WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'customer_not_found' });
    res.json({ ok: true, customer: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'customer_get_failed' });
  }
});

app.post('/api/dn/customers', async (req, res) => {
  try {
    const {
      customer_code,
      name,
      contact_name,
      phone,
      email,
      zip,
      pref,
      city,
      addr1,
      addr2,
    } = req.body || {};

    if (!customer_code) return badRequest(res, 'customer_code is required');
    if (!name) return badRequest(res, 'name is required');

    const { rows } = await pool.query(
      `
        INSERT INTO dn_customers
        (customer_code, name, contact_name, phone, email, zip, pref, city, addr1, addr2)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `,
      [customer_code, name, contact_name || null, phone || null, email || null, zip || null, pref || null, city || null, addr1 || null, addr2 || null]
    );

    res.json({ ok: true, customer: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'customer_create_failed', detail: e.message });
  }
});

/* =========================
   Products
========================= */

app.get('/api/dn/products', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM dn_products
      WHERE is_active = true
      ORDER BY id DESC
    `);
    res.json({ ok: true, products: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'products_list_failed' });
  }
});

app.post('/api/dn/products', async (req, res) => {
  try {
    const {
      product_code,
      name,
      unit,
      price,
      tax_rate,
      is_active,
    } = req.body || {};

    if (!product_code) return badRequest(res, 'product_code is required');
    if (!name) return badRequest(res, 'name is required');

    const { rows } = await pool.query(
      `
        INSERT INTO dn_products
        (product_code, name, unit, price, tax_rate, is_active)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING *
      `,
      [
        product_code,
        name,
        unit || '袋',
        Number(price || 0),
        Number(tax_rate ?? 8.0),
        is_active === false ? false : true,
      ]
    );

    res.json({ ok: true, product: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'product_create_failed', detail: e.message });
  }
});

/* =========================
   Orders
========================= */

app.get('/api/dn/orders', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        o.*,
        c.name AS customer_name
      FROM dn_orders o
      JOIN dn_customers c ON c.id = o.customer_id
      ORDER BY o.id DESC
    `);
    res.json({ ok: true, orders: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'orders_list_failed' });
  }
});

app.get('/api/dn/orders/:id', async (req, res) => {
  const id = Number(req.params.id);

  try {
    const orderRes = await pool.query(
      `
        SELECT
          o.*,
          c.name AS customer_name
        FROM dn_orders o
        JOIN dn_customers c ON c.id = o.customer_id
        WHERE o.id = $1
      `,
      [id]
    );

    if (!orderRes.rows[0]) {
      return res.status(404).json({ ok: false, error: 'order_not_found' });
    }

    const itemsRes = await pool.query(
      `
        SELECT *
        FROM dn_order_items
        WHERE order_id = $1
        ORDER BY id ASC
      `,
      [id]
    );

    res.json({
      ok: true,
      order: orderRes.rows[0],
      items: itemsRes.rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'order_get_failed' });
  }
});

app.post('/api/dn/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      customer_id,
      order_date,
      delivery_date,
      memo,
      created_by,
      items,
    } = req.body || {};

    if (!customer_id) return badRequest(res, 'customer_id is required');
    if (!order_date) return badRequest(res, 'order_date is required');
    if (!Array.isArray(items) || items.length === 0) {
      return badRequest(res, 'items is required');
    }

    await client.query('BEGIN');

    const orderNo = await generateOrderNo();

    const orderInsert = await client.query(
      `
        INSERT INTO dn_orders
        (order_no, customer_id, order_date, delivery_date, status, memo, created_by)
        VALUES ($1,$2,$3,$4,'draft',$5,$6)
        RETURNING *
      `,
      [
        orderNo,
        Number(customer_id),
        order_date,
        delivery_date || null,
        memo || null,
        created_by || 'admin',
      ]
    );

    const order = orderInsert.rows[0];

    for (const item of items) {
      const qty = Number(item.quantity || 0);
      const unitPrice = Number(item.unit_price || 0);
      const taxRate = Number(item.tax_rate ?? 8.0);
      const lineAmount = Math.round(qty * unitPrice);

      await client.query(
        `
          INSERT INTO dn_order_items
          (order_id, product_id, product_code, product_name, unit, quantity, unit_price, tax_rate, line_amount)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          order.id,
          item.product_id ? Number(item.product_id) : null,
          item.product_code || null,
          item.product_name,
          item.unit || '袋',
          qty,
          unitPrice,
          taxRate,
          lineAmount,
        ]
      );
    }

    await client.query('COMMIT');

    res.json({ ok: true, order });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ ok: false, error: 'order_create_failed', detail: e.message });
  } finally {
    client.release();
  }
});

/* =========================
   Delivery Notes
========================= */

app.get('/api/dn/delivery-notes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        dn.*,
        c.name AS customer_name
      FROM dn_delivery_notes dn
      JOIN dn_customers c ON c.id = dn.customer_id
      ORDER BY dn.id DESC
    `);
    res.json({ ok: true, delivery_notes: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'delivery_notes_list_failed' });
  }
});

app.get('/api/dn/delivery-notes/:id', async (req, res) => {
  const id = Number(req.params.id);

  try {
    const noteRes = await pool.query(
      `
        SELECT
          dn.*,
          c.name AS customer_name,
          c.contact_name,
          c.phone,
          c.email,
          c.zip,
          c.pref,
          c.city,
          c.addr1,
          c.addr2
        FROM dn_delivery_notes dn
        JOIN dn_customers c ON c.id = dn.customer_id
        WHERE dn.id = $1
      `,
      [id]
    );

    if (!noteRes.rows[0]) {
      return res.status(404).json({ ok: false, error: 'delivery_note_not_found' });
    }

    const itemsRes = await pool.query(
      `
        SELECT *
        FROM dn_delivery_note_items
        WHERE delivery_note_id = $1
        ORDER BY id ASC
      `,
      [id]
    );

    const receiptRes = await pool.query(
      `
        SELECT *
        FROM dn_delivery_receipts
        WHERE delivery_note_id = $1
      `,
      [id]
    );

    const eventsRes = await pool.query(
      `
        SELECT *
        FROM dn_delivery_events
        WHERE delivery_note_id = $1
        ORDER BY id ASC
      `,
      [id]
    );

    res.json({
      ok: true,
      delivery_note: noteRes.rows[0],
      items: itemsRes.rows,
      receipt: receiptRes.rows[0] || null,
      events: eventsRes.rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'delivery_note_get_failed' });
  }
});

app.get('/api/dn/delivery-notes/view/:token', async (req, res) => {
  const token = req.params.token;

  const client = await pool.connect();
  try {
    const noteRes = await client.query(
      `
        SELECT
          dn.*,
          c.name AS customer_name,
          c.contact_name,
          c.phone,
          c.email,
          c.zip,
          c.pref,
          c.city,
          c.addr1,
          c.addr2
        FROM dn_delivery_notes dn
        JOIN dn_customers c ON c.id = dn.customer_id
        WHERE dn.view_token = $1
      `,
      [token]
    );

    if (!noteRes.rows[0]) {
      return res.status(404).json({ ok: false, error: 'delivery_note_not_found' });
    }

    const note = noteRes.rows[0];

    const itemsRes = await client.query(
      `
        SELECT *
        FROM dn_delivery_note_items
        WHERE delivery_note_id = $1
        ORDER BY id ASC
      `,
      [note.id]
    );

    const receiptRes = await client.query(
      `
        SELECT *
        FROM dn_delivery_receipts
        WHERE delivery_note_id = $1
      `,
      [note.id]
    );

    await logDnEvent(client, note.id, 'viewed', 'customer', null, { token_view: true });

    res.json({
      ok: true,
      delivery_note: note,
      items: itemsRes.rows,
      receipt: receiptRes.rows[0] || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'delivery_note_view_failed' });
  } finally {
    client.release();
  }
});

app.post('/api/dn/delivery-notes/from-order/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `
        SELECT *
        FROM dn_orders
        WHERE id = $1
      `,
      [orderId]
    );

    if (!orderRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'order_not_found' });
    }

    const order = orderRes.rows[0];

    const itemsRes = await client.query(
      `
        SELECT *
        FROM dn_order_items
        WHERE order_id = $1
        ORDER BY id ASC
      `,
      [orderId]
    );

    const items = itemsRes.rows;
    if (items.length === 0) {
      await client.query('ROLLBACK');
      return badRequest(res, 'order_items_not_found');
    }

    const { subtotal, taxAmount, totalAmount } = calcAmounts(items);
    const deliveryNoteNo = await generateDeliveryNoteNo();
    const viewToken = randomToken(16);

    const noteInsert = await client.query(
      `
        INSERT INTO dn_delivery_notes
        (
          delivery_note_no,
          order_id,
          customer_id,
          issue_date,
          delivery_date,
          status,
          subtotal,
          tax_amount,
          total_amount,
          view_token,
          memo
        )
        VALUES ($1,$2,$3,CURRENT_DATE,$4,'issued',$5,$6,$7,$8,$9)
        RETURNING *
      `,
      [
        deliveryNoteNo,
        order.id,
        order.customer_id,
        order.delivery_date || null,
        subtotal,
        taxAmount,
        totalAmount,
        viewToken,
        order.memo || null,
      ]
    );

    const note = noteInsert.rows[0];

    for (const item of items) {
      await client.query(
        `
          INSERT INTO dn_delivery_note_items
          (
            delivery_note_id,
            product_code,
            product_name,
            unit,
            quantity,
            unit_price,
            tax_rate,
            line_amount
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          note.id,
          item.product_code || null,
          item.product_name,
          item.unit || '袋',
          Number(item.quantity || 0),
          Number(item.unit_price || 0),
          Number(item.tax_rate ?? 8.0),
          Number(item.line_amount || 0),
        ]
      );
    }

    await client.query(
      `
        UPDATE dn_orders
        SET status = 'confirmed', updated_at = now()
        WHERE id = $1
      `,
      [order.id]
    );

    await logDnEvent(client, note.id, 'issued', 'admin', 'system', {
      from_order_id: order.id,
      delivery_note_no: note.delivery_note_no,
    });

    await client.query('COMMIT');

    res.json({ ok: true, delivery_note: note });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ ok: false, error: 'delivery_note_create_failed', detail: e.message });
  } finally {
    client.release();
  }
});

/* =========================
   Sign / Receipt
========================= */

app.post('/api/dn/delivery-notes/:id/sign', async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();

  try {
    const {
      received_by,
      signer_name,
      signature_data_url,
      signed_device,
      signed_ip,
    } = req.body || {};

    if (!received_by) return badRequest(res, 'received_by is required');
    if (!signer_name) return badRequest(res, 'signer_name is required');

    await client.query('BEGIN');

    const noteRes = await client.query(
      `
        SELECT *
        FROM dn_delivery_notes
        WHERE id = $1
      `,
      [id]
    );

    if (!noteRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'delivery_note_not_found' });
    }

    await client.query(
      `
        INSERT INTO dn_delivery_receipts
        (
          delivery_note_id,
          received_by,
          received_at,
          signer_name,
          signature_image_url,
          signed_device,
          signed_ip
        )
        VALUES ($1,$2,now(),$3,$4,$5,$6)
        ON CONFLICT (delivery_note_id)
        DO UPDATE SET
          received_by = EXCLUDED.received_by,
          received_at = EXCLUDED.received_at,
          signer_name = EXCLUDED.signer_name,
          signature_image_url = EXCLUDED.signature_image_url,
          signed_device = EXCLUDED.signed_device,
          signed_ip = EXCLUDED.signed_ip
      `,
      [
        id,
        received_by,
        signer_name,
        signature_data_url || null,
        signed_device || req.get('user-agent') || null,
        signed_ip || req.ip || null,
      ]
    );

    await client.query(
      `
        UPDATE dn_delivery_notes
        SET status = 'signed',
            updated_at = now()
        WHERE id = $1
      `,
      [id]
    );

    await logDnEvent(client, id, 'signed', 'customer', signer_name, {
      received_by,
    });

    await client.query('COMMIT');

    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ ok: false, error: 'sign_failed', detail: e.message });
  } finally {
    client.release();
  }
});

/* =========================
   Simple seed copy (optional)
   既存 products を壊さず dn_products へコピー
========================= */

app.post('/api/dn/seed/products-from-main', async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const src = await client.query(`
      SELECT id, name, price
      FROM products
      WHERE active = true
      ORDER BY sort_order NULLS LAST, id
    `);

    let inserted = 0;
    for (const p of src.rows) {
      const r = await client.query(
        `
          INSERT INTO dn_products
          (product_code, name, unit, price, tax_rate, is_active)
          VALUES ($1,$2,'袋',$3,8.00,true)
          ON CONFLICT (product_code) DO NOTHING
          RETURNING id
        `,
        [String(p.id), p.name, Number(p.price || 0)]
      );
      if (r.rows[0]) inserted++;
    }

    await client.query('COMMIT');
    res.json({ ok: true, inserted, total_source: src.rows.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ ok: false, error: 'seed_products_failed', detail: e.message });
  } finally {
    client.release();
  }
});

/* =========================
   Root
========================= */

app.get('/', (_req, res) => {
  res.redirect('/delivery-note.html');
});
/* =========================
   Error
========================= */

app.use((err, _req, res, _next) => {
  console.error('UNHANDLED ERROR:', err);
  res.status(500).json({ ok: false, error: 'internal_server_error' });
});

app.listen(PORT, () => {
  console.log(`dn server listening on :${PORT}`);
});