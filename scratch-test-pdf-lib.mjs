import { generateQuotationPdfBytes } from './src/lib/pdf.js';

const mockCase = {
  case_no: 'HHC-261015-00001',
  patient_name: 'Priya Verma',
  patient_age: 68,
  patient_gender: 'F',
  patient_mobile: '+91 98200 98200',
  address: 'Flat 402, Sea View Apartments, Worli',
  patient_locality: 'Worli',
  pincode: '400018',
  subtotal: 7500,
  discount_pct: 10,
  discount_amount: 750,
  total: 6750,
  created_at: '2026-10-15T10:00:00Z',
};

const mockItems = [
  { service_name: 'Complete Blood Count (CBC) with ESR', service_code: 'LAB-CBC', unit: 'per test', qty: 1, unit_price: 550, line_total: 550, price_tax_basis: 'incl_gst' },
  { service_name: 'Kidney Function Test (KFT) with Electrolytes', service_code: 'LAB-KFT', unit: 'per test', qty: 1, unit_price: 1200, line_total: 1200, price_tax_basis: 'incl_gst' },
  { service_name: 'Portable Digital Chest X-Ray at Home (Single View AP)', service_code: 'XRAY-CHEST', unit: 'per view', qty: 1, unit_price: 2250, line_total: 2250, price_tax_basis: 'incl_gst' },
  { service_name: '12-Lead ECG at Home with Clinical Cardiologist Tele-reporting', service_code: 'ECG-12', unit: 'per test', qty: 1, unit_price: 1500, line_total: 1500, price_tax_basis: 'incl_gst' },
  { service_name: 'Doctor Home Visit - Initial Assessment & Care Plan Formulation', service_code: 'VISIT-DOC', unit: 'per visit', qty: 1, unit_price: 2000, line_total: 2000, price_tax_basis: 'incl_gst' },
];

const pdfBytes = generateQuotationPdfBytes({
  k: mockCase,
  patient: null,
  items: mockItems,
  workspace: { brand_name: 'HINDUJA HOME CARE SERVICES' },
});

console.log('Quotation PDF generated successfully! Total bytes:', pdfBytes.length);
console.log('Header:', Buffer.from(pdfBytes.slice(0, 15)).toString());
console.log('Trailer:', Buffer.from(pdfBytes.slice(-30)).toString());
