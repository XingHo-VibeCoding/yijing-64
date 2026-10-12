-- 迁移 20261013005400（2026-10-13）
-- 背景：真实匿名 JWT 的 sub 是一个每次都变的 uid，云函数自行解析并拼 uid 属重复劳动。
-- 真正的把关在 PostgREST 验签 + RLS 的 with check 两层，数据库自己就能按 auth.uid() 填。
-- 范围：只加列默认值。**不改现有数据、不改策略、不改索引。**
-- 回滚：alter table <表> alter column uid drop default;

alter table public.divination_records alter column uid set default auth.uid();
alter table public.favorites        alter column uid set default auth.uid();
alter table public.study_rounds      alter column uid set default auth.uid();
alter table public.study_progress    alter column uid set default auth.uid();
alter table public.gilded            alter column uid set default auth.uid();
