-- HOPE Data Analysis クラウド同期 スキーマ（Supabase / PostgreSQL 15+）
-- Supabase の SQL Editor に貼り付けて 1 回実行します（何度実行しても壊れないように書いてあります）。
-- 方針：表への直接の書き込みは全面禁止。書き込みは下の関数（security definer）だけが行い、
--       関数の中で「ログイン中のユーザー(auth.uid())が、そのチームの何の権限か」を毎回確認します。

create extension if not exists pgcrypto;

-- ===== 表 =====
create table if not exists public.teams(
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  seq bigint not null default 0               -- 変更の通し番号（チームごと）
);
create table if not exists public.members(
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('admin','coach','viewer')),
  email text,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists members_user on public.members(user_id);
create table if not exists public.invites(
  code text primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  role text not null check (role in ('admin','coach','viewer')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses int not null default 1 check (max_uses between 1 and 100),
  uses int not null default 0,
  revoked boolean not null default false
);
create table if not exists public.join_attempts(
  user_id uuid not null, at timestamptz not null default now(), ok boolean not null
);
create index if not exists join_attempts_u on public.join_attempts(user_id, at);
create table if not exists public.records(
  team_id uuid not null references public.teams(id) on delete cascade,
  coll text not null,
  rid text not null,
  grp text,                                    -- 試合ID（試合に属する記録の印）
  ord double precision,                        -- 記録の並び順（打席の順番などを端末間でそろえる）
  data jsonb,
  rev int not null default 1,
  seq bigint not null,
  deleted boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (team_id, coll, rid)
);
alter table public.records add column if not exists ord double precision;
create index if not exists records_seq on public.records(team_id, seq);
create table if not exists public.backups(
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  label text,
  size int not null,
  payload text not null
);
create index if not exists backups_team on public.backups(team_id, created_at desc);

-- ===== 行レベルセキュリティ（RLS）=====
alter table public.teams enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.join_attempts enable row level security;
alter table public.records enable row level security;
alter table public.backups enable row level security;
alter table public.teams force row level security;
alter table public.members force row level security;
alter table public.invites force row level security;
alter table public.join_attempts force row level security;
alter table public.records force row level security;
alter table public.backups force row level security;

-- 表そのものの権限は最小限（読み取りのみ・RLS で絞る）。書き込み権限は誰にも与えない。
revoke all on public.teams, public.members, public.invites, public.join_attempts, public.records, public.backups from anon, authenticated;
grant select on public.teams, public.members, public.records to authenticated;

create or replace function public.h_role(p_team uuid) returns text
language sql stable security definer set search_path = public as
$$ select role from public.members where team_id = p_team and user_id = auth.uid() $$;
revoke all on function public.h_role(uuid) from public, anon;
grant execute on function public.h_role(uuid) to authenticated;

drop policy if exists teams_sel on public.teams;
create policy teams_sel on public.teams for select to authenticated using (public.h_role(id) is not null);
drop policy if exists members_sel on public.members;
create policy members_sel on public.members for select to authenticated using (public.h_role(team_id) is not null);
drop policy if exists records_sel on public.records;
create policy records_sel on public.records for select to authenticated using (public.h_role(team_id) is not null);
-- invites / backups / join_attempts には policy を作らない＝直接は誰も読めない（関数経由のみ）

-- ===== 関数（書き込みと管理はすべてここを通る）=====
create or replace function public.h_need(p_team uuid, p_roles text[]) returns text
language plpgsql stable security definer set search_path = public as $$
declare r text;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode='28000'; end if;
  r := public.h_role(p_team);
  if r is null then raise exception 'forbidden' using errcode='42501'; end if;
  if not (r = any(p_roles)) then raise exception 'forbidden_role' using errcode='42501'; end if;
  return r;
end $$;

create or replace function public.create_team(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t uuid; n int; em text;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode='28000'; end if;
  select count(*) into n from members where user_id = auth.uid();
  if n >= 10 then raise exception 'too_many_teams'; end if;
  p_name := btrim(coalesce(p_name,''));
  if char_length(p_name) < 1 or char_length(p_name) > 60 then raise exception 'bad_name'; end if;
  em := auth.jwt() ->> 'email';
  insert into teams(name, created_by) values (p_name, auth.uid()) returning id into t;
  insert into members(team_id, user_id, role, email) values (t, auth.uid(), 'admin', em);
  return jsonb_build_object('team_id', t, 'name', p_name, 'role', 'admin');
end $$;

create or replace function public.my_teams() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('team_id', t.id, 'name', t.name, 'role', m.role) order by t.created_at), '[]'::jsonb)
  from members m join teams t on t.id = m.team_id where m.user_id = auth.uid()
$$;

