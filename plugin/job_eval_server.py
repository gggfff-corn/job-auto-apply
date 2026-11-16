#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
求职岗位 AI 评估服务（本地）
==================================
给油猴脚本用：脚本把采集到的岗位 POST 过来，这里用硅基流动的免费模型
（XingChenAGI/Xing4.0-29B 或 THUDM/GLM-Z1-9B-0414）打分并给出"去不去"的判断。

为什么不用脚本直连 API：API key 写进油猴脚本就等于贴在网上，任何人都能拿走。
key 只放在本机，脚本通过 127.0.0.1 调用。

启动：
    python job_eval_server.py                # 默认 127.0.0.1:8765
    python job_eval_server.py --port 8766

接口：
    GET  /health                  → 服务与模型状态
    POST /evaluate  {"jobs":[…]}  → 逐条评估
    POST /company   {"company":…} → 公司口碑检索（必应搜索 + 模型总结）

岗位字段：jobId / platform / title / company / salary / city / tags[] / desc / url
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
# job_scan.py 是可选的：存在时就复用它的 Client/密钥加载与限流重试，
# 不存在也能跑（密钥从 .env 或浏览器面板读）。可用 JOB_SCAN_DIR 指定额外目录。
SCAN_DIRS = [d for d in [
    HERE,
    HERE.parent,
    Path(os.getenv("JOB_SCAN_DIR")) if os.getenv("JOB_SCAN_DIR") else None,
] if d]

sys.path.insert(0, str(HERE))
JOB_SCAN = None
for d in SCAN_DIRS:
    if (d / "job_scan.py").exists():
        sys.path.insert(0, str(d))
        try:
            import job_scan as JOB_SCAN  # noqa: E402
        except Exception as exc:  # pragma: no cover
            print(f"[warn] 载入 job_scan 失败: {exc}")
        break

# 分析模型（都是免费额度）
MODEL_MAIN = os.getenv("EVAL_MODEL") or "XingChenAGI/Xing4.0-29B"
MODEL_FALLBACK = "THUDM/GLM-Z1-9B-0414"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def read_env_value(path, names):
    """从 .env 里读第一个命中的键。不引入 python-dotenv，少一个依赖。"""
    try:
        if not path.exists():
            return None
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() in names:
                v = v.strip().strip('"').strip("'")
                if v:
                    return v
    except Exception:
        pass
    return None

from html import unescape as html_unescape  # noqa: E402


