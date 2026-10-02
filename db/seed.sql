-- ============================================================================
-- 易经六十四卦学习 · 示例数据（可复现 · 可重复执行 · 不碰真实数据）
-- 文件：db/seed.sql
-- ============================================================================
-- 来源：docs/api-contract.md（各接口的响应形状）+ db/schema.full.sql（表结构）
-- 用途：灌一批**固定值**的示例数据，用来核对表结构与接口形状对不对
--       （第 3 周建成表之后、写接口之前就靠它验证）。
-- 前置：先执行 db/schema.full.sql（表得先存在）。
--
-- ----------------------------------------------------------------------------
-- ⚠️ 三条安全约定（本文件刻意不 drop、不 truncate）
-- ----------------------------------------------------------------------------
--   1. 「先删」只删**两个示例 uid** 的行。示例 uid 是明文假标识（demo-yijing64-user-a / -b），
--      而真实 uid 由匿名登录生成、是 UUID 形状 —— **两者不可能相同**，
--      所以无论跑多少遍，都不会碰到任何真实用户的数据。
--   2. 不用 drop / truncate。线上库已有真实数据（Day 14 实测：13 条记录、
--      23 个匿名 uid 的测验进度、27 条成绩、14 条镀金），drop 一次就是全部清空。
--   3. 除删示例行以外，每条 insert 都带 on conflict —— 重复执行不会产生重复数据。
--
-- ----------------------------------------------------------------------------
-- 「可复现」是什么意思
-- ----------------------------------------------------------------------------
--   日期、分数、错题全部写成**字面量**，不用 now() / random()，
--   所以每次执行后查出来的内容完全一样，截图和结果可对照。
--   唯一不固定的是 study_rounds.id（流水号由序列分配，这是对的：
--   写死 id 会让序列停在原地，后来真实的插入就可能撞号）。
--
-- ----------------------------------------------------------------------------
-- 执行步骤
-- ----------------------------------------------------------------------------
--   1. CloudBase 控制台 → 数据库 → PostgreSQL → SQL 编辑器
--   2. 整份粘贴执行
--   3. 看文件末尾三组验证查询的输出（示例数据量 / 记录页视角 / 红线核对）
--   4. 想清掉示例数据：执行文末「清空示例数据」那一段
-- ============================================================================


begin;

-- ----------------------------------------------------------------------------
-- 0. 先删：只删示例 uid 的数据（顺序无关，五张表都没有外键）
-- ----------------------------------------------------------------------------
delete from public.divination_records
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b');
delete from public.favorites
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b');
delete from public.study_progress
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b');
delete from public.study_rounds
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b');
delete from public.gilded
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b');


-- ----------------------------------------------------------------------------
-- 1. 起卦记录（契约 2.1 / 2.2）—— 共 4 条
-- ----------------------------------------------------------------------------
-- 用户 a 连起三天，用户 b 今天刚开始。
-- 刻意覆盖两种情况：**有变爻**（{3,5} / {6}）与**无变爻**（空数组）——
-- 前端「卦起.见爻」那行入口只在有变爻时出现，两种都得有数据才验得到。
insert into public.divination_records (uid, date, hexagram_id, changing_lines, created_at) values
  ('demo-yijing64-user-a', '2026-09-30',  1, '{}',      '2026-09-30 07:42:00+08'),  -- 乾，无变爻
  ('demo-yijing64-user-a', '2026-10-01', 63, '{3,5}',   '2026-10-01 08:05:00+08'),  -- 既济，两条变爻
  ('demo-yijing64-user-a', '2026-10-02',  2, '{6}',     '2026-10-02 07:31:00+08'),  -- 坤，上爻变
  ('demo-yijing64-user-b', '2026-10-02', 12, '{}',      '2026-10-02 19:38:00+08')   -- 否，无变爻
on conflict (uid, date) do update
  set hexagram_id    = excluded.hexagram_id,
      changing_lines = excluded.changing_lines,
      created_at     = excluded.created_at;


-- ----------------------------------------------------------------------------
-- 2. 收藏（契约 3.1 / 3.2 / 3.3）—— 共 3 条
-- ----------------------------------------------------------------------------
insert into public.favorites (uid, hexagram_id, created_at) values
  ('demo-yijing64-user-a',  1, '2026-09-30 07:45:00+08'),
  ('demo-yijing64-user-a', 63, '2026-10-01 08:09:00+08'),
  ('demo-yijing64-user-b', 12, '2026-10-02 19:41:00+08')
on conflict (uid, hexagram_id) do update
  set created_at = excluded.created_at;


