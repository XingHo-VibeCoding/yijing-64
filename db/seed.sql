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
-- 量：五个示例用户，合计 36 行，**每张表都 ≥ 5 行**
-- ----------------------------------------------------------------------------
--   divination_records  9 行   favorites  8 行   study_progress  5 行
--   study_rounds        9 行   gilded     5 行
--   （study_progress 与 gilded 是「一人一行」，所以行数 = 用户数 → 至少要 5 个用户）
--
-- ----------------------------------------------------------------------------
-- 五个示例用户各自代表一种典型状态（刻意做出差异，便于验证不同分支）
-- ----------------------------------------------------------------------------
--   a  连着五天起卦、收藏 3 卦、测验三轮 6→5→7、已镀 2 卦      「老用户」
--   b  只在当天起了一卦、刚做完一轮 5/8、已镀 1 卦              「刚上手」
--   c  起了卦、收藏 2 卦、两轮 5→6、已镀 1 卦
--   d  起了卦、收藏 1 卦、一轮只考 3 分（**不及格**）、**没有任何镀金**（空数组）
--   e  昨天才起卦、一轮 6/8 再一轮 7/8、已镀 1 卦
--   ⚠️ d 的空镀金数组不是漏写 —— 它对应「未达容错、没走到终局仪式」那条路径，
--      而且空数组合法（契约 5.1 允许 hexagramIds 为空）。
--
-- ----------------------------------------------------------------------------
-- ⚠️ 三条安全约定（本文件刻意不 drop、不 truncate）
-- ----------------------------------------------------------------------------
--   1. 「先删」只删**五个示例 uid** 的行。示例 uid 是明文假标识（demo-yijing64-user-a ~ -e），
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
-- 0. 先删：只删示例 uid 的数据（五张表之间没有外键，顺序无关）
-- ----------------------------------------------------------------------------
delete from public.divination_records
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b', 'demo-yijing64-user-c',
               'demo-yijing64-user-d', 'demo-yijing64-user-e');
delete from public.favorites
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b', 'demo-yijing64-user-c',
               'demo-yijing64-user-d', 'demo-yijing64-user-e');
delete from public.study_progress
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b', 'demo-yijing64-user-c',
               'demo-yijing64-user-d', 'demo-yijing64-user-e');
delete from public.study_rounds
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b', 'demo-yijing64-user-c',
               'demo-yijing64-user-d', 'demo-yijing64-user-e');
delete from public.gilded
 where uid in ('demo-yijing64-user-a', 'demo-yijing64-user-b', 'demo-yijing64-user-c',
               'demo-yijing64-user-d', 'demo-yijing64-user-e');


-- ----------------------------------------------------------------------------
-- 1. 起卦记录（契约 2.1 / 2.2）—— 共 9 条
-- ----------------------------------------------------------------------------
-- 用户 a 连着五天各起一卦（09-28 ~ 10-02），用来验「每日第一卦」的连续存档。
-- b / c / d 是同一天（10-02、10-03）各自的第一卦 —— 同一个 date 在不同 uid 下并存，
-- 正好证明「一天一条」是**按 uid 限定**的，不是全库一天只留一条。
-- 变爻刻意覆盖：空数组 / 单条 / 两条 —— 前端「卦起.见爻」那行入口只在有变爻时出现。
insert into public.divination_records (uid, date, hexagram_id, changing_lines, created_at) values
  ('demo-yijing64-user-a', '2026-09-28', 11, '{}',    '2026-09-28 07:40:00+08'),  -- 泰，无变爻
  ('demo-yijing64-user-a', '2026-09-29', 36, '{2}',   '2026-09-29 07:52:00+08'),  -- 明夷，二爻变
  ('demo-yijing64-user-a', '2026-09-30',  1, '{}',    '2026-09-30 07:42:00+08'),  -- 乾，无变爻
  ('demo-yijing64-user-a', '2026-10-01', 63, '{3,5}', '2026-10-01 08:05:00+08'),  -- 既济，两条变爻
  ('demo-yijing64-user-a', '2026-10-02',  2, '{6}',   '2026-10-02 07:31:00+08'),  -- 坤，上爻变
  ('demo-yijing64-user-b', '2026-10-02', 12, '{}',    '2026-10-02 19:38:00+08'),  -- 否，无变爻
  ('demo-yijing64-user-c', '2026-10-02', 25, '{1,4}', '2026-10-02 20:20:00+08'),  -- 无妄，两条变爻
  ('demo-yijing64-user-d', '2026-10-03', 63, '{}',    '2026-10-03 12:05:00+08'),  -- 既济，无变爻
  ('demo-yijing64-user-e', '2026-10-03', 55, '{}',    '2026-10-03 21:02:00+08')   -- 丰，无变爻
