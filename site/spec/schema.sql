-- Agent Passport, share layer schema v0.1 (PostgreSQL / Supabase migration).
--
-- THREAT MODEL, three lines:
--   1. Every uploaded passport is public the moment its link exists. There is no
--      confidentiality here, no access control, no accounts. Assume every stored
--      row will be read by strangers.
--   2. The row uuid is the only secret. Read access is a keyhole: present the exact
--      uuid or learn nothing, including whether that uuid exists.
--   3. Delete tokens are shown to the uploader exactly once and never stored in
--      plaintext. Only the SHA-256 hex of the token lives in the database.
--
-- Companion documents, both normative for anything this file cannot enforce:
--   site/spec/upload-validation.md   the server side validation contract
--   spec/passport-0.1.md             the passport format itself
--
-- Run order: this file is one migration. It is idempotent enough to re-run on a
-- clean project, not idempotent against a project that already holds data.


-- ---------------------------------------------------------------------------
-- 0. Extensions and schemas
-- ---------------------------------------------------------------------------

-- pgcrypto supplies gen_random_bytes (delete token) and digest (SHA-256).
-- Supabase convention is to install extensions into the `extensions` schema.
create extension if not exists pgcrypto with schema extensions;

-- `private` is never exposed over the Data API. The rate limit ledger lives here.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 1. Validation helpers
--
-- These are the floor, not the contract. The real validator is the upload
-- endpoint (site/spec/upload-validation.md), which parses the markdown. These
-- functions exist so that a row inserted by something other than that endpoint
-- (see the honesty note in section 5) is still structurally a passport.
-- ---------------------------------------------------------------------------

create or replace function public.passport_body_wellformed(p_body text)
returns boolean
language sql
immutable
set search_path = public, pg_catalog
as $$
  select
    -- Frontmatter opens on line 1.
    p_body ~ '^---[ \t]*\n'
    -- The six body headings, present and in order. Postgres regexes are
    -- newline-insensitive by default, so `.` spans lines here.
    and p_body ~ ('## 1\. What this agent is'
                  || '.*## 2\. What it needs from you'
                  || '.*## 3\. Functional spec'
                  || '.*## 4\. Golden examples'
                  || '.*## 5\. Installer'
                  || '.*## 6\. Losses')
    -- comparison_mode is the field verification switches on. Absent is invalid.
    and p_body ~ 'comparison_mode:[ \t]*(structural|exact|input_relative)'
    -- Active content. This is a narrow blocklist on purpose. Full HTML
    -- rejection is the upload validator's job (E_HTML in upload-validation.md);
    -- duplicating the full rule in SQL would guarantee the two drift apart.
    and p_body !~* '<(script|iframe|object|embed|svg|form|link|meta|base)\M'
    and p_body !~* 'javascript:'
    and p_body !~* '\Wdata:text/html'
$$;

comment on function public.passport_body_wellformed(text) is
  'Structural floor for a passport body. Presence and order of the six sections, '
  'frontmatter opener, comparison_mode, and a narrow active-content blocklist. '
  'Not a substitute for the upload validator.';


