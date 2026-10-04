-- 迁移：20261004230153_scope_demo_policy_to_publishable_key_only
-- 目的：修一个越权读取 —— demo 读策略原先对**已登录用户**也生效。
--
-- 起因（Day 17 收尾时由前端接入实测发现，不是理论推演）：
--   迁移 20261004221126 建的两条策略是
--       create policy "read demo records" ... for select to anon, authenticated
--         using (uid like 'demo-yijing64-user-%');
--   `to anon, authenticated` 意味着**任何已登录用户**都匹配这条策略。
--   于是一个库里 0 行的真实匿名用户，通过通道 A 读 /api/records，
--   拿到了**全部 5 个 demo 用户的 9 条记录**（实测 visible=9 / demo_leaked=9），
--   并被前端 pullAndMerge 合并进了他的本地记录 —— 数据被凭空写进了用户浏览器。
--
-- 修法：demo 行只对「发布用匿名身份」放行，即 auth.uid() 为空或等于 'anon'
--      （Publishable Key 的 sub 恒为 'anon'；真实会话的 sub 是 UUID，
--        两者不可能相等，所以这个判据无法被伪造）。
--
-- 三重安全（修完仍然成立）：
--   ① 仍只限 uid like 'demo-yijing64-user-%'
--   ② 仍只限 SELECT
--   ③ 原有 uid = current_uid() 策略原样保留，登录用户读自己的数据完全不受影响
--
-- 幂等：先 drop policy if exists 再 create。

drop policy if exists "read demo records" on public.divination_records;
create policy "read demo records" on public.divination_records
  for select to anon, authenticated
  using (
    uid like 'demo-yijing64-user-%'
    and (auth.uid() is null or auth.uid() = 'anon')
  );

drop policy if exists "read demo favorites" on public.favorites;
create policy "read demo favorites" on public.favorites
  for select to anon, authenticated
  using (
    uid like 'demo-yijing64-user-%'
    and (auth.uid() is null or auth.uid() = 'anon')
  );
