-- 迁移 20261013020000（2026-10-13）
-- 背景：Publishable Key 的匿名会话在清掉本地持久化后 sub='anon'，
-- auth.uid() 返回字符串 'anon'；原写策略 (uid = current_uid()) 两边都是 'anon' 被放行，
-- 导致不同访客的起卦记录/收藏/进度/镀金互相可见（已实测复现串号）。
-- 范围：只收紧 7 条写策略（5 张表 INSERT + gilded/study_progress UPDATE）。
-- 不动读策略、不动数据、不动索引。NULL 身份本来就被 (uid = NULL) 拒绝。
-- 回滚：把各策略 with_check/qual 改回 (uid = current_uid())。

ALTER POLICY "insert own records" ON public.divination_records
  WITH CHECK (uid = current_uid() AND current_uid() <> 'anon'::text);

ALTER POLICY "insert own favorites" ON public.favorites
  WITH CHECK (uid = current_uid() AND current_uid() <> 'anon'::text);

ALTER POLICY "insert own gilded" ON public.gilded
  WITH CHECK (uid = current_uid() AND current_uid() <> 'anon'::text);

ALTER POLICY "insert own progress" ON public.study_progress
  WITH CHECK (uid = current_uid() AND current_uid() <> 'anon'::text);

ALTER POLICY "insert own rounds" ON public.study_rounds
  WITH CHECK (uid = current_uid() AND current_uid() <> 'anon'::text);

ALTER POLICY "update own gilded" ON public.gilded
  USING (uid = current_uid() AND current_uid() <> 'anon'::text)
  WITH CHECK (uid = current_uid() AND current_uid() <> 'anon'::text);

ALTER POLICY "update own progress" ON public.study_progress
  USING (uid = current_uid() AND current_uid() <> 'anon'::text)
  WITH CHECK (uid = current_uid() AND current_uid() <> 'anon'::text);
