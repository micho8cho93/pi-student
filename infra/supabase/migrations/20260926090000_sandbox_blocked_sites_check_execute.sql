-- organizations.valid_sandbox_blocked_sites is a CHECK constraint, and Postgres
-- evaluates CHECK expressions with the privileges of the writing role. The
-- validator was revoked from authenticated, so every owner/admin update of an
-- organization row (details, class experience) failed with 42501 even when the
-- blocked-sites column was untouched. The function is an immutable, side-effect
-- free hostname validator, so executing it grants no additional authority; RLS
-- on public.organizations still decides who may update which row.
grant execute on function private.valid_sandbox_blocked_sites(text[]) to authenticated, service_role;
