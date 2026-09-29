-- 易经六十四卦学习 · 数据库结构与行级权限（v1：4 表 + RLS）
-- 来源：db/schema.sql（Day 12 首次执行；V4 已核实 auth.uid() 存在）

-- 0. 当前用户标识（V4：auth.uid() 已在真库核实存在，薄封装保留）
create or replace function public.current_uid() returns text
  language sql
  stable
as $$
  select auth.uid()::text
$$;

comment on function public.current_uid() is
  '行级权限用的当前用户标识（V4 已核实：auth.uid() 在 CloudBase PG 真库存在）。';


-- 1. 起卦记录（F8）—— 每天只留第一卦
create table if not exists public.divination_records (
  uid            text        not null,
  date           date        not null,
  hexagram_id    smallint    not null check (hexagram_id between 1 and 64),
  changing_lines smallint[]  not null default '{}',
  created_at     timestamptz not null default now(),
  primary key (uid, date)
);

comment on table public.divination_records is
  'PRD F8：每日第一卦自动存档。主键 (uid, date) 用数据库强制「一天一条」，不靠应用层查重。'
  '刻意不存精确时刻（PRD §7.3 红线），也不用 timestamptz 存日期。';


-- 2. 收藏（F8）
create table if not exists public.favorites (
  uid         text        not null,
  hexagram_id smallint    not null check (hexagram_id between 1 and 64),
  created_at  timestamptz not null default now(),
  primary key (uid, hexagram_id)
);

comment on table public.favorites is
  'PRD F8：收藏某一卦。主键 (uid, hexagram_id) 保证同一卦不会重复收藏。';


-- 3. 学习进度（F3）
create table if not exists public.study_progress (
  uid            text primary key,
  answered_total integer    not null default 0,
  correct_total  integer    not null default 0,
  wrong_ids      smallint[] not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.study_progress is
  'PRD F3：测验累计进度（作答数 / 正确数 / 错题）。一人一行，允许 update。';


-- 4. 每轮成绩（F3）
create table if not exists public.study_rounds (
  id         bigserial primary key,
  uid        text      not null,
  score      smallint  not null,
  total      smallint  not null default 8,
  created_at timestamptz not null default now()
);

comment on table public.study_rounds is
  'PRD F3：每一轮的得分流水，用于展示分数变化。只增不改。';

create index if not exists idx_rounds_uid_time
  on public.study_rounds (uid, created_at desc);


-- 5. 行级权限（RLS）
alter table public.divination_records enable row level security;
alter table public.favorites          enable row level security;
alter table public.study_progress     enable row level security;
alter table public.study_rounds       enable row level security;

-- 起卦记录：可读、可写、可删；刻意不建 update 策略（记录不可事后编辑 = 数据库层硬约束）
drop policy if exists "read own records"   on public.divination_records;
drop policy if exists "insert own records" on public.divination_records;
drop policy if exists "delete own records" on public.divination_records;

create policy "read own records"   on public.divination_records
  for select using (uid = public.current_uid());

create policy "insert own records" on public.divination_records
  for insert with check (uid = public.current_uid());

create policy "delete own records" on public.divination_records
  for delete using (uid = public.current_uid());

-- 收藏
drop policy if exists "read own favorites"   on public.favorites;
drop policy if exists "insert own favorites" on public.favorites;
drop policy if exists "delete own favorites" on public.favorites;

create policy "read own favorites"   on public.favorites
  for select using (uid = public.current_uid());

create policy "insert own favorites" on public.favorites
  for insert with check (uid = public.current_uid());

create policy "delete own favorites" on public.favorites
  for delete using (uid = public.current_uid());

-- 学习进度（唯一允许 update 的表）
drop policy if exists "read own progress"   on public.study_progress;
drop policy if exists "insert own progress" on public.study_progress;
drop policy if exists "update own progress" on public.study_progress;

create policy "read own progress"   on public.study_progress
  for select using (uid = public.current_uid());

create policy "insert own progress" on public.study_progress
  for insert with check (uid = public.current_uid());

create policy "update own progress" on public.study_progress
  for update using (uid = public.current_uid())
              with check (uid = public.current_uid());

-- 每轮成绩：只增不改
drop policy if exists "read own rounds"   on public.study_rounds;
drop policy if exists "insert own rounds" on public.study_rounds;

create policy "read own rounds"   on public.study_rounds
  for select using (uid = public.current_uid());

create policy "insert own rounds" on public.study_rounds
  for insert with check (uid = public.current_uid());
