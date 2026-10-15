import fs from 'node:fs';
import xlsx from 'xlsx';

// -------------------------------------------------------------
// Sheet 1: Feature Gap Analysis (Requirements vs Implementation)
// -------------------------------------------------------------
const featureMatrix = [
  {
    'Requirement ID': 'REQ-01',
    'Category': 'Operational Architecture',
    'Requirement Description': 'SecondMedic as single point of contact coordinating patients, hospital clinicians, and service partners.',
    'Status': 'Added',
    'Current Implementation in HHCS-CRM': 'Multi-role RLS (caredesk_rls.sql) with coordinator, supervisor, field_staff, medical_desk, client_clinical, and provider. Central queue and role gates.',
    'Target File(s) / Architecture for Logic': 'supabase/migrations/20261008100300_caredesk_rls.sql, src/lib/auth.jsx',
    'Technical Action Required': 'None (fully functional and operational).'
  },
  {
    'Requirement ID': 'REQ-02',
    'Category': 'Telephony & Callbacks',
    'Requirement Description': 'Missed-call follow-up automation with configurable delays (30, 45, 60 minutes) upon agent availability.',
    'Status': 'Pending',
    'Current Implementation in HHCS-CRM': 'Immediate click-to-call via MyOperator webhook with 10-minute missed-call SLA countdown timer. Call connects immediately.',
    'Target File(s) / Architecture for Logic': '1. DB Migration: Add "scheduled_for" timestamptz & "snoozed" status to callbacks table.\n2. Cloudflare Cron: cloudflare/src/services/cron.ts checks due callbacks.\n3. Frontend UI: src/pages/Callbacks.jsx adds 30/45/60 min delay dropdown.',
    'Technical Action Required': 'Implement scheduled callback queue with cron dispatcher and agent availability triggers.'
  },
  {
    'Requirement ID': 'REQ-03',
    'Category': 'Telephony & Callbacks',
    'Requirement Description': 'Track callback completion with explicit states: Call Back, Mark Done, and Unreachable.',
    'Status': 'Pending',
    'Current Implementation in HHCS-CRM': 'UI provides "Call back" (MyOperator CTI) and "Mark handled" with resolution notes. Auto-resolves after 3 attempts.',
    'Target File(s) / Architecture for Logic': '1. DB Migration: alter table callbacks add constraint callbacks_status_check check (status in (\'open\', \'in_progress\', \'resolved\', \'unreachable\', \'scheduled\'));\n2. Frontend: src/pages/Callbacks.jsx add "Mark Unreachable" and "Schedule Follow-up" buttons.',
    'Technical Action Required': 'Add Unreachable disposition button and filter tabs on /callbacks screen.'
  },
  {
    'Requirement ID': 'REQ-04',
    'Category': 'Intake & Clinical Requirements',
    'Requirement Description': 'Capture patient condition, expected discharge date, home care needs, and standardized enquiry dispositions.',
    'Status': 'Added',
    'Current Implementation in HHCS-CRM': 'Intake form in TransitionPanel records hospital, ward, room, treating doctor, expected discharge date, plan days, clinical summary, and 8 standard dispositions.',
    'Target File(s) / Architecture for Logic': 'src/pages/Transition.jsx, supabase/migrations/20261013150000_discharge_transition.sql',
    'Technical Action Required': 'None (fully functional and integrated into case pipeline).'
  },
  {
    'Requirement ID': 'REQ-05',
    'Category': 'Clinical Validation',
    'Requirement Description': 'Hospital nurse/care coordinator validates requirements with relatives, treating doctor, and ward nurses.',
    'Status': 'Added',
    'Current Implementation in HHCS-CRM': 'discharge_assessments table + schedule_validation() and record_validation() RPCs. Supports both Hospital Bedside and Home Visit checks.',
    'Target File(s) / Architecture for Logic': 'src/pages/Transition.jsx, supabase/migrations/20261015121000_home_assessment_mode.sql, src/pages/Checklist.jsx',
    'Technical Action Required': 'None (includes Form HHCS-CL-01 care plan printable checklist).'
  },
  {
    'Requirement ID': 'REQ-06',
    'Category': 'Commercials & Sign-Off',
    'Requirement Description': 'Finalize itemized services and pricing with the decision-maker; record agreed vs dropped items and obtain formal sign-off.',
    'Status': 'Added',
    'Current Implementation in HHCS-CRM': 'Care plan comparison sheet, drop categories (arranged_elsewhere, cost, not_needed, etc.), discount approvals, and record_signoff(). Releases partner leads.',
    'Target File(s) / Architecture for Logic': 'src/pages/Transition.jsx, src/pages/CaseDetail.jsx, supabase/migrations/20261013150000_discharge_transition.sql',
    'Technical Action Required': 'None (strictly gates provider routing until sign-off is logged).'
  },
  {
    'Requirement ID': 'REQ-07',
    'Category': 'Lead Routing & Partner Split',
    'Requirement Description': 'Split service delivery: SecondMedic handles diagnostics (labs, X-ray, ECG); Book My Medicare handles manpower & equipment.',
    'Status': 'Added',
    'Current Implementation in HHCS-CRM': 'Automatic split via split_case_referrals(): SM gets lab, xray, ecg; BMM gets nursing, physio, beds, eldercare, equipment, icu, consumables.',
    'Target File(s) / Architecture for Logic': 'supabase/migrations/20261009110100_providers_routing.sql, supabase/migrations/20261015120000_case1_consumables_catalogue.sql',
    'Technical Action Required': 'None (automated in PostgreSQL trigger and lead creation).'
  },
  {
    'Requirement ID': 'REQ-08',
    'Category': 'Partner Journey Tracking',
    'Requirement Description': 'Track partners through full journey (dispatched, arrival, deployed, completed). Interim Excel-based workflow for BMM.',
    'Status': 'Added',
    'Current Implementation in HHCS-CRM': 'Provider portal (/leads), deployment logging (equipment serials, staff IDs), and import_referral_updates() for two-way Excel sheet upload and sync.',
    'Target File(s) / Architecture for Logic': 'src/pages/Leads.jsx, supabase/migrations/20261013150000_discharge_transition.sql, supabase/migrations/20261013180000_discharge_data_model.sql',
    'Technical Action Required': 'None (Excel batch update and online portal both live).'
  },
  {
    'Requirement ID': 'REQ-09',
    'Category': 'Pricing & Margins Governance',
    'Requirement Description': 'Maintain both B2B buying costs and B2C selling rates; calculate gross margin while keeping costs strictly confidential.',
    'Status': 'Added',
    'Current Implementation in HHCS-CRM': 'provider_rates table (B2B), services table (B2C), GST tax basis, effective dating, case_margins and margin_report views. RLS restricts access to supervisors/coordinators.',
    'Target File(s) / Architecture for Logic': 'supabase/migrations/20261015130000_buying_rates_margins.sql, src/components/CaseMargins.jsx, src/pages/RateCard.jsx',
    'Technical Action Required': 'None (full margin engine with import and governance active).'
  },
  {
    'Requirement ID': 'REQ-10',
    'Category': 'Service Catalogue & Scripts',
    'Requirement Description': 'Comprehensive catalogue (80-90 services) with pricing, opening scripts, standardized dispositions, and WhatsApp templates.',
    'Status': 'Pending',
    'Current Implementation in HHCS-CRM': 'Call scripts (S-01, S-02, S-09), WhatsApp templates (T-01 to T-10), and 28 seed services. The full 80-90 SKU master catalogue is not yet seeded.',
    'Target File(s) / Architecture for Logic': '1. DB Migration: supabase/migrations/20261015140000_full_85_services_catalogue.sql\n2. Settings Rate Card: Ingest via Rate Card Excel Import engine.',
    'Technical Action Required': 'Populate and seed the remaining ~57 specialized healthcare SKUs across nursing, equipment, and lab tests.'
  },
  {
    'Requirement ID': 'REQ-11',
    'Category': 'Finance & Commercials',
    'Requirement Description': 'Two dedicated bank accounts for business collections (SecondMedic vs. Hinduja collections split).',
    'Status': 'Pending',
    'Current Implementation in HHCS-CRM': 'payments table records amount, mode (upi, link, card, cash), txn_ref, and receipt_no, but lacks bank destination tracking.',
    'Target File(s) / Architecture for Logic': '1. DB Migration: alter table payments add column destination_account text check (destination_account in (\'HHC_COLLECTION_A\', \'HHC_COLLECTION_B\'));\n2. Frontend UI: src/pages/CaseDetail.jsx (PaymentPanel modal).',
    'Technical Action Required': 'Add bank account selector to payment recording modal and reconciliation views.'
  },
  {
    'Requirement ID': 'REQ-12',
    'Category': 'Testing & Telephony Simulation',
    'Requirement Description': 'Simulated demo call data with missed, failed, and connected call test cases using personal and virtual numbers.',
    'Status': 'Added',
    'Current Implementation in HHCS-CRM': 'Local simulation engine (src/lib/localsim.js) and browser demo sandbox (src/demo/sim.js) supporting synthetic telephony webhooks and recordings.',
    'Target File(s) / Architecture for Logic': 'src/demo/sim.js, src/lib/localsim.js, cloudflare/src/services/myoperator.ts',
    'Technical Action Required': 'None (demo mode fully operational alongside production MyOperator CTI).'
  }
];