create or replace function public.passport_needs_wellformed(p_needs jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_catalog
as $$
declare
  v_row jsonb;
begin
  if jsonb_typeof(p_needs) is distinct from 'array' then
    return false;
  end if;
  -- A passport with no consent rows is a passport that asks for nothing, which
  -- is never true of a real agent. Upper bound is a sanity ceiling, not a limit
  -- anyone should hit: the v0.1 vocabulary has twelve ids.
  if jsonb_array_length(p_needs) < 1 or jsonb_array_length(p_needs) > 24 then
    return false;
  end if;

  for v_row in select jsonb_array_elements(p_needs) loop
    if jsonb_typeof(v_row) is distinct from 'object' then
      return false;
    end if;
    -- The consent table columns of spec/passport-0.1.md section 3, as
    -- site/spec/upload-validation.md 6.3 derives them.
    --
    -- required_label and installable_label are required here, and that is the
    -- amendment this function missed when 6.3 got it. They are the passport's
    -- own wording for the two verdict cells, and a renderer that receives a row
    -- without them is forbidden by 6.3 from wording the verdict itself, so a
    -- row stored without them renders a page with two cells missing. Refusing
    -- the insert is the right place to catch that: this constraint and 6.3 are
    -- the same authority, and letting them drift is how the row shape and the
    -- document describing it stopped agreeing in the first place. Rows already
    -- stored without the labels are not affected; this checks new inserts.
    if not (v_row ? 'capability' and v_row ? 'why' and v_row ? 'required'
            and v_row ? 'required_label' and v_row ? 'if_skipped'
            and v_row ? 'installable' and v_row ? 'installable_label') then
      return false;
    end if;
    if jsonb_typeof(v_row -> 'capability') <> 'string'
       or jsonb_typeof(v_row -> 'why') <> 'string'
       or jsonb_typeof(v_row -> 'if_skipped') <> 'string'
       or jsonb_typeof(v_row -> 'required') <> 'boolean'
       or jsonb_typeof(v_row -> 'required_label') <> 'string'
       or jsonb_typeof(v_row -> 'installable') <> 'boolean'
       or jsonb_typeof(v_row -> 'installable_label') <> 'string' then
      return false;
    end if;
    if length(v_row ->> 'capability') between 1 and 200 then
      null;
    else
      return false;
    end if;
  end loop;

  return true;
end;
$$;

comment on function public.passport_needs_wellformed(jsonb) is
  'Shape check for the derived consent table: array of objects carrying '
  'capability, why, required, required_label, if_skipped, installable, '
  'installable_label. Optional key: ref. The two _label keys are the '
  'passport''s own wording for the verdict cells; see upload-validation.md 6.3.';


-- ---------------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------------

create table if not exists public.passports (
  id                uuid        primary key default gen_random_uuid(),

  -- Denormalised from the body so the passport page renders without parsing
  -- markdown in the browser. Derivation rules: upload-validation.md section 4.
  title             text        not null,
  summary           text        not null,
  needs             jsonb       not null,

  body              text        not null,
  capture_path      text        not null,
  created_at        timestamptz not null default now(),
  delete_token_hash text        not null,

  -- Columns beyond the build plan list. One justification each.

  -- passport_version: spec/passport-0.1.md section 8 requires readers to refuse
  -- versions they do not know. The renderer and every future migration need that
  -- decision without re-parsing frontmatter, and a v0.2 table will hold both.
  passport_version  text        not null,

  -- owner_confirmed: spec/passport-0.1.md section 2 makes surfacing this
  -- mandatory ("the passport page and every installer must surface that fact
  -- rather than hide it"). It drives a banner on every render, so it is denormalised
  -- for the same reason title and summary are.
  owner_confirmed   boolean     not null,

  -- validated_at: proof that a row was admitted by the validator rather than
  -- inserted around it, and when. Without it there is no way to tell, after the
  -- fact, which rows predate a rule change.
  validated_at      timestamptz not null,

  -- validator_version: upload-validation.md section 5 keeps two implementations
  -- of one rule set in sync by version string. When the rules tighten, this is
  -- the only column that says which rules a stored row actually passed.
  validator_version text        not null,

  -- view_count: the one telemetry the build plan permits in v0.1 (section 6,
  -- "telemetry beyond a page-view counter" is out of scope). Incremented only
  -- through public.record_passport_view.
  view_count        integer     not null default 0,

  constraint passports_title_ck
    check (title ~ '^[^\r\n]{1,200}$'),

  constraint passports_summary_ck
    check (length(summary) between 1 and 2000 and summary !~ '[\r]'),

  constraint passports_needs_ck
    check (public.passport_needs_wellformed(needs)),

  -- Size ceiling. 262144 bytes = 256 KiB, matching E_TOO_LARGE in
  -- upload-validation.md. The floor rejects anything too small to contain six
  -- sections and frontmatter.
  constraint passports_body_size_ck
    check (octet_length(body) between 512 and 262144),

  constraint passports_body_shape_ck
    check (public.passport_body_wellformed(body)),

  -- The two legal capture paths, spec/passport-0.1.md section 2.
  constraint passports_capture_path_ck
    check (capture_path in ('file', 'browser')),

  -- v0.1 is the only format this table knows how to render.
  constraint passports_version_ck
    check (passport_version in ('0.1')),

  -- SHA-256, lowercase hex, 64 chars. No plaintext token, ever.
  constraint passports_delete_token_hash_ck
    check (delete_token_hash ~ '^[0-9a-f]{64}$'),

  constraint passports_validator_version_ck
    check (validator_version ~ '^[0-9a-z.\-]{1,32}$'),

  constraint passports_view_count_ck
    check (view_count >= 0)
);

comment on table public.passports is
  'One row per uploaded agent passport. Public once its link exists. The uuid is '
  'the only secret. See the header of this file for the threat model.';

comment on column public.passports.delete_token_hash is
  'SHA-256 hex of the delete token. The token itself is returned once by '
  'public.create_passport and is never stored, logged, or recoverable.';

-- Indexes. The primary key is the only read path by design: every lookup is by
-- exact uuid. created_at carries the one batch operation that is planned, the
-- retention and abuse sweep run by an operator with the service key.
create index if not exists passports_created_at_idx
  on public.passports (created_at desc);

-- The delete path filters on this column and nothing else (see the DELETE
-- section), so it needs an index. Unique because two passports sharing a delete
-- token would mean one token deletes someone else's passport, and a collision on
-- 160 random bits should surface as a failed insert rather than as a surprise.
create unique index if not exists passports_delete_token_hash_uq
  on public.passports (delete_token_hash);


-- ---------------------------------------------------------------------------
-- 3. Return types
--
-- Composite types rather than RETURNS TABLE: output column names in a
-- RETURNS TABLE function collide with the table's own column names and produce
-- ambiguity errors. This is the boring way to avoid that.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'passport_public') then
    create type public.passport_public as (
      id               uuid,
      title            text,
      summary          text,
      needs            jsonb,
      body             text,
      capture_path     text,
      passport_version text,
      owner_confirmed  boolean,
      created_at       timestamptz,
      view_count       integer
    );
  end if;
end
$$;

comment on type public.passport_public is
  'Everything a reader gets. Note the absence of delete_token_hash, '
  'validated_at and validator_version: operator fields, not reader fields.';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'passport_created') then
    create type public.passport_created as (
      id           uuid,
      delete_token text
    );
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 4. Row Level Security
--
-- What RLS enforces here, exactly:
--   READ    nothing. There is no SELECT policy, so the table is invisible to
--           anon and authenticated no matter what query they send. No listing,
--           no enumeration, no count, no ordering, no `select=id`. Reads happen
--           only through public.get_passport(uuid), which cannot be handed a
--           filter, only a uuid.
--   INSERT  one permissive policy for anon, whose WITH CHECK repeats every
--           machine-checkable invariant. See the honesty note in section 5.
--   DELETE  one permissive policy whose USING clause hashes a caller-supplied
--           token and compares it to the stored hash. A caller without the token
--           matches zero rows, which is indistinguishable from a uuid that was
--           never there.
--
-- What RLS cannot enforce here: rate limiting, markdown validity, secret
-- scanning, and the difference between an upload that came through the create
-- page and one that did not. Those are marked below and specified in
-- upload-validation.md.
-- ---------------------------------------------------------------------------

