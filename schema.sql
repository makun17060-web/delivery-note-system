create extension if not exists pgcrypto;

create table if not exists customers (
  id bigserial primary key,
  customer_code text unique not null,
  name text not null,
  contact_name text,
  phone text,
  email text,
  zip text,
  pref text,
  city text,
  addr1 text,
  addr2 text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists products (
  id bigserial primary key,
  product_code text unique not null,
  name text not null,
  unit text not null default '袋',
  price numeric(10,2) not null default 0,
  tax_rate numeric(5,2) not null default 8.00,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id bigserial primary key,
  order_no text unique not null,
  customer_id bigint not null references customers(id),
  order_date date not null,
  delivery_date date,
  status text not null default 'draft',
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_items (
  id bigserial primary key,
  order_id bigint not null references orders(id) on delete cascade,
  product_id bigint references products(id),
  product_code text,
  product_name text not null,
  unit text not null default '袋',
  quantity numeric(10,2) not null default 0,
  unit_price numeric(10,2) not null default 0,
  tax_rate numeric(5,2) not null default 8.00,
  line_amount numeric(12,2) not null default 0
);

create table if not exists delivery_notes (
  id bigserial primary key,
  delivery_note_no text unique not null,
  order_id bigint references orders(id),
  customer_id bigint not null references customers(id),
  issue_date date not null,
  delivery_date date,
  status text not null default 'issued',
  subtotal numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  view_token text unique not null,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists delivery_note_items (
  id bigserial primary key,
  delivery_note_id bigint not null references delivery_notes(id) on delete cascade,
  product_code text,
  product_name text not null,
  unit text not null default '袋',
  quantity numeric(10,2) not null default 0,
  unit_price numeric(10,2) not null default 0,
  tax_rate numeric(5,2) not null default 8.00,
  line_amount numeric(12,2) not null default 0
);

create table if not exists delivery_receipts (
  id bigserial primary key,
  delivery_note_id bigint not null unique references delivery_notes(id) on delete cascade,
  received_by text,
  signer_name text,
  signature_data_url text,
  signed_device text,
  signed_ip text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists delivery_events (
  id bigserial primary key,
  delivery_note_id bigint not null references delivery_notes(id) on delete cascade,
  event_type text not null,
  actor_type text not null,
  actor_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_orders_customer_id on orders(customer_id);
create index if not exists idx_delivery_notes_customer_id on delivery_notes(customer_id);
create index if not exists idx_delivery_notes_view_token on delivery_notes(view_token);
create index if not exists idx_delivery_events_delivery_note_id on delivery_events(delivery_note_id);

insert into customers (customer_code, name, contact_name, phone, email, pref, city, addr1)
values
  ('TOKU001', 'サンプル商店', '山田 太郎', '090-1111-2222', 'sample@example.com', '愛知県', '武豊町', '1-2-3')
on conflict (customer_code) do nothing;

insert into products (product_code, name, unit, price, tax_rate)
values
  ('EBI001', '手造りえびせんべい', '袋', 250, 8.00),
  ('SET001', '磯屋オリジナルセット', 'セット', 2100, 8.00)
on conflict (product_code) do nothing;
