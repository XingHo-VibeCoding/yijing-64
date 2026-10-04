-- 迁移：20261004221126_add_demo_read_policy
-- 目的：让「示例数据」可被公开读取（Day 17 的 GET 读接口要能在浏览器里直接打开验证）
--
-- 背景：PUBLISHABLE_KEY 的 sub 恒为 'anon'，而既有策略是 `uid = current_uid()`，
--       匹配不到任何行。给它开一条**只读、且只限 demo 前缀**的 SELECT 策略。
--
-- 安全性（三重）：
--   ① 只限 SELECT —— 写接口是 Day 18 的事，今天不开放任何写
--   ② 只限 uid like 'demo-yijing64-user-%' —— 真实 uid 由匿名登录生成、是 UUID 形状，
--      永远匹配不上这个前缀
--   ③ 原有 `uid = current_uid()` 策略原样保留，登录用户读自己的数据完全不受影响
--   → 双重锁定：RLS 是最终闸门。即便有人绕过云函数、直接拿 Publishable Key 打 PostgREST，
--     也只能读到 demo 行，读不到任何真实用户数据。
--
-- 幂等：先 drop policy if exists 再 create。

drop policy if exists "read demo records" on public.divination_records;
create policy "read demo records" on public.divination_records
  for select to anon, authenticated
  using (uid like 'demo-yijing64-user-%');

drop policy if exists "read demo favorites" on public.favorites;
create policy "read demo favorites" on public.favorites
  for select to anon, authenticated
  using (uid like 'demo-yijing64-user-%');
