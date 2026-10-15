# -*- coding: utf-8 -*-
"""
verify-project：易经六十四卦项目 · 发布前检查
把历史踩坑固化为逐项 PASS/FAIL/WARN 检查。纯标准库，无第三方依赖。

用法：
    python .workbuddy/skills/verify-project/scripts/verify.py
退出码：有 FAIL → 1；否则 0（WARN 不阻塞）。

判定三态：
    PASS  符合通过标准
    FAIL  不符合（退出码 1，发布前必须处理）
    WARN  需人工确认（不阻塞；检查器无法静态判定的灰区）
"""
import os
import re
import subprocess
import sys
import urllib.request
import json
from pathlib import Path

# ---- 定位项目根：从本文件向上找含 AGENTS.md + src/ 的目录 ----
HERE = Path(__file__).resolve()
ROOT = next((p for p in HERE.parents if (p / 'AGENTS.md').exists() and (p / 'src').is_dir()), None)
if ROOT is None:
    print('找不到项目根（含 AGENTS.md 与 src/ 的目录）'); sys.exit(2)

RESULTS = []   # (id, name, status, evidence)


def report(cid, name, ok, evidence, warn=False):
    status = 'PASS' if ok else ('WARN' if warn else 'FAIL')
    RESULTS.append((cid, name, status, str(evidence)))
    return ok


def sh(args, cwd=ROOT, timeout=60):
    """跑命令，返回 (returncode, stdout+stderr 文本)"""
    try:
        r = subprocess.run(args, cwd=str(cwd), capture_output=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).decode('utf-8', 'replace')
    except Exception as e:  # noqa: BLE001
        return 99, '命令执行失败: %s' % e


def git(args):
    return sh(['git'] + args)


def read(p):
    return (ROOT / p).read_text(encoding='utf-8')


def lines_of(p):
    return (ROOT / p).read_text(encoding='utf-8').split('\n')


def strip_comment_lines(text):
    """去掉 JS/JSX/CSS/Python 的注释行（行首判定，够用且可解释）；
    检查器只扫非注释行 —— 规则注释里出现禁词/模式串不算违规。"""
    out = []
    for ln in text.split('\n'):
        s = ln.strip()
        if s.startswith(('*', '//', '/*', '*/', '#')):
            continue
        out.append(ln)
    return '\n'.join(out)


def grep_tree(pattern, subdir, exclude_comments=True):
    """在 subdir 的所有文本文件里搜正则，返回 [(相对路径, 行号, 行内容摘录)]"""
    hits = []
    base = ROOT / subdir
    if not base.is_dir():
        return hits
    for fp in sorted(base.rglob('*')):
        if not fp.is_file() or fp.suffix not in ('.js', '.jsx', '.ts', '.tsx', '.css', '.md', '.json', '.sql'):
            continue
        try:
            text = fp.read_text(encoding='utf-8')
        except Exception:  # noqa: BLE001
            continue
        if exclude_comments:
            text = strip_comment_lines(text)
        for i, ln in enumerate(text.split('\n'), 1):
            if re.search(pattern, ln):
                hits.append((str(fp.relative_to(ROOT)), i, ln.strip()[:90]))
    return hits


# ============================================================
# A. 密钥与配置（上线红线）
# ============================================================
KEY_PATTERNS = [
    r'AKID[0-9A-Za-z]{10,}',                          # 腾讯云 SecretId 真实值
    r'AKIA[0-9A-Z]{16}',                              # AWS 风格 Key
    r'eyJhbGci',                                      # JWT（Publishable Key 数值）
    r'-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',  # 私钥（不匹配文档里的省略号示例）
    r'(secret_key|client_secret|access_token)\s*[=:]\s*[\'"]?[A-Za-z0-9._-]{16,}',  # 赋了真实长度值的密钥字段
]
KEY_RE = '|'.join(KEY_PATTERNS)

# A1 当前树（已跟踪文件）无密钥特征值
SELF_DIR = '.workbuddy/skills/verify-project/'  # 检查器自身：模式定义必然含特征词字面量，排除（否则自查匹配自己）


def is_cmd_example(line):
    """git grep 输出 '<rev>:<path>:<ln>:<content>'；content 以 -e 开头的是
    docs/security-checklist.md 里的扫描命令示例（文档教人怎么搜，必然含特征词字面量，
    但不是密钥）——排除它，保留真实赋值/密钥行。"""
    parts = line.split(':', 3)
    content = parts[3] if len(parts) > 3 else line
    return bool(re.match(r'\s*-e\s', content))


