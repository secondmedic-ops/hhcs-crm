import os
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# Output destinations
OUTPUT_FILES = [
    r'C:\Users\DELL\Documents\Today_Work_Report_2026-10-21.xlsx',
    r'C:\Users\DELL\Desktop\Today_Work_Report_2026-10-21.xlsx',
    r'C:\Users\DELL\Documents\hhcs-crm\Today_Work_Report_2026-10-21.xlsx'
]

# Work data for today: 21-10-2026
# Columns: Changes, Assigned Date, Completion Date, Start Time, Done Time, Status, Project, AI Module, Details
TODAY_DATA = [
    {
        "changes": "Optimize Supabase free-plan query budget with per-row live change notes (live_change_rows), consolidate minute cron into single SQL statement (cron_minute), update role cache with integration_only flag, and grant BMM provider logins read access to Product Knowledge for delivered categories",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "11:15",
        "done_time": "12:00",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "Claude Opus 5.5 / secondmedic-ops",
        "scope": "Commit 0105d29 (Migrations 20261021100000, 20261021100100, 20261021100200, cron.ts, Knowledge.jsx)"
    },
    {
        "changes": "Implement dedicated 'Book My Medicare' workspace portal tab at /bmm (Leads, Jobs, Products, Team), configure role-based access, and eliminate query budget drain by registering my_pending_wrapup and provider_portal as read-only RPCs in pg-adapter",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "12:10",
        "done_time": "12:52",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "Claude Opus 5.5 / secondmedic-ops",
        "scope": "Commit 1b03dd9 (BmmWorkspace.jsx, pg-adapter.js, read-rpc-sync.test.ts, Shell.jsx, auth.jsx)"
    },
    {
        "changes": "Fix payment-mode validation for sale returns against UPI or Card bills; ensure electronic refunds correctly post to UPI/Card collection accounts without breaking payment checks",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "12:20",
        "done_time": "13:08",
        "status": "Completed",
        "project": "SM-ERP",
        "ai_module": "secondmedic-ops",
        "scope": "Commits a805674 & 629456d (Billing & Payment Collections)"
    },
    {
        "changes": "Increase cron-minute PGlite migration test timeout from default 5s to 120s to ensure deterministic CI execution and prevent test timeouts on CI runners",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "12:56",
        "done_time": "13:08",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "Claude Opus 5.5 / secondmedic-ops",
        "scope": "Commit a9e520a (cloudflare/test/cron-minute.test.mjs)"
    },
    {
        "changes": "Enforce PII data protection by masking patient and doctor sensitive identification fields for non-billing roles (S1 security requirement)",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "13:10",
        "done_time": "13:29",
        "status": "Completed",
        "project": "SM-ERP",
        "ai_module": "secondmedic-ops",
        "scope": "Commit 3a0ab74 (Security & RBAC Views)"
    },
    {
        "changes": "Consolidate production worker deployment to single production domain hhcs-caredesk.secondmedichost.workers.dev and enhance scripts/cloudflare-token.mjs to automatically extract GH_REPO when multiple Git remotes are configured",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "14:15",
        "done_time": "14:43",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "Claude Opus 5.5 / secondmedic-ops",
        "scope": "Commit 1f0094c (PROJECT.md, scripts/cloudflare-token.mjs)"
    },
    {
        "changes": "Implement dedicated patient Email conversation interface at /email with Gmail SMTP integration (/api/v1/email/send), case number tagging in email subjects, awaiting-reply sidebar badge, timeline interaction logging, and responsive panel filter scrolling",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "14:40",
        "done_time": "15:05",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "secondmedic-ops",
        "scope": "Commit 8fa3fc3 (src/pages/Email.jsx, cloudflare/src/services/emailChat.ts, styles.css)"
    },
    {
        "changes": "Restrict BMM provider logins from creating or accessing non-BMM service catalog items, and implement pricing guards on service modifications and case items",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "15:55",
        "done_time": "16:42",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "secondmedic-ops",
        "scope": "Commit 62cea7c (Migration 20261021170000, data.ts, bmm-scoping.test.mjs, ProductKnowledge.jsx)"
    },
    {
        "changes": "Implement live field staff GPS breadcrumb telemetry table (staff_locations), view v_staff_locations, Actual Time of Arrival (ATA) capture, ETA-vs-ATA variance derivation (eta_vs_ata_variance_min), and 200m geofence check-in verification",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "16:45",
        "done_time": "17:12",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "secondmedic-ops",
        "scope": "Commit d1ff678 (Migration 20261021180000, field.ts, field-tracking.test.mjs, Field.jsx, MyVisits.jsx)"
    },
    {
        "changes": "Build supervisor team management panel allowing coordinators and administrators to register, manage, and assign field delivery personnel directly within BMM Team workspace",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "17:05",
        "done_time": "17:26",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "secondmedic-ops",
        "scope": "Commit 5e32a31 (admin.ts, bmm-team.test.mjs, BmmWorkspace.jsx, routes.ts)"
    },
    {
        "changes": "Add per-person location privacy switch (profiles.location_sharing), location_allowed RLS check, and automatic 1-minute background GPS telemetry transmission while an assigned job is in progress",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "17:25",
        "done_time": "17:45",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "secondmedic-ops",
        "scope": "Commit 9fbfaac (Migration 20261021190000, set_location_sharing, ProviderFulfilment.jsx, BmmWorkspace.jsx)"
    },
    {
        "changes": "Plot live field staff GPS markers directly on the Dispatch Board ZoneMap with pulsating radar indicators, technician initials badge, en-route trajectory lines to patient destinations, interactive marker popover card, filter controls (All/Staff/Visits), and Google Maps direct links in Dispatch Board & BMM Team Tracker",
        "assigned_date": "21-10-2026",
        "completion_date": "21-10-2026",
        "start_time": "19:35",
        "done_time": "19:50",
        "status": "Completed",
        "project": "HHCS CareDesk CRM",
        "ai_module": "Antigravity (Gemini 3.8 Flash)",
        "scope": "Frontend Map & Telemetry Integration (src/pages/Field.jsx, src/pages/BmmWorkspace.jsx)"
    }
]

