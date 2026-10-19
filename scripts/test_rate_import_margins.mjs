// scripts/test_rate_import_margins.mjs
// Verifies:
// 1. docs/B2B_Provider_Rates_Template.xlsx schema and header mapping against RateCard.jsx autoMap logic
// 2. Importing via rate_import_check and submit_rate_import in demo/local PGlite environment
// 3. Margin calculations in case_margins() with real B2B buying rates, discount allocation, and reconciliation.

import fs from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';
import { PGlite } from '@electric-sql/pglite';

xlsx.set_fs(fs);

const FIELDS = [
  ['service_code', 'Service Code', ['servicecode', 'code']],
  ['service_name', 'Service Name', ['servicename', 'service', 'name', 'serviceequipmentdiagnostics', 'serviceequipment', 'item']],
  ['provider_code', 'Provider Code', ['providercode', 'provider', 'suppliercode', 'supplier']],
  ['category', 'Category', ['category', 'clinicalcategory']],
  ['unit', 'Unit', ['unit', 'uom', 'unitperdaypervisitpermonth', 'unitperdayvisitmonth']],
  ['b2b', 'B2B Rate', ['b2brate', 'b2b', 'buyingrate', 'partnerbuyingrateb2b', 'partnerbuyingrate', 'buyingrateb2b']],
  ['b2c', 'B2C Rate', ['b2crate', 'b2c', 'sellingrate', 'proposedhindujapatientprice', 'hindujapatientprice', 'patientprice', 'sellingpriceb2c', 'sellingprice']],
  ['effective_from', 'Effective From', ['effectivefrom', 'effectivedate']],
];

const normHead = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function autoMap(headers) {
  const map = {};
  for (const [k, , aliases] of FIELDS) {
    const i = headers.findIndex((h, j) => aliases.includes(normHead(h)) && !Object.values(map).includes(String(j)));
    map[k] = i >= 0 ? String(i) : '';
  }
  return map;
}

const J = (v) => JSON.stringify(v);