create or replace function public.create_invite(p_team uuid, p_role text, p_days int default 7, p_max int default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c text; raw text;
begin
  perform public.h_need(p_team, array['admin']);
  if p_role not in ('admin','coach','viewer') then raise exception 'bad_role'; end if;
  p_days := least(greatest(coalesce(p_days,7),1),30); p_max := least(greatest(coalesce(p_max,1),1),100);
  raw := upper(substr(replace(gen_random_uuid()::text,'-',''),1,16));
  c := substr(raw,1,4)||'-'||substr(raw,5,4)||'-'||substr(raw,9,4)||'-'||substr(raw,13,4);
  insert into invites(code, team_id, role, created_by, expires_at, max_uses)
    values (c, p_team, p_role, auth.uid(), now() + make_interval(days => p_days), p_max);
  return jsonb_build_object('code', c, 'role', p_role, 'days', p_days, 'max', p_max);
end $$;

create or replace function public.list_invites(p_team uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.h_need(p_team, array['admin']);
  return (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'role', role, 'expires_at', expires_at, 'max', max_uses, 'uses', uses, 'revoked', revoked, 'live', (not revoked and expires_at > now() and uses < max_uses)) order by created_at desc), '[]'::jsonb)
          from (select * from invites where team_id = p_team order by created_at desc limit 20) i);
end $$;

create or replace function public.revoke_invite(p_team uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.h_need(p_team, array['admin']);
  update invites set revoked = true where team_id = p_team and code = upper(btrim(p_code));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.join_team(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i invites%rowtype; t teams%rowtype; fails int; em text;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode='28000'; end if;
  select count(*) into fails from join_attempts where user_id = auth.uid() and ok = false and at > now() - interval '1 hour';
  if fails >= 10 then raise exception 'too_many_attempts'; end if;
  select * into i from invites where code = upper(btrim(coalesce(p_code,''))) for update;
  if not found or i.revoked or i.expires_at <= now() or i.uses >= i.max_uses then
    insert into join_attempts(user_id, ok) values (auth.uid(), false);   -- 失敗は記録して回数制限に使う（例外にすると記録が巻き戻るので結果として返す）
    perform pg_sleep(0.2);
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  select * into t from teams where id = i.team_id;
  if exists (select 1 from members where team_id = i.team_id and user_id = auth.uid()) then
    return jsonb_build_object('team_id', t.id, 'name', t.name, 'role', public.h_role(t.id), 'already', true);
  end if;
  em := auth.jwt() ->> 'email';
  insert into members(team_id, user_id, role, email) values (i.team_id, auth.uid(), i.role, em);
  update invites set uses = uses + 1 where code = i.code;
  insert into join_attempts(user_id, ok) values (auth.uid(), true);
  return jsonb_build_object('team_id', t.id, 'name', t.name, 'role', i.role);
end $$;

create or replace function public.list_members(p_team uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.h_need(p_team, array['admin','coach','viewer']);
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'role', role, 'email', email, 'joined_at', joined_at, 'me', user_id = auth.uid()) order by joined_at), '[]'::jsonb) from members where team_id = p_team);
end $$;

