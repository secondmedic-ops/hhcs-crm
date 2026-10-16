# Buying rates, selling rates and booking margins

Migration `20261015130000_buying_rates_margins.sql`. Screens: `src/pages/RateCard.jsx` (Settings > Rate card), `src/components/CaseMargins.jsx` (case page, under Services & quote), `src/components/MarginReport.jsx` (MIS reports > Margins). Tests: `cloudflare/test/rates.test.mjs` (SQL, per role) and `rates.itest.mjs` (through the Worker, run by the rehearsal).

## Terms

- **B2C selling rate**: what the patient pays per unit. It is the existing locked rate card (`services.price`). It changes only through a Hinduja approval (`decide_approval`, approver `client_manager`), as before.
- **B2B buying rate**: what SecondMedic pays a provider per unit (`provider_rates`). It can differ by provider for the same service.
- **Unit**: the rate-card unit of the service (shift, day, month, visit, 12 hours, ...). A buying rate is stored against the unit the service had when the rate was set. Units are compared after trimming, lower-casing and dropping a leading "per" ("Per day" = "day"). Nothing is ever converted: a day rate is not a shift rate, a month rate is not 30 day rates.
- **GST basis**: `incl_gst`, `excl_gst` or `no_gst`, on every buying rate and on the selling price (`services.tax_basis`, null = not confirmed). The importer never assumes it. A margin is computed only when the line's buying and selling bases are equal.
- **Gross margin** = net selling value (after the customer discount) − buying total. It is a projection before collections and refunds. It is not profit or cash received.

## Who sees what

| | Selling rates | Buying rates | Import rates | Booking costs and margins | MIS > Margins |
|---|---|---|---|---|---|
| supervisor (SecondMedic) | read, request change | read, set, end | yes | read; amend after agreement (with reason) | yes |
| coordinator (SecondMedic) | read | read | no | read (cases they can see); choose provider on drafts | yes |
| admin (platform) | read, request change | read, set, end | yes | **no** (no patient data) | no |
| administrator | as supervisor | as supervisor | yes | as supervisor | yes |
| client_manager (Hinduja) | read; **approves** selling changes | no | no | no | no |
| agent, field staff, medical desk, client_clinical, provider | read (provider: the card, not its history) | no | no | no | no |

Enforced in three places: RLS on the tables, role checks inside every function, and `READ` / `RPC` in `services/data.ts`. Booking costs are not a readable table through the API at all (`case_item_costs` is not in `READ`); they come only from `case_margins()` and `margin_report()`. Buying rates never enter `case_items`, `v_cases`, the audit log (readable by Hinduja), the timeline, quote templates, WhatsApp, partner exports, the BMM API or `mis_report()`. The Hinduja approval request carries selling prices only.

Hinduja management has no access to costs or margins. Extending it needs a business decision first.

## Settings > Rate card

- **Selling rates (B2C)**: the locked card with unit, GST basis, version, approved selling prices that start later, and price change requests (single change and import).
- **Buying rates (B2B)**: per provider and service, with from / to dates and state (in force, starts later, ended, replaced). *Set buying rate* adds a version. The version before it ends the day the new one starts. A version on the same start date replaces that row, which is kept as `replaced`. Two valid rates for the same provider, service and unit never cover the same day (deferred constraint trigger).
- **Import rates**: see below.

## Import rates

1. *Download template*: sheets Rates (Service Code, Service Name, Provider Code, Category, Unit, B2B Rate, B2C Rate, Effective From), Instructions, Rate card (current codes and units) and Providers.
2. Choose an .xlsx or .csv file, the worksheet and the header row, and match each field to a column (template headings, and the marketing sheet's "Service/ Equipment Diagnostics" and "Proposed Hinduja Patient Price", are matched automatically; anything else is chosen by hand. A provider's "BMM B2C / Listed Tariff" is never matched to B2C). Choose the GST basis for the B2B column and for the B2C column. Optionally choose one effective date and one provider for rows that leave them blank.
   - **B2B = % of B2C** (migration `20261015140000_rate_import_derived_buying.sql`): rows with a B2C rate and an empty B2B cell get B2B = round(B2C × % / 100, 2), computed on the server; the preview marks them "70% of B2C". An explicit B2B in the file always wins. HHCS rule (Oct 2026): **70**, i.e. the provider is paid 70% of the patient price and SecondMedic keeps its 30% agreed share. The rule is kept in `rate_imports.options`.
   - **Provider: By category (as case routing)**: rows without a provider code get the one active provider whose routing categories cover the service category: lab, X-ray, ECG and visit to SecondMedic (SM), everything else to Book My Medicare (BMM). BMM also takes category `other` (for example ambulance) since that migration.
