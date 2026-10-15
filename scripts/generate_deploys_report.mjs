import xlsx from 'xlsx';
import path from 'node:path';

// Deployment and topics history for HHCS CareDesk CRM
// Columns matching the user's template format:
// Changes | Assigned Date | Completion Date | Start Time | Done Time | Status | Project | Deployed By / AI Tool

const deployRecords = [
  {
    'Changes': 'Tax Invoice / Bill View & Generator (Step 6 Case 1 Billing & Payments: FinalInvoiceModal.jsx, Invoice.jsx printable route, equipment serial numbers, nursing shifts, reconciled receipts, server-side totals, A4 print styles HHCS-CL-01)',
    'Assigned Date': '15-10-2026',
    'Completion Date': '15-10-2026',
    'Start Time': '13:25',
    'Done Time': '14:45',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity (Gemini 3.8 Flash High)'
  },
  {
    'Changes': 'Medicare Field Fulfilment Portal with Live Oversight (Provider lead management, referral dispatch, status update RPCs, interim Excel sync)',
    'Assigned Date': '15-10-2026',
    'Completion Date': '15-10-2026',
    'Start Time': '13:20',
    'Done Time': '14:22',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'Book My Medicare (BMM) Connection Design & Release Authorization documentation (Security protocol, auth tokens, lead push specs)',
    'Assigned Date': '15-10-2026',
    'Completion Date': '15-10-2026',
    'Start Time': '13:00',
    'Done Time': '13:17',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'Rate Import B2B/B2C Margin Sharing & Provider Category Routing (70% HHCS / 30% SecondMedic margin share, auto-routing diagnostics to SM & care/equipment to BMM)',
    'Assigned Date': '15-10-2026',
    'Completion Date': '15-10-2026',
    'Start Time': '12:20',
    'Done Time': '13:10',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'Rate Import Marketing Price List Ingestion Engine (Automatic header matching, review table, auto-code and category suggestion for un-coded services)',
    'Assigned Date': '15-10-2026',
    'Completion Date': '15-10-2026',
    'Start Time': '11:55',
    'Done Time': '12:18',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'B2B Buying Rates per Provider, B2C Selling History, Rate Import & Approval, Case Margins Engine & MIS Report, Consumables Catalogue, Home Assessment Mode',
    'Assigned Date': '15-10-2026',
    'Completion Date': '15-10-2026',
    'Start Time': '10:35',
    'Done Time': '11:56',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'Supervisor Staff Workspaces (Audited proxy sessions with visible banner and Staff - Supervisor labels), Administrator Role (Full access, unmasked phones, staff creation), create-login Action',
    'Assigned Date': '15-10-2026',
    'Completion Date': '15-10-2026',
    'Start Time': '09:30',
    'Done Time': '10:20',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'Department & Staff Login on First Page & Settings Roster, Read RPC Infinite Loop Prevention',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '19:00',
    'Done Time': '19:59',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Claude AI'
  },
  {
    'Changes': 'Live Call Transcription Connection Resilience, Call-End Panel Layout & Legacy Durations Fix',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '19:15',
    'Done Time': '19:50',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'Gemini 3.5 Live Call Audio Transcription (gemini-3.5-transcribe-live audio streaming worklet, ephemeral tokens) & Transcript-based AI Summaries',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '18:00',
    'Done Time': '18:33',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'Settings: Departments & Staff Administration for Platform Admin & Supervisors (Staff roster, department counts, MyOperator/zone/partner columns, editing)',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '17:30',
    'Done Time': '18:03',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'AI Call Summaries Resilience & Quota Backoff (Gemini Files API upload, readable quota/billing error handling, skip calls >2h, retry sweep for failed calls)',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '16:30',
    'Done Time': '17:25',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'Assessment Checklist A4 Print Layout Fix (Form HHCS-CL-01, bedside assessment questionnaire, care plan pricing sheet)',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '15:45',
    'Done Time': '16:25',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Claude AI'
  },
  {
    'Changes': 'Discharge-to-Homecare Data Model (Journey states derived + history, partner work orders with staff IDs & equipment serials, payment schedule, data dictionary & ER diagram)',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '14:45',
    'Done Time': '15:27',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Claude AI'
  },
  {
    'Changes': 'Post-Discharge Home Care Transition SOP (Intake disposition, hospital bedside validation, item negotiation & family sign-off gate, SecondMedic & BMM split fulfilment, transition MIS)',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '13:30',
    'Done Time': '14:40',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Claude AI'
  },
  {
    'Changes': 'Automated Predictive Re-Dial & Agent Bridging for Missed Inquiries PRD & Backend Workflow Architecture Specification',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '11:30',
    'Done Time': '13:07',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'ChatGPT (OpenAI)'
  },
  {
    'Changes': 'Callbacks Auto-Dialer Engine with 30/45/60 min buffer, Agent Availability Toggle (set_my_availability), Done on Connect',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '10:00',
    'Done Time': '11:39',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Claude AI'
  },
  {
    'Changes': 'WhatsApp Bridge UI Toolbar Buttons Fix & Prominent Disconnect WhatsApp Button with Confirmation Dialog',
    'Assigned Date': '13-10-2026',
    'Completion Date': '13-10-2026',
    'Start Time': '10:15',
    'Done Time': '11:16',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Antigravity / Gemini'
  },
  {
    'Changes': 'WhatsApp Web QR Scan Pairing Login & Live Socket Chat Bridge Integration',
    'Assigned Date': '12-10-2026',
    'Completion Date': '12-10-2026',
    'Start Time': '18:00',
    'Done Time': '19:20',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Claude AI'
  },
  {
    'Changes': 'MyOperator CTI Calling Identity Lock, Fresh MyOperator Session Token on Dial, Live Call Bar for Medical Desk',
    'Assigned Date': '12-10-2026',
    'Completion Date': '12-10-2026',
    'Start Time': '17:30',
    'Done Time': '18:58',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Claude AI'
  },
  {
    'Changes': 'CRM Outbound Dialing without MyOperator Extension Requirement (Direct customer bridging via API)',
    'Assigned Date': '12-10-2026',
    'Completion Date': '12-10-2026',
    'Start Time': '13:30',
    'Done Time': '15:29',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Claude AI'
  },
  {
    'Changes': 'MyOperator Telephony Webhook Handling (v2, InCall, AfterCall), Recording Retrieval & Call-Log Sync Integration',
    'Assigned Date': '09-10-2026',
    'Completion Date': '09-10-2026',
    'Start Time': '12:00',
    'Done Time': '18:30',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'ChatGPT (OpenAI) & Core Team'
  },
  {
    'Changes': 'Book My Medicare (BMM) Lead Routing, Branch Configuration (Khar/Mahim), Lead Import from Previous CRM',
    'Assigned Date': '09-10-2026',
    'Completion Date': '09-10-2026',
    'Start Time': '14:00',
    'Done Time': '15:10',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'Claude AI & Core Team'
  },
  {
    'Changes': 'CareDesk CRM Initial Architecture, Core Database Schema, Supabase ES256 Auth & RLS Role Matrix, Cloudflare Hyperdrive Worker API Scaffolding',
    'Assigned Date': '08-10-2026',
    'Completion Date': '08-10-2026',
    'Start Time': '16:30',
    'Done Time': '20:10',
    'Status': 'Completed',
    'Project': 'HHCS CareDesk CRM',
    'Deployed By / AI Tool': 'ChatGPT (OpenAI) & Core Team'
  }
];