on conflict (uid, date) do update
  set hexagram_id    = excluded.hexagram_id,
      changing_lines = excluded.changing_lines,
      created_at     = excluded.created_at;


-- ----------------------------------------------------------------------------
-- 2. 收藏（契约 3.1 / 3.2 / 3.3）—— 共 8 条
-- ----------------------------------------------------------------------------
-- 主键 (uid, hexagram_id) 保证同一卦不会被重复收藏；d 与 a 都收藏了既济，互不影响。
insert into public.favorites (uid, hexagram_id, created_at) values
  ('demo-yijing64-user-a',  1, '2026-09-30 07:45:00+08'),
  ('demo-yijing64-user-a', 63, '2026-10-01 08:09:00+08'),
  ('demo-yijing64-user-a', 11, '2026-09-28 08:00:00+08'),
  ('demo-yijing64-user-b', 12, '2026-10-02 19:41:00+08'),
  ('demo-yijing64-user-c', 25, '2026-10-02 20:24:00+08'),
  ('demo-yijing64-user-c', 42, '2026-10-03 08:05:00+08'),
  ('demo-yijing64-user-d', 63, '2026-10-03 12:50:00+08'),
  ('demo-yijing64-user-e', 55, '2026-10-03 21:10:00+08')
on conflict (uid, hexagram_id) do update
  set created_at = excluded.created_at;


-- ----------------------------------------------------------------------------
-- 3. 学习进度（契约 4.3 / 4.4）—— 共 5 条（一人一行，所以 = 用户数）
-- ----------------------------------------------------------------------------
-- a 做了三轮累计 24 次作答、18 次正确（75%）；d 一轮只对 3 个（**低于 PASS_MIN = 5**，
-- 对应「运随时变，切勿焦躁」那条分支）；e 全对 6 个。须满足 CHECK：correct <= answered。
insert into public.study_progress
  (uid, answered_total, correct_total, wrong_ids, created_at, updated_at) values
  ('demo-yijing64-user-a', 24, 18, '{3,7}',    '2026-10-01 20:02:00+08', '2026-10-02 20:14:00+08'),
  ('demo-yijing64-user-b',  8,  5, '{12}',     '2026-10-02 19:52:00+08', '2026-10-02 19:52:00+08'),
  ('demo-yijing64-user-c', 16, 12, '{25,43}',  '2026-10-02 20:05:00+08', '2026-10-03 08:20:00+08'),
  ('demo-yijing64-user-d',  8,  3, '{29,49,55}','2026-10-03 12:40:00+08', '2026-10-03 12:40:00+08'),
  ('demo-yijing64-user-e',  8,  6, '{}',       '2026-10-03 21:05:00+08', '2026-10-04 09:15:00+08')
on conflict (uid) do update
  set answered_total = excluded.answered_total,
      correct_total  = excluded.correct_total,
      wrong_ids      = excluded.wrong_ids,
      updated_at     = excluded.updated_at;


