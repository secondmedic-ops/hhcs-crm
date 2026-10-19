// scripts/export_provider_rate_template.mjs
// Generates docs/B2B_Provider_Rates_Template.xlsx containing all 101 services from the seed/database,
// matching the schema required by submit_rate_import() in cloudflare/src/services/data.ts.

import fs from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';
import { PGlite } from '@electric-sql/pglite';

xlsx.set_fs(fs);

const CAT_LABELS = {
  lab: 'Sample collection',
  xray: 'Portable X-ray',
  ecg: 'ECG at home',
  visit: 'Visit charges',
  nursing: 'Nursing',
  physio: 'Physiotherapy',
  beds: 'Hospital beds',
  eldercare: 'Elder care',
  homecare: 'Other home care',
  equipment: 'Equipment',
  icu: 'ICU setup',
  consumables: 'Consumables',
  other: 'Other'
};

const DEFAULT_PROVIDERS = {
  lab: 'SM',
  xray: 'SM',
  ecg: 'SM',
  visit: 'SM',
  // All other clinical categories route to Book My Medicare (BMM)
  beds: 'BMM',
  equipment: 'BMM',
  nursing: 'BMM',
  physio: 'BMM',
  eldercare: 'BMM',
  icu: 'BMM',
  consumables: 'BMM',
  homecare: 'BMM',
  other: 'BMM',
};

// Current date in IST (UTC+5:30)
function istDateStr(daysAhead = 0) {
  const d = new Date(Date.now() + 5.5 * 3600e3 + daysAhead * 86400e3);
  return d.toISOString().slice(0, 10);
}

export async function loadCatalogueFromMigrations() {
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
  const db = new PGlite();
  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of sqlFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await db.exec(sql);
  }
  const result = await db.query(
    `select code, name, category, unit, price, tax_basis, active from services order by category, code`
  );
  return result.rows;
}