create or replace function public.set_role(p_team uuid, p_user uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur text; n int;
begin
  perform public.h_need(p_team, array['admin']);
  if p_role not in ('admin','coach','viewer') then raise exception 'bad_role'; end if;
  select role into cur from members where team_id = p_team and user_id = p_user for update;
  if cur is null then raise exception 'not_found'; end if;
  if cur = 'admin' and p_role <> 'admin' then
    select count(*) into n from members where team_id = p_team and role = 'admin';
    if n <= 1 then raise exception 'last_admin'; end if;
  end if;
  update members set role = p_role where team_id = p_team and user_id = p_user;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.remove_member(p_team uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur text; n int;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode='28000'; end if;
  if p_user <> auth.uid() then perform public.h_need(p_team, array['admin']); else perform public.h_need(p_team, array['admin','coach','viewer']); end if;
  select role into cur from members where team_id = p_team and user_id = p_user for update;
  if cur is null then raise exception 'not_found'; end if;
  if cur = 'admin' then
    select count(*) into n from members where team_id = p_team and role = 'admin';
    if n <= 1 then raise exception 'last_admin'; end if;
  end if;
  delete from members where team_id = p_team and user_id = p_user;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sync_pull(p_team uuid, p_since bigint default 0, p_limit int default 500) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rows jsonb; mx bigint; cnt int; top bigint;
begin
  perform public.h_need(p_team, array['admin','coach','viewer']);
  p_limit := least(greatest(coalesce(p_limit,500),1),1000);
  select coalesce(jsonb_agg(jsonb_build_object('coll', coll, 'rid', rid, 'grp', grp, 'ord', ord, 'data', data, 'rev', rev, 'seq', seq, 'deleted', deleted) order by seq), '[]'::jsonb), coalesce(max(seq), p_since), count(*)
    into rows, mx, cnt
    from (select * from records where team_id = p_team and seq > coalesce(p_since,0) order by seq limit p_limit) r;
  select seq into top from teams where id = p_team;
  return jsonb_build_object('rows', rows, 'seq', mx, 'top', top, 'more', mx < top);
end $$;

create or replace function public.sync_push(p_team uuid, p_changes jsonb, p_device text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ch jsonb; ex records%rowtype; s bigint; applied jsonb := '[]'::jsonb; confl jsonb := '[]'::jsonb;
        c text; r text; br int; d jsonb; g text; o double precision; allowed text[] := array['p','a','m','g','pt','gl','px','sb','sn','op','df','pk','ao','ev','ob','opp','gr','rs','hh','ho','obj'];
begin
  perform public.h_need(p_team, array['admin','coach']);
  if jsonb_typeof(p_changes) <> 'array' then raise exception 'bad_request'; end if;
  if jsonb_array_length(p_changes) > 500 then raise exception 'too_many_changes'; end if;
  select seq into s from teams where id = p_team for update;     -- チーム単位で直列化
  for ch in select * from jsonb_array_elements(p_changes) loop
    c := ch->>'coll'; r := ch->>'rid'; br := coalesce((ch->>'base_rev')::int, 0); d := ch->'data'; g := nullif(ch->>'grp',''); o := nullif(ch->>'ord','')::double precision;
    if c is null or r is null or char_length(r) > 80 or char_length(c) > 40 then raise exception 'bad_record'; end if;
    if not (c = any(allowed) or c like 'o8.%') then raise exception 'bad_collection'; end if;
    if d is not null and jsonb_typeof(d) <> 'null' and octet_length(d::text) > 1000000 then raise exception 'record_too_large'; end if;
    if jsonb_typeof(d) = 'null' then d := null; end if;
    select * into ex from records where team_id = p_team and coll = c and rid = r;
    if (found and ex.rev <> br) or (not found and br <> 0) then
      confl := confl || jsonb_build_array(jsonb_build_object('coll', c, 'rid', r, 'server', jsonb_build_object('data', ex.data, 'rev', ex.rev, 'seq', ex.seq, 'deleted', ex.deleted, 'grp', ex.grp, 'ord', ex.ord)));
      continue;
    end if;
    s := s + 1;
    if found then
      update records set data = d, grp = coalesce(g, grp), ord = coalesce(o, ord), rev = rev + 1, seq = s, deleted = (d is null), updated_by = auth.uid(), updated_at = now()
        where team_id = p_team and coll = c and rid = r;
      applied := applied || jsonb_build_array(jsonb_build_object('coll', c, 'rid', r, 'rev', ex.rev + 1, 'seq', s));
    else
      insert into records(team_id, coll, rid, grp, ord, data, rev, seq, deleted, updated_by) values (p_team, c, r, g, o, d, 1, s, d is null, auth.uid());
      applied := applied || jsonb_build_array(jsonb_build_object('coll', c, 'rid', r, 'rev', 1, 'seq', s));
    end if;
  end loop;
  update teams set seq = s where id = p_team;
  return jsonb_build_object('applied', applied, 'conflicts', confl, 'seq', s);
end $$;

create or replace function public.backup_create(p_team uuid, p_label text, p_payload text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare id uuid;
begin
  perform public.h_need(p_team, array['admin','coach']);
  if p_payload is null or char_length(p_payload) < 2 then raise exception 'empty_backup'; end if;
  if char_length(p_payload) > 15000000 then raise exception 'backup_too_large'; end if;
  insert into backups(team_id, created_by, label, size, payload) values (p_team, auth.uid(), left(coalesce(p_label,''),80), char_length(p_payload), p_payload) returning backups.id into id;
  delete from backups where team_id = p_team and backups.id not in (select b.id from backups b where b.team_id = p_team order by b.created_at desc limit 20);
  return jsonb_build_object('id', id);
end $$;

create or replace function public.backup_list(p_team uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.h_need(p_team, array['admin','coach']);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'label', label, 'size', size, 'by', created_by) order by created_at desc), '[]'::jsonb) from backups where team_id = p_team);
end $$;

create or replace function public.backup_get(p_team uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b backups%rowtype;
begin
  perform public.h_need(p_team, array['admin']);
  select * into b from backups where team_id = p_team and id = p_id;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('id', b.id, 'label', b.label, 'created_at', b.created_at, 'payload', b.payload);
end $$;

-- 関数の実行権限：ログイン済みユーザーだけ（匿名キーだけでは何も実行できない）
do $$ declare f text; begin
  foreach f in array array[
    'h_need(uuid,text[])','create_team(text)','my_teams()','create_invite(uuid,text,int,int)','list_invites(uuid)','revoke_invite(uuid,text)',
    'join_team(text)','list_members(uuid)','set_role(uuid,uuid,text)','remove_member(uuid,uuid)','sync_pull(uuid,bigint,int)',
    'sync_push(uuid,jsonb,text)','backup_create(uuid,text,text)','backup_list(uuid)','backup_get(uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
-- h_need は内部用：クライアントから直接呼べないようにする
revoke execute on function public.h_need(uuid,text[]) from authenticated;
