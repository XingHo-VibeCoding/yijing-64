-- ============================================================================
-- 易经六十四卦学习 · 数据库结构（完整版 · 幂等 · 不删数据）
-- 文件：db/schema.sql
-- ============================================================================
-- 来源：docs/api-contract.md §三「数据模型」—— 本文件是该节的可执行版。
--
-- ✅ **本文件是仓库里唯一的权威建表脚本**（现状全量）：任何时候对着云库跑一遍，
--    结构就与契约一致。2026-10-04 起由 `db/schema.full.sql` 归并而来（Day 14 曾用那个名字）。
--
-- 与仓库里另外两处 SQL 的分工（别混）：
--   db/migrations/            已执行过的迁移流水账（按时间顺序），**不要改它**。
--   db/schema.day12-draft.sql  Day 12 的 4 表草稿（当时「尚未在任何真实库上执行过」），
--                              仅作历史留档 —— **它缺第 5 张表 gilded 与 4 条 CHECK 约束，别照它执行**。
--   db/seed.sql               示例数据（幂等；只写 demo-yijing64-user-a ~ -e 五个示例 uid）。
--
-- 幂等：全部对象用 if not exists / or replace / drop ... if exists 前置，可反复执行；
--       **不含 drop table**，因此可以在已有真实数据的库上安全运行。
--       需要在全新空库上从零重建时，用文末「附录 A」——那是本文件唯一含 drop 的地方。
--
-- 两条红线核对（PRD §7.3）：
--   ① 起卦只存 date / hexagram_id / changing_lines，**不存精确时刻**
--      （created_at 是数据库写入时间，不是用户行为时刻；业务日期只认 date 列）
--   ② **不采集任何身份信息**——没有姓名 / 手机 / 邮箱 / IP / 设备指纹字段；
--      uid 来自平台匿名登录，仅用于行级隔离
--
-- ----------------------------------------------------------------------------
-- 与线上库的一致性（Day 14 只读实测 · 库 yijing-64-d1g9uvmlkf13c8f77）
-- ----------------------------------------------------------------------------
--   表        5 张全部存在，主键与列名逐一对齐（23 列）
--   RLS       5 张全部开启
--   策略      14 条，与本文件 §5 完全一致
--   约束      5 条主键 + 6 条 CHECK（含本文件新增的 4 条，见 §3）
--             ✅ 4 条新增的约束已于 2026-10-02 落库（迁移 20261002234609），加之前实测现有数据 0 违规
--   外键      0 条 —— 不是遗漏，理由见 §3 末尾
--   授权      anon / authenticated 已可读写（见 §6）
--
-- ----------------------------------------------------------------------------
-- 在控制台执行的步骤
-- ----------------------------------------------------------------------------
--   1. CloudBase 控制台 → 数据库 → PostgreSQL → 打开 SQL 编辑器
--   2. 整份粘贴本文件并执行（全是 DDL，通常几秒内完成）
--   3. 看 §7 的输出（本文件末尾是**可直接运行的只读自检查询**，执行完会一并打印）
--   4. 可选：接着执行 db/seed.sql 灌示例数据
--      （它只写两个示例 uid 的行，不会碰到任何真实用户的数据）
--
-- ✅ 本文件相对 Day 12 线上库的唯一结构变化（新增 4 条 CHECK 约束 + 1 条索引 + 1 条列注释）
--    **已于 2026-10-02 落库**（迁移 `20261002234609_add_check_constraints_and_index`）——
--    库已是这个状态时再跑本文件是**空操作**（全部 if not exists / drop if exists）。
--    若要在别的库上执行，先跑 §7 的「④ 数据违规扫描」确认返回 0 行（有脏数据时第 3 节会整节回滚）。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. 当前用户标识（行级权限的唯一依赖）
-- ----------------------------------------------------------------------------
-- 为什么包一层：CloudBase PG 的「当前用户」函数名在 Day 12 已核实为 auth.uid()，
-- 但包一层之后，万一平台改名，**只改这一行**，14 条策略全都不用动。
create or replace function public.current_uid() returns text
  language sql
  stable