def is_self_dir(line):
    """检查器自身的源码/文档：KEY_PATTERNS 的定义处，必然含特征词字面量。"""
    return SELF_DIR in line


rc, out = git(['grep', '-nE', KEY_RE, 'HEAD'])
tree_hits = [l for l in out.split('\n') if l.strip() and not l.startswith('fatal')
             and not is_cmd_example(l) and not is_self_dir(l)]
report('A1', '当前树无密钥特征值', len(tree_hits) == 0,
       "git grep -nE '<密钥特征集>' HEAD → %d 命中%s（已排除检查器自身目录与自查文档的命令示例行）"
       % (len(tree_hits), '；' + '；'.join(tree_hits[:3]) if tree_hits else ''))

# A2 全 Git 历史 blob 无密钥特征值
rc, revs_raw = git(['rev-list', '--all'])
revs = revs_raw.split()
rc2, out2 = git(['grep', '-nE', KEY_RE] + revs)
hist_hits = [l for l in out2.split('\n') if l.strip() and not l.startswith('fatal')
             and not is_cmd_example(l) and not is_self_dir(l)]
report('A2', '全 Git 历史（%d 个提交）无密钥特征值' % len(revs), len(hist_hits) == 0,
       "git grep -nE '<特征集>' $(git rev-list --all) → %d 命中%s（已排除检查器自身目录与自查文档的命令示例行）"
       % (len(hist_hits), '；' + '；'.join(hist_hits[:3]) if hist_hits else ''))

# A3 .env 不被跟踪且被忽略；.env.example 被跟踪
rc, tracked = git(['ls-files'])
tracked_env = [l for l in tracked.split('\n') if l.strip().endswith('.env') or l.strip() == '.env']
rc3, ignore_out = git(['check-ignore', '.env'])
env_ignored = rc3 == 0
example_tracked = '.env.example' in tracked.split('\n')
report('A3', '.env 不入库且被忽略 / .env.example 入库',
       (not any(t == '.env' for t in tracked_env)) and env_ignored and example_tracked,
       '被跟踪的 env 文件=%s；.env 被忽略=%s；.env.example 被跟踪=%s' % (tracked_env or '无', env_ignored, example_tracked))

# A4 .env.example 只含占位（无真实长度值）
ex = read('.env.example')
ex_bad = [l for l in ex.split('\n') if re.search(r'=\s*[\'"]?[A-Za-z0-9._-]{16,}', l)]
report('A4', '.env.example 仅占位（无真实长度值）', len(ex_bad) == 0,
       '赋长值的行=%d%s' % (len(ex_bad), '；' + '；'.join(ex_bad[:3]) if ex_bad else '（四项均为空占位）'))

# ============================================================
# B. 环境变量
# ============================================================
# B1 src 用到的 VITE_ 变量都在 .env.example 有占位
src_text = '\n'.join(read(p) for p in ['src/storage.js', 'src/App.jsx', 'src/identity.js'] if (ROOT / p).exists())
used = sorted(set(re.findall(r'import\.meta\.env\.(VITE_\w+)', src_text)))
missing = [v for v in used if (v + '=') not in ex]
report('B1', 'src 使用的 VITE_ 变量均在 .env.example 占位', len(missing) == 0,
       '使用=%s；缺占位=%s' % (used or '无', missing or '无'))

# B2 src 无硬编码密钥回退（PUB_KEY/API_BASE 等直接赋长值）
hard = grep_tree(r"(PUB_KEY|API_BASE|SECRET|TOKEN)\s*=\s*['\"][A-Za-z0-9._-]{16,}", 'src')
report('B2', 'src 无硬编码密钥回退值', len(hard) == 0,
       '%d 处%s' % (len(hard), '；' + '；'.join('%s:%d' % h[:2] for h in hard[:3]) if hard else ''))