alter table public.passports enable row level security;

-- Deliberately NOT `force row level security`: the table owner and service_role
-- must retain an unfiltered path for retention sweeps and abuse takedowns. That
-- also means the service key bypasses everything in this file. The upload
-- endpoint MUST call this database with the anon key. If it uses the service
-- key, none of the policies below run and the WITH CHECK below is decoration.

revoke all on public.passports from public, anon, authenticated;

-- Column level INSERT grant. created_at and view_count are omitted so a caller
-- cannot backdate a passport or inflate its counter.
grant insert (
  id, title, summary, needs, body, capture_path,
  passport_version, owner_confirmed, delete_token_hash,
  validated_at, validator_version
) on public.passports to anon;

grant delete on public.passports to anon;

-- No SELECT grant of any kind. Not on the table, not on a single column. An
-- anon client running `select ... from public.passports` gets "permission denied
-- for table passports" before RLS is even consulted, which is one layer stronger
-- than an empty result set. Verified on Postgres 15.
--
-- DO NOT add a SELECT grant or a SELECT policy here as a convenience. Either one
-- turns /rest/v1/passports into a uuid enumeration endpoint and ends the only
-- secret this design has. Reads go through public.get_passport and nowhere else.
-- The consequence for deletes is handled in the DELETE section below.