-- ----------------------------------------------------------------------------
-- 4. 成绩流水（契约 4.1 / 4.2）—— 共 9 条
-- ----------------------------------------------------------------------------
-- 注意 id 不写死（由 study_rounds_id_seq 分配），所以本表重复执行后会换新号 —— 这是预期的。
-- a 的成绩走向 6 → 5 → 7，用来验「看到分数变化」；其中 5 与 6 ≥ PASS_MIN 会触发终局仪式，
-- d 的 3 分不会。须满足 CHECK：score <= total 且 total > 0。
insert into public.study_rounds (uid, score, total, created_at) values
  ('demo-yijing64-user-a', 6, 8, '2026-10-01 20:02:00+08'),
  ('demo-yijing64-user-a', 5, 8, '2026-10-02 09:31:00+08'),
  ('demo-yijing64-user-a', 7, 8, '2026-10-02 20:14:00+08'),
  ('demo-yijing64-user-b', 5, 8, '2026-10-02 19:52:00+08'),
  ('demo-yijing64-user-c', 5, 8, '2026-10-02 20:05:00+08'),
  ('demo-yijing64-user-c', 6, 8, '2026-10-03 08:20:00+08'),
  ('demo-yijing64-user-d', 3, 8, '2026-10-03 12:40:00+08'),
  ('demo-yijing64-user-e', 6, 8, '2026-10-03 21:05:00+08'),
  ('demo-yijing64-user-e', 7, 8, '2026-10-04 09:15:00+08');


-- ----------------------------------------------------------------------------
-- 5. 镀金成就（契约 5.1 / 5.2）—— 共 5 条（一人一行）
-- ----------------------------------------------------------------------------
-- d 是空数组：他一轮只考 3 分、从没进过终局仪式，所以没拿到镀金 —— 这是有意的对照。
-- 数组元素须在 1–64（CHECK 会把关）。写接口是 PUT 取并集，永不删除。
insert into public.gilded (uid, hexagram_ids, created_at, updated_at) values
  ('demo-yijing64-user-a', '{1,12}', '2026-10-02 20:15:00+08', '2026-10-02 20:15:00+08'),
  ('demo-yijing64-user-b', '{12}',   '2026-10-02 19:53:00+08', '2026-10-02 19:53:00+08'),
  ('demo-yijing64-user-c', '{25}',   '2026-10-03 08:21:00+08', '2026-10-03 08:21:00+08'),
  ('demo-yijing64-user-d', '{}',     '2026-10-03 12:41:00+08', '2026-10-03 12:41:00+08'),
  ('demo-yijing64-user-e', '{55}',   '2026-10-04 09:16:00+08', '2026-10-04 09:16:00+08')
on conflict (uid) do update
  set hexagram_ids = excluded.hexagram_ids,
      updated_at   = excluded.updated_at;

commit;

-- 合计 36 行示例数据（9 + 8 + 5 + 9 + 5），覆盖五张表，每张都 ≥ 5 行。


-- ============================================================================
-- 验证（下面三条都是只读的，执行本文件时会一并打印结果）
-- ============================================================================

-- ① 各表示例行数：ge_5 列应全为 true（这就是「每张表至少 5 行种子数据」的自检）
select 'divination_records' as tbl,
       count(*) filter (where uid like 'demo-%') as demo_rows,
       (count(*) filter (where uid like 'demo-%') >= 5) as ge_5,
       count(*) as total_rows
  from public.divination_records
union all
select 'favorites', count(*) filter (where uid like 'demo-%'),
       (count(*) filter (where uid like 'demo-%') >= 5), count(*)
  from public.favorites
union all
select 'study_progress', count(*) filter (where uid like 'demo-%'),
       (count(*) filter (where uid like 'demo-%') >= 5), count(*)
  from public.study_progress
union all
select 'study_rounds', count(*) filter (where uid like 'demo-%'),
       (count(*) filter (where uid like 'demo-%') >= 5), count(*)
  from public.study_rounds
union all
select 'gilded', count(*) filter (where uid like 'demo-%'),
       (count(*) filter (where uid like 'demo-%') >= 5), count(*)
  from public.gilded
order by tbl;

-- ② 记录页视角：示例用户 a 的记录列表（应 5 行，按 date 倒序 —— 连着五天的每日首卦）
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