// -------------------------------------------------------------
// Sheet 2: Technical Implementation Roadmap for Pending Items
// -------------------------------------------------------------
const implementationRoadmap = [
  {
    'Item ID': 'GAP-01',
    'Feature': 'Configurable Callback Delays (30/45/60 min)',
    'Status': 'Pending',
    'Architecture Layer': 'Database + Backend Cron + Frontend UI',
    'Detailed Implementation Plan': '1. In `callbacks` table, add `scheduled_for` timestamptz and `delay_minutes` int.\n2. In `cloudflare/src/services/cron.ts`, add scheduled query in minute cron checking `where status = \'scheduled\' and scheduled_for <= now()` to trigger agent dispatch or push notifications.\n3. In `src/pages/Callbacks.jsx`, add delay pill buttons (+15m, +30m, +45m, +60m) that call RPC `reschedule_callback(callback_id, delay_minutes)`.',
    'Estimated Complexity': 'Medium (1.5 days)'
  },
  {
    'Item ID': 'GAP-02',
    'Feature': 'Callback Disposition: Unreachable',
    'Status': 'Pending',
    'Architecture Layer': 'PostgreSQL RPC + UI Action',
    'Detailed Implementation Plan': '1. Add RPC `mark_callback_unreachable(p_callback uuid, p_notes text)` in migration.\n2. In `src/pages/Callbacks.jsx`, add "Mark Unreachable" button next to "Mark Handled".\n3. Increment attempt count and auto-schedule next attempt if attempts < 3; close callback if attempts = 3.',
    'Estimated Complexity': 'Low (0.5 day)'
  },
  {
    'Item ID': 'GAP-03',
    'Feature': 'Full 85-Item Service Catalogue Expansion',
    'Status': 'Pending',
    'Architecture Layer': 'Database Migration / Rate Card Excel Import',
    'Detailed Implementation Plan': '1. Prepare seed migration with 85 standardized hospital services (ICU equipment, specialty nursing, rehabilitation, home diagnostics, consumables).\n2. Set baseline selling rates (B2C) and buying rates (B2B) with GST tax bases (e.g. 0% for nursing/medical care, 12% or 18% for equipment rental).\n3. Ingest directly via `submit_rate_import()` or migration.',
    'Estimated Complexity': 'Low (1 day)'
  },
  {
    'Item ID': 'GAP-04',
    'Feature': 'Two Dedicated Bank Accounts Allocation',
    'Status': 'Pending',
    'Architecture Layer': 'Database Schema + Payment Modal UI + MIS Reports',
    'Detailed Implementation Plan': '1. In `payments` table, add column `destination_account text not null default \'HHC_ACCOUNT_1\' check (destination_account in (\'HHC_ACCOUNT_1\', \'HHC_ACCOUNT_2\'))`.\n2. Update `record_payment(p_case, p_amount, p_mode, p_txn, p_account)` RPC to record destination account.\n3. In `src/pages/CaseDetail.jsx` (`PayModal`), add Bank Account radio selector: "Account 1 (Hinduja Hospital Direct)" vs "Account 2 (SecondMedic Ops Escrow)".\n4. Update MIS reconciliation reports to filter and aggregate collections by bank account.',
    'Estimated Complexity': 'Medium (1 day)'
  }
];