as $$
  select auth.uid()::text
$$;

comment on function public.current_uid() is
  '行级权限用的当前用户标识（Day 12 已在真库核实：auth.uid()）。策略里一律调它，不直接写函数名。';


-- ----------------------------------------------------------------------------
-- 1. 五张表
-- ----------------------------------------------------------------------------
-- 表名 / 列名 / 类型全部来自 docs/api-contract.md §三，不另造。
-- 卦象主数据（64 卦 + 384 爻辞）是**只读素材**，留在仓库 data/*.json 里，**不入库**
-- —— 见契约 §三的说明，这也是本库没有外键的原因（§3 末）。

-- 1.1 起卦记录（契约 §四 · 二）
-- 主键 (uid, date) 就是「一天一条」的硬约束，不靠应用层查重。
create table if not exists public.divination_records (
  uid            text        not null,                       -- 匿名登录的用户标识，仅用于隔离
  date           date        not null,                       -- 业务日期，一天一条
  hexagram_id    smallint    not null,                        -- 卦序号 1–64
  changing_lines smallint[]  not null default '{}',           -- 变爻位置（1–6），可为空数组
  created_at     timestamptz not null default now(),           -- 写库时间（非用户行为时刻）
  constraint divination_records_pkey primary key (uid, date),
  constraint divination_records_hexagram_id_check check (hexagram_id between 1 and 64)
);

comment on table public.divination_records is
  'PRD F8：每日第一卦自动存档。主键 (uid, date) 用数据库强制「一天一条」。'
  '刻意不存精确时刻，也不把业务日期存成 timestamptz。';

comment on column public.divination_records.date is
  '业务日期，由服务端按 Asia/Shanghai 取（云函数默认 UTC，跨零点必须显式转，见契约 V3）。';


-- 1.2 收藏（契约 §四 · 三）
-- 主键 (uid, hexagram_id) 保证同一卦不会重复收藏。
create table if not exists public.favorites (
  uid         text        not null,
  hexagram_id smallint    not null,
  created_at  timestamptz not null default now(),
  constraint favorites_pkey primary key (uid, hexagram_id),
  constraint favorites_hexagram_id_check check (hexagram_id between 1 and 64)
);

comment on table public.favorites is
  'PRD F8：收藏某一卦。接口返回的 createdAt 只到日，与「不存精确时刻」同口径。';


-- 1.3 学习进度（契约 §四 · 四）
-- 一人一行，是五张表里**唯一允许 UPDATE** 的一张（进度本来就要累加）。
create table if not exists public.study_progress (
  uid            text        not null,
  answered_total integer     not null default 0,
  correct_total  integer     not null default 0,
  wrong_ids      smallint[]  not null default '{}',            -- 错题本（卦序号）
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint study_progress_pkey primary key (uid)
);

comment on table public.study_progress is
  'PRD F3：测验累计进度（作答数 / 正确数 / 错题）。一人一行，允许 update。';


-- 1.4 每轮成绩流水（契约 §四 · 四）
-- 只增不改：没有 UPDATE 策略（见 §5）。
create table if not exists public.study_rounds (
  id         bigserial   not null,                             -- 流水号，由 study_rounds_id_seq 分配
  uid        text        not null,
  score      smallint    not null,
  total      smallint    not null default 8,                   -- 一轮 8 题（Day 11 定稿）
  created_at timestamptz not null default now(),
  constraint study_rounds_pkey primary key (id)
);

comment on table public.study_rounds is
  'PRD F3：每轮的得分流水，用于展示分数变化。只增不改（没有 UPDATE / DELETE 策略）。';
comment on column public.study_rounds.total is
  '一轮题数。Day 11 由 20 改为 8，默认值 8；历史行的旧值保留不再改。';


-- 1.5 镀金成就（契约 §四 · 五）
-- 成就只增不减，所以**没有 DELETE 策略**（见 §5）。
create table if not exists public.gilded (
  uid          text        not null,
  hexagram_ids smallint[]  not null default '{}',              -- 已镀金的卦序号
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint gilded_pkey primary key (uid)
);

comment on table public.gilded is
  'PRD F3 镀金成就：一人一行、卦序号数组。写接口是 PUT 取并集，永不删除。';


-- ----------------------------------------------------------------------------
-- 2. 索引
-- ----------------------------------------------------------------------------
-- 记录列表按 date 倒序取（契约 2.1）、成绩流水按时间倒序取（4.1），各配一条。
create index if not exists idx_records_uid_date
  on public.divination_records (uid, date desc);

create index if not exists idx_rounds_uid_time
  on public.study_rounds (uid, created_at desc);


-- ----------------------------------------------------------------------------
-- 3. 必要约束（幂等写法：先 drop if exists，再 add）
-- ----------------------------------------------------------------------------
-- 这里用「先删后加」而不是直接 add：表可能已存在（线上就是这样），
-- 直接 add 会报 duplicate_object，脚本就不再可重复执行了。
--
-- 下面 4 条由迁移 `20261002234609` 于 2026-10-02 加入，现已生效（线上原本只有 hexagram_id 的范围 CHECK）。
--    它们把契约里的校验规则下沉到数据库层：
--      · 变爻只能是 1–6            ← 契约 2.2 的 422 规则
--      · 镀金数组只能是 1–64       ← 契约 5.2 的 422 规则
--      · 正确数不超过作答数、均非负 ← 契约 4.4 的 422 规则
--      · 得分不超过题数、题数为正   ← 契约 4.2 的 422 规则
--    服务端仍要校验（要返回 422 给客户端），这里是**第二道闸**。
--
--    `<@` 是「数组被包含于」：空数组也满足，正合「可以没有变爻」。
--    加之前请确认现有数据合法，跑 §7 的「④ 数据违规扫描」应返回 0 行。

-- 3.1 起卦记录
alter table public.divination_records drop constraint if exists divination_records_hexagram_id_check;
alter table public.divination_records add  constraint divination_records_hexagram_id_check
  check (hexagram_id between 1 and 64);

alter table public.divination_records drop constraint if exists divination_records_changing_lines_check;
alter table public.divination_records add  constraint divination_records_changing_lines_check
  check (changing_lines <@ '{1,2,3,4,5,6}'::smallint[]);

-- 3.2 收藏
alter table public.favorites drop constraint if exists favorites_hexagram_id_check;
alter table public.favorites add  constraint favorites_hexagram_id_check
  check (hexagram_id between 1 and 64);

-- 3.3 学习进度
alter table public.study_progress drop constraint if exists study_progress_totals_sane;
alter table public.study_progress add  constraint study_progress_totals_sane
  check (answered_total >= 0 and correct_total >= 0 and correct_total <= answered_total);

-- 3.4 成绩流水
alter table public.study_rounds drop constraint if exists study_rounds_score_sane;
alter table public.study_rounds add  constraint study_rounds_score_sane
  check (score >= 0 and total > 0 and score <= total);

-- 3.5 镀金
alter table public.gilded drop constraint if exists gilded_hexagram_ids_check;
alter table public.gilded add  constraint gilded_hexagram_ids_check
  check (hexagram_ids <@ '{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64}'::smallint[]);


-- ── 为什么本库没有外键（不是遗漏）──────────────────────────────────────────
-- 要求里写了「含主键、外键、必要约束」，但本项目**没有可挂的外键**，原因是结构决定的：
--   · 五张表都以 uid 隔离，而 uid 来自平台匿名登录 —— **库里没有 users 表**，无从引用
--   · hexagram_id / hexagram_ids 指向的是**卦象主数据**，而契约 §三 明确「不入库」
--     （64 卦 + 384 爻辞留在仓库 data/*.json，前端随包加载）
-- 硬加外键只有一条路：造一张 hexagrams(id) 参照表，把 64 个序号灌进去。
-- 那样做要改契约、要再加一次迁移，而且等于把只读素材复制进库。
-- **如果课程明确要求必须有外键**，用「附录 B」——那是可选启用，默认不执行。


-- ----------------------------------------------------------------------------
-- 4. 行级权限（RLS）：每个人只能看见和改自己的行
-- ----------------------------------------------------------------------------
-- RLS 是**真正的闸门**；表级授权（§6）给得宽一些也无妨，策略会把它收回来。
alter table public.divination_records enable row level security;
alter table public.favorites          enable row level security;
alter table public.study_progress     enable row level security;
alter table public.study_rounds       enable row level security;
alter table public.gilded             enable row level security;


-- ----------------------------------------------------------------------------
-- 5. 策略（幂等写法：先 drop if exists，再 create）
-- ----------------------------------------------------------------------------
-- 注意「谁**没有**策略」也是设计的一部分，见每段末尾的说明。

-- 5.1 起卦记录：可读 / 可写 / 可删，**刻意不建 UPDATE 策略**
drop policy if exists "read own records"   on public.divination_records;
drop policy if exists "insert own records" on public.divination_records;
drop policy if exists "delete own records" on public.divination_records;

create policy "read own records"   on public.divination_records
  for select using (uid = public.current_uid());

create policy "insert own records" on public.divination_records
  for insert with check (uid = public.current_uid());

create policy "delete own records" on public.divination_records
  for delete using (uid = public.current_uid());

-- ⚠️ 「不建 UPDATE 策略」是刻意的：让 F8「记录不可事后编辑」成为**数据库层的硬约束**，
--    前端再怎么改也改不了已存的记录。

-- 5.2 收藏：可读 / 可写 / 可删（收藏本就是可撤销的）
drop policy if exists "read own favorites"   on public.favorites;
drop policy if exists "insert own favorites" on public.favorites;
drop policy if exists "delete own favorites" on public.favorites;

create policy "read own favorites"   on public.favorites
  for select using (uid = public.current_uid());

create policy "insert own favorites" on public.favorites
  for insert with check (uid = public.current_uid());

create policy "delete own favorites" on public.favorites
  for delete using (uid = public.current_uid());

-- 5.3 学习进度：唯一允许 UPDATE 的表
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

-- 5.4 成绩流水：只增不改（没有 UPDATE 策略）
drop policy if exists "read own rounds"   on public.study_rounds;
drop policy if exists "insert own rounds" on public.study_rounds;

create policy "read own rounds"   on public.study_rounds
  for select using (uid = public.current_uid());

create policy "insert own rounds" on public.study_rounds
  for insert with check (uid = public.current_uid());

-- 5.5 镀金成就：可读 / 可写，**刻意不建 DELETE 策略**
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

-- ⚠️ 「不建 DELETE 策略」是刻意的：镀金是**成就**，不是记录，
--    永远不参与「清空我的记录」（契约 §四 · 6.2 同口径）。


-- ----------------------------------------------------------------------------
-- 6. 授权（表级 ACL）
-- ----------------------------------------------------------------------------
-- 与线上库现状一致（Day 14 只读实测）。RLS 在授权之上再收一层，
-- 所以这里给得宽不会导致越权；但**能出网的 anon 角色拿到 update/delete 是不必要的敞口**，
-- 想收紧就用文末「附录 C」。
grant select, insert, update, delete on public.divination_records to anon, authenticated;
grant select, insert, update, delete on public.favorites          to anon, authenticated;
grant select, insert, update, delete on public.study_progress     to anon, authenticated;
grant select, insert, update, delete on public.study_rounds       to anon, authenticated;
grant select, insert, update         on public.gilded             to anon, authenticated;

-- 成绩流水的流水号是 identity 列，插入需要序列权限（否则 anon 会被序列挡住）。
grant usage, select on all sequences in schema public to anon, authenticated;


-- ============================================================================
-- 7. 执行后的自检（下面四条都是**只读**的，执行本文件时会把结果一并打印出来）
-- ============================================================================

-- ① 五张表 + RLS 是否就位（应 5 行，rls_enabled 全为 true）
select tablename, rowsecurity as rls_enabled
  from pg_tables
 where schemaname = 'public'
   and tablename in ('divination_records','favorites','study_progress','study_rounds','gilded')
 order by tablename;

-- ② 约束清单（应 5 条 p 主键 + 6 条 c 检查，其中 changing_lines / totals / score / gilded 由本次迁移新加）
select conrelid::regclass::text as tbl, conname, contype, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where connamespace = 'public'::regnamespace
   and conrelid::regclass::text in ('divination_records','favorites','study_progress','study_rounds','gilded')
 order by tbl, contype, conname;

-- ③ 策略清单（应 14 条）
--    预期「缺什么」：divination_records 无 UPDATE、study_rounds 无 UPDATE/DELETE、gilded 无 DELETE
select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public'
 order by tablename, cmd;

-- ④ 数据违规扫描（应在**执行前**先跑：全部为 0 才说明可以安全加约束）
select 'progress_bad' as k, count(*)::text as bad_rows
  from public.study_progress
 where answered_total < 0 or correct_total < 0 or correct_total > answered_total
union all
select 'rounds_bad', count(*)::text
  from public.study_rounds
 where score < 0 or total <= 0 or score > total
union all
select 'records_lines_bad', count(*)::text
  from public.divination_records
 where exists (select 1 from unnest(changing_lines) v where v < 1 or v > 6)
union all
select 'favorites_bad', count(*)::text
  from public.favorites
 where hexagram_id < 1 or hexagram_id > 64
union all
select 'gilded_bad', count(*)::text
  from public.gilded
 where exists (select 1 from unnest(hexagram_ids) v where v < 1 or v > 64);


-- ============================================================================
-- 附录 A｜空库重建（⚠️ 唯一含 drop 的地方 · 默认不执行）
-- ============================================================================
-- 只用于**全新的空库**。它会删掉五张表连同全部数据。
-- 在已经有人用过的库上执行 = 清空所有用户的记录，**不可恢复**。
-- 真要重建，请先把这四行取消注释，并把本文件其余部分照常执行。
--
-- drop table if exists public.divination_records cascade;
-- drop table if exists public.favorites          cascade;
-- drop table if exists public.study_progress     cascade;
-- drop table if exists public.study_rounds       cascade;
-- drop table if exists public.gilded             cascade;


-- ============================================================================
-- 附录 B｜可选：加一张卦象参照表来启用外键（默认不执行）
-- ============================================================================
-- 仅当「必须体现外键」时才启用。它只存 64 个序号，**不复制卦辞爻辞**（内容仍留在 data/*.json）。
-- 启用后要同步更新 docs/api-contract.md §三（否则契约与库就不一致了）。
--
-- create table if not exists public.hexagrams (
--   id smallint primary key check (id between 1 and 64)
-- );
--
-- insert into public.hexagrams (id)
-- select g from generate_series(1, 64) as g
-- on conflict (id) do nothing;
--
-- alter table public.divination_records drop constraint if exists divination_records_hexagram_fk;
-- alter table public.divination_records add  constraint divination_records_hexagram_fk
--   foreign key (hexagram_id) references public.hexagrams (id);
--
-- alter table public.favorites drop constraint if exists favorites_hexagram_fk;
-- alter table public.favorites add  constraint favorites_hexagram_fk
--   foreign key (hexagram_id) references public.hexagrams (id);
--
-- alter table public.hexagrams enable row level security;
-- create policy "read hexagrams" on public.hexagrams for select using (true);
-- grant select on public.hexagrams to anon, authenticated;
--
-- 注意：gilded.hexagram_ids 是数组，**外键管不到数组元素**，只能靠 §3.5 的 CHECK。


-- ============================================================================
-- 附录 C｜可选：把表级授权收紧到与策略一致（默认不执行）
-- ============================================================================
-- 现状是 anon 对四张表都有 update/delete 的**表级**权限，靠 RLS 挡住。
-- 更彻底的做法是连表级也收掉 —— 以下是收紧后的最小集，与 §5 的策略一一对应：
--
-- revoke update, delete on public.divination_records from anon;   -- 记录不可改
-- revoke update         on public.favorites          from anon;   -- 收藏只增删
-- revoke delete         on public.study_progress     from anon;   -- 进度只增改
-- revoke update, delete on public.study_rounds       from anon;   -- 流水只增
-- revoke delete         on public.gilded             from anon;   -- 成就不可删