// Summary by Contributor / AI Engine
const summaryByAI = [
  {
    'AI Engine / Contributor': 'Antigravity (Google DeepMind / Gemini)',
    'Total Deploys': 10,
    'Core Domains & Features Handled': 'Tax Invoice & Bill View & Print Generator (HHCS-CL-01), B2B/B2C Rates & Margin Governance Engine, Rate Import Matching & Approval Workflow, Supervisor Staff Workspaces (Audited proxy sessions with visible banner), Gemini 3.5 Live Call Audio PCM Streaming & Transcription, AI Post-Call Summaries (Files API & quota backoff), BMM Connection Design Specification, Medicare Field Fulfilment Portal.'
  },
  {
    'AI Engine / Contributor': 'Claude AI (Anthropic)',
    'Total Deploys': 9,
    'Core Domains & Features Handled': 'Callbacks Auto-Dialer Engine (30/45/60 min buffer & agent availability), Post-Discharge Transition SOP, Discharge-to-Homecare Data Model (Journey states & partner work orders), Assessment Checklist A4 Form Layout (HHCS-CL-01), WhatsApp Web QR Scan Pairing Login & Chat Bridge, CTI Calling Identity Lock & Medical Desk Live Call Bar, Lead Routing by Provider Categories.'
  },
  {
    'AI Engine / Contributor': 'ChatGPT (OpenAI)',
    'Total Deploys': 3,
    'Core Domains & Features Handled': 'Automated Predictive Re-Dial & Agent Bridging PRD and Workflow Architecture, MyOperator Initial Webhook & CTI Calling Integration Patches, Foundation System Specification for Hinduja Home Care Services.'
  },
  {
    'AI Engine / Contributor': 'Core Architecture Team (secondmedic-ops)',
    'Total Deploys': 2,
    'Core Domains & Features Handled': 'Repository Scaffolding, Cloudflare Hyperdrive & Supabase Session Pooler Setup, CI/CD Pipeline Automation (SHIP.bat & GitHub Actions), Production Environment Secrets & Telephony Infrastructure.'
  }
];

// Build Workbook
const wb = xlsx.utils.book_new();

// Sheet 1: Main Deployment Log matching attached format
const ws1 = xlsx.utils.json_to_sheet(deployRecords);
// Set auto column widths
ws1['!cols'] = [
  { wch: 75 }, // Changes
  { wch: 14 }, // Assigned Date
  { wch: 16 }, // Completion Date
  { wch: 12 }, // Start Time
  { wch: 12 }, // Done Time
  { wch: 12 }, // Status
  { wch: 20 }, // Project
  { wch: 32 }  // Deployed By / AI Tool
];
xlsx.utils.book_append_sheet(wb, ws1, 'Deployment History');

// Sheet 2: Summary by AI Tool
const ws2 = xlsx.utils.json_to_sheet(summaryByAI);
ws2['!cols'] = [
  { wch: 38 }, // AI Engine
  { wch: 14 }, // Total Deploys
  { wch: 90 }  // Core Domains
];
xlsx.utils.book_append_sheet(wb, ws2, 'Summary by AI Engine');

// Write out file to docs and artifact directory
const outputPath1 = 'docs/HHCS_CareDesk_Deployments_Report.xlsx';
xlsx.writeFile(wb, outputPath1);
console.log(`Report generated successfully at: ${outputPath1}`);

const artifactPath = 'C:/Users/DELL/.gemini/antigravity/brain/15a417d3-8c14-4e2e-b948-fa6e0c1bddb7/HHCS_CareDesk_Deployments_Report.xlsx';
xlsx.writeFile(wb, artifactPath);
console.log(`Report also copied to artifact directory: ${artifactPath}`);