// -------------------------------------------------------------
// Sheet 3: Standard 85-Item Service Catalogue
// -------------------------------------------------------------
const catalogueServices = [
  // --- Diagnostics: Lab (SecondMedic) ---
  { Code: 'LAB-CBC', Name: 'Complete Blood Count (CBC)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 450, Buying_Price_INR: 250, GST_Basis: 'Exempt', TAT: '12 hrs' },
  { Code: 'LAB-LFT', Name: 'Liver Function Test (LFT)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 750, Buying_Price_INR: 420, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'LAB-KFT', Name: 'Kidney Function Test (KFT / RFT)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 800, Buying_Price_INR: 450, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'LAB-HBA1C', Name: 'HbA1c Glycated Hemoglobin', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 600, Buying_Price_INR: 350, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'LAB-LIPID', Name: 'Lipid Profile (Cholesterol & Triglycerides)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 700, Buying_Price_INR: 380, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'LAB-THY', Name: 'Thyroid Panel (Total T3, T4, TSH)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 650, Buying_Price_INR: 350, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'LAB-ELECT', Name: 'Serum Electrolytes (Na, K, Cl)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 600, Buying_Price_INR: 320, GST_Basis: 'Exempt', TAT: '12 hrs' },
  { Code: 'LAB-CRP', Name: 'C-Reactive Protein (Quantitative CRP)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 550, Buying_Price_INR: 300, GST_Basis: 'Exempt', TAT: '12 hrs' },
  { Code: 'LAB-DDIMER', Name: 'D-Dimer Test', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 1200, Buying_Price_INR: 700, GST_Basis: 'Exempt', TAT: '12 hrs' },
  { Code: 'LAB-PROCAL', Name: 'Procalcitonin (PCT) Sepsis Marker', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 2500, Buying_Price_INR: 1600, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'LAB-PTINR', Name: 'Prothrombin Time with INR (PT-INR)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 450, Buying_Price_INR: 250, GST_Basis: 'Exempt', TAT: '12 hrs' },
  { Code: 'LAB-URINE', Name: 'Urine Routine & Microscopic Examination', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 300, Buying_Price_INR: 150, GST_Basis: 'Exempt', TAT: '12 hrs' },
  { Code: 'LAB-URINEC', Name: 'Urine Culture & Antibiotic Sensitivity', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 900, Buying_Price_INR: 500, GST_Basis: 'Exempt', TAT: '48 hrs' },
  { Code: 'LAB-BLOODC', Name: 'Blood Culture & Sensitivity (Aerobic/Anaerobic)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 1400, Buying_Price_INR: 850, GST_Basis: 'Exempt', TAT: '48 hrs' },
  { Code: 'LAB-ABG', Name: 'Arterial Blood Gas Analysis (ABG Sample)', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 1100, Buying_Price_INR: 650, GST_Basis: 'Exempt', TAT: '6 hrs' },
  { Code: 'LAB-VITD', Name: 'Vitamin D 25-Hydroxy', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 1200, Buying_Price_INR: 650, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'LAB-B12', Name: 'Vitamin B12 Cyanocobalamin', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 950, Buying_Price_INR: 520, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'LAB-PANEL', Name: 'Senior Citizen Comprehensive Health Panel', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 2800, Buying_Price_INR: 1600, GST_Basis: 'Exempt', TAT: '36 hrs' },
  { Code: 'LAB-ICUPAN', Name: 'Post-ICU Transition Recovery Profile', Category: 'lab', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 3500, Buying_Price_INR: 2100, GST_Basis: 'Exempt', TAT: '24 hrs' },

  // --- Diagnostics: ECG & Imaging (SecondMedic) ---
  { Code: 'ECG-12', Name: 'ECG at Home (12-Lead Diagnostic ECG)', Category: 'ecg', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 900, Buying_Price_INR: 500, GST_Basis: 'Exempt', TAT: '4 hrs' },
  { Code: 'ECG-RPT', Name: 'Follow-up / Repeat ECG at Home', Category: 'ecg', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 650, Buying_Price_INR: 350, GST_Basis: 'Exempt', TAT: '4 hrs' },
  { Code: 'XR-CHEST', Name: 'Portable X-Ray: Chest AP / PA', Category: 'xray', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 2200, Buying_Price_INR: 1300, GST_Basis: 'Exempt', TAT: '12 hrs' },
  { Code: 'XR-LIMB', Name: 'Portable X-Ray: Upper / Lower Extremity', Category: 'xray', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 2400, Buying_Price_INR: 1450, GST_Basis: 'Exempt', TAT: '12 hrs' },
  { Code: 'XR-PELV', Name: 'Portable X-Ray: Pelvis / Hip Joint', Category: 'xray', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 2500, Buying_Price_INR: 1500, GST_Basis: 'Exempt', TAT: '12 hrs' },
  { Code: 'XR-SPINE', Name: 'Portable X-Ray: Spine (Cervical / Lumbar)', Category: 'xray', Provider: 'SecondMedic (SM)', Unit: 'test', Selling_Price_INR: 2600, Buying_Price_INR: 1600, GST_Basis: 'Exempt', TAT: '12 hrs' },

  // --- Clinical Nursing & Manpower (Book My Medicare) ---
  { Code: 'NURSE-12H', Name: 'Qualified Nurse (12-Hour Shift: Day or Night)', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'shift', Selling_Price_INR: 2000, Buying_Price_INR: 1500, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'NURSE-24H', Name: 'Qualified Nurse (24-Hour Residential Care)', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'shift', Selling_Price_INR: 3800, Buying_Price_INR: 2850, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'NURSE-ICU12', Name: 'Critical Care / ICU-Trained Nurse (12-Hour)', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'shift', Selling_Price_INR: 2500, Buying_Price_INR: 1900, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'NURSE-ICU24', Name: 'Critical Care / ICU-Trained Nurse (24-Hour)', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'shift', Selling_Price_INR: 4800, Buying_Price_INR: 3600, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'ATTEND-12H', Name: 'Trained Patient Attendant / Caretaker (12-Hour)', Category: 'eldercare', Provider: 'Book My Medicare (BMM)', Unit: 'shift', Selling_Price_INR: 1200, Buying_Price_INR: 900, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'ATTEND-24H', Name: 'Trained Patient Attendant / Caretaker (24-Hour)', Category: 'eldercare', Provider: 'Book My Medicare (BMM)', Unit: 'shift', Selling_Price_INR: 2200, Buying_Price_INR: 1650, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'NURS-VISIT', Name: 'Nurse Short Procedure Home Visit (< 1 hr)', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 650, Buying_Price_INR: 450, GST_Basis: 'Exempt', TAT: '4 hrs' },
  { Code: 'NURS-DRESS', Name: 'Surgical Wound Dressing & Care (Sterile)', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 850, Buying_Price_INR: 550, GST_Basis: 'Exempt', TAT: '6 hrs' },
  { Code: 'NURS-BEDSOR', Name: 'Bed Sore Debridement & Advanced Dressing', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 1200, Buying_Price_INR: 800, GST_Basis: 'Exempt', TAT: '6 hrs' },
  { Code: 'NURS-CATH', Name: 'Urinary Catheterization (Foley Insertion/Change)', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 900, Buying_Price_INR: 600, GST_Basis: 'Exempt', TAT: '6 hrs' },
  { Code: 'NURS-RYLE', Name: 'Nasogastric (Ryle\'s) Tube Insertion & Care', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 950, Buying_Price_INR: 650, GST_Basis: 'Exempt', TAT: '6 hrs' },
  { Code: 'NURS-TRACH', Name: 'Tracheostomy Care & Tube Suctioning', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 1100, Buying_Price_INR: 750, GST_Basis: 'Exempt', TAT: '6 hrs' },
  { Code: 'NURS-IVINF', Name: 'IV Cannula Insertion & Infusion Administration', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 750, Buying_Price_INR: 500, GST_Basis: 'Exempt', TAT: '4 hrs' },
  { Code: 'NURS-STOMA', Name: 'Colostomy / Stoma Bag Care & Training', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 1000, Buying_Price_INR: 680, GST_Basis: 'Exempt', TAT: '6 hrs' },
  { Code: 'NURS-PICCL', Name: 'PICC Line / Central Line Dressing & Heparin Flush', Category: 'nursing', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 1400, Buying_Price_INR: 950, GST_Basis: 'Exempt', TAT: '12 hrs' },

  // --- Physiotherapy & Rehabilitation (Book My Medicare) ---
  { Code: 'PHYSIO-GEN', Name: 'General Physiotherapy Session (Mobility/Gait)', Category: 'physio', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 900, Buying_Price_INR: 650, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'PHYSIO-NEU', Name: 'Neuro-Physiotherapy (Stroke / Paralysis Rehab)', Category: 'physio', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 1200, Buying_Price_INR: 850, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'PHYSIO-ORT', Name: 'Orthopedic / Post-Surgical Rehab Session', Category: 'physio', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 1000, Buying_Price_INR: 720, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'PHYSIO-RES', Name: 'Cardio-Pulmonary / Chest Physiotherapy', Category: 'physio', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 1100, Buying_Price_INR: 780, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'SPEECH-TH', Name: 'Speech & Swallowing Therapy Session', Category: 'physio', Provider: 'Book My Medicare (BMM)', Unit: 'session', Selling_Price_INR: 1300, Buying_Price_INR: 920, GST_Basis: 'Exempt', TAT: '24 hrs' },

  // --- Hospital Beds & Mattress Systems (Book My Medicare) ---
  { Code: 'BED-SEMI', Name: 'Semi-Fowler Hospital Bed with Railings (Rental)', Category: 'beds', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 180, Buying_Price_INR: 120, GST_Basis: '18% GST', TAT: '24 hrs' },
  { Code: 'BED-FOWL', Name: 'Full Fowler 2-Function Hospital Bed (Rental)', Category: 'beds', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 240, Buying_Price_INR: 160, GST_Basis: '18% GST', TAT: '24 hrs' },
  { Code: 'BED-ICU', Name: 'Motorized ICU Bed (3/5 Function with Remote)', Category: 'beds', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 450, Buying_Price_INR: 300, GST_Basis: '18% GST', TAT: '24 hrs' },
  { Code: 'AIRBED', Name: 'Alternating Pressure Bubble Air Mattress', Category: 'beds', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 80, Buying_Price_INR: 50, GST_Basis: '18% GST', TAT: '12 hrs' },
  { Code: 'TYNA-BED', Name: 'Tubular High-Risk Pressure Redistribution Bed', Category: 'beds', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 150, Buying_Price_INR: 100, GST_Basis: '18% GST', TAT: '24 hrs' },

  // --- Respiratory & Life Support Equipment (Book My Medicare) ---
  { Code: 'OXY-CONC5', Name: 'Oxygen Concentrator 5 Litre (Medical Grade)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 200, Buying_Price_INR: 130, GST_Basis: '12% GST', TAT: '6 hrs' },
  { Code: 'OXY-CONC10', Name: 'Oxygen Concentrator 10 Litre High Flow', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 380, Buying_Price_INR: 250, GST_Basis: '12% GST', TAT: '6 hrs' },
  { Code: 'OXY-CYL-D', Name: 'Oxygen Cylinder Jumbo D-Type (Bulk 46.7L)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 120, Buying_Price_INR: 75, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'OXY-CYL-B', Name: 'Oxygen Cylinder Portable B-Type (10L Refillable)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 80, Buying_Price_INR: 50, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'OXY-REFILL', Name: 'Oxygen Gas Refill (Medical Grade D-Type)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 750, Buying_Price_INR: 500, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'BIPAP-AUTO', Name: 'Auto BiPAP / CPAP Machine with Humidifier', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 320, Buying_Price_INR: 210, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'HFNC', Name: 'High-Flow Nasal Cannula (Airvo 2) System', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 1200, Buying_Price_INR: 800, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'VENT-HOME', Name: 'Home Invasive/Non-Invasive Mechanical Ventilator', Category: 'icu', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 3500, Buying_Price_INR: 2300, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'MINI-ICU', Name: 'Complete Mini-ICU Home Setup (Bed+Vent+Monitor)', Category: 'icu', Provider: 'Book My Medicare (BMM)', Unit: 'setup', Selling_Price_INR: 15000, Buying_Price_INR: 10500, GST_Basis: '18% GST', TAT: '24 hrs' },

  // --- Monitoring & Medical Devices (Book My Medicare) ---
  { Code: 'MONITOR', Name: 'Multipara Vital Signs Monitor (ECG, NIBP, SpO2, Temp)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 300, Buying_Price_INR: 190, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'SUCTION', Name: 'Electric Medical Suction Machine (Single/Dual Jar)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 120, Buying_Price_INR: 75, GST_Basis: '12% GST', TAT: '6 hrs' },
  { Code: 'SYR-PUMP', Name: 'Precision Syringe Infusion Pump (Rental)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 250, Buying_Price_INR: 160, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'VOL-PUMP', Name: 'Volumetric IV Infusion Pump (Rental)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 280, Buying_Price_INR: 180, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'NEBULIZER', Name: 'Medical Compressor Nebulizer Machine', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 60, Buying_Price_INR: 35, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'BP-MONITOR', Name: 'Digital NIBP Blood Pressure Monitor', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 50, Buying_Price_INR: 30, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'SPO2-PROBE', Name: 'Finger Pulse Oximeter with OLED Display', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 40, Buying_Price_INR: 25, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'THERMO-DIG', Name: 'Clinical Digital Thermometer', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 250, Buying_Price_INR: 160, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'GLUCOMETER', Name: 'Glucometer Device with Lancing Pen', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 950, Buying_Price_INR: 620, GST_Basis: '12% GST', TAT: '4 hrs' },

  // --- Mobility & Assistive Aids (Book My Medicare) ---
  { Code: 'WHEEL-STD', Name: 'Standard Folding Wheelchair (Rental)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 70, Buying_Price_INR: 40, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'WHEEL-COMM', Name: 'Commode Wheelchair with Removable Pan', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 90, Buying_Price_INR: 55, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'WALKER-ADJ', Name: 'Foldable Height-Adjustable Adult Walker', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 1400, Buying_Price_INR: 900, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'WALK-STICK', Name: 'Quadripod Walking Stick (Wide Base)', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 650, Buying_Price_INR: 420, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'PAT-LIFT', Name: 'Hydraulic Patient Transfer Hoist / Lift', Category: 'equipment', Provider: 'Book My Medicare (BMM)', Unit: 'day', Selling_Price_INR: 400, Buying_Price_INR: 260, GST_Basis: '18% GST', TAT: '24 hrs' },

  // --- Clinical Consumables & Patient Disposables (Book My Medicare) ---
  { Code: 'GLOVES-BOX', Name: 'Examination Gloves Box (Powder-Free, 100 pcs)', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'box', Selling_Price_INR: 450, Buying_Price_INR: 280, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'GLOVES-STER', Name: 'Surgical Sterile Gloves Pairs (Pack of 10)', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'box', Selling_Price_INR: 350, Buying_Price_INR: 220, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'FEED-SYR-60', Name: 'Catheter-Tip Feeding Syringes (60ml, Pack of 5)', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'box', Selling_Price_INR: 280, Buying_Price_INR: 170, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'SUCT-CATH', Name: 'Mucus Extractor & Suction Catheters (10 pcs)', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'box', Selling_Price_INR: 220, Buying_Price_INR: 130, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'OXY-CANNULA', Name: 'Nasal Oxygen Cannula with Twin Prong Tubing', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 150, Buying_Price_INR: 85, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'OXY-MASK', Name: 'Venturi / High-Concentration Oxygen Mask', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 240, Buying_Price_INR: 140, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'BIPAP-MASK', Name: 'Full-Face Non-Vented BiPAP Cushion Mask', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 2800, Buying_Price_INR: 1800, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'HFNC-KIT', Name: 'Optiflow Nasal Interface & Heated Breathing Tube', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 4500, Buying_Price_INR: 3100, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'VENT-CIRCUIT', Name: 'Dual-Limb Ventilator Patient Circuit with Chamber', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 1800, Buying_Price_INR: 1200, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'HME-FILTER', Name: 'Heat & Moisture Exchanger (HME) Filter Pack', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'box', Selling_Price_INR: 650, Buying_Price_INR: 400, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'FOLEY-CATH', Name: 'Silicone Foley Balloon Catheter (All Sizes)', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 320, Buying_Price_INR: 190, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'URO-BAG', Name: 'Urine Drainage Collection Bag with Anti-Reflux', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 180, Buying_Price_INR: 95, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'RYLE-TUBE', Name: 'Ryle\'s Nasogastric Feeding Tube with Guide Wire', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 220, Buying_Price_INR: 130, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'TRACH-TUBE', Name: 'Cuffed / Uncuffed Tracheostomy Tube (Shiley Type)', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 1950, Buying_Price_INR: 1300, GST_Basis: '12% GST', TAT: '12 hrs' },
  { Code: 'IV-CAN-SET', Name: 'IV Infusion Administration Set with Micro-Drip', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 140, Buying_Price_INR: 75, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'MOUTH-CHX', Name: 'Chlorhexidine Gluconate 0.2% Oral Care Rinse', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 160, Buying_Price_INR: 95, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'MOIST-CREAM', Name: 'Moisturex Soft Protective Barrier Emollient Cream', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 380, Buying_Price_INR: 240, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'CAVILON-SP', Name: '3M Cavilon No-Sting Barrier Film Spray (28ml)', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'unit', Selling_Price_INR: 1100, Buying_Price_INR: 750, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'ADULT-DIAP', Name: 'Adult Diapers Tape-Style (Pack of 10 Large)', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'box', Selling_Price_INR: 550, Buying_Price_INR: 360, GST_Basis: '12% GST', TAT: '4 hrs' },
  { Code: 'UNDER-PAD', Name: 'Super-Absorbent Bed Underpads (Pack of 10)', Category: 'consumables', Provider: 'Book My Medicare (BMM)', Unit: 'box', Selling_Price_INR: 420, Buying_Price_INR: 260, GST_Basis: '12% GST', TAT: '4 hrs' },

  // --- Home Care Coordinator & Emergency Visit Charges ---
  { Code: 'VISIT-STD', Name: 'Home Assessment & Care Coordinator Visit', Category: 'visit', Provider: 'SecondMedic (SM)', Unit: 'visit', Selling_Price_INR: 150, Buying_Price_INR: 100, GST_Basis: 'Exempt', TAT: '24 hrs' },
  { Code: 'VISIT-URG', Name: 'Urgent Express Surcharge (Arrival within 2 hrs)', Category: 'visit', Provider: 'SecondMedic (SM)', Unit: 'visit', Selling_Price_INR: 300, Buying_Price_INR: 200, GST_Basis: 'Exempt', TAT: '2 hrs' }
];

// Create Workbook
const wb = xlsx.utils.book_new();

// Sheet 1: Feature Implementation Matrix
const ws1 = xlsx.utils.json_to_sheet(featureMatrix);
xlsx.utils.book_append_sheet(wb, ws1, 'Feature Gap Analysis');

// Sheet 2: Technical Architecture Roadmap
const ws2 = xlsx.utils.json_to_sheet(implementationRoadmap);
xlsx.utils.book_append_sheet(wb, ws2, 'Implementation Roadmap');

// Sheet 3: Standard Service Catalogue (85 SKUs)
const ws3 = xlsx.utils.json_to_sheet(catalogueServices);
xlsx.utils.book_append_sheet(wb, ws3, '85 Services Catalogue');

// Write workbook to file
const outputPath = 'docs/HHCS_CRM_Feature_Matrix_and_Catalogue.xlsx';
xlsx.writeFile(wb, outputPath);
console.log(`Excel sheet generated successfully at: ${outputPath}`);