-- INSERT ------------------------------------------------------------------
drop policy if exists passports_insert_anon on public.passports;
create policy passports_insert_anon
  on public.passports
  for insert
  to anon
  with check (
    -- Every column constraint is already enforced by the table. Repeated here
    -- only where the policy can say something the constraint cannot: that the
    -- values are the ones the validator was supposed to have produced.
    passport_version = '0.1'
    and capture_path in ('file', 'browser')
    and octet_length(body) between 512 and 262144
    and public.passport_body_wellformed(body)
    and public.passport_needs_wellformed(needs)
    and delete_token_hash ~ '^[0-9a-f]{64}$'
    -- validated_at must be the current transaction, not a value the caller
    -- invented, and must not claim a validation that happened in the future.
    and validated_at between now() - interval '5 minutes' and now() + interval '1 minute'
  );

-- RATE LIMIT BOUNDARY, stated plainly: RLS cannot count requests. A policy has
-- no view of who is calling, how often, or from where; it sees one candidate row
-- inside one transaction. Nothing above limits an uploader to N passports per
-- hour. Two mechanisms outside RLS do that, in this order of authority:
--   1. The upload endpoint (edge function or app server), which is the only
--      layer that can see an IP, a session, a user agent and a body it has
--      already parsed. upload-validation.md section 3 fixes the numbers.
--   2. public.check_request below, a Data API pre-request hook. It is a blunt
--      backstop, not the limit: it counts writes per source IP as reported by
--      x-forwarded-for, which is set by Supabase's edge and is absent or wrong
--      in other topologies.
-- If both are removed, the insert policy still admits unlimited rows.


-- DELETE ------------------------------------------------------------------
--
-- POSTGRES BEHAVIOUR THIS DESIGN IS BUILT AROUND, found by testing rather than
-- by reading: when a DELETE carries a WHERE clause that reads a column of the
-- target table, Postgres ANDs the table's SELECT policies into the delete qual.
-- With no SELECT policy that added term is a constant `false`, so
--
--     delete from public.passports where id = '<uuid>';   -- always deletes 0
--
-- no matter how correct the token is. The EXPLAIN shows it plainly:
-- `Filter: (false AND (delete_token_hash = ...))`.
--
-- Rather than open a SELECT policy to work around it, the delete carries no
-- WHERE clause at all. Both halves of the claim, the passport id and the delete
-- token, are handed to the policy through transaction-local settings, so the
-- policy is the entire filter and the caller's statement contributes nothing.
-- public.delete_passport below is the only supported caller.
--
-- Consequence worth knowing: a direct PostgREST delete cannot work, because
-- PostgREST refuses an unfiltered DELETE and any filter reintroduces the
-- `false` above. That is a narrowing, not a loss.

-- The token is handed to the policy either as a transaction-local setting
-- (set by public.delete_passport) or as a request header, so an operator or a
-- future edge function can present it either way.
create or replace function public.presented_delete_token()
returns text
language plpgsql
stable
set search_path = public, pg_catalog
as $$
declare
  v_token text;
begin
  v_token := nullif(current_setting('app.delete_token', true), '');
  if v_token is null then
    begin
      v_token := current_setting('request.headers', true)::json
                   ->> 'x-passport-delete-token';
    exception when others then
      v_token := null;
    end;
  end if;
  return v_token;
end;
$$;

comment on function public.presented_delete_token() is
  'The delete token the caller presented, from the transaction setting '
  'app.delete_token or the x-passport-delete-token header. Never logged.';

drop policy if exists passports_delete_with_token on public.passports;
create policy passports_delete_with_token
  on public.passports
  for delete
  to anon
  using (
    -- Both halves must be presented. An unset setting yields '', which no uuid
    -- text ever equals, so the default is deny.
    id::text = coalesce(nullif(current_setting('app.delete_passport_id', true), ''), '')
    and delete_token_hash = encode(
      extensions.digest(coalesce(public.presented_delete_token(), ''), 'sha256'),
      'hex'
    )
  );

