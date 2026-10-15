-- =====================================================================
-- CareDesk CRM  |  Referring source options (Hinduja, 15 Oct 2026)
--   When the source channel is Referral, the agent picks the referring source:
--   ICU, Doctor, Nursing Team or Other. Stored in cases.referral_subtype (20261015200000), as the label shown.
--   Values saved under the earlier wording are mapped to the new list, then the check allows only the four.
-- Idempotent: the mapping is a no-op once applied; the constraint is dropped and re-added.
-- =====================================================================

alter table cases drop constraint if exists cases_referral_subtype_check;

update cases set referral_subtype = case referral_subtype
    when 'ICU / Pamphlet Advertisement' then 'ICU'
    when 'icu_pamphlet' then 'ICU'
    when 'icu' then 'ICU'
    when 'doctor' then 'Doctor'
    when 'Nursing Team / Internal Nurse' then 'Nursing Team'
    when 'nurse' then 'Nursing Team'
    when 'nursing_team' then 'Nursing Team'
    when 'other' then 'Other'
    else referral_subtype end
 where referral_subtype is not null
   and referral_subtype not in ('ICU', 'Doctor', 'Nursing Team', 'Other');

alter table cases add constraint cases_referral_subtype_check
  check (referral_subtype is null or referral_subtype in ('ICU', 'Doctor', 'Nursing Team', 'Other'));

-- create_enquiry logs the enquiry on the timeline with the case's source channel. Walk-in and Referral are valid
-- source channels but were missing here, so those enquiries (without a linked call) failed to save. Expand only.
alter table interactions drop constraint if exists interactions_channel_check;
alter table interactions add constraint interactions_channel_check
  check (channel in ('phone','whatsapp','sms','email','chat','note','system','crm_edit','field','lab','payment','walkin','referral'));

comment on column cases.referral_subtype is
  'Referring source when source_channel is referral: ICU, Doctor, Nursing Team or Other';