3. *Check file* calls `rate_import_check()`. It is read-only and validates on the server:
   - Service by exact code (or an explicit choice). Similar names are never matched. A row with an unknown code, or no code at all (a sheet such as the marketing price list), must be resolved: choose the rate-card service on the row (*Resolve*), or confirm it as a new service. *Review N as new services* lists them all, one line per service (same code, or same name and unit), with a suggested code (from the name, plus the unit when the name appears with several units) and a suggested category (from the file's category column, else from the name) to check and edit. Nothing is added until the import is submitted.
   - Provider by exact code (or an explicit choice). It is required for every B2B rate. Inactive and unknown providers are refused.
   - Unit must equal the rate-card unit.
   - Amounts: blank = not given; `0` = zero (warned); negatives, text, spreadsheet errors (`#N/A`, `#REF!`, ...), more than 2 decimals and amounts over 99,99,999.99 are refused. `₹`, `Rs`, `INR` and thousands commas are accepted.
   - Effective From is `YYYY-MM-DD` or `DD-MM-YYYY` (also `/` or `.`), from 2020 up to one year ahead. Back-dated rates are warned: bookings already made keep their cost.
   - Across rows: duplicate provider rows (same service, provider and date), different B2C rates or dates for the same service on different supplier rows, and a new service defined differently on two rows are all refused. A B2C rate below a B2B rate is a warning only.
   - Selling changes are refused while the same service already has a selling change awaiting approval.
   The preview shows old and new B2B and B2C per row (new / changed / unchanged), row errors and warnings, and a downloadable check report (.xlsx).
4. *Submit* calls `submit_rate_import()`. It validates again and refuses the whole file on any error. Otherwise, in one transaction, it:
   - adds the new services, inactive at price 0;
   - saves the buying rates, each from its own date;
   - sends every selling change to Hinduja management as **one** `rate_import` approval.
   The same content again (any file name) returns the first import and applies nothing. The key covers the submitted rows and the file-wide choices, so a retry is still recognised after its new services exist. Two simultaneous submissions of the same content: the second one reports the first.
5. Approval (Approvals page): all selling changes apply together, or none if a price moved after the import was submitted (the approver then rejects and the file is imported again). A price dated today or earlier applies at once. A later date is `scheduled` in `service_price_history` and activated by the minute cron (`activate_due_prices()`), which also makes a new service quotable.

State in `rate_imports`: `buy_status` none / applied; `sell_status` none / awaiting_approval / approved / rejected. A rejected import leaves its buying rates and inactive new services in place. Resubmitting the same file then sends only the selling changes again.

## Booking snapshots

- When a line is added (or its service changes), `case_items` copies the selling price, `price_version`, `unit`, `price_tax_basis` and `priced_at`. Quantity changes and drop / keep reuse the snapshot. A later rate-card change never rewrites a line. Previously, any update of a line re-read today's price.
- `case_item_costs` holds the line's provider, `provider_rate_id`, unit, buying rate and GST basis. They are copied automatically when exactly one active provider has a rate in force for that service and unit. With several providers, a coordinator or supervisor chooses on the case page. With none, the cost is missing (never zero).
- *Refresh prices* (case page banner, `refresh_case_prices()`) works only on a draft quote (Enquiry or Pricing, not sent, not signed off). It takes today's selling prices and the chosen provider's buying rate, and writes the change in total on the timeline.
- After agreement (signed off or past Pricing), only a supervisor can amend a buying cost, with a reason. The old and new values go to `case_item_cost_history`. Customer prices, totals and sign-off do not change. The existing sign-off invalidation (`recalc_case()` clears `signoff_at` when the total changes) is unchanged.
- Lines made before this release have `priced_at` null and show **Cost not captured**. Costs are not backfilled from today's rates.

## Margin calculation (`margin_lines()`, SQL numeric)

- Included lines only; dropped lines are left out of every total. Cancelled bookings are left out of the report.
- Booking discount (`cases.discount_amount`) is spread over included lines in proportion to their line totals, in paise. Each line gets the floor of its share, and the remaining paise go to the lines with the largest remainders (ties: the earlier line). The net lines therefore add up to `cases.total` exactly, and `case_margins().reconciles` checks it.
- Buying total = qty × buying rate, rounded to the paisa. Margin = net line − buying total. Margin % = margin × 100 / net line, rounded to 2 decimals, and n/a when net is 0.
- Line cost status: `ok`, `no_provider`, `missing`, `not_captured`, `unit_mismatch` or `tax_basis` (bases differ or the selling basis is not confirmed). The booking margin is shown only when every included line is `ok`. Otherwise the panel shows *Margin incomplete* and a separate "costed lines only" subtotal.
- Example: ₹12,000 buying and ₹16,000 selling gives ₹4,000 and 25%. With a 10% discount: net ₹14,400, margin ₹2,400, 16.67%.

## MIS reports > Margins (`margin_report()`)

- Bookings whose booking was confirmed in the period (IST date of `booking_confirmed_at`), filtered by provider, service and case ID.
- **Projected** = service not completed yet; **completed** = `service_completed_at` recorded.
- Totals for bookings with complete costs, bookings with incomplete costs (with a costed-lines subtotal) and bookings with cost not captured. Breakdowns by provider, service and booking.
- Aggregate margin % = aggregate margin / aggregate net selling, never an average of percentages.
- The Excel download is logged in `access_log` (`export`, `margins`).

## Rate card from the Hinduja price sheet

Migration `20261016160000_rate_card_from_price_sheet.sql` puts every priced line of "Service & Pricing - Home Care Services (Marketing).xlsx" on the card: 61 services at the "Proposed Hinduja Patient Price", units through `unit_key()`, codes and categories as in the proposed import file, GST basis not confirmed, no buying rates. The three X-ray lines were already there (`20261016130000_diagnostic_xray_home.sql`). Existing services are matched by code or by name and unit; only rows still at 0 are priced, nothing set is overwritten. The older per-day / per-shift placeholders (VENT-HOME, OXY-CONC, NURSE-12H, ...) stay unpriced because the sheet prices those items per month or per 12 hours and units are never converted. `care_plan_sheet()` counts "12 hours" / "24 hours" nursing and attendant cover daily, session variants 3 a week and month items per started 30 days.

## Business inputs still open

See the hand-over notes for this change. In short:
- B2B rates: settled as 70% of the patient price (SecondMedic keeps 30%), BMM for everything except X-ray, ECG and blood tests (SecondMedic). Provider-specific rates that differ from this can still be set under Buying rates (B2B).
- The GST basis of each column.
- Effective dates.
- Whether "12 hours" / "24 hours" / "Per month" services replace or sit beside the existing shift / day services.
- Hinduja management access to margins.
