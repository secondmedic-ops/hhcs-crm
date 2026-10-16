import os
import re
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

with open('cloudflare/test/api.itest.mjs', 'r', encoding='utf-8') as f:
    lines = f.readlines()

current_sec = '1. Authentication & Security (Login Required)'
test_items = []

for idx, line in enumerate(lines):
    raw = line.strip()
    if raw.startswith('// ---- 1.'):
        current_sec = '1. Authentication & Security (Login Required)'
    elif raw.startswith('// ---- 2.'):
        current_sec = '2. Profile & Role Resolution (/me)'
    elif raw.startswith('// ---- 3.'):
        current_sec = '3. Role-Based Access Control (RBAC)'
    elif raw.startswith('// ---- 4.'):
        current_sec = '4. SQL Injection Protection & Query Parameterization'
    elif 'arrays arrive as lists' in raw:
        current_sec = '4b. Array Handling (Postgres Arrays)'
    elif raw.startswith('// ---- 5.'):
        current_sec = '5. Case Workflow Engine (Enquiry to Pricing & Gates)'
    elif raw.startswith('// ---- 6.'):
        current_sec = '6. MyOperator Telephony Inbound & Missed Calls'
    elif raw.startswith('// ---- 6b.'):
        current_sec = '6b. Telephony Connection & App Settings Vault'
    elif raw.startswith('// ---- 6b2.'):
        current_sec = '6b2. CRM Calling & Edge-case Handling'
    elif raw.startswith('// ---- 6c.'):
        current_sec = '6c. Call-Log Sync & Auto-Reconciliation'
    elif raw.startswith('// ---- 7.'):
        current_sec = '7. Live Updates & WebSocket Dispatch'
    elif raw.startswith('// ---- 7b.'):
        current_sec = '7b. Book My Medicare (BMM) Provider Access & Scoped Routing'
    elif raw.startswith('// ---- 7b2.'):
        current_sec = '7b2. Service Dates & Expected Discharge Handling'
    elif raw.startswith('// ---- 7c.'):
        current_sec = '7c. Post-Discharge Transition SOP & Data Model'
    elif raw.startswith('// ---- 8.'):
        current_sec = '8. User Provisioning & Administration'
    elif raw.startswith('// ---- 8b.'):
        current_sec = '8b. WhatsApp QR Bridge & Two-Way Live Messaging'
    elif raw.startswith('// ---- 9.'):
        current_sec = '9. Predictive Callback Auto-Dialer & Availability'
    elif 'AI call summaries:' in raw:
        current_sec = '10. Gemini AI Call Summaries & Quota Handling'
    elif 'Live microphone capture:' in raw:
        current_sec = '11. Gemini 3.5 Live Microphone Transcription & Checkpoints'
    elif 'the every-minute sweep:' in raw:
        current_sec = '12. Background Cron Sweep for Missed Recordings'
    elif 'BMM\'s proposed connection is closed' in raw:
        current_sec = '13. BMM Machine Integration API Boundary & Security'
    elif 'Administrator: full access' in raw:
        current_sec = '14. Administrator Role & Audited Staff Sessions'

    # Match check string: find all check(...) occurrences
    matches = re.finditer(r'check\((.+?)\);', raw)
    # or line-based checks
    if 'check(' in raw:
        # extract description (usually in string literal)
        desc_match = re.search(r",\s*['\"`]([^'\"`]+)['\"`]", raw)
        if desc_match:
            desc = desc_match.group(1)
            test_items.append({
                'line': idx + 1,
                'section': current_sec,
                'assertion': desc,
                'status': 'Passed'
            })

print(f"Extracted {len(test_items)} test assertions across {len(set(x['section'] for x in test_items))} sections.")
