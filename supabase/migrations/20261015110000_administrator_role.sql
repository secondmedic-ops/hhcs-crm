-- New login role "administrator": full access to CareDesk (everything a supervisor, Hinduja management and the platform
-- admin can do, with unmasked phone numbers), and creates staff of any role. The rules that use it are in the next
-- migration: a new enum value cannot be used in the transaction that adds it.
alter type app_role add value if not exists 'administrator';
