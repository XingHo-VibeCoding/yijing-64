-- 迁移：20261002234609_add_check_constraints_and_index
-- 目的：把四条「必要约束」与一条索引补到线上（Day 14；来源 db/schema.full.sql）
-- 背景：契约 2.2 / 4.2 / 4.4 / 5.2 的 422 规则下沉到数据库层，作为服务端校验之外的第二道闸。
-- 安全性：加约束前已只读扫描现有数据，5 项违规检查全为 0 行。
-- 幂等：索引用 if not exists；约束先 drop if exists 再 add。

-- 1) 索引：记录列表按 date 倒序取（契约 2.1）
create index if not exists idx_records_uid_date
  on public.divination_records (uid, date desc);

-- 2) 变爻只能落在 1–6（空数组合法）
alter table public.divination_records drop constraint if exists divination_records_changing_lines_check;
alter table public.divination_records add  constraint divination_records_changing_lines_check
  check (changing_lines <@ '{1,2,3,4,5,6}'::smallint[]);

-- 3) 镀金数组元素只能落在 1–64
alter table public.gilded drop constraint if exists gilded_hexagram_ids_check;
alter table public.gilded add  constraint gilded_hexagram_ids_check
  check (hexagram_ids <@ '{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64}'::smallint[]);

-- 4) 进度：非负，且正确数不超过作答数
alter table public.study_progress drop constraint if exists study_progress_totals_sane;
alter table public.study_progress add  constraint study_progress_totals_sane
  check (answered_total >= 0 and correct_total >= 0 and correct_total <= answered_total);

-- 5) 成绩：题数为正，且得分不超过题数
alter table public.study_rounds drop constraint if exists study_rounds_score_sane;
alter table public.study_rounds add  constraint study_rounds_score_sane
  check (score >= 0 and total > 0 and score <= total);

-- 6) 补一条线上缺的列注释
comment on column public.study_rounds.total is
  '一轮题数。Day 11 由 20 改为 8，默认值 8；历史行的旧值保留不再改。';