async function runVerification() {
  console.log('--- Step 1: Inspecting Excel Template File & Header Auto-Mapping ---');
  const templatePath = path.join(process.cwd(), 'docs', 'B2B_Provider_Rates_Template.xlsx');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found at ${templatePath}`);
  }

  const wb = xlsx.readFile(templatePath);
  console.log(`Worksheet names in template: ${wb.SheetNames.join(', ')}`);
  if (!wb.SheetNames.includes('Rates')) {
    throw new Error('Template must contain a "Rates" worksheet');
  }

  const wsRates = wb.Sheets['Rates'];
  const rawRows = xlsx.utils.sheet_to_json(wsRates, { header: 1 });
  const headers = rawRows[0];
  console.log(`Headers in 'Rates' sheet (${headers.length}):`, headers);

  const mapped = autoMap(headers);
  console.log('RateCard.jsx autoMap resolution:', mapped);

  for (const [key, label] of FIELDS) {
    if (mapped[key] === '') {
      throw new Error(`Field '${label}' (${key}) failed to auto-map from headers: ${JSON.stringify(headers)}`);
    }
    console.log(`  ✓ ${label.padEnd(16)} -> Column index ${mapped[key]} (${headers[Number(mapped[key])]})`);
  }

  const dataRows = rawRows.slice(1).filter((r) => r.length > 0 && r[0]);
  console.log(`Total data rows in template: ${dataRows.length}`);
  if (dataRows.length !== 101) {
    throw new Error(`Expected 101 services, found ${dataRows.length}`);
  }

  console.log('\n--- Step 2: Spinning up Demo/Local Database (PGlite with all migrations) ---');
  const db = new PGlite();
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of sqlFiles) {
    await db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }

  const wsId = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const provs = Object.fromEntries((await db.query(`select code, id from providers`)).rows.map((r) => [r.code, r.id]));
  console.log(`Initialized workspace HHC (${wsId}), Providers:`, Object.keys(provs));

  // Create test users
  const supId = 'c3333333-3333-4333-8333-333333333333';
  const agentId = 'c1111111-1111-4111-8111-111111111111';
  await db.query(
    `insert into profiles(id, workspace_id, full_name, role) values ($1, $2, 'Supervisor User', 'supervisor'), ($3, $2, 'Agent User', 'agent')
     on conflict (id) do nothing`,
    [supId, wsId, agentId]
  );

  async function as(user, sql, params = []) {
    await db.exec('reset role');
    const uid = user === 'sup' ? supId : agentId;
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [uid]);
    await db.exec('set role caredesk_app');
    try {
      return await db.transaction(async (tx) => (await tx.query(sql, params)).rows);
    } finally {
      await db.exec('reset role');
    }
  }

  console.log('\n--- Step 3: Preparing Import Payload with Contracted Partner B2B Rates ---');
  // Simulate populating contracted B2B buying rates: 70% of B2C for priced items, or flat ₹500 for unpriced/consumables
  const importRows = dataRows.map((r, i) => {
    const sCode = r[Number(mapped.service_code)];
    const sName = r[Number(mapped.service_name)];
    const cat = r[Number(mapped.category)];
    const unit = r[Number(mapped.unit)];
    const b2c = Number(r[Number(mapped.b2c)]) || 0;
    const pCode = r[Number(mapped.provider_code)] || 'BMM';
    const effFrom = r[Number(mapped.effective_from)] || '2026-10-19';

    // Simulate partner B2B contracted rate (e.g., 70% of B2C, or baseline for rent/equipment)
    const b2b = b2c > 0 ? (Math.round(b2c * 0.70 * 100) / 100).toFixed(2) : '350.00';

    return {
      row: i + 2,
      service_code: sCode,
      service_name: sName,
      category: cat,
      unit: unit,
      b2b: b2b,
      b2c: b2c > 0 ? String(b2c) : '0',
      provider_code: pCode,
      effective_from: effFrom,
    };
  });

  const importOptions = {
    buy_tax_basis: 'incl_gst',
    sell_tax_basis: 'incl_gst',
    effective_from: '2026-10-19',
  };

  console.log(`Prepared ${importRows.length} rows for server import preview.`);
  const [{ r: preview }] = await as(
    'sup',
    `select rate_import_check($1::jsonb, $2::jsonb) as r`,
    [J(importRows), J(importOptions)]
  );

  console.log('rate_import_check preview result:');
  console.log(`  - ok: ${preview.ok}`);
  console.log(`  - total rows: ${preview.summary.rows}`);
  console.log(`  - error rows: ${preview.summary.error_rows}`);
  console.log(`  - warning rows: ${preview.summary.warning_rows}`);
  console.log(`  - buy_new: ${preview.summary.buy_new}`);
  console.log(`  - buy_changed: ${preview.summary.buy_changed}`);
  console.log(`  - sell_unchanged: ${preview.summary.sell_unchanged}`);

  if (!preview.ok || preview.summary.error_rows > 0) {
    const errSample = preview.rows.filter((r) => r.errors?.length).slice(0, 5);
    throw new Error(`rate_import_check failed with ${preview.summary.error_rows} errors: ${JSON.stringify(errSample)}`);
  }
  console.log('✓ rate_import_check passed with ZERO errors across all 101 services!');

  console.log('\n--- Step 4: Submitting Rate Import via submit_rate_import() ---');
  const [{ r: submitRes }] = await as(
    'sup',
    `select submit_rate_import($1::jsonb, $2::jsonb, 'B2B_Provider_Rates_Template.xlsx', 'Rates') as r`,
    [J(importRows), J(importOptions)]
  );

  console.log('submit_rate_import response:', submitRes);
  if (submitRes.buying_applied !== 101) {
    throw new Error(`Expected 101 buying rates applied, got ${submitRes.buying_applied}`);
  }
  console.log(`✓ Successfully applied ${submitRes.buying_applied} B2B buying rates to provider_rates!`);

  if (submitRes.approval_id) {
    console.log(`Approving rate import approval ${submitRes.approval_id} as Hinduja client_manager...`);
    const clientId = 'c5555555-5555-4555-8555-555555555555';
    await db.query(
      `insert into profiles(id, workspace_id, full_name, role) values ($1, $2, 'Client Approver', 'client_manager') on conflict (id) do nothing`,
      [clientId, wsId]
    );
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [clientId]);
    await db.exec('set role caredesk_app');
    await db.query(`select decide_approval($1, true, 'Approved B2C selling rates')`, [submitRes.approval_id]);
    await db.exec('reset role');
    console.log('✓ Selling prices and tax basis approved and activated on rate card!');
  }

  // Verify provider_rates table count
  const [{ count: providerRateCount }] = (await db.query(`select count(*)::int as count from provider_rates where status = 'valid'`)).rows;
  console.log(`Total valid rows in provider_rates table: ${providerRateCount}`);
  if (providerRateCount !== 101) {
    throw new Error(`Expected 101 rows in provider_rates, found ${providerRateCount}`);
  }

  console.log('\n--- Step 5: Testing Margin Calculations with Live B2B Rates ---');
  // Create an enquiry with multiple items
  const [{ r: enq }] = await as('agent', `select create_enquiry($1::jsonb) as r`, [
    J({
      patient: { full_name: 'Margin Test Patient', mobile: '9820099881', address: 'Bandra West', pincode: '400050' },
      caller_name: 'Margin Test Patient',
      consent: true,
      services_requested: 'Hospital Bed + Nursing + ABPM',
    }),
  ]);
  const caseId = enq.case_id;
  console.log(`Created test case: ${caseId}`);

  // Pick 3 diverse services with selling price > 0 from different categories
  const pricedServices = (await db.query(`select id, code, name, price, unit, category from services where price > 0 order by price desc`)).rows;
  console.log(`Found ${pricedServices.length} priced services in catalogue.`);
  const testItems = [
    pricedServices.find((s) => s.category === 'beds'),
    pricedServices.find((s) => s.category === 'equipment'),
    pricedServices.find((s) => s.category === 'homecare'),
  ].filter(Boolean);

  console.log('Selected test services:');
  for (const s of testItems) {
    console.log(`  - ${s.code}: ₹${s.price} per ${s.unit} (${s.category})`);
    await as('agent', `insert into case_items (case_id, service_id, qty) values ($1, $2, 1)`, [caseId, s.id]);
  }

  // Expected calculations:
  // Each service was imported with B2B rate = round(B2C * 0.70, 2)
  const expectedNetSelling = testItems.reduce((sum, s) => sum + Number(s.price), 0);
  const expectedBuying = testItems.reduce((sum, s) => sum + Math.round(Number(s.price) * 0.70 * 100) / 100, 0);
  const expectedMargin = Math.round((expectedNetSelling - expectedBuying) * 100) / 100;
  const expectedMarginPct = Math.round((expectedMargin * 100 / expectedNetSelling) * 100) / 100;

  // Query case margins as supervisor
  const [{ r: marginsBeforeDiscount }] = await as('sup', `select case_margins($1) as r`, [caseId]);
  console.log('Case margins (before discount):');
  console.log('  Totals:', marginsBeforeDiscount.totals);
  console.log('  Lines breakdown:');
  for (const line of marginsBeforeDiscount.lines) {
    console.log(`    - ${line.service_code} (${line.provider_code}): Selling ₹${line.line_total}, Buying ₹${line.buying_total}, Margin ₹${line.margin} (${line.margin_pct}%), Basis: ${line.cost_basis}, Status: ${line.cost_status}`);
  }

  const t = marginsBeforeDiscount.totals;
  if (t.status !== 'complete') throw new Error(`Expected totals status 'complete', got '${t.status}'`);
  if (Number(t.net_selling) !== expectedNetSelling) throw new Error(`Expected net_selling ${expectedNetSelling}, got ${t.net_selling}`);
  if (Number(t.buying) !== expectedBuying) throw new Error(`Expected buying ${expectedBuying}, got ${t.buying}`);
  if (Number(t.margin) !== expectedMargin) throw new Error(`Expected margin ${expectedMargin}, got ${t.margin}`);
  if (Number(t.margin_pct) !== expectedMarginPct) throw new Error(`Expected margin_pct ${expectedMarginPct}%, got ${t.margin_pct}`);
  if (!marginsBeforeDiscount.reconciles) throw new Error('Margins do not reconcile!');

  for (const line of marginsBeforeDiscount.lines) {
    if (line.cost_basis !== 'rate') {
      throw new Error(`Expected cost_basis 'rate', got '${line.cost_basis}' on line ${line.service_code}`);
    }
    if (line.cost_status !== 'ok') {
      throw new Error(`Expected cost_status 'ok', got '${line.cost_status}' on line ${line.service_code}`);
    }
  }
  console.log('✓ Margin calculation with contracted B2B provider rates verified successfully!');

  console.log('\n--- Step 6: Testing Margin with 10% Booking Discount ---');
  await as('agent', `select advance_case($1, null)`, [caseId]);
  const [{ r: discRes }] = await as('agent', `select set_discount($1, 10, 'Special family package') as r`, [caseId]);
  console.log('Discount response:', discRes);

  const [{ r: marginsAfterDiscount }] = await as('sup', `select case_margins($1) as r`, [caseId]);
  console.log('Case margins (after 10% discount):');
  console.log('  Totals:', marginsAfterDiscount.totals);
  const expectedDiscount = Math.round(expectedNetSelling * 0.10 * 100) / 100;
  const expectedDiscountedNetSelling = expectedNetSelling - expectedDiscount;
  const expectedDiscountedMargin = Math.round((expectedDiscountedNetSelling - expectedBuying) * 100) / 100;
  const expectedDiscountedMarginPct = Math.round((expectedDiscountedMargin * 100 / expectedDiscountedNetSelling) * 100) / 100;

  const td = marginsAfterDiscount.totals;
  if (Number(td.discount) !== expectedDiscount) throw new Error(`Expected discount ${expectedDiscount}, got ${td.discount}`);
  if (Number(td.net_selling) !== expectedDiscountedNetSelling) throw new Error(`Expected net_selling ${expectedDiscountedNetSelling}, got ${td.net_selling}`);
  if (Number(td.buying) !== expectedBuying) throw new Error(`Expected buying ${expectedBuying}, got ${td.buying}`);
  if (Number(td.margin) !== expectedDiscountedMargin) throw new Error(`Expected margin ${expectedDiscountedMargin}, got ${td.margin}`);
  if (Number(td.margin_pct) !== expectedDiscountedMarginPct) throw new Error(`Expected margin_pct ${expectedDiscountedMarginPct}%, got ${td.margin_pct}`);
  if (!marginsAfterDiscount.reconciles) throw new Error('Discounted margins do not reconcile!');
  console.log('✓ Discount allocation and margin reconciliation verified to the paisa!');

  console.log('\n--- Step 7: Testing 6-Column Format (Omitted Provider and Date Columns) with File-Wide Routing ---');
  // Test importing a sheet with ONLY the 6 columns:
  // Service Code, Service Name, Clinical Category, Unit (Per Day / Per Visit / Per Month), Selling Price (B2C), Partner Buying Rate (B2B)
  // using provider_by_routing: true and effective_from: today
  const sixColRows = dataRows.slice(0, 10).map((r, i) => ({
    row: i + 2,
    service_code: r[Number(mapped.service_code)],
    service_name: r[Number(mapped.service_name)],
    category: r[Number(mapped.category)],
    unit: r[Number(mapped.unit)],
    b2b: '1200.00',
    b2c: String(r[Number(mapped.b2c)] || '0'),
  }));

  const sixColOptions = {
    buy_tax_basis: 'incl_gst',
    sell_tax_basis: 'incl_gst',
    effective_from: '2026-11-01',
    provider_by_routing: true,
  };

  const [{ r: sixColPreview }] = await as(
    'sup',
    `select rate_import_check($1::jsonb, $2::jsonb) as r`,
    [J(sixColRows), J(sixColOptions)]
  );

  console.log(`6-column format preview: ok = ${sixColPreview.ok}, error_rows = ${sixColPreview.summary.error_rows}`);
  if (!sixColPreview.ok || sixColPreview.summary.error_rows > 0) {
    throw new Error(`6-column preview failed: ${JSON.stringify(sixColPreview.file_errors || sixColPreview.rows)}`);
  }
  console.log('✓ 6-column format with provider_by_routing also verified with ZERO errors!');

  console.log('\n============================================================');
  console.log(' ALL VERIFICATION CHECKS PASSED PERFECTLY!');
  console.log('============================================================');
}

runVerification().catch((err) => {
  console.error('\n❌ Verification failed:', err);
  process.exit(1);
});