def build_workbook():
    wb = openpyxl.Workbook()
    # Remove default sheet
    wb.remove(wb.active)

    # Styling definitions
    font_header = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    fill_header = PatternFill(fill_type="solid", start_color="1F4E78") # Professional Deep Navy
    
    font_data = Font(name="Calibri", size=11)
    font_bold = Font(name="Calibri", size=11, bold=True)
    
    fill_even = PatternFill(fill_type="solid", start_color="FFFFFF")
    fill_odd = PatternFill(fill_type="solid", start_color="F9FAFB") # Very subtle zebra light grey
    
    border_thin = Side(border_style="thin", color="D9D9D9")
    cell_border = Border(left=border_thin, right=border_thin, top=border_thin, bottom=border_thin)
    
    align_left = Alignment(horizontal="left", vertical="center")
    align_center = Alignment(horizontal="center", vertical="center")

    # ----------------------------------------------------
    # SHEET 1: Work Log (Requested Format)
    # Exact 7 columns as requested: Changes, Assigned Date, Completion Date, Start Time, Done Time, Status, Project
    # ----------------------------------------------------
    ws_main = wb.create_sheet(title="Work Log (Requested Format)")
    headers_main = ["Changes", "Assigned Date", "Completion Date", "Start Time", "Done Time", "Status", "Project"]
    
    ws_main.append(headers_main)
    ws_main.row_dimensions[1].height = 26

    for col_idx in range(1, 8):
        cell = ws_main.cell(row=1, column=col_idx)
        cell.font = font_header
        cell.fill = fill_header
        cell.alignment = align_center if col_idx in (2, 3, 4, 5, 6) else align_left
        cell.border = cell_border

    for r_idx, item in enumerate(TODAY_DATA, start=2):
        row_vals = [
            item["changes"],
            item["assigned_date"],
            item["completion_date"],
            item["start_time"],
            item["done_time"],
            item["status"],
            item["project"]
        ]
        ws_main.append(row_vals)
        ws_main.row_dimensions[r_idx].height = 24
        
        row_fill = fill_odd if r_idx % 2 == 1 else fill_even
        for col_idx in range(1, 8):
            cell = ws_main.cell(row=r_idx, column=col_idx)
            cell.font = font_data
            cell.fill = row_fill
            cell.border = cell_border
            cell.alignment = align_center if col_idx in (2, 3, 4, 5, 6) else align_left

    # Enable Excel AutoFilter
    ws_main.auto_filter.ref = f"A1:G{len(TODAY_DATA)+1}"

    # Auto-adjust column widths
    col_widths = {
        "A": 110, # Changes
        "B": 16,  # Assigned Date
        "C": 17,  # Completion Date
        "D": 13,  # Start Time
        "E": 13,  # Done Time
        "F": 14,  # Status
        "G": 22   # Project
    }
    for col_letter, width in col_widths.items():
        ws_main.column_dimensions[col_letter].width = width

    # ----------------------------------------------------
    # SHEET 2: AI_Modules_Summary
    # ----------------------------------------------------
    ws_ai = wb.create_sheet(title="AI_Modules_Summary")
    headers_ai = ["AI Module / Assistant", "Project", "Code Changes Count", "Primary Scope / Focus Area"]
    ws_ai.append(headers_ai)
    ws_ai.row_dimensions[1].height = 26
    
    for col_idx in range(1, len(headers_ai) + 1):
        cell = ws_ai.cell(row=1, column=col_idx)
        cell.font = font_header
        cell.fill = PatternFill(fill_type="solid", start_color="203764")
        cell.alignment = align_left
        cell.border = cell_border

    ai_summary_rows = [
        ["Antigravity (Gemini 3.8 Flash High)", "HHCS CareDesk CRM", 1, "Field Staff Live Map SVG plotting with radar pulse, en-route trajectory lines, popover cards & Google Maps integration"],
        ["secondmedic-ops", "HHCS CareDesk CRM", 5, "Live field geolocation & ATA tracking, BMM team management, partner location privacy switch, email chat interface & BMM service scoping"],
        ["Claude Opus 5.5 / secondmedic-ops", "HHCS CareDesk CRM", 4, "Free-plan query budget, minute cron in one SQL statement, BMM workspace tab & reload loop fix, domain consolidation"],
        ["secondmedic-ops", "SM-ERP", 2, "Sale return electronic refund to UPI/Card payment collection accounts & S1 PII masking for non-billing staff"],
    ]

    for r_idx, r_vals in enumerate(ai_summary_rows, start=2):
        ws_ai.append(r_vals)
        ws_ai.row_dimensions[r_idx].height = 22
        row_fill = fill_odd if r_idx % 2 == 1 else fill_even
        for col_idx in range(1, len(r_vals) + 1):
            cell = ws_ai.cell(row=r_idx, column=col_idx)
            cell.font = font_data
            cell.fill = row_fill
            cell.border = cell_border
            cell.alignment = align_center if col_idx == 3 else align_left

    ws_ai.column_dimensions["A"].width = 38
    ws_ai.column_dimensions["B"].width = 24
    ws_ai.column_dimensions["C"].width = 22
    ws_ai.column_dimensions["D"].width = 85

    # ----------------------------------------------------
    # SHEET 3: Project_Summary
    # ----------------------------------------------------
    ws_proj = wb.create_sheet(title="Project_Summary")
    headers_proj = ["Project", "Total Changes", "AI Modules Used", "Key Delivery Highlights Today"]
    ws_proj.append(headers_proj)
    ws_proj.row_dimensions[1].height = 26
    
    for col_idx in range(1, len(headers_proj) + 1):
        cell = ws_proj.cell(row=1, column=col_idx)
        cell.font = font_header
        cell.fill = PatternFill(fill_type="solid", start_color="2F5597")
        cell.alignment = align_left
        cell.border = cell_border

    proj_summary_rows = [
        [
            "HHCS CareDesk CRM",
            10,
            "Antigravity (Gemini 3.8 Flash), Claude Opus 5.5, secondmedic-ops",
            "Live field staff geolocation, ATA tracking, 200m geofencing, real-time map plotting with radar pulse and Google Maps integration, BMM workspace tab (/bmm), supervisor team management, partner privacy switch, email chat interface with SMTP, free-plan query budget optimization, and domain consolidation."
        ],
        [
            "SM-ERP",
            2,
            "secondmedic-ops",
            "Fixed sale returns electronic refund mode for UPI/Card collection accounts and implemented S1 PII protection masking for non-billing staff."
        ]
    ]

    for r_idx, r_vals in enumerate(proj_summary_rows, start=2):
        ws_proj.append(r_vals)
        ws_proj.row_dimensions[r_idx].height = 24
        row_fill = fill_odd if r_idx % 2 == 1 else fill_even
        for col_idx in range(1, len(r_vals) + 1):
            cell = ws_proj.cell(row=r_idx, column=col_idx)
            cell.font = font_data
            cell.fill = row_fill
            cell.border = cell_border
            cell.alignment = align_center if col_idx == 2 else align_left

    ws_proj.column_dimensions["A"].width = 24
    ws_proj.column_dimensions["B"].width = 16
    ws_proj.column_dimensions["C"].width = 38
    ws_proj.column_dimensions["D"].width = 95

    # ----------------------------------------------------
    # SHEET 4: Detailed_Scope_and_Commits
    # ----------------------------------------------------
    ws_detail = wb.create_sheet(title="Detailed_Scope_and_Commits")
    headers_detail = ["ID", "Project", "Time Window", "Changes Title", "Scope / Commits / Files", "Status"]
    ws_detail.append(headers_detail)
    ws_detail.row_dimensions[1].height = 26

    for col_idx in range(1, len(headers_detail) + 1):
        cell = ws_detail.cell(row=1, column=col_idx)
        cell.font = font_header
        cell.fill = PatternFill(fill_type="solid", start_color="1F4E78")
        cell.alignment = align_left
        cell.border = cell_border

    for idx, item in enumerate(TODAY_DATA, start=1):
        r_idx = idx + 1
        row_vals = [
            f"CHG-20261021-{idx:02d}",
            item["project"],
            f"{item['start_time']} - {item['done_time']}",
            item["changes"],
            item["scope"],
            item["status"]
        ]
        ws_detail.append(row_vals)
        ws_detail.row_dimensions[r_idx].height = 24
        row_fill = fill_odd if r_idx % 2 == 1 else fill_even
        for col_idx in range(1, len(row_vals) + 1):
            cell = ws_detail.cell(row=r_idx, column=col_idx)
            cell.font = font_data
            cell.fill = row_fill
            cell.border = cell_border
            cell.alignment = align_center if col_idx in (1, 3, 6) else align_left

    ws_detail.column_dimensions["A"].width = 20
    ws_detail.column_dimensions["B"].width = 22
    ws_detail.column_dimensions["C"].width = 18
    ws_detail.column_dimensions["D"].width = 85
    ws_detail.column_dimensions["E"].width = 65
    ws_detail.column_dimensions["F"].width = 14

    return wb

if __name__ == '__main__':
    wb = build_workbook()
    for path in OUTPUT_FILES:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            wb.save(path)
            print(f"Successfully generated: {path}")
        except Exception as e:
            print(f"Error saving to {path}: {e}")