-- ----------------------------------------------------------------------------
-- 3. 学习进度（契约 4.3 / 4.4）—— 共 2 条
-- ----------------------------------------------------------------------------
-- 用户 a：三轮做完，累计作答 24、正确 18（正确率 75%），错在 3 / 7 两卦。
-- 用户 b：只做了一轮，8 题对 5（契约 PASS_MIN = 5，刚好够触发终局仪式）。
-- 须满足 CHECK：correct_total <= answered_total。
insert into public.study_progress
  (uid, answered_total, correct_total, wrong_ids, created_at, updated_at) values
  ('demo-yijing64-user-a', 24, 18, '{3,7}',  '2026-10-01 20:02:00+08', '2026-10-02 20:14:00+08'),
  ('demo-yijing64-user-b',  8,  5, '{12}',   '2026-10-02 19:52:00+08', '2026-10-02 19:52:00+08')
on conflict (uid) do update
  set answered_total = excluded.answered_total,
      correct_total  = excluded.correct_total,
      wrong_ids      = excluded.wrong_ids,
      updated_at     = excluded.updated_at;


-- ----------------------------------------------------------------------------
-- 4. 成绩流水（契约 4.1 / 4.2）—— 共 4 条
-- ----------------------------------------------------------------------------
-- 注意 id 不写死（由 study_rounds_id_seq 分配），所以本表重复执行后会换新号 —— 这是预期的。
-- 用户 a 的成绩走向 6 → 5 → 7，正好用来验「看到分数变化」；其中 5 与 6 都 ≥ PASS_MIN。
-- 须满足 CHECK：score <= total 且 total > 0。
insert into public.study_rounds (uid, score, total, created_at) values
  ('demo-yijing64-user-a', 6, 8, '2026-10-01 20:02:00+08'),
  ('demo-yijing64-user-a', 5, 8, '2026-10-02 09:31:00+08'),
  ('demo-yijing64-user-a', 7, 8, '2026-10-02 20:14:00+08'),
  ('demo-yijing64-user-b', 5, 8, '2026-10-02 19:52:00+08');


-- ----------------------------------------------------------------------------
-- 5. 镀金成就（契约 5.1 / 5.2）—— 共 2 条
-- ----------------------------------------------------------------------------
-- 用户 a 镀了两卦，用户 b 镀了一卦。数组元素须在 1–64（CHECK 会把关）。
insert into public.gilded (uid, hexagram_ids, created_at, updated_at) values
  ('demo-yijing64-user-a', '{1,12}', '2026-10-02 20:15:00+08', '2026-10-02 20:15:00+08'),
  ('demo-yijing64-user-b', '{12}',   '2026-10-02 19:53:00+08', '2026-10-02 19:53:00+08')
on conflict (uid) do update
  set hexagram_ids = excluded.hexagram_ids,
      updated_at   = excluded.updated_at;

commit;

-- 合计 15 行示例数据（4 + 3 + 2 + 4 + 2），覆盖五张表。


-- ============================================================================
-- 验证（下面三条都是只读的，执行本文件时会一并打印结果）
-- ============================================================================

-- ① 各表行数：应能看到示例行；「含真实数据」的总数应明显大于示例行数
select 'divination_records' as tbl, count(*) filter (where uid like 'demo-%') as demo_rows,
       count(*) as total_rows
  from public.divination_records
union all
select 'favorites', count(*) filter (where uid like 'demo-%'), count(*)
  from public.favorites
union all
select 'study_progress', count(*) filter (where uid like 'demo-%'), count(*)
  from public.study_progress
union all
select 'study_rounds', count(*) filter (where uid like 'demo-%'), count(*)
  from public.study_rounds
union all
select 'gilded', count(*) filter (where uid like 'demo-%'), count(*)
  from public.gilded
order by tbl;

-- ② 记录页视角：示例用户 a 的记录列表（应 3 行，按 date 倒序）
select date, hexagram_id, changing_lines
  from public.divination_records
 where uid = 'demo-yijing64-user-a'
 order by date desc;

-- ③ 红线核对：示例数据里**不应出现任何身份信息**（姓名 / 手机 / 邮箱）
--    本查询是「自证」—— 字段就这些，库层面压根没有可存身份信息的地方
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('divination_records','favorites','study_progress','study_rounds','gilded')
   and column_name ~ 'name|phone|email|mobile|ip|device'
 order by table_name, column_name;
-- 预期：0 行。


-- ============================================================================
-- 清空示例数据（默认不执行；跑过 seed 之后想收拾干净时用）
-- ============================================================================
-- delete from public.divination_records where uid like 'demo-yijing64-user-%';
-- delete from public.favorites          where uid like 'demo-yijing64-user-%';
-- delete from public.study_progress     where uid like 'demo-yijing64-user-%';
-- delete from public.study_rounds       where uid like 'demo-yijing64-user-%';
-- delete from public.gilded             where uid like 'demo-yijing64-user-%';
--
-- 注意：gilded 在 RLS 下没有 DELETE 策略（成就不参与清空），
--       但控制台是用所有者身份执行，不受 RLS 限制，所以上面这句仍然有效。