# ============================================================
# C. 错误处理（Day 23）
# ============================================================
# C1 errorText.js 三类齐全 + 三组件引用
et = ROOT / 'src/errorText.js'
et_ok = et.exists()
et_text = read('src/errorText.js') if et_ok else ''
three = all(k in et_text for k in ("input:", 'network:', 'server:'))
refs = {f: ('friendlyError' in read('src/' + f)) for f in ('App.jsx', 'Records.jsx', 'RestoreNotice.jsx')}
report('C1', 'errorText.js 三类中文提示 + App/Records/RestoreNotice 引用',
       et_ok and three and all(refs.values()),
       '文件存在=%s；三类齐全=%s；引用=%s' % (et_ok, three, refs))

# C2 用户可见位置直展 (e|err).message 的灰区（契约中文源豁免 → WARN）
raw_sites = []
for f in ('App.jsx', 'Records.jsx', 'RestoreNotice.jsx'):
    p = ROOT / 'src' / f
    if not p.exists():
        continue
    text = p.read_text(encoding='utf-8')
    lines = text.split('\n')
    for i, ln in enumerate(lines):
        if re.search(r'set\w+\(.*\((e|err|error) && \1\.message', ln) or re.search(r'set\w+\(.*(e|err|error)\.message', ln):
            ctx = '\n'.join(lines[max(0, i - 15):i])
            contract_cn = ('importBackupCode' in ctx) or ('exportBackupCode' in ctx)
            raw_sites.append(('%s:%d' % (f, i + 1), '契约中文源豁免' if contract_cn else '需人工确认', ln.strip()[:70]))
need_review = [s for s in raw_sites if s[1] == '需人工确认']
report('C2', '用户可见位置无裸 (e|err).message（契约中文源豁免）', len(need_review) == 0,
       '直展点 %d 处：%s' % (len(raw_sites), '；'.join('%s(%s)' % s[:2] for s in raw_sites) or '无'),
       warn=bool(raw_sites) and len(need_review) < len(raw_sites) and len(need_review) == 0)

# ============================================================
# D. 云端写入与 RLS（Day 19–24 踩坑）
# ============================================================
# D1 云函数非注释行无 upsert / merge-duplicates（RLS 401 坑）
ups = grep_tree(r'resolution=merge-duplicates|on_conflict', 'cloudfunctions')
report('D1', '云无非注释行无 upsert/merge-duplicates（RLS 401 坑）', len(ups) == 0,
       '%d 处%s' % (len(ups), '；' + '；'.join('%s:%d' % h[:2] for h in ups[:3]) if ups else ''))

# D2 favorites 插入用 return=minimal（不带 return=representation）
fav_repo = read('cloudfunctions/api/repositories/favoritesRepository.js') if (ROOT / 'cloudfunctions/api/repositories/favoritesRepository.js').exists() else ''
insert_fn = fav_repo.split('module.exports')[0]
if 'async function insertFavorite' in insert_fn:
    insert_fn = insert_fn.split('async function insertFavorite')[-1]
insert_fn_clean = strip_comment_lines(insert_fn)  # 注释里提及 return=representation 是说明，不算用
report('D2', 'favorites 插入用 Prefer return=minimal',
       "Prefer: 'return=minimal'" in insert_fn_clean and 'return=representation' not in insert_fn_clean,
       "return=minimal 出现=%d 次（insertFavorite 内已排除注释行判定）" % insert_fn_clean.count("return=minimal"))

# D3 删除不带 uid 条件（RLS USING 兜底）
del_ok = "删除**不加 uid 条件**" in fav_repo or 'RLS 保证只能删自己的行' in fav_repo
report('D3', 'favorites 删除不加 uid 条件（RLS 兜底，注释明示）', del_ok,
       '注释明示=%s' % del_ok)

# D4 timestamptz 写完整 ISO（带时区），不塞裸日期
iso_hits = grep_tree(r"\+ 'T00:00:00\+08:00'|\+08:00", 'cloudfunctions')
report('D4', 'timestamptz 写入带时区完整 ISO（不塞 YYYY-MM-DD）', len(iso_hits) >= 1,
       '带 +08:00 的写入点 %d 处：%s' % (len(iso_hits), '；'.join('%s:%d' % h[:2] for h in iso_hits[:3]) or '无'))

# D5 日期格式化不用 Intl 'en-CA'（不保证 ISO）
enca = grep_tree(r"en-CA", 'src') + grep_tree(r"en-CA", 'cloudfunctions')
report('D5', "日期格式化不用 Intl.DateTimeFormat('en-CA')", len(enca) == 0,
       '%d 处%s' % (len(enca), '；' + '；'.join('%s:%d' % h[:2] for h in enca[:3]) if enca else ''))

