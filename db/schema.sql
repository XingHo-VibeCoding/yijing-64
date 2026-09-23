-- ============================================================================
-- 易经六十四卦学习 · 数据库结构与行级权限
-- ============================================================================
-- 来源：docs/TECH_DESIGN.md §7.1（表结构）与 §7.3（RLS）—— **本文件是那两节的可执行版**
-- 执行时机：TECH_DESIGN §15 的**第 5 步**，即云环境建好之后（第 1–4 步由用户在控制台完成）
--
-- ⚠️ 三条前置纪律
--   1. **本文件尚未在任何真实 PostgreSQL 上执行过** —— 云环境还没建。第一次执行时请留意报错行。
--   2. **V4 待核实**：`auth.uid()` 只是**示意**函数名（CloudBase PG 的当前用户函数名未确认）。
--      本文件把它单独封在 `public.current_uid()` 里，**改一处即可全部生效**（见下）。
--   3. 执行前这份文件要给用户看过（TECH_DESIGN §15 第 5 步的要求）。
--
-- 幂等：全部 `if not exists` / `drop policy if exists`，可以重复执行。
-- 不含任何密钥、不含任何用户数据。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. 待核实点集中处：当前用户标识
-- ----------------------------------------------------------------------------
-- 为什么包一层：V4（RLS 当前用户函数名）是本次最不确定的一项。若直接在每个策略里写
-- `auth.uid()`，等确认下来名字不对，就要改十几处；封成函数后**只改这一行**。
-- 若控制台文档给出的写法不同（例如读 JWT claims 的 current_setting(...)），就替换函数体。
-- 若确认 `auth.uid()` 就是对的，本函数保留也无害（一层薄封装）。
create or replace function public.current_uid() returns text
  language sql
  stable
as $$
  select auth.uid()::text
$$;

comment on function public.current_uid() is
  '行级权限用的当前用户标识。⚠️ V4 待核实：函数体按控制台文档调整，本文件其余部分不必改。';


-- ----------------------------------------------------------------------------
-- 1. 起卦记录（F8）—— 每天只留第一卦
-- ----------------------------------------------------------------------------
create table if not exists public.divination_records (
  uid            text        not null,                      -- 匿名登录返回的用户标识
  date           date        not null,                      -- 用户本地日期，一天一条
  hexagram_id    smallint    not null check (hexagram_id between 1 and 64),
  changing_lines smallint[]  not null default '{}',         -- 变爻位置（1–6），可为空数组
  created_at     timestamptz not null default now(),
  primary key (uid, date)                                   -- 主键即「一天一条」的硬约束
);

comment on table public.divination_records is
  'PRD F8：每日第一卦自动存档。主键 (uid, date) 用数据库强制「一天一条」，不靠应用层查重。'
  '刻意不存精确时刻（PRD §7.3 红线），也不用 timestamptz 存日期。';


-- ----------------------------------------------------------------------------
-- 2. 收藏（F8）
-- ----------------------------------------------------------------------------
create table if not exists public.favorites (
  uid         text        not null,
  hexagram_id smallint    not null check (hexagram_id between 1 and 64),
  created_at  timestamptz not null default now(),
  primary key (uid, hexagram_id)
);

comment on table public.favorites is
  'PRD F8：收藏某一卦。主键 (uid, hexagram_id) 保证同一卦不会重复收藏。';


-- ----------------------------------------------------------------------------
-- 3. 学习进度（F3 测验，本期 P1）
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- 4. 每轮成绩（F3：「看到分数变化」）
-- ----------------------------------------------------------------------------
create table if not exists public.study_rounds (
  id         bigserial primary key,
  uid        text      not null,
  score      smallint  not null,
  total      smallint  not null default 20,                 -- PRD F3：一轮 20 题
  created_at timestamptz not null default now()
);

comment on table public.study_rounds is
  'PRD F3：每一轮的得分流水，用于展示分数变化。只增不改。';

create index if not exists idx_rounds_uid_time
  on public.study_rounds (uid, created_at desc);


-- ----------------------------------------------------------------------------
-- 5. 行级权限（RLS）—— 每个人只能看见和改自己的行
-- ----------------------------------------------------------------------------
alter table public.divination_records enable row level security;
alter table public.favorites          enable row level security;
alter table public.study_progress     enable row level security;
alter table public.study_rounds       enable row level security;

-- 起卦记录：可读、可写、可删；**刻意不建 update 策略**
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

-- 学习进度（唯一允许 update 的表：进度本来就要累加）
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

-- ⚠️ 「起卦记录不建 update 策略」是**刻意的**（TECH_DESIGN §7.3）：
--    让 PRD F8「记录不可事后编辑」成为**数据库层的硬约束** —— 前端再怎么改也改不了已存的记录。


-- ----------------------------------------------------------------------------
-- 6. 执行后的自检（把这三条查询跑一遍，结果贴回给 AI 核对）
-- ----------------------------------------------------------------------------
-- ① 四张表的 RLS 是否都开启（应全为 true）
-- select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;

-- ② 策略清单（起卦记录应只有 SELECT / INSERT / DELETE 三种，**没有 UPDATE**）
-- select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public' order by tablename, cmd;

-- ③ 辅助函数是否建好
-- select proname, prosrc from pg_proc where proname = 'current_uid';