-- Why a plain `=` and not a constant time comparison: the compared value is the
-- SHA-256 of a 160 bit random token. There is no dictionary to walk and no
-- prefix to extend, so an early-exit byte comparison leaks nothing usable.
--
-- Why the id is checked as well as the token, when tokens are already unique:
-- so that delete_passport(id, token) means exactly what its signature says, and
-- an operator reading the log of a failed delete does not have to reason about
-- whether a token could have matched some other row.


-- ---------------------------------------------------------------------------
-- 5. The API surface
--
-- HONESTY NOTE, the largest hole in this file. anon holds INSERT on the table,
-- as the build plan specifies ("insert via anon key with rate limit"). That
-- means anyone holding the publishable key can POST straight to
-- /rest/v1/passports and skip the upload endpoint entirely. The table
-- constraints and the insert policy are then the only checks that run: they
-- catch shape, size, version, capture path and active content, and they do NOT
-- catch unscrubbed secrets, non UTF-8, HTML beyond the blocklist, a summary that
-- does not match the body, or anything else in upload-validation.md.
--
-- The one line fix, when that becomes a real problem rather than a theoretical
-- one, is to close the direct path and route every upload through an endpoint
-- holding a key anon does not have:
--
--   revoke insert on public.passports from anon;
--   -- then make public.create_passport SECURITY DEFINER and gate it on a
--   -- short-lived upload ticket issued by the create page.
--
-- That change is deliberately not made here, because it moves the whole
-- validation contract into a service that does not exist yet in v0.1.
-- ---------------------------------------------------------------------------

-- READ: the keyhole. SECURITY DEFINER because there is no SELECT policy and
-- there must not be one. The narrowing is structural: the function takes a uuid
-- and returns at most one row. It cannot be given a filter, an order, a limit,
-- or an offset, so there is no query a caller can write that returns two rows.
create or replace function public.get_passport(p_id uuid)
returns setof public.passport_public
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p.id, p.title, p.summary, p.needs, p.body, p.capture_path,
         p.passport_version, p.owner_confirmed, p.created_at, p.view_count
  from public.passports p
  where p.id = p_id;
$$;

comment on function public.get_passport(uuid) is
  'Read one passport by exact uuid. Returns zero rows for a uuid that never '
  'existed and zero rows for one that was deleted. The API layer must render '
  'both as the same 404 with the same body and the same headers.';

-- WHAT THIS CANNOT DO: it cannot stop someone who already holds a uuid from
-- learning that the uuid exists. That is not a leak, it is the product: the uuid
-- is the capability. It also cannot hide timing. A primary key probe on a
-- missing row and on a present row differ by microseconds, which is below the
-- noise of the network path, but this is an assumption, not a proof.


-- WRITE: SECURITY INVOKER (the default), so the insert policy above actually
-- runs. The delete token is generated here and returned exactly once. It is the
-- only moment in the system where the plaintext token exists.
create or replace function public.create_passport(
  p_title             text,
  p_summary           text,
  p_needs             jsonb,
  p_body              text,
  p_capture_path      text,
  p_passport_version  text,
  p_owner_confirmed   boolean,
  p_validator_version text
)
returns public.passport_created
language plpgsql
volatile
set search_path = public, extensions, pg_catalog
as $$
declare
  v_id     uuid := gen_random_uuid();
  -- 20 bytes = 160 bits of entropy, rendered as 40 lowercase hex characters.
  v_token  text := encode(extensions.gen_random_bytes(20), 'hex');
  v_result public.passport_created;
begin
  -- No RETURNING clause anywhere in this function: RETURNING would require a
  -- SELECT policy on the table, and there must not be one.
  insert into public.passports (
    id, title, summary, needs, body, capture_path,
    passport_version, owner_confirmed, delete_token_hash,
    validated_at, validator_version
  ) values (
    v_id, p_title, p_summary, p_needs, p_body, p_capture_path,
    p_passport_version, p_owner_confirmed,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    now(), p_validator_version
  );

  v_result.id := v_id;
  v_result.delete_token := v_token;
  return v_result;