def bing_search(query, limit=6, timeout=15):
    """必应网页搜索（不需要 API Key），只取标题/链接/摘要给模型当参考。
    国内一般能访问 cn.bing.com；失败返回空列表，调用方回落成纯链接。"""
    url = "https://cn.bing.com/search?q=" + requests.utils.quote(query) + "&setlang=zh-CN"
    try:
        resp = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"},
                            timeout=timeout)
        if resp.status_code != 200:
            return []
        page = resp.text
    except requests.RequestException:
        return []

    def clean(s):
        s = re.sub(r"<[^>]+>", "", s or "")
        return html_unescape(s).replace("\u200b", "").strip()

    items = []
    for block in re.findall(r'<li class="b_algo".*?</li>', page, re.S)[:limit]:
        m = re.search(r'<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not m:
            continue
        link = html_unescape(m.group(1))
        title = clean(m.group(2))
        snip = ""
        sm = re.search(r'<p[^>]*>(.*?)</p>', block, re.S)
        if sm:
            snip = clean(sm.group(1))[:220]
        if title and link.startswith("http"):
            items.append({"title": title[:120], "url": link, "snippet": snip})
    return items

SYSTEM = """你是一名做了十年招聘的 HR，私下帮朋友判断岗位值不值得投。
你的判断标准是"真实到手多少钱"和"有没有坑"，不安慰人，不和稀泥。

铁律：
1. 只依据给出的字段判断。字段里没有的（比如没写社保、没写发薪日），判为"信息缺失"，
   放进 flags 里标 unknown，绝对不能编造具体条款。
2. 薪资永远看左不看右。区间上限是话术，下限才是谈判起点。
3. 提成/奖金与销售额、绩效挂钩时，按差额的 20%~40% 折算，不能当保底。
4. 底薪未披露、只写"底薪+提成"的，按当地最低工资量级估保底（三四线 1700-2000，
   二线 2000-2300，一线 2500-2700），并说明是推算。
5. 如果给了【本地已算好的数字】，工时/月薪/时薪直接采用，禁止自己重算、禁止改动，
   你的 flags 里也不要再写工时的具体小时数。
6. 只输出 JSON，不要 markdown 代码块，不要多余文字。

flags 的 level 必须严格区分：
- "hard"：原文【明确写出】的严重问题（12 小时班制、月末发薪、卡 25 岁以下、月工时超 250、
  提成占大头却没底薪数字等）。必须能指到原文里的词。
- "soft"：能忍但要知道（经验要求偏高、包吃住没写清等）。
- "unknown"：原文【没有写】的信息（社保、发薪日、公积金、上下班时间等）。
  信息缺失一律用 unknown，绝对不能标成 hard，也不能编一个具体条款出来。

输出 JSON 结构：
{
  "score": 0-100 的整数（越值得投越高）,
  "verdict": "pass" | "watch" | "reject",
  "real_monthly": "现实月薪区间，如 2800-3400；无法估算写 unknown",
  "hourly": "现实时薪，如 12-15；工时未写写 unknown",
  "flags": [{"level": "hard"|"soft"|"unknown", "text": "一句话，带原文依据"}],
  "reason": "40 字以内，直给结论"
}

打分口径：
- 从 60 分起算。信息完整（写清薪资构成/工时/社保/发薪日）+10；
  底薪明写 +5；社保齐全 +5；工时合规（≤200h/月）+5。
- 扣分：月末或次月发薪 -8；只有五险无公积金 -5；不包吃住 -3；
  单人岗/无人替班 -5；月工时 >250 小时 -12；提成占大头 -8；
  「抗压」「长期稳定」「勿扰」-5；卡年龄 25 岁以下 -5；12 小时以上班制 -8；
  信息严重不足（描述少于 50 字） -10。
- verdict：score ≥70 且无 hard 问题 → pass；40-69 → watch；<40 或有致命 hard → reject。
"""


def build_user_prompt(job, brief=""):
    tags = job.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    part = [
        f"职位：{job.get('title') or '未写'}",
        f"公司：{job.get('company') or '未写'}",
        f"薪资：{job.get('salary') or '未写'}",
        f"城市：{job.get('city') or '未写'}",
        f"标签：{'、'.join(str(t) for t in tags) or '未写'}",
        f"平台：{job.get('platform') or '未知'}",
    ]
    desc = (job.get("desc") or "").strip()
    part.append("岗位描述：" + (desc[:1800] if desc else "（未采集到详情，只有列表页摘要）"))
    if brief:
        part.append("")
        part.append(brief)
    return "\n".join(part)


# ---------------------------------------------------------------- 本地算数
# 小模型算数不可靠（会写出"月工时 171 小时"这种明显错误），所以工时/月薪/时薪一律本地算好，
# 模型只负责判断"值不值得去"。这和 job_scan.py 的做法一致。

NUM = r"(\d+(?:\.\d+)?)"


def parse_salary_to_k(text):
    """"6-7千" → (6,7)；"8-12K" → (8,12)；"6千-1万" → (6,10)；"3000-5000元/月" → (3,5)"""
    if not text:
        return None, None
    t = str(text).replace(" ", "").replace("～", "-").replace("~", "-")

    def to_k(val, unit):
        v = float(val)
        if unit in ("万", "w", "W"):
            return v * 10
        if unit in ("千", "k", "K"):
            return v
        # 无单位：3000 这种按元处理
        return v / 1000 if v >= 100 else v

    # 形式 1：a[单位]-b[单位]，单位可能只写一个（"6千-1万" / "8-12K" / "6-7千"）
    m = re.search(NUM + r"([万千kK]?)\s*-\s*" + NUM + r"([万千kK]?)", t)
    if m:
        v1, u1, v2, u2 = float(m.group(1)), m.group(2), float(m.group(3)), m.group(4)
        if not u1 and not u2:
            return to_k(v1, ""), to_k(v2, "")   # 纯数字，按元
        if not u1:
            u1 = u2
        if not u2:
            u2 = u1
        return to_k(v1, u1), to_k(v2, u2)
    # 形式 2：a单位以上 / a单位起
    m = re.search(NUM + r"([万千kK])", t)
    if m:
        v = to_k(m.group(1), m.group(2))
        return v, v
    # 形式 3：纯数字对，按元
    m = re.search(NUM + r"-" + NUM, t)
    if m:
        return to_k(m.group(1), ""), to_k(m.group(2), "")
    return None, None


def extract_work_time(desc):
    """从描述里抠出上下班时间，返回 (work_time字符串, 午休小时数)"""
    if not desc:
        return "", 0.0
    txt = desc.replace("：", ":").replace("－", "-").replace("—", "-")
    m = re.search(r"(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})", txt)
    wt = f"{m.group(1)}-{m.group(2)}" if m else ""
    lunch = 0.0
    ml = re.search(r"(?:午休|休息|吃饭)[^\d]{0,6}" + NUM + r"\s*(?:个)?\s*小时", txt)
    if ml:
        try:
            lunch = float(ml.group(1))
        except Exception:
            lunch = 0.0
    return wt, lunch


def extract_rest(desc):
    if not desc:
        return ""
    for pat in (r"月休\s*\d+\s*天", r"双休", r"单休", r"上六休一", r"上五休二", r"大小周"):
        m = re.search(pat, desc)
        if m:
            return m.group(0)
    return ""


def local_math(job):
    """返回本地算好的工时/月薪/时薪，以及给模型看的简报。"""
    if not JOB_SCAN:
        return {}, ""
    smin, smax = parse_salary_to_k(job.get("salary"))
    desc = (job.get("desc") or "")
    wt, lunch = extract_work_time(desc)
    rest = extract_rest(desc)
    info = {
        # salary_math 期望的是"元"，这里把 K 换算过去
        "salary_min": int(smin * 1000) if smin else None,
        "salary_max": int(smax * 1000) if smax else None,
        "work_time": wt,
        "rest": rest,
        "full_text": desc or (job.get("title") or "") + " " + (job.get("salary") or ""),
        "benefits_raw": " ".join(job.get("tags") or []) if isinstance(job.get("tags"), list) else str(job.get("tags") or ""),
    }
    try:
        m = JOB_SCAN.salary_math(info, city_tier=job.get("cityTier") or "三四线")
    except Exception:
        return {}, ""
    # 扣午休
    if lunch and m.get("daily_hours"):
        m["daily_hours"] = max(0.5, round(m["daily_hours"] - lunch, 1))
        if m.get("month_days"):
            m["total_hours"] = round(m["daily_hours"] * m["month_days"], 1)

    # 纯固定月薪（没有提成/绩效挂钩）不该按"底薪未披露"砍到最低工资：
    # 8-12K 的运维岗现实就是 7-10K，不是 3-4K。只在薪资确实靠提成时才用最低工资口径。
    commission = bool(re.search(r"提成|绩效|奖金|销售|业绩|计件", desc + " " + str(job.get("tags") or "")))
    if smin and smin >= 6 and not commission:
        m["real_low"] = int(round(smin * 0.9 * 1000 / 50) * 50)
        m["real_high"] = int(round(min(smax or smin, smin * 1.2) * 1000 / 50) * 50)
        m["base_note"] = f"固定月薪区间，按下限 {int(smin * 1000)} 元九折估算"

    # 时薪统一按最终月薪 / 月总工时重算
    if m.get("real_low") and m.get("total_hours"):
        m["hourly_low"] = round(m["real_low"] / m["total_hours"], 1)
        m["hourly_high"] = round(m["real_high"] / m["total_hours"], 1)
    brief = ""
    try:
        brief = JOB_SCAN.math_brief(m)
    except Exception:
        brief = ""
    # 把本地解析出来的事实写清楚，避免模型倒打一耙说"原文没写"
    facts = []
    if wt:
        facts.append(f"上下班时间已写：{wt}" + (f"，午休 {lunch} 小时" if lunch else ""))
    if rest:
        facts.append(f"休息安排已写：{rest}")
    if facts:
        brief = (brief + "\n【原文已写明的事实，不要在 flags 里说它没写】" + "；".join(facts)) if brief \
            else ("【原文已写明的事实】" + "；".join(facts))
    return m, brief


def parse_model_json(text):
    """模型可能带废话或代码块，尽力取出 JSON 对象。"""
    if not text:
        return None
    t = text.strip()
    t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    start = t.find("{")
    end = t.rfind("}")
    if start < 0 or end <= start:
        return None
    frag = t[start:end + 1]
    try:
        return json.loads(frag)
    except Exception:
        # 去掉尾逗号再试一次
        frag2 = re.sub(r",\s*([}\]])", r"\1", frag)
        try:
            return json.loads(frag2)
        except Exception:
            return None


def sanitize(job, data):
    """兜住模型输出，保证字段类型稳定。"""
    if not isinstance(data, dict):
        return {
            "jobId": job.get("jobId"), "platform": job.get("platform"),
            "score": 50, "verdict": "watch", "real_monthly": "unknown",
            "hourly": "unknown", "flags": [{"level": "unknown", "text": "模型未返回有效结果"}],
            "reason": "评估失败，需人工看",
        }
    score = data.get("score")
    try:
        score = max(0, min(100, int(float(score))))
    except Exception:
        score = 50
    verdict = str(data.get("verdict") or "watch").lower()
    if verdict not in ("pass", "watch", "reject"):
        verdict = "pass" if score >= 70 else ("watch" if score >= 40 else "reject")
    flags = data.get("flags") or []
    if not isinstance(flags, list):
        flags = []
    clean_flags = []
    for f in flags[:8]:
        if isinstance(f, dict):
            lv = str(f.get("level") or "soft").lower()
            if lv not in ("hard", "soft", "unknown"):
                lv = "soft"
            txt = str(f.get("text") or "").strip()
            if txt:
                clean_flags.append({"level": lv, "text": txt[:120]})
        elif isinstance(f, str) and f.strip():
            clean_flags.append({"level": "soft", "text": f.strip()[:120]})
    return {
        "jobId": job.get("jobId"),
        "platform": job.get("platform"),
        "score": score,
        "verdict": verdict,
        "real_monthly": str(data.get("real_monthly") or "unknown")[:40],
        "hourly": str(data.get("hourly") or "unknown")[:40],
        "flags": clean_flags,
        "reason": str(data.get("reason") or "")[:120],
    }


class LLMClient:
    """最小 OpenAI 兼容客户端：支持任意服务商（DeepSeek/智谱/百炼/硅基/混元/方舟/Groq/Ollama/自定义）。

    与 job_scan.Client 的区别：base_url、api_key、model 全部由调用方（浏览器）传入，
    服务端不落盘。key 只在 127.0.0.1 上转发，比写进油猴脚本安全。
    """

    def __init__(self, base_url, api_key="", model="", no_thinking=False, fallback_model=""):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = (api_key or "").strip()
        self.model = model
        self.fallback_model = (fallback_model or "").strip()
        self.no_thinking = bool(no_thinking)
        if not self.base_url:
            raise RuntimeError("未提供服务商地址（baseUrl）")
        if not self.model:
            raise RuntimeError("未提供模型名（model）")
        if not self.api_key and not re.search(r"//(127\.0\.0\.1|localhost)", self.base_url):
            raise RuntimeError("缺少 API Key")

    @property
    def url(self):
        return self.base_url + "/chat/completions"

    def chat(self, messages, temperature=0.2, max_tokens=1200, timeout=150, model=None):
        use_model = model or self.model
        body = {
            "model": use_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        # 只对支持该参数的国产服务商发，避免个别严格实现报 400
        if self.no_thinking:
            body["enable_thinking"] = False
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        try:
            resp = requests.post(self.url, json=body, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            raise RuntimeError(f"网络请求失败: {exc}")
        if resp.status_code == 401:
            raise RuntimeError("API Key 无效或已过期（401）")
        if resp.status_code == 403:
            raise RuntimeError("无权限访问该模型（403），请确认已开通")
        if resp.status_code == 404:
            raise RuntimeError(f"地址或模型不存在（404）：{self.url} / {use_model}")
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            data = resp.json()
            msg = (data.get("choices") or [{}])[0].get("message") or {}
        except Exception as exc:
            raise RuntimeError(f"返回不是合法 JSON: {exc}")
        content = (msg.get("content") or "").strip()
        if not content:
            reason = (msg.get("reasoning_content") or "").strip()
            if reason:
                raise RuntimeError("模型只输出了思考过程（正文为空），请换模型或关闭 thinking")
            raise RuntimeError("模型返回空内容")
        return content

    def models_to_try(self):
        out = [self.model]
        if self.fallback_model and self.fallback_model != self.model:
            out.append(self.fallback_model)
        return out


class Evaluator:
    def __init__(self):
        self.client = None            # 服务端 .env 的兜底客户端
        self.model = MODEL_MAIN
        self.lock = threading.Lock()
        self.cache = {}
        self._pool = {}               # (base, keyhash, model) -> LLMClient
        self._key_locks = {}          # 同一 Key 串行化，防多标签页并发被 429

    def _key_lock(self, llm):
        """三个平台标签页同时评估时，同一 Key 的请求在这里排队，
        避免免费账号的 QPS/RPM 限制把整批判失败。不同 Key 之间仍并行。"""
        seed = (str((llm or {}).get("baseUrl") or ""), str((llm or {}).get("apiKey") or "")[-10:])
        with self.lock:
            lk = self._key_locks.get(seed)
            if lk is None:
                if len(self._key_locks) > 16:
                    self._key_locks.clear()
                lk = threading.Lock()
                self._key_locks[seed] = lk
        return lk

    def ensure_client(self):
        """兜底：浏览器没传 key 时，用 .env 里的硅基流动密钥。"""
        if self.client:
            return self.client
        # 兜底顺序：环境变量 -> 本目录 .env -> job_scan.py 的密钥加载（可选）
        key = os.getenv("SILICONFLOW_API_KEY") or os.getenv("SF_API_KEY")
        if not key:
            key = read_env_value(HERE / ".env", ("SILICONFLOW_API_KEY", "SF_API_KEY"))
        if not key and JOB_SCAN:
            try:
                key, _ = JOB_SCAN.load_keys()
            except Exception as exc:
                print(f"[warn] job_scan.load_keys 失败: {exc}")
        if not key:
            raise RuntimeError("浏览器未填 API Key，本机 .env 也没配置 SILICONFLOW_API_KEY")
        if JOB_SCAN:
            self.client = JOB_SCAN.Client(key)
        else:
            # 没有 job_scan.py 时用内置客户端直连硅基流动，保证 clone 下来就能跑
            self.client = LLMClient("https://api.siliconflow.cn/v1", key, MODEL_MAIN, no_thinking=True)
        return self.client

    def client_for(self, llm):
        """根据浏览器传来的配置取客户端；未传则回落到 .env。"""
        if not llm or not (llm.get("baseUrl") and llm.get("model")):
            return self.ensure_client(), [self.model, MODEL_FALLBACK]
        base = str(llm.get("baseUrl") or "").rstrip("/")
        key = str(llm.get("apiKey") or "")
        model = str(llm.get("model") or "")
        fallback = str(llm.get("fallbackModel") or "")
        no_think = bool(llm.get("noThinking"))
        ck = (base, hash(key), model, fallback, no_think)
        with self.lock:
            cli = self._pool.get(ck)
            if cli is None:
                cli = LLMClient(base, key, model, no_thinking=no_think, fallback_model=fallback)
                if len(self._pool) > 32:
                    self._pool.clear()
                self._pool[ck] = cli
        return cli, cli.models_to_try()

    def summarize_company(self, name, items, llm=None):
        """把搜索到的公开摘要喂给模型，总结员工口碑。只依据摘要，不许编造。"""
        if not items:
            return ""
        client, models = self.client_for(llm)
        lines = [f"- {it['title']}｜{it['snippet']}" for it in items if it.get("title")]
        prompt = (
            f"公司：{name}\n"
            "下面是必应搜索到的公开网页标题与摘要（只是摘要，不是全文）：\n" + "\n".join(lines) +
            "\n\n请只依据这些摘要，用 120 字以内回答：\n"
            "1) 员工/前员工提到的主要优点；\n"
            "2) 主要抱怨或风险（加班、社保、管理、离职率等）；\n"
            "3) 一句话建议：值得去 / 谨慎 / 不建议，并给理由。\n"
            "如果摘要里几乎没有员工评价，就直接说「公开摘要里缺少可信的员工评价」，不要编造。"
        )
        messages = [
            {"role": "system", "content": "你是求职顾问，只依据给定材料回答，宁可说没有，也不编造。"},
            {"role": "user", "content": prompt},
        ]
        for model in models:
            try:
                if isinstance(client, LLMClient):
                    raw = client.chat(messages, model=model, max_tokens=600, timeout=90)
                else:
                    raw = client.chat(model, messages, temperature=0.2, max_tokens=600,
                                      timeout=90, no_thinking=True)
                txt = (JOB_SCAN.clean_output(raw) if JOB_SCAN else raw).strip()
                if txt:
                    return txt[:400]
            except Exception as exc:
                print(f"[warn] 口碑总结失败 {model}: {exc}")
                time.sleep(1)
        return ""

    def evaluate_one(self, job, llm=None):
        jid = str(job.get("jobId") or "")
        m, brief = local_math(job)
        cache_key = f"{job.get('platform')}|{jid}|{job.get('salary')}|{len(job.get('desc') or '')}"
        if cache_key in self.cache:
            return self.cache[cache_key]

        client, models = self.client_for(llm)
        prompt = build_user_prompt(job, brief)
        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ]
        data = None
        last_err = None
        with self._key_lock(llm):
            for model in models:
                try:
                    if isinstance(client, LLMClient):
                        raw = client.chat(messages, model=model)
                    else:  # job_scan.Client 兼容分支
                        raw = client.chat(model, messages, temperature=0.2, max_tokens=1200,
                                          timeout=150, no_thinking=True)
                    data = parse_model_json(JOB_SCAN.clean_output(raw) if JOB_SCAN else raw)
                    if data:
                        break
                except Exception as exc:
                    last_err = exc
                    print(f"[warn] {model} 评估失败: {exc}")
                    time.sleep(1)
        if not data and last_err:
            raise RuntimeError(str(last_err))
        out = sanitize(job, data)
        # 数字以本地计算为准，模型只负责判断
        if m.get("real_low") and m.get("real_high"):
            out["real_monthly"] = f"{m['real_low']}-{m['real_high']}"
        if m.get("hourly_low") and m.get("hourly_high"):
            out["hourly"] = f"{m['hourly_low']}-{m['hourly_high']}"
        if m.get("total_hours"):
            out["totalHours"] = m["total_hours"]
        if m.get("base_note"):
            out["baseNote"] = m["base_note"]
        self.cache[cache_key] = out
        return out


EVAL = Evaluator()


class Handler(BaseHTTPRequestHandler):
    server_version = "JobEval/1.0"

    def log_message(self, fmt, *args):  # 静音默认访问日志
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path.startswith("/health"):
            models = [MODEL_MAIN, MODEL_FALLBACK]
            env_key = False
            try:
                env_key = bool(EVAL.ensure_client())
            except Exception:
                env_key = False
            return self._send(200, {"ok": True, "models": models, "envKey": env_key,
                                    "cached": len(EVAL.cache),
                                    "note": "浏览器可在面板里填 Key 和服务商；没填则用本机 .env"})
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            return self._send(400, {"ok": False, "error": f"bad json: {exc}"})

        # 连通性测试：面板「测试连接」按钮用
        if self.path.startswith("/test"):
            llm = payload.get("llm") or {}
            t0 = time.time()
            try:
                client, models = EVAL.client_for(llm)
                model = models[0]
                if isinstance(client, LLMClient):
                    reply = client.chat([{"role": "user", "content": "只回复两个字：可用"}],
                                        max_tokens=64, timeout=40, model=model)
                    used = model
                else:
                    reply = client.chat(model, [{"role": "user", "content": "只回复两个字：可用"}],
                                        temperature=0.1, max_tokens=64, timeout=40,
                                        no_thinking=True)
                    used = model
                return self._send(200, {"ok": True, "model": used,
                                        "ms": int((time.time() - t0) * 1000),
                                        "reply": (reply or "").strip()[:60]})
            except Exception as exc:
                return self._send(200, {"ok": False, "error": str(exc)[:300],
                                        "ms": int((time.time() - t0) * 1000)})

        if self.path.startswith("/evaluate"):
            jobs = payload.get("jobs") or []
            llm = payload.get("llm") or None
            if not isinstance(jobs, list) or not jobs:
                return self._send(400, {"ok": False, "error": "jobs 为空"})
            jobs = jobs[:40]  # 单次上限，避免一口气打爆免费额度
            results = []
            errors = []
            for job in jobs:
                try:
                    results.append(EVAL.evaluate_one(job, llm=llm))
                except Exception as exc:
                    errors.append(str(exc)[:200])
                    bad = sanitize(job, None)
                    bad["error"] = str(exc)[:200]
                    results.append(bad)
                    print(f"[warn] 评估异常 {job.get('jobId')}: {exc}")
            # 全部失败说明是配置问题（key/地址/模型），整体报错让面板提示出来
            if errors and len(errors) == len(results):
                return self._send(502, {"ok": False, "error": errors[0], "results": results})
            return self._send(200, {"ok": True, "count": len(results), "results": results,
                                    "failed": len(errors)})

        if self.path.startswith("/company"):
            name = (payload.get("company") or "").strip()
            if not name:
                return self._send(400, {"ok": False, "error": "company 为空"})
            # v2：必应搜真实网页（含论坛/评价帖），再让模型总结
            q = f"{name} 上班 体验 怎么样 员工评价 吐槽"
            items = bing_search(q, limit=6)
            summary = ""
            if items and payload.get("summarize", True):
                try:
                    summary = EVAL.summarize_company(name, items, payload.get("llm"))
                except Exception as exc:
                    print(f"[warn] 口碑总结异常 {name}: {exc}")
            return self._send(200, {
                "ok": True, "company": name, "query": q,
                "results": items,
                "summary": summary,
                "count": len(items),
                "note": "" if items else "搜索引擎没返回结果（可能被限流），可点下面的链接自己看",
                "links": [
                    "https://www.bing.com/search?q=" + requests.utils.quote(f"{name} 怎么样 员工评价"),
                    "https://www.jobui.com/company/?keyword=" + requests.utils.quote(name),
                    "https://www.kanzhun.com/search/?query=" + requests.utils.quote(name),
                ],
            })

        self._send(404, {"ok": False, "error": "not found"})


def main():
    ap = argparse.ArgumentParser(description="求职岗位 AI 评估服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"评估服务已启动：http://{args.host}:{args.port}")
    print(f"模型：{MODEL_MAIN}（备用 {MODEL_FALLBACK}）")
    print("健康检查：curl http://127.0.0.1:%d/health" % args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
