# CareDesk CRM — Test Accounts & Logins

This document lists test accounts configured in demo and local test environments for Hinduja Home Care Services (CareDesk CRM).
Do not share customer or patient credentials here.

## 1. Field Staff Roles (Mobile OTP & App Login)

Field staff can sign in using **Mobile OTP** with their 10-digit registered number.
In demo/local mode, the test verification OTP is `123456`.
Field staff access is strictly scoped under DPDP Act 2023: technicians can view and update **only** the cases and tasks assigned to them.

| Role | Name | Mobile (OTP) | Email | Skills | Covered Area & Pincodes | Shift |
|---|---|---|---|---|---|---|
| `phlebotomist` | Pritesh Sonawane | `+91 98200 00021` | `pritesh.phlebo@demo.local` | `phlebotomy` | South Mumbai (`400001`, `400005`, `400020`) | 07:00 – 15:00 IST |
| `nurse` | Sunita D'Souza | `+91 98200 00022` | `sunita.nurse@demo.local` | `nursing`, `injections`, `wound_dressing` | Bandra – Khar (`400050`, `400052`) | 08:00 – 16:00 IST |
| `physiotherapist` | Dr. Rajesh Varma (PT) | `+91 98200 00023` | `rajesh.physio@demo.local` | `physio`, `rehabilitation` | Andheri – Juhu (`400053`, `400058`) | 09:00 – 17:00 IST |
| `icu_nurse` | Anthony Paul | `+91 98200 00024` | `anthony.icu@demo.local` | `icu_care`, `nursing`, `ventilator` | Dadar – Prabhadevi (`400025`, `400028`) | 08:00 – 20:00 IST |
| `eldercare_attendant` | Ramesh Kamble | `+91 98200 00025` | `ramesh.eldercare@demo.local` | `eldercare`, `patient_mobility` | Mahim – Matunga (`400016`, `400019`) | 08:00 – 20:00 IST |
| `delivery_executive` | Nilesh Shinde | `+91 98200 00026` | `nilesh.delivery@demo.local` | `delivery`, `pickup` | Western Suburbs (`400050`, `400058`) | 08:00 – 18:00 IST |
| `doctor` | Dr. Kavita Raman | `+91 98200 00027` | `dr.kavita@demo.local` | `doctor_visit`, `teleconsult` | Greater Mumbai (`400001`, `400050`) | 10:00 – 18:00 IST |
| `field_staff` (general) | Santosh Jadhav | `+91 98000 00107` | `santosh.field@demo.local` | `phlebotomy` | Andheri (`400058`) | 08:00 – 17:00 IST |

Default password for password-based login for all demo field accounts: `HindujaCare#2026!`

---

## 2. Back-Office Roles (Email & Password Login)

Back-office staff authenticate via corporate email and password, with optional TOTP MFA.

| Role | Name | Email | Default Password | Extension / Agent Code | Scope / Permissions |
|---|---|---|---|---|---|
| `coordinator` | Farhan Shaikh | `farhan.coord@demo.local` | `HindujaCare#2026!` | `COORD-01` | Cases, assign/reassign, field dispatch, callbacks |
| `telecaller` | Pooja Sharma | `pooja.telecaller@demo.local` | `HindujaCare#2026!` | `TC-01` (MyOperator `5010`) | Calling queues, enquiries, callbacks |
| `lab_staff` | Vikas More | `vikas.lab@demo.local` | `HindujaCare#2026!` | `LAB-01` | Sample handover, custody tracking, test status |
| `accounts` | Sandeep Nair | `sandeep.accounts@demo.local` | `HindujaCare#2026!` | `ACC-01` | Payments, receipts, billing & reconciliation only (cannot assign staff) |
| `supervisor` | Meera Iyer | `meera.sup@demo.local` | `HindujaCare#2026!` | `SUP-01` | Operational oversight, staff clash overrides, escalation |
| `admin` | Platform Admin | `admin@secondmedic.demo` | `HindujaCare#2026!` | `ADM-01` | Staff & Logins administration, roles, skills, rate cards |