end;
$$;

comment on function public.create_passport is
  'Insert a validated passport. Returns the new uuid and the plaintext delete '
  'token, which is never stored and never retrievable again. Callers must not '
  'log the return value.';

-- CALLER WARNING. Call this as `select * from public.create_passport(...)`.
-- Writing `select (public.create_passport(...)).*` makes Postgres expand the
-- composite in the target list and evaluate the function once per output column,
-- which inserts two passports and returns the id of one and the token of the
-- other. supabase-js `.rpc()` and a plain PostgREST POST both call it once and
-- are safe. This bites in psql and in hand-written SQL.


-- DELETE: SECURITY INVOKER, so the delete policy is the enforcement rather than
-- a comment about one. The token reaches the policy through a transaction-local
-- setting.
create or replace function public.delete_passport(p_id uuid, p_delete_token text)
returns boolean
language plpgsql
volatile
set search_path = public, pg_catalog
as $$
declare
  v_deleted integer;
begin
  -- true = transaction local, so neither value survives into another statement
  -- on a pooled connection.
  perform set_config('app.delete_token', coalesce(p_delete_token, ''), true);
  perform set_config('app.delete_passport_id', coalesce(p_id::text, ''), true);

  -- No WHERE clause. This is deliberate and load bearing: see the note above
  -- the delete policy. The policy is the filter. Adding `where id = p_id` here
  -- makes this function always return false.
  delete from public.passports;
  get diagnostics v_deleted = row_count;

  perform set_config('app.delete_token', '', true);
  perform set_config('app.delete_passport_id', '', true);
  return v_deleted = 1;
end;
$$;

comment on function public.delete_passport(uuid, text) is
  'Delete one passport on presentation of a token that hashes to its stored '
  'delete_token_hash. Returns false for a wrong token and false for a uuid that '
  'does not exist. The API layer must render both identically.';


-- VIEW COUNTER: SECURITY DEFINER, because a bare UPDATE would need an update
-- policy, and an update policy on this table would let a caller rewrite a
-- passport's body. This function can only add one to one counter.
create or replace function public.record_passport_view(p_id uuid)
returns void
language sql
volatile
security definer
set search_path = public, pg_catalog
as $$
  update public.passports
     set view_count = view_count + 1
   where id = p_id;
$$;

comment on function public.record_passport_view(uuid) is
  'Increment the page view counter. One write per rendered page view. If this '
  'ever becomes hot, sample it in the API layer or move it to an append-only '
  'counter table. Do not solve it by granting UPDATE on passports.';


-- Function privileges. Postgres grants EXECUTE to PUBLIC by default, which
-- would expose these to any role including future ones. Revoke first, grant
-- deliberately.
revoke all on function public.get_passport(uuid) from public;
revoke all on function public.create_passport(text, text, jsonb, text, text, text, boolean, text) from public;
revoke all on function public.delete_passport(uuid, text) from public;
revoke all on function public.record_passport_view(uuid) from public;
revoke all on function public.presented_delete_token() from public;
revoke all on function public.passport_body_wellformed(text) from public;
revoke all on function public.passport_needs_wellformed(jsonb) from public;

grant execute on function public.get_passport(uuid) to anon, authenticated;
grant execute on function public.create_passport(text, text, jsonb, text, text, text, boolean, text) to anon, authenticated;
grant execute on function public.delete_passport(uuid, text) to anon, authenticated;
grant execute on function public.record_passport_view(uuid) to anon, authenticated;

-- These three are never called by a client directly, but Postgres evaluates
-- check constraints and policy expressions as the invoking role, so the role
-- performing the insert or delete must hold EXECUTE on them. Without these
-- grants every insert fails with "permission denied for function". Verified by
-- running this migration and an insert as `anon` on Postgres 15.
grant execute on function public.passport_body_wellformed(text) to anon, authenticated;
grant execute on function public.passport_needs_wellformed(jsonb) to anon, authenticated;
grant execute on function public.presented_delete_token() to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. Rate limit backstop (Data API pre-request hook)
--
-- This is the blunt instrument, not the rate limit. Read the boundary comment
-- in section 4 before relying on it. It exists so that a project with a broken
-- or bypassed upload endpoint still has a ceiling.
-- ---------------------------------------------------------------------------