# D6 云函数时区显式 Asia/Shanghai
tz = grep_tree(r'Asia/Shanghai', 'cloudfunctions')
report('D6', '云函数业务时区显式 Asia/Shanghai', len(tz) >= 1,
       '%d 处' % len(tz))

# ============================================================
# E. 前端规则（R2/R4/R5 + Day 22 层级教训）
# ============================================================
# E1 禁词（排除注释行；「你会」用负向先行排除「你会发现」假阳性）
BAN = r'你会(?!发现)|建议你|不宜|运势|命定|注定|天机|必然'
ban_hits = grep_tree(BAN, 'src')
report('E1', 'src 非注释行禁词零命中（你会/建议你/不宜/运势/命定/注定/天机/必然）',
       len(ban_hits) == 0,
       '%d 处%s' % (len(ban_hits), '；' + '；'.join('%s:%d「%s」' % (h[0], h[1], h[2][:30]) for h in ban_hits[:3]) if ban_hits else ''))

# E2 来源标注无 plain（白话层已整层移除）
plain_hits = grep_tree(r"kind=[\"']plain[\"']|=== 'plain'|[\"']plain[\"']", 'src')
report('E2', '来源标注只有 text/ours（无 plain 白话层）', len(plain_hits) == 0,
       '%d 处%s' % (len(plain_hits), '；' + '；'.join('%s:%d' % h[:2] for h in plain_hits[:3]) if plain_hits else ''))

# E3 繁体仅限测验终局仪式两句（R5）
trad = grep_tree(r'運隨時變|靜神定心', 'src')
trad_files = sorted({h[0] for h in trad})
report('E3', '繁体题字仅出现在 QuizCeremony.jsx（R5）',
       bool(trad_files) and all(f.endswith('QuizCeremony.jsx') for f in trad_files),
       '出现文件=%s（%d 处）' % (trad_files or '无', len(trad)))

# E4 全屏浮层级高于动画层：.qi-stage > .cast-root（Day 22 教训）
def css_z(selector, file):
    try:
        text = read(file)
    except Exception:  # noqa: BLE001
        return None
    m = re.search(re.escape(selector) + r'\s*\{[^}]*?z-index:\s*(\d+)', text, re.S)
    return int(m.group(1)) if m else None

qi = css_z('.qi-stage', 'src/index.css')
cast = css_z('.cast-root', 'src/casting.css')
report('E4', '.qi-stage 层级高于 .cast-root（全屏浮层不被动画盖住）',
       qi is not None and cast is not None and qi > cast,
       '.qi-stage=%s（index.css）；.cast-root=%s（casting.css）' % (qi, cast))

# ============================================================
# F. 文档规范
# ============================================================
# F1 doc-check.py 全过
py = sys.executable
rc_dc, out_dc = sh([py, str(ROOT / '.workbuddy' / 'doc-check.py')])
dc_bad = ('加粗渲染失败: 0' not in out_dc
          or re.search(r'表格问题 [1-9]', out_dc)
          or re.search(r'标题数量问题 [1-9]', out_dc)
          or ('悬空引用 无' not in out_dc and '悬空引用' in out_dc and re.search(r'悬空引用 \[', out_dc)))
report('F1', 'doc-check.py 文档自检全过（加粗/表格/标题/悬空引用）', (rc_dc == 0) and not dc_bad,
       'exit=%d；%s' % (rc_dc, '有问题' if dc_bad else '加粗 0 / 表格 0 / 标题 0 / 悬空引用 无'))

# F2 docs 无内嵌 mermaid（配图必须导出 PNG）
mm = grep_tree(r'```mermaid', 'docs', exclude_comments=False)
report('F2', 'docs 无内嵌 mermaid 代码块（配图走 PNG）', len(mm) == 0,
       '%d 处%s' % (len(mm), '；' + '；'.join('%s:%d' % h[:2] for h in mm[:3]) if mm else ''))

# F3 每个 docs/img 的 .mmd 都有同名 .png 成对
img = ROOT / 'docs' / 'img'
pairs = []
if img.is_dir():
    for mmd in sorted(img.glob('*.mmd')):
        pairs.append((mmd.name, (img / (mmd.stem + '.png')).exists()))
