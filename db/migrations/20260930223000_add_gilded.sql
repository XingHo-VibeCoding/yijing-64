-- 迁移：20260930223000_add_gilded
-- 目的：把「镀金」成就上云（此前仅存 localStorage，换设备必丢）
-- 红线核对：不存任何身份信息（无姓名/手机/邮箱/设备），只有 uid + 卦序号数组

create table if not exists public.gilded (
  uid          text        primary key,
  hexagram_ids smallint[]  not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.gilded is
  'PRD F3 镀金成就：一人一行，卦序号数组。刻意不存身份信息（与 divination_records 同口径）。';

-- 行级权限：只能读自己的
alter table public.gilded enable row level security;

drop policy if exists "read own gilded"   on public.gilded;
drop policy if exists "insert own gilded" on public.gilded;
drop policy if exists "update own gilded" on public.gilded;

create policy "read own gilded"   on public.gilded
  for select using (uid = public.current_uid());

create policy "insert own gilded" on public.gilded
  for insert with check (uid = public.current_uid());

create policy "update own gilded" on public.gilded
  for update using (uid = public.current_uid())
              with check (uid = public.current_uid());

-- 与既有四表一致的授权（否则 anon 角色会被 RLS 之前的 ACL 挡住）
grant select, insert, update on public.gilded to anon, authenticated;