create table if not exists private.rate_limits (
  ip         inet        not null,
  request_at timestamptz not null default now()
);

create index if not exists rate_limits_ip_request_at_idx
  on private.rate_limits (ip, request_at desc);

create or replace function public.check_request()
returns void
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
declare
  v_method  text := current_setting('request.method', true);
  v_path    text := current_setting('request.path', true);
  v_ip      inet;
  v_writes  integer;
begin
  -- GET and HEAD are served read only and may land on a read replica, so they
  -- cannot be counted here. Passport reads are therefore not rate limited by
  -- this hook at all. That is intentional: reads require a uuid the caller must
  -- already possess, so there is nothing to brute force.
  if v_method is null or v_method in ('GET', 'HEAD') then
    return;
  end if;

  -- get_passport and record_passport_view arrive as POST because PostgREST RPC
  -- is POST. Exempt them, or a shared NAT reading passports would exhaust the
  -- write budget. Path format is `rpc/<function>`; the pattern is deliberately
  -- loose because the exact prefix is a PostgREST detail that has changed before.
  if v_path is not null and (v_path like '%get_passport%'
                             or v_path like '%record_passport_view%') then
    return;
  end if;

  begin
    v_ip := split_part(
      current_setting('request.headers', true)::json ->> 'x-forwarded-for',
      ',', 1)::inet;
  exception when others then
    v_ip := null;
  end;

  -- GAP, stated rather than hidden: no usable client IP means no limit. A caller
  -- that reaches Postgres without x-forwarded-for is unlimited by this hook.
  if v_ip is null then
    return;
  end if;

  select count(*) into v_writes
  from private.rate_limits
  where ip = v_ip
    and request_at > now() - interval '10 minutes';

  -- 20 writes per 10 minutes per IP. A person publishing a passport makes one.
  -- upload-validation.md section 3 sets the tighter, real limit at the endpoint.
  if v_writes >= 20 then
    raise sqlstate 'PGRST' using
      message = json_build_object(
        'code', 'E_RATE_LIMIT',
        'message', 'Too many uploads from this network. Try again in ten minutes.'
      )::text,
      detail = json_build_object(
        'status', 429,
        'status_text', 'Too Many Requests'
      )::text;
  end if;

  insert into private.rate_limits (ip, request_at) values (v_ip, now());

  -- Opportunistic pruning, roughly once every 200 writes. Without pg_cron this
  -- table would otherwise grow forever.
  if random() < 0.005 then
    delete from private.rate_limits where request_at < now() - interval '1 day';
  end if;
end;
$$;

revoke all on function public.check_request() from public;
grant execute on function public.check_request() to authenticator;

-- SCOPE WARNING: db_pre_request is set on the `authenticator` role and therefore
-- applies to every Data API request in the whole project, not just this table.
-- If this database ever hosts anything else, revisit that.
-- If the migration user lacks permission on the role, run these two statements
-- from the Supabase SQL editor as `postgres`.
alter role authenticator set pgrst.db_pre_request = 'public.check_request';
notify pgrst, 'reload config';


-- ---------------------------------------------------------------------------
-- 7. What is left to the API layer, in one list
--
--   Rate limiting per client, per session and per body fingerprint.
--   UTF-8 decoding and rejection of anything that is not valid UTF-8.
--   Markdown parsing, frontmatter parsing, and every rule in
--     spec/passport-0.1.md section 7.
--   HTML and script rejection beyond the narrow blocklist above.
--   The unscrubbed secret scan.
--   Derivation of title, summary, needs, capture_path, passport_version and
--     owner_confirmed from the body, and failing the upload when derivation fails.
--   Identical 404 responses for "no such uuid" and "deleted".
--   Identical failure responses for "wrong delete token" and "no such uuid".
--   Showing the delete token exactly once and never persisting it.
--
-- All of it is specified in site/spec/upload-validation.md. If that document and
-- this file disagree about a value, this file is wrong: the validator is the
-- contract, the schema is the floor.
-- ---------------------------------------------------------------------------