missing_png = [n for n, ok in pairs if not ok]
report('F3', 'docs/img 的 .mmd 与 .png 成对存在', bool(pairs) and not missing_png,
       '共 %d 对：%s' % (len(pairs), '；'.join('%s%s' % (n, '✓' if ok else '✗缺png') for n, ok in pairs) or '无 mmd'))

# ============================================================
# G. 构建
# ============================================================
# G1 vite build 通过（产物落 .workbuddy/dist-verify-<时间戳>）
# ⚠️ 必须每次换新目录：本机沙箱删不掉已存在目录（safe-delete 失败 closed），
#    vite 的 --emptyOutDir 撞上残留目录会整构建失败（deliberate 跑实测踩到）。
import shutil
import time
dist_verify = ROOT / '.workbuddy' / ('dist-verify-%d' % int(time.time()))
# 顺手清旧的 dist-verify / dist-verify-*（删不掉就留着，都在忽略目录里）
for d in [ROOT / '.workbuddy' / 'dist-verify'] + list((ROOT / '.workbuddy').glob('dist-verify-*')):
    if d.exists() and d != dist_verify:
        shutil.rmtree(d, ignore_errors=True)
# Windows 上 npx 是 npx.cmd，不用 shell 会 WinError 2 —— 必须 shell=True
try:
    rb = subprocess.run('npx vite build --outDir .workbuddy/%s --emptyOutDir' % dist_verify.name,
                        cwd=str(ROOT), capture_output=True, timeout=180, shell=True)
    rc_b, out_b = rb.returncode, (rb.stdout + rb.stderr).decode('utf-8', 'replace')
except Exception as e:  # noqa: BLE001
    rc_b, out_b = 99, '命令执行失败: %s' % e
build_ok = rc_b == 0 and 'built in' in out_b
tail = [l for l in out_b.split('\n') if 'built in' in l or 'error' in l.lower()]
report('G1', 'vite build 通过', build_ok,
       'exit=%d；%s' % (rc_b, tail[-1][:80] if tail else out_b.strip().split('\n')[-1][:80]))

# ============================================================
# H. 公网（最小版本必含两项）
# ============================================================
HOSTING = 'https://yijing-64-d1g9uvmlkf13c8f77-1498185256.tcloudbaseapp.com/'
GATEWAY = 'https://yijing-64-d1g9uvmlkf13c8f77-1498185256.ap-shanghai.app.tcloudbase.com'


def http_get(url, timeout=8):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read(200000).decode('utf-8', 'replace')
    except Exception as e:  # noqa: BLE001
        return 0, '%s' % e


st, body = http_get(HOSTING)
report('H1', '静态托管首页可打开（HTTP 200）', st == 200,
       'GET %s → HTTP %s%s' % (HOSTING, st, '' if st == 200 else '（' + body[:60] + '）'))

st2, body2 = http_get(GATEWAY + '/api/health')
health_ok = False
try:
    health_ok = st2 == 200 and json.loads(body2).get('ok') is True
except Exception:  # noqa: BLE001
    pass
report('H2', '健康接口返回 200 且 ok:true', health_ok,
       'GET /api/health → HTTP %s；body 前 80 字: %s' % (st2, body2[:80]))

# ============================================================
# 汇总输出
# ============================================================
W = max(len(r[1]) for r in RESULTS)
print('=' * (W + 46))
print('verify-project · 发布前检查（项目根：%s）' % ROOT)
print('=' * (W + 46))
for cid, name, status, ev in RESULTS:
    mark = {'PASS': '✓', 'FAIL': '✗', 'WARN': '!'}[status]
    print('[%s %-4s] %-*s  %s' % (cid, status, W, name, ev))
n_pass = sum(1 for r in RESULTS if r[2] == 'PASS')
n_fail = sum(1 for r in RESULTS if r[2] == 'FAIL')
n_warn = sum(1 for r in RESULTS if r[2] == 'WARN')
print('-' * (W + 46))
print('合计 %d 项：PASS %d · FAIL %d · WARN %d' % (len(RESULTS), n_pass, n_fail, n_warn))
if n_fail:
    print('结论：存在 FAIL —— 发布前必须处理（详见上方证据）')
else:
    print('结论：无 FAIL%s' % ('（有 %d 项 WARN 需人工确认）' % n_warn if n_warn else ' —— 可以发布'))
sys.exit(1 if n_fail else 0)