export async function generateProviderRateTemplate(options = {}) {
  const outPath = options.outPath || path.join(process.cwd(), 'docs', 'B2B_Provider_Rates_Template.xlsx');
  const today = options.effectiveDate || istDateStr(0);

  const services = await loadCatalogueFromMigrations();
  if (services.length === 0) {
    throw new Error('No services found in database migrations.');
  }

  // Ensure target directory exists
  const targetDir = path.dirname(outPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 1. Prepare main 'Rates' sheet data
  // Columns requested:
  // Service Code, Service Name, Clinical Category, Unit (Per Day / Per Visit / Per Month), Selling Price (B2C), Partner Buying Rate (B2B), Provider Code, Effective From
  const rateRows = services.map((s) => ({
    'Service Code': s.code,
    'Service Name': s.name,
    'Clinical Category': CAT_LABELS[s.category] || s.category,
    'Unit (Per Day / Per Visit / Per Month)': s.unit,
    'Selling Price (B2C)': Number(s.price),
    'Partner Buying Rate (B2B)': '', // Left editable for partner / commercial ops to fill
    'Provider Code': DEFAULT_PROVIDERS[s.category] || 'BMM',
    'Effective From': today,
  }));

  const wb = xlsx.utils.book_new();

  // Create Rates worksheet
  const wsRates = xlsx.utils.json_to_sheet(rateRows);
  wsRates['!cols'] = [
    { wch: 28 }, // Service Code
    { wch: 42 }, // Service Name
    { wch: 20 }, // Clinical Category
    { wch: 34 }, // Unit (Per Day / Per Visit / Per Month)
    { wch: 20 }, // Selling Price (B2C)
    { wch: 26 }, // Partner Buying Rate (B2B)
    { wch: 15 }, // Provider Code
    { wch: 16 }, // Effective From
  ];

  xlsx.utils.book_append_sheet(wb, wsRates, 'Rates');

  // 2. Instructions Sheet
  const instructions = [
    ['Field / Column', 'Format / Rule', 'Detailed Description'],
    ['Service Code', 'Alphanumeric Code (e.g. BED-ICU-PARAMOUNT-AB5)', 'Exact rate-card code from the Hinduja Home Care Services catalogue (101 services). Do not modify codes.'],
    ['Service Name', 'Text', 'Standard clinical service or rental equipment name. Provided for readability.'],
    ['Clinical Category', 'Text (e.g. Hospital beds, Nursing, Equipment)', 'Clinical discipline for case routing and categorisation.'],
    ['Unit (Per Day / Per Visit / Per Month)', 'Text (e.g. month, day, 12 hours, visit, unit)', 'Billing unit of measure. Buying rates apply to this exact unit without conversion.'],
    ['Selling Price (B2C)', 'Rupees (Numeric)', 'Approved patient tariff agreed with Hinduja Hospital. Selling changes require Hinduja management sign-off.'],
    ['Partner Buying Rate (B2B)', 'Rupees (Numeric, e.g. 3850.00)', 'What SecondMedic pays the partner per unit. Enter the contracted rate. Leave blank to apply default share (70% of B2C).'],
    ['Provider Code', 'SM or BMM', 'SM = SecondMedic (Diagnostics, Lab, Portable X-ray, ECG, Visit). BMM = Book My Medicare (Beds, Equipment, Nursing, Eldercare, ICU, etc.).'],
    ['Effective From', 'YYYY-MM-DD or DD-MM-YYYY', 'Date from which the partner buying rate takes effect. Defaults to today.'],
    ['GST Basis', 'Specified during UI Import', 'In Settings > Rate Card, select whether buying/selling rates include GST (Includes GST, GST extra, or No GST).'],
  ];
  const wsInstructions = xlsx.utils.aoa_to_sheet(instructions);
  wsInstructions['!cols'] = [{ wch: 36 }, { wch: 38 }, { wch: 80 }];
  xlsx.utils.book_append_sheet(wb, wsInstructions, 'Instructions');

  // 3. Providers Sheet
  const providers = [
    { 'Provider Code': 'BMM', 'Provider Name': 'Book My Medicare', 'Active': 'Yes', 'Covered Categories': 'Hospital beds, Equipment, Nursing, Physiotherapy, Elder care, ICU setup, Consumables, Other home care' },
    { 'Provider Code': 'SM', 'Provider Name': 'SecondMedic', 'Active': 'Yes', 'Covered Categories': 'Sample collection (Lab tests), Portable X-ray, ECG at home, Visit charges' }
  ];
  const wsProviders = xlsx.utils.json_to_sheet(providers);
  wsProviders['!cols'] = [{ wch: 16 }, { wch: 24 }, { wch: 10 }, { wch: 75 }];
  xlsx.utils.book_append_sheet(wb, wsProviders, 'Providers');

  // 4. Clinical Categories Sheet
  const categoriesList = Object.entries(CAT_LABELS).map(([code, label]) => ({
    'Category Key': code,
    'Clinical Display Label': label,
    'Default Fulfilment Partner': DEFAULT_PROVIDERS[code] || 'BMM'
  }));
  const wsCategories = xlsx.utils.json_to_sheet(categoriesList);
  wsCategories['!cols'] = [{ wch: 18 }, { wch: 26 }, { wch: 26 }];
  xlsx.utils.book_append_sheet(wb, wsCategories, 'Categories');

  // Write file
  xlsx.writeFile(wb, outPath);

  const stats = fs.statSync(outPath);
  return {
    outPath,
    totalServices: services.length,
    fileSizeKB: Math.round(stats.size / 1024),
    categories: [...new Set(services.map((s) => s.category))],
  };
}

// Run as script
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  console.log('CareDesk CRM: Exporting B2B Provider Rates Template...');
  generateProviderRateTemplate()
    .then((res) => {
      console.log(`Successfully generated template: ${res.outPath}`);
      console.log(`Total services exported: ${res.totalServices}`);
      console.log(`Distinct clinical categories: ${res.categories.length}`);
      console.log(`File size: ${res.fileSizeKB} KB`);
    })
    .catch((err) => {
      console.error('Failed to generate template:', err);
      process.exit(1);
    });
}

