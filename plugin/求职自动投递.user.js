// ==UserScript==
// @name         求职自动投递助手（BOSS直聘 / 前程无忧）
// @namespace    https://scriptcat.org/zh/script/job-auto-apply
// @version      0.5.1
// @description  脚本猫/Tampermonkey 兼容用户脚本：BOSS直聘、前程无忧自动投递（默认确认队列模式，可切极速全自动）。含登录检测（cookie/DOM 三层）、限速熔断（随机间隔/每日上限/夜间静默/验证码熔断）、自动搜索翻页收集、投递台账（GM 存储）、求职意向配置面板。页面 selector 未经实测，均提供多候选，可在 CONFIG 区微调。
// @author       job-auto-apply
// @match        *://www.zhipin.com/*
// @match        *://we.51job.com/*
// @match        *://m.51job.com/*
// @match        *://www.51job.com/*
// @match        *://sou.51job.com/*
// @match        *://jobs.51job.com/*
// @match        *://q.yingjiesheng.com/*
// @match        *://www.yingjiesheng.com/*
// @icon         https://www.zhipin.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      www.zhipin.com
// @connect      we.51job.com
// @connect      jobs.51job.com
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * 架构总览（M1 - BOSS直聘 / 前程无忧链路）
 * ---------------------------------------------------------------
 * 0. 平台注册表 + 页面 selector 配置区（用户可微调）
 * 1. 存储层（GM_getValue/GM_setValue，JSON 序列化，跨页面持久）
 * 2. 通用工具（等待/选择器多候选/薪资解析/HTML 转义等）
 * 3. 登录检测（DOM 双标记 -> cookie 哨兵 -> 人工确认）
 * 4. 限速与熔断（随机间隔/每日上限/夜间静默/安全验证熔断）
 * 5. 意向匹配引擎（必含词/屏蔽词/城市/薪资 + 简单评分）
 * 6. 平台适配器（BOSS：立即沟通打招呼；51job：申请职位按钮）
 * 7. 投递队列执行器（跨页面状态机：导航->投递->间隔->下一个）
 * 8. 浮窗面板 UI（投递队列 / 投递台账 / 求职意向设置）
 * 9. 页面入口主流程（恢复队列、列表抓取匹配、极速模式自动开跑）
 *
 * 平台参数源自注册表 platforms.json（boss 条目），两处修改请同步。
 * GM_xmlhttpRequest 预留给后续「接口探测登录」兜底层（M2）。
 */
(function () {
  'use strict';

  /* =========================================================
   * 0. 平台注册表 + 页面 selector 配置区
   *    selector 均为多候选防御式写法，按顺序尝试；
   *    若站点改版，用 F12 检查实际元素后在此处增改即可。
   * ========================================================= */

  // 平台注册表（源自 f:\求职\platforms.json 的 boss 条目）
  var BOSS_REGISTRY = {
    id: 'boss',
    name: 'BOSS直聘',
    applyType: 'chat-greeting', // 聊天式打招呼即投递
    risk: 'high',
    rateLimit: { intervalSec: [30, 90], dailyCap: 80, quietHours: ['23:00', '08:00'] },
    loginDetect: { cookie: ['wt2'], domLoginBtn: null, domAvatar: null, verified: false },
  };

  // 页面 selector 多候选配置（已实测回填，2026-11 成都搜索页验证）
  var SEL = {
    // —— 登录检测 DOM 双标记 ——
    loginBtn: ['.header-login-btn', 'a[href*="login"]', '.header-nav a[href*="/web/user/"]'],
    // 已登录：顶部导航中用户名链接（如「高峰」）或头像
    avatar: ['a[ka="header-username"]', '.nav-figure a', '.nav-user .name', '.user-nav img', '.header-avatar img'],

    // —— 安全验证/滑块熔断 ——
    captcha: ['.nc-container', '#nc_1_n1z', '.verify-wrap', '.ui-slider-wrap', '.geetest_panel'],
    // BOSS 未登录/风控会跳到 web/passport/zp/security.html，必须识别为熔断，
    // 否则脚本会在安全页上一直"抓 0 条"
    captchaUrlHint: ['security-check', 'web/common/security', 'passport/zp/security', '/web/passport/'],

    // —— 职位列表卡片（实测）——
    card: ['li.job-card-box', 'li.job-card-wrapper', '.job-card-wrapper', 'li.job-card-body'],
    cardTitle: ['.job-name', '.job-title'],
    cardArea: ['.company-location', '.job-area-wrapper .job-area', '.job-area'],
    // 薪资：BOSS 用自定义字体反爬，textContent 是乱码；
    // 真实薪资在卡片 Vue 实例 __vue__.$props.data.salaryDesc，由 scrapeBySelectors 优先读取。
    cardSalary: ['.salary', '.job-salary'],
    cardCompany: ['.boss-name', '.company-name', '.company-info .name'],
    cardTags: ['.tag-list li', '.job-card-footer .tag-list li'],
    cardLink: ['a[href*="/job_detail/"]'],

    // —— 职位详情面板（右侧滑出面板，实测）——
    dTitle: ['.job-detail-info .job-name', '.job-banner .name', '.job-primary .name'],
    dSalary: ['.job-detail-info .job-salary', '.job-banner .salary', '.job-primary .salary'],
    dCompany: ['.job-boss-info .name', '.company-info .name', '.company a'],
    dCity: ['.job-detail-info .tag-list li:first-child', '.location-address', '.job-address', '.job-banner .area'],
    // 实测 2026-11：新版详情面板的描述在 .job-detail-body P.desc，
    // 但 P.desc 文本被自定义字体污染（混入 boss/kanzhun 水印字），
    // 干净数据源是 unsafeWindow._jobInfo.postDescription（fetchDesc 优先读它）
    dDesc: ['.job-detail-body P.desc', '.job-sec-text', '.job-detail-section'],

    // —— 沟通动作（实测）——
    // 详情面板中的「立即沟通」按钮：a.op-btn.op-btn-chat
    chatBtn: ['a.op-btn.op-btn-chat', '.btn-startchat', '.job-op-btn-chat'],
    // 成功弹窗：点立即沟通后弹出，含「已向BOSS发送消息」
    successPopup: ['.greet-boss-header'],
    successText: ['已向BOSS发送消息', '已发送'],
    // 成功弹窗按钮：留在此页 / 继续沟通
    stayBtn: ['a.default-btn.cancel-btn', '.cancel-btn'],
    continueBtn: ['a.default-btn.sure-btn', '.sure-btn'],
  };

  // 前程无忧平台参数（源自 platforms.json 的 51job 条目）
  var JOB51_REGISTRY = {
    id: '51job',
    name: '前程无忧',
    applyType: 'apply-button', // 申请职位按钮式投递
    risk: 'medium',
    cityInSearch: false,       // 搜索 URL 不带城市参数，靠本地城市过滤
    rateLimit: { intervalSec: [15, 45], dailyCap: 120, quietHours: ['23:00', '08:00'] },
    loginDetect: { cookie: ['51job', 'guid'], domLoginBtn: null, domAvatar: null, verified: false },
  };

  // 应届生求职网平台参数
  var YJS_REGISTRY = {
    id: 'yjs',
    name: '应届生求职网',
    applyType: 'apply-button', // 立即申请按钮式投递
    risk: 'medium',
    cityInSearch: false,       // 搜索 URL 不带城市参数，城市靠页面选择
    rateLimit: { intervalSec: [15, 45], dailyCap: 120, quietHours: ['23:00', '08:00'] },
    loginDetect: { cookie: [], domLoginBtn: null, domAvatar: null, verified: true },
  };

  var REGISTRY = { boss: BOSS_REGISTRY, '51job': JOB51_REGISTRY, yjs: YJS_REGISTRY };

  // 当前页面所属平台
  function platformId() {
    var h = location.hostname;
    if (/(^|\.)51job\.com$/i.test(h)) return '51job';
    if (/(^|\.)yingjiesheng\.com$/i.test(h)) return 'yjs';
    return 'boss';
  }
  function plat() { return REGISTRY[platformId()]; }
  // 平台显示名（台账/队列标签用）
  function platLabel(pid) {
    if (pid === '51job') return '51job';
    if (pid === 'yjs') return '应届生';
    return 'BOSS';
  }
  function curSEL() {
    var p = platformId();
    if (p === '51job') return SEL51;
    if (p === 'yjs') return SELYJS;
    return SEL;
  }
  function adapter() {
    var p = platformId();
    if (p === '51job') return Job51Adapter;
    if (p === 'yjs') return YjsAdapter;
    return BossAdapter;
  }

  // 前程无忧 selector 多候选（新版 we.51job.com 为主，兼容旧版 sou/jobs 站点）
  var SEL51 = {
    // —— 登录检测 ——
    loginBtn: ['a[href*="login"]', '.login', '.header-login', '.nav-login', '.unlogin'],
    avatar: ['.user-info', '.header-user', '.u-info', '.user-name', '.nav-user img', '.header-avatar img'],

    // —— 验证 ——
    captcha: ['.nc-container', '#nc_1_n1z', '.geetest_panel', '.verify-wrap', '.shield-verify'],
    captchaUrlHint: ['captcha', 'security-check', 'verify.html'],

    // —— 列表卡片 ——
    // 新版 we.51job.com：.joblist-item > .joblist-item-job-wrapper > .joblist-item-job[sensorsdata]
    // sensorsdata 属性是 JSON 字符串，含 jobId/jobTitle/jobSalary/jobArea/jobYear/jobDegree/companyId 等
    card: ['div.joblist-item', '.joblist-item', '.job-item', 'div.e', '.j_joblist .e'],
    cardJob: ['.joblist-item-job', '.joblist-item-job-wrapper'],
    cardTitle: ['.joblist-item-job-name', '.jname', '.job-name', '.t1', 'a[href*="jobId="]'],
    cardArea: ['.joblist-item-job-area', '.area', '.job-area', '.t3'],
    cardSalary: ['.joblist-item-job-salary', '.sal', '.job-salary', '.salary', '.t4'],
    cardCompany: ['.joblist-item-company-name', '.cname', 'a.comp', '.company-name', '.t2'],
    cardTags: ['.joblist-item-tags .tag', '.tags .tag', '.joblist-item-job-tags span', '.tag'],
    cardLink: ['a[href*="jobId="]', 'a[href*="/pc/jobdetail"]', 'a[href*="jobdetail"]', '.joblist-item-job a', 'a[href$=".html"]'],
    // 列表页直接投递按钮（新版 we.51job.com 每个卡片都有）
    listApplyBtn: ['button.btn.apply', 'button.apply', '.joblist-item .btn.apply', '.joblist-item .apply'],

    // —— 详情页 ——
    dTitle: ['.job-title', '.job-name', '.jname', 'h1', '.cn h1'],
    dSalary: ['.job-salary', '.sal', '.salary', '.job-basic-info .sal', '.cn .salary'],
    dCompany: ['.company-name', '.cname', '.com-name', '.cn .cname'],
    dCity: ['.job-address', '.job-area', '.area', '.job-location', '.cn .msg'],
    dDesc: ['.job-detail', '.job-detail-section', '.job-description', '.job_msg'],

    // —— 投递动作 ——
    applyBtn: ['button.btn.apply', 'button.apply', '.btn-apply', '.job-apply', '.apply-btn', '.btn-gray.btn-apply', '.job-operation .btn'],
    // 投递过程中可能出现的二次确认/选择简历弹窗按钮
    confirmBtn: ['.el-dialog__footer .el-button--primary', '.ant-modal-footer .ant-btn-primary',
      '.modal-footer .btn-primary', '.confirm-btn', '.job-apply-dialog .btn-primary',
      'a.btn[sensor_elementid*="apply"]', 'a.btn'],
    // 投递成功弹窗（新版 51job）
    successPopup: ['.success-popup', '.apply-component-success-dialog'],
    appliedText: ['已申请', '已投递', '继续投递', '投递成功', '申请成功'],
  };

  // 应届生求职网 selector（q.yingjiesheng.com 搜索页，2026-11 实测）
  var SELYJS = {
    // —— 登录检测 ——
    loginBtn: ['a[href*="login"]', '.login-btn', '.header-login', 'a:contains("登录")'],
    avatar: ['.userinfo .text-cut', '.personal-user-center .name', '.userinfo', '.header-user'],

    // —— 验证/滑块 ——
    captcha: ['.nc-container', '#nc_1_n1z', '.geetest_panel', '.verify-wrap', '.ui-slider-wrap'],
    captchaUrlHint: ['security-check', 'captcha', 'verify'],

    // —— 列表卡片（实测）——
    // 职位卡片（带「立即申请」）：div.search-list-item.job
    // 公司推荐卡片（带「查看详情」）：div.search-list-item.company（脚本只处理 .job 卡片）
    card: ['div.search-list-item.job'],
    cardTitle: ['.left-title-name .text-cut'],
    cardSalary: ['.right-salary'],
    cardCompany: ['.left-detail-company'],
    // 标签：城市/经验/学历/技能等，第一项通常是城市
    cardTags: ['.left-tag .left-tag-item'],
    cardArea: ['.left-tag .left-tag-item:first-child'],
    cardLink: ['a[href*="/jobdetail/"]'],
    // 列表页直接投递按钮：.notdelivery（"立即申请"），投递后变为"已申请"
    listApplyBtn: ['.notdelivery'],

    // —— 详情页 ——
    dTitle: ['.job-name', '.position-name', 'h1'],
    dSalary: ['.job-salary', '.salary'],
    dCompany: ['.company-name', '.coname'],
    dCity: ['.job-area', '.location'],
    dDesc: ['.job-description', '.job-detail'],

    // —— 投递动作 ——
    applyBtn: ['.notdelivery', '.apply-btn', 'button.apply'],
    confirmBtn: ['.el-dialog__footer .el-button--primary', '.confirm-btn'],
    // 成功弹窗：.el-dialog__wrapper 可见且 body 含「投递成功」
    successPopup: ['.el-dialog__wrapper'],
    successText: ['投递成功', '申请成功', '已投递', '已申请'],
    appliedText: ['已申请', '已投递', '投递成功'],
  };

  // 默认求职意向设置（用户可在面板中修改，持久化到 GM 存储）
  var DEFAULT_SETTINGS = {
    includeKeywords: [],   // 必含关键词（标题/标签任一命中；空 = 不限）
    excludeKeywords: [],   // 屏蔽关键词（任一命中即排除）
    preferredCities: [],   // 优先城市，按优先级排序；空 = 不限城市
    salaryMinK: 0,         // 最低薪资下限（K/月），0 = 不限
    dailyCap: BOSS_REGISTRY.rateLimit.dailyCap,
    intervalSec: BOSS_REGISTRY.rateLimit.intervalSec.slice(),
    mode: 'confirm',       // confirm=确认队列（默认）| fast=极速全自动
    searchPages: 2,        // 自动搜索：每个关键词/城市组合最多翻几页
    searchCityLimit: 3,    // 自动搜索：最多搜索几个优先城市
    greetingTemplate: '您好，我看到贵司的{职位}岗位与我的背景很匹配，希望能进一步沟通，方便时可以看下我的简历，谢谢！',
    evalUrl: 'http://127.0.0.1:8899', // 本地 AI 评估服务（python job_eval_server.py）
    autoEval: true,       // 扫描到新岗位后自动调 AI 评估（3 秒防抖，只评新出现的）
    evalDuringSearch: true, // 自动搜索每翻完一页就地评估（否则翻页后岗位离开 DOM，补不到详情）
    // —— 大模型服务商（Key 只存浏览器本地，随请求发给本机服务，不写进脚本源码）——
    llmProvider: 'siliconflow',
    llmKey: '',
    llmBaseUrl: '',        // 空 = 用预设的地址
    llmModel: '',          // 空 = 用预设的模型
    llmFallback: '',       // 备用模型，空 = 用预设
    minScore: 60,          // AI 评分低于此值不自动投递
    onlyPass: false,       // 只显示 AI 判定为 pass 的岗位
  };

  // 服务商预设：选中后自动填地址与模型（都是 OpenAI 兼容接口）
  var LLM_PRESETS = [
    { id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat', fallback: '', noThinking: false,
      hint: 'Key 在 platform.deepseek.com 创建，充值按量计费' },
    { id: 'zhipu', name: '智谱 GLM-4-Flash（免费）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash', fallback: '', noThinking: false,
      hint: 'glm-4-flash 免费；注册后在控制台拿 Key' },
    { id: 'dashscope', name: '阿里云百炼 Qwen（有免费额度）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus', fallback: 'qwen-turbo', noThinking: true,
      hint: '新用户有免费额度；模型可用 qwen-plus / qwen-flash / qwen-turbo' },
    { id: 'siliconflow', name: '硅基流动 SiliconFlow（含免费模型）', baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'XingChenAGI/Xing4.0-29B', fallback: 'THUDM/GLM-Z1-9B-0414', noThinking: true,
      hint: '默认用电信 29B（免费）；也可填 Qwen/Qwen3.5-4B 等' },
    { id: 'hunyuan', name: '腾讯混元 lite（免费额度）', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
      model: 'hunyuan-lite', fallback: '', noThinking: false,
      hint: '混元 lite 免费；Key 在腾讯云控制台创建' },
    { id: 'ark', name: '火山方舟 Doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: '', fallback: '', noThinking: false,
      hint: '模型处要填「推理接入点 ID」（ep-xxxxxxxx），不是模型名' },
    { id: 'groq', name: 'Groq（免费，需外网）', baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile', fallback: '', noThinking: false,
      hint: '国内需代理；速度很快，适合批量评估' },
    { id: 'ollama', name: '本地 Ollama（免费/离线）', baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b', fallback: '', noThinking: false, local: true,
      hint: '先 ollama pull qwen2.5:7b；Key 随便填或留空' },
    { id: 'custom', name: '自定义', baseUrl: '', model: '', fallback: '', noThinking: false,
      hint: '填任何 OpenAI 兼容地址，末尾到 /v1 或 /v3' },
  ];

  function presetOf(id) {
    for (var i = 0; i < LLM_PRESETS.length; i++) if (LLM_PRESETS[i].id === id) return LLM_PRESETS[i];
    return LLM_PRESETS[3]; // 默认硅基流动
  }

  /* =========================================================
   * 1. 存储层
   * ========================================================= */
  var Store = {
    settingsKey: 'jaap_settings_v1',
    recordsKey: 'jaap_records_v1',
    runnerKey: 'jaap_runner_v1',
    stagingKey: 'jaap_staging_v1',

    gmGet: function (k, def) {
      try {
        var raw = GM_getValue(k);
        if (raw === undefined || raw === null || raw === '') return def;
        return JSON.parse(raw);
      } catch (e) { return def; }
    },
    gmSet: function (k, v) {
      try { GM_setValue(k, JSON.stringify(v)); }
      catch (e) { console.error('[求职投递] 存储写入失败：', e); }
    },

    getSettings: function () {
      var s = this.gmGet(this.settingsKey, {});
      var out = {};
      for (var k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
      for (var k2 in s) out[k2] = s[k2];
      // 数组/数字兜底
      if (!Array.isArray(out.includeKeywords)) out.includeKeywords = [];
      if (!Array.isArray(out.excludeKeywords)) out.excludeKeywords = [];
      if (!Array.isArray(out.preferredCities)) out.preferredCities = [];
      if (!Array.isArray(out.intervalSec) || out.intervalSec.length !== 2) out.intervalSec = DEFAULT_SETTINGS.intervalSec.slice();
      if (typeof out.dailyCap !== 'number' || out.dailyCap <= 0) out.dailyCap = DEFAULT_SETTINGS.dailyCap;
      if (typeof out.salaryMinK !== 'number' || out.salaryMinK < 0) out.salaryMinK = 0;
      if (typeof out.searchPages !== 'number' || out.searchPages < 1) out.searchPages = DEFAULT_SETTINGS.searchPages;
      if (typeof out.searchCityLimit !== 'number' || out.searchCityLimit < 1) out.searchCityLimit = DEFAULT_SETTINGS.searchCityLimit;
      if (out.mode !== 'confirm' && out.mode !== 'fast') out.mode = 'confirm';
      return out;
    },
    saveSettings: function (s) { this.gmSet(this.settingsKey, s); },

    // 待投队列（持久化，自动搜索跨页面收集后不丢）
    getStaging: function () {
      var a = this.gmGet(this.stagingKey, []);
      return Array.isArray(a) ? a : [];
    },
    // 只落"投递必需"的字段：ai/desc/review 都能从 Eval 缓存重建，
    // 落库会让几百条候选把存储撑大、每次写都变慢。
    saveStaging: function (arr) {
      var slim = (arr || []).map(function (x) {
        return {
          jobId: x.jobId, url: x.url, title: x.title, company: x.company,
          salary: x.salary, city: x.city, tags: x.tags || [],
          platform: x.platform || plat().id,
        };
      });
      this.gmSet(this.stagingKey, slim);
    },
    clearStagingStore: function () { try { GM_deleteValue(this.stagingKey); } catch (e) { /* 忽略 */ } },
    // 多标签页安全追加：写前重读一次再合并去重，避免两个页面各自
    // 「读全量→改→写全量」把对方刚加进去的岗位覆盖掉。
    mergeStaging: function (items) {
      if (!items || !items.length) return { list: this.getStaging(), added: 0 };
      var kf = function (x) { return (x.platform || plat().id) + ':' + x.jobId; };
      var arr = this.getStaging();
      var have = {};
      for (var i = 0; i < arr.length; i++) have[kf(arr[i])] = true;
      var added = 0;
      for (var j = 0; j < items.length; j++) {
        // 平台标记必须落到条目上：待投队列是三平台共用的，
        // 没有 platform 就没法判断这条属于谁、该在哪个页面投。
        if (!items[j].platform) items[j].platform = plat().id;
        if (have[kf(items[j])]) continue;
        have[kf(items[j])] = true;
        arr.push(items[j]);
        added++;
      }
      if (added) this.saveStaging(arr);
      return { list: arr, added: added };
    },

    getRecords: function () {
      var r = this.gmGet(this.recordsKey, {});
      return r && typeof r === 'object' ? r : {};
    },
    saveRecords: function (r) { this.gmSet(this.recordsKey, r); },
    // 台账主键带平台前缀，避免不同平台 jobId 撞车
    recKey: function (platform, jobId) { return (platform || plat().id) + ':' + jobId; },
    findRec: function (records, platform, jobId) { return (records || {})[this.recKey(platform, jobId)]; },
    upsertRecord: function (rec) {
      var all = this.getRecords();
      var key = this.recKey(rec.platform, rec.jobId);
      var old = all[key] || {};
      var merged = {};
      for (var k in old) merged[k] = old[k];
      for (var k2 in rec) {
        if (rec[k2] !== undefined && rec[k2] !== null && rec[k2] !== '') merged[k2] = rec[k2];
      }
      all[key] = merged;
      this.saveRecords(all);
    },

    getRunner: function () { return this.gmGet(this.runnerKey, null); },
    saveRunner: function (st) { this.gmSet(this.runnerKey, st); },
    clearRunner: function () { try { GM_deleteValue(this.runnerKey); } catch (e) { /* 忽略 */ } },

    // 浮窗/悬浮球位置持久化
    getPos: function (key) { return this.gmGet(key, null); },
    savePos: function (key, pos) { this.gmSet(key, pos); },
  };

  /* =========================================================
   * 2. 通用工具
   * ========================================================= */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function randInt(min, max) {
    if (min > max) { var t = min; min = max; max = t; }
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function todayStr(d) {
    d = d || new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[求职投递]');
    try { console.log.apply(console, args); } catch (e) { /* 忽略 */ }
  }

  // 依次尝试多个 selector，返回第一个命中的元素
  function pick(selArr, root) {
    var scope = root || document;
    for (var i = 0; i < selArr.length; i++) {
      try {
        var el = scope.querySelector(selArr[i]);
        if (el) return el;
      } catch (e) { /* 无效 selector 跳过 */ }
    }
    return null;
  }

  // 依次尝试多个 selector，返回第一个非空的元素数组
  function pickAll(selArr, root) {
    var scope = root || document;
    for (var i = 0; i < selArr.length; i++) {
      try {
        var els = scope.querySelectorAll(selArr[i]);
        if (els.length) return Array.prototype.slice.call(els);
      } catch (e) { /* 无效 selector 跳过 */ }
    }
    return [];
  }

  // 按 selector 收集候选，再按文本匹配（selector 全不中时，
  // 仅在未限定容器的情况下做全局可点元素文本兜底）
  function pickByText(selArr, texts, root) {
    var scope = root || document;
    for (var i = 0; i < selArr.length; i++) {
      var els = [];
      try { els = scope.querySelectorAll(selArr[i]); } catch (e) { continue; }
      for (var j = 0; j < els.length; j++) {
        var t = (els[j].textContent || '').trim();
        for (var k = 0; k < texts.length; k++) {
          if (t && (t === texts[k] || t.indexOf(texts[k]) >= 0)) return els[j];
        }
      }
    }
    if (root) return null;
    var clickables = document.querySelectorAll('a, button, span, i, em, .btn, div[role="button"]');
    for (var m = 0; m < clickables.length; m++) {
      var t2 = (clickables[m].textContent || '').trim();
      if (t2 && t2.length <= 10) {
        for (var n = 0; n < texts.length; n++) {
          if (t2 === texts[n]) return clickables[m];
        }
      }
    }
    return null;
  }

  // 容器内是否存在精确匹配文本的元素（如卡片上的“继续沟通”标记）
  function hasText(root, texts) {
    if (!root) return false;
    try {
      var els = root.querySelectorAll('*');
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || '').trim();
        if (t && t.length <= 10 && texts.indexOf(t) >= 0) return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  // 轮询等待 fn() 返回真值；超时返回 null
  function waitFor(fn, timeout, interval) {
    timeout = timeout || 10000;
    interval = interval || 300;
    return new Promise(function (resolve) {
      var start = Date.now();
      var timer = setInterval(function () {
        var result = null;
        try { result = fn(); } catch (e) { result = null; }
        if (result) { clearInterval(timer); resolve(result); }
        else if (Date.now() - start >= timeout) { clearInterval(timer); resolve(null); }
      }, interval);
    });
  }

  function elText(el) { return el ? (el.textContent || '').trim() : ''; }

  // 城市归一化："杭州·西湖区" -> "杭州"
  function normCity(s) {
    if (!s) return '';
    return String(s).split(/[·\-—/,，\s]/)[0].trim();
  }

  // 关键词别名拆分：用户在「必含关键词」里常写「运维/技术支持」表示"或"，
  // 但直接当子串匹配永远命不中，搜索引擎也会把 / 当字面量。
  // 统一按 / | 、 , ；拆成多个同义词。
  function aliasList(st) {
    var out = [];
    ((st && st.includeKeywords) || []).forEach(function (k) {
      String(k || '').split(/[\/|｜、,，;；]+/).forEach(function (t) {
        t = t.trim();
        if (t && out.indexOf(t) < 0) out.push(t);
      });
    });
    return out;
  }

  // 薪资解析为 K/月区间："15-25K" -> {min:15,max:25}；"2-3万" -> {min:20,max:30}
  function parseSalaryK(text) {
    if (!text) return null;
    var t = String(text).replace(/\s/g, '');
    var m = t.match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)\s*[Kk千]/);
    if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
    m = t.match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)\s*[万wW]/);
    if (m) return { min: parseFloat(m[1]) * 10, max: parseFloat(m[2]) * 10 };
    m = t.match(/(\d+(?:\.\d+)?)\s*[Kk千]\s*以上/);
    if (m) { var v = parseFloat(m[1]); return { min: v, max: v }; }
    return null; // "200元/天" 等无法统一口径的不参与过滤
  }

  // 招呼语模板渲染：{职位} {公司} {城市} {薪资}
  function renderGreeting(tpl, job) {
    return String(tpl || '')
      .replace(/\{职位\}/g, job.title || '')
      .replace(/\{公司\}/g, job.company || '')
      .replace(/\{城市\}/g, normCity(job.city) || '')
      .replace(/\{薪资\}/g, job.salary || '');
  }

  function downloadJson(name, data) {
    try {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    } catch (e) { log('导出失败：', e); }
  }

  function splitList(s) {
    return String(s || '').split(/[,，;；\n]+/).map(function (x) { return x.trim(); }).filter(function (x) { return !!x; });
  }

  /* =========================================================
   * 3. 登录检测（三层）
   * ========================================================= */
  async function detectLogin() {
    var s = curSEL();
    // 第 1 层：DOM 双标记（最准）
    var avatar = await waitFor(function () { return pick(s.avatar); }, 4000, 300);
    if (avatar) return { status: 'in', how: 'DOM 头像' };
    var loginBtn = await waitFor(function () { return pick(s.loginBtn); }, 3000, 300);
    if (loginBtn) return { status: 'out', how: 'DOM 登录按钮' };
    // 第 2 层：cookie 哨兵（部分 cookie 可能为 HttpOnly，仅作正向弱信号）
    try {
      var cookies = (plat().loginDetect && plat().loginDetect.cookie) || [];
      for (var i = 0; i < cookies.length; i++) {
        if (document.cookie.indexOf(cookies[i] + '=') >= 0) {
          return { status: 'in', how: 'Cookie ' + cookies[i] };
        }
      }
    } catch (e) { /* 忽略 */ }
    // 第 3 层：接口探测兜底（M2 实现，当前返回未知 -> 由面板提示人工确认）
    return { status: 'unknown', how: '未能自动识别' };
  }

  /* =========================================================
   * 4. 限速与熔断
   * ========================================================= */
  var Limit = {
    isQuietHour: function (now) {
      now = now || new Date();
      var qh = (plat().rateLimit && plat().rateLimit.quietHours) || ['23:00', '08:00'];
      var h = now.getHours() + now.getMinutes() / 60;
      var parts = qh[0].split(':');
      var parts2 = qh[1].split(':');
      var a = parseInt(parts[0], 10);
      var b = parseInt(parts2[0], 10);
      if (a > b) return h >= a || h < b; // 跨夜静默（23:00–次日 08:00）
      return h >= a && h < b;
    },
    sentToday: function (records) {
      var t = todayStr();
      var n = 0;
      for (var id in records) {
        var r = records[id];
        if (r && r.status === 'sent' && r.sentDate === t) n++;
      }
      return n;
    },
  };

  /* =========================================================
   * 5. 意向匹配引擎（M1 简化版：过滤 + 简单评分）
   *    M2 将升级为加权打分（技能命中/活跃度/薪资竞争力等）
   * ========================================================= */
  function matchJob(job, st) {
    var hay = ((job.title || '') + ' ' + (job.tags || []).join(' ')).toLowerCase();

    for (var i = 0; i < st.excludeKeywords.length; i++) {
      var w1 = st.excludeKeywords[i].toLowerCase();
      if (w1 && hay.indexOf(w1) >= 0) return { pass: false, score: 0 };
    }
    // 必含关键词按别名做"任一命中"，而不是把「运维/技术支持」整体当子串
    var inc = aliasList(st);
    if (inc.length) {
      var hit = false;
      for (var j = 0; j < inc.length; j++) {
        var w2 = inc[j].toLowerCase();
        if (w2 && hay.indexOf(w2) >= 0) { hit = true; break; }
      }
      if (!hit) return { pass: false, score: 0 };
    }
    if (st.preferredCities.length) {
      var jc = normCity(job.city);
      var ok = false;
      for (var k = 0; k < st.preferredCities.length; k++) {
        if (normCity(st.preferredCities[k]) === jc) { ok = true; break; }
      }
      if (!ok) return { pass: false, score: 0 };
    }
    var sal = parseSalaryK(job.salary);
    if (st.salaryMinK > 0 && sal && sal.max > 0 && sal.max < st.salaryMinK) {
      return { pass: false, score: 0 };
    }

    var score = 60;
    for (var m = 0; m < inc.length; m++) {
      var w3 = inc[m].toLowerCase();
      if (w3 && hay.indexOf(w3) >= 0) score += 10;
    }
    if (st.salaryMinK > 0 && sal && sal.max >= st.salaryMinK * 1.5) score += 5;
    if (score > 100) score = 100;
    return { pass: true, score: score };
  }

  /* =========================================================
   * 5.5 城市编码
   *      BOSS 用自有一套 city 码；前程无忧/应届生同为 51job 体系（jobArea/jobarea）。
   *      未收录的城市返回空串，则退回"全国搜索 + 本地城市过滤"。
   * ========================================================= */
  var CITY_CODES = {
    '北京': '101010100', '上海': '101020100', '天津': '101030100', '重庆': '101040100',
    '哈尔滨': '101050100', '长春': '101060100', '沈阳': '101070100', '大连': '101070200',
    '呼和浩特': '101080100', '石家庄': '101090100', '太原': '101100100', '西安': '101110100',
    '济南': '101120100', '青岛': '101120200', '郑州': '101180100', '南京': '101190100',
    '无锡': '101190200', '苏州': '101190400', '合肥': '101220100', '杭州': '101210100',
    '宁波': '101210400', '福州': '101230100', '厦门': '101230200', '南昌': '101240100',
    '长沙': '101250100', '武汉': '101200100', '广州': '101280100', '深圳': '101280600',
    '东莞': '101281600', '佛山': '101280800', '南宁': '101300100', '海口': '101310100',
    '昆明': '101290100', '贵阳': '101260100', '成都': '101270100', '兰州': '101160100',
    '西宁': '101150100', '银川': '101170100', '乌鲁木齐': '101130100',
  };

  // 51job / 应届生共用区域编码（已实测：北京/上海/广州/深圳/天津/重庆/成都/杭州/南京/武汉）
  var AREA_CODES = {
    '北京': '010000', '上海': '020000', '广州': '030200', '深圳': '040000',
    '天津': '050000', '重庆': '060000', '南京': '070200', '杭州': '080200',
    '成都': '090200', '武汉': '180200',
  };

  function areaCodeOf(city) {
    return AREA_CODES[normCity(city)] || '';
  }

  /* =========================================================
   * 6. BOSS 适配器
   * ========================================================= */
  var BossAdapter = {
    id: 'boss',
    name: 'BOSS直聘',
    cityInSearch: true, // 搜索 URL 支持 city 城市码

    isListPage: function () {
      if (/\/web\/geek\/(job|recommend)/.test(location.pathname)) return true;
      // 首页/城市频道也常带职位列表
      var p = location.pathname;
      return p === '/' || p === '/web/geek' || p === '/web/geek/';
    },
    isDetailPage: function () {
      return /\/job_detail\//.test(location.pathname);
    },
    jobIdOnPage: function () {
      var m = location.pathname.match(/job_detail\/([^\/\.]+)\.html/);
      return m ? m[1] : '';
    },
    searchUrl: function (task) {
      var u = 'https://www.zhipin.com/web/geek/jobs?query=' + encodeURIComponent(task.query);
      if (task.code) u += '&city=' + task.code;
      // 注意：实测 BOSS 新版搜索页忽略 URL page 参数（page=2 仍显示第 1 页），
      // 翻页由 scrollLoadMore 滚动加载实现，这里不再拼 page
      return u;
    },

    // 滚动加载下一屏职位（BOSS 新版列表页为无限滚动，15 张/屏）
    scrollLoadMore: async function () {
      var before = pickAll(SEL.card).length;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);
      window.scrollTo(0, document.body.scrollHeight);
      await waitFor(function () {
        return pickAll(SEL.card).length > before ? true : null;
      }, 6000, 600);
      await sleep(800);
    },
    isOnTaskPage: function (task) {
      if (!this.isListPage()) return false;
      try {
        var q = new URLSearchParams(location.search);
        // BOSS 翻页是滚动加载，URL 永远停在第 1 页；只校验关键词与城市
        var curCity = q.get('city');
        var cityOk = !task.code || !curCity || curCity === task.code;
        return q.get('query') === task.query && cityOk;
      } catch (e) { return false; }
    },
    isSecurityPage: function () {
      var u = location.href;
      for (var i = 0; i < SEL.captchaUrlHint.length; i++) {
        if (u.indexOf(SEL.captchaUrlHint[i]) >= 0) return true;
      }
      return !!pick(SEL.captcha);
    },

    // 抓取当前列表页职位（优先按 selector，全部不中时走通用兜底解析）
    scrapeList: function () {
      var jobs = this.scrapeBySelectors();
      if (!jobs.length) jobs = this.scrapeGeneric();
      return jobs;
    },

    // 从卡片 DOM 元素读取 Vue 组件实例数据（BOSS 自定义字体反爬的真实数据源）
    // Vue 把组件实例挂在元素的 __vue__ 属性上，$props.data 含 salaryDesc/brandName/cityName 等
    getVueCardData: function (card) {
      try {
        var el = card;
        while (el && !el.__vue__) el = el.parentElement;
        if (!el || !el.__vue__) return null;
        var data = el.__vue__.$props && el.__vue__.$props.data;
        if (!data) return null;
        return data;
      } catch (e) { return null; }
    },

    // 按配置 selector 解析职位卡片（优先 Vue 数据，兜底 DOM 文本）
    scrapeBySelectors: function () {
      var cards = pickAll(SEL.card);
      var jobs = [];
      var seen = {};
      var records = Store.getRecords();
      for (var i = 0; i < cards.length; i++) {
        try {
          var card = cards[i];
          var titleEl = pick(SEL.cardTitle, card);
          var linkEl = pick(SEL.cardLink, card);
          if (!titleEl || !linkEl) continue;
          var href = linkEl.getAttribute('href') || '';
          var mid = href.match(/job_detail\/([^\/\.]+)\.html/);
          if (!mid) continue;
          var jobId = mid[1];
          if (seen[jobId]) continue;
          seen[jobId] = true;
          var prev = records[Store.recKey('boss', jobId)];
          var tags = pickAll(SEL.cardTags, card).map(function (t) { return elText(t); });

          // 优先从 Vue 实例取真实数据（薪资无乱码、公司/城市准确）
          var vd = this.getVueCardData(card);
          var title = (vd && vd.jobName) || elText(titleEl);
          var salary = (vd && vd.salaryDesc) || elText(pick(SEL.cardSalary, card));
          var company = (vd && vd.brandName) || elText(pick(SEL.cardCompany, card));
          // 城市：Vue data 里 cityName=城市, areaDistrict=区, businessDistrict=商圈
          var city = '';
          if (vd && vd.cityName) {
            city = vd.cityName + (vd.areaDistrict ? '·' + vd.areaDistrict : '') +
                   (vd.businessDistrict ? '·' + vd.businessDistrict : '');
          } else {
            city = elText(pick(SEL.cardArea, card));
          }
          // 标签优先用 Vue data 的 jobLabels
          if (vd && vd.jobLabels && vd.jobLabels.length) tags = vd.jobLabels.slice();

          jobs.push({
            jobId: jobId,
            platform: 'boss',
            url: 'https://www.zhipin.com/job_detail/' + jobId + '.html',
            title: title,
            salary: salary,
            city: city,
            company: company,
            tags: tags,
            // 站内"继续沟通"标记或本脚本台账已有 sent 记录 => 视为已沟通过
            dup: hasText(card, ['继续沟通', '已沟通']) || !!(prev && prev.status === 'sent'),
          });
        } catch (e) { /* 单卡片解析失败不影响整体 */ }
      }
      return jobs;
    },

    // 在列表页查找指定 jobId 的卡片元素（供列表页直接投递使用）
    findJobOnList: function (jobId) {
      var cards = pickAll(SEL.card);
      for (var i = 0; i < cards.length; i++) {
        var linkEl = pick(SEL.cardLink, cards[i]);
        if (!linkEl) continue;
        var href = linkEl.getAttribute('href') || '';
        var mid = href.match(/job_detail\/([^\/\.]+)\.html/);
        if (mid && mid[1] === String(jobId)) return cards[i];
      }
      return null;
    },

    // 通用兜底：扫全站 /job_detail/ 链接，按文本启发式解析
    // 站点改版导致 SEL 全部失效时仍能工作（标题/薪资/城市为启发式结果）
    scrapeGeneric: function () {
      var anchors = document.querySelectorAll('a[href*="/job_detail/"]');
      var jobs = [];
      var seen = {};
      var records = Store.getRecords();
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var href = a.getAttribute('href') || '';
        var mid = href.match(/job_detail\/([^\/\.\?]+)\.html/);
        if (!mid || seen[mid[1]]) continue;
        var jobId = mid[1];
        var card = null;
        try { card = a.closest('li') || a.closest('[class*="job-card"]') || a.parentElement; }
        catch (e) { card = a.parentElement; }
        var text = (card && card.innerText) ? card.innerText : (a.innerText || '');
        var lines = text.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return !!s; });
        var title = lines[0] || '';
        if (!title || title.length > 30) title = (a.innerText || '').split('\n')[0].trim();
        var salary = '';
        var sm = text.match(/\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*[Kk]|\d+(?:\.\d+)?\s*[Kk]\s*以上|面议/);
        if (sm) salary = sm[0].replace(/\s/g, '');
        var city = '';
        var cm = text.match(/([\u4e00-\u9fa5]{2,6})[·•]/);
        if (cm) city = cm[1];
        var company = '';
        for (var k = 0; k < lines.length; k++) {
          if (lines[k] !== title && lines[k].length <= 30 &&
            /公司|有限|集团|科技|网络|信息|股份/.test(lines[k])) { company = lines[k]; break; }
        }
        seen[jobId] = true;
        var prev = records[Store.recKey('boss', jobId)];
        jobs.push({
          jobId: jobId,
          platform: 'boss',
          url: 'https://www.zhipin.com/job_detail/' + jobId + '.html',
          title: title,
          salary: salary,
          city: city,
          company: company,
          tags: [],
          dup: hasText(card, ['继续沟通', '已沟通']) || !!(prev && prev.status === 'sent'),
        });
      }
      return jobs;
    },

    // 抓取详情页信息（补充/校准列表数据）
    // BOSS 详情多在右侧滑出面板，薪资文本为字体乱码，优先读 window._jobInfo
    scrapeDetail: async function () {
      await waitFor(function () { return pick(SEL.dTitle); }, 8000, 400);
      // 尝试通过 unsafeWindow 读取页面全局 _jobInfo（含真实 salaryDesc）
      var jinfo = null;
      try {
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow._jobInfo) {
          jinfo = unsafeWindow._jobInfo;
        }
      } catch (e) { /* 忽略 */ }
      var mid = location.pathname.match(/job_detail\/([^\/\.]+)\.html/);
      var salary = '';
      if (jinfo && jinfo.salaryDesc) salary = jinfo.salaryDesc;
      else salary = elText(pick(SEL.dSalary));
      return {
        jobId: mid ? mid[1] : (jinfo && jinfo.encryptId) || undefined,
        title: (jinfo && jinfo.jobName) || elText(pick(SEL.dTitle)),
        salary: salary,
        company: elText(pick(SEL.dCompany)),
        city: (jinfo && jinfo.locationName) || elText(pick(SEL.dCity)),
        url: location.origin + location.pathname,
      };
    },

    // 打开卡片详情面板读取岗位描述（供 AI 评估判断"内容是否详细/有没有坑"）
    // 关闭方式尽量轻柔：优先点面板关闭按钮，否则点空白处把面板收起来
    fetchDesc: async function (job) {
      var card = this.findJobOnList(job.jobId);
      if (!card) return '';
      try {
        card.click();
        await sleep(900);
        // 首选 _jobInfo.postDescription：干净纯文本（DOM 里的 P.desc 混有自定义字体水印字）
        var txt = '';
        try {
          if (typeof unsafeWindow !== 'undefined' && unsafeWindow._jobInfo && unsafeWindow._jobInfo.postDescription) {
            txt = String(unsafeWindow._jobInfo.postDescription).trim();
          }
        } catch (e) { /* 忽略 */ }
        if (!txt) {
          var el = pick(SEL.dDesc);
          if (el) {
            var clone = el.cloneNode(true);
            clone.querySelectorAll('style,script').forEach(function (e) { e.remove(); });
            txt = (clone.innerText || clone.textContent || '').trim();
          }
        }
        // 详情面板里的公司/城市不要拿来覆盖列表值：新版右侧面板会把 HR 名片
        // （"王女士 在线" / "彭寅 刚刚活跃"）当成 .company-name 命中，
        // 覆盖后会把公司名写成 HR 的名字，模型还会据此判定"公司名虚假"。
        // 列表的 Vue 数据（brandName/cityName/areaDistrict）本来就更准。
        // 兜底清洗：DOM 兜底时可能把 HR 状态条/推荐位混进正文
        if (txt) {
          txt = txt.split('\n').filter(function (line) {
            var s = String(line).trim();
            if (!s) return false;
            return !/^(刚刚活跃|在线|今日活跃|回复率|平均回复|查看联系方式|举报|竞争力分析|相似职位|看过该职位的人还看了)/.test(s);
          }).join('\n').trim();
        }
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch (e) { /* 忽略 */ }
        await sleep(150);
        return txt;
      } catch (e) { return ''; }
    },

    // 核心投递链路（实测 2026-11）：
    //   列表页：点卡片打开右侧详情面板 -> 点「立即沟通」-> BOSS 自动发送预设招呼语
    //          -> 弹出「已向BOSS发送消息」-> 点「留在此页」留在列表继续下一个
    //   详情页：直接点「立即沟通」-> 同上
    // 注意：BOSS 招呼语由用户在【消息通知-设置招呼语】预设，脚本不参与文本输入。
    // 返回 {status: sent|failed|duplicate, msg}
    applyOnDetail: async function (greeting, job) {
      try {
        var jobId = job && job.jobId ? String(job.jobId) : '';

        // —— 列表页直接投递（推荐路径）——
        if (this.isListPage() && jobId) {
          var card = this.findJobOnList(jobId);
          if (!card) return { status: 'failed', msg: '列表页未找到该职位卡片（可能已翻页/下线）' };
          // 点卡片打开右侧详情面板
          card.click();
          await sleep(800);
          // 详情面板中按钮若为「继续沟通」说明已沟通过
          var chatBtnNow = pick(SEL.chatBtn);
          if (chatBtnNow && /继续沟通|已沟通/.test(chatBtnNow.textContent || '')) {
            return { status: 'duplicate', msg: '该职位已沟通过，自动跳过' };
          }
        }

        // 详情面板/详情页：点「立即沟通」
        var btn = await waitFor(function () {
          return pickByText(SEL.chatBtn, ['立即沟通']);
        }, 8000, 400);
        if (!btn) return { status: 'failed', msg: '未找到「立即沟通」按钮' };
        btn.click();

        // 等待成功弹窗（BOSS 自动发送预设招呼语）
        var popup = await waitFor(function () {
          return pick(SEL.successPopup) ||
            (hasText(document.body, SEL.successText) ? document.body : null);
        }, 10000, 400);

        if (!popup) {
          // 没出现成功弹窗，可能是验证码或异常
          return { status: 'failed', msg: '未检测到成功弹窗（可能触发安全验证）' };
        }

        // 点「留在此页」留在当前页，方便继续处理下一个
        var stay = pick(SEL.stayBtn);
        if (stay) {
          stay.click();
          await sleep(500);
        }
        return { status: 'sent', msg: '已向BOSS发送招呼语（BOSS 使用您预设的招呼语）' };
      } catch (e) {
        return { status: 'failed', msg: '投递流程异常：' + ((e && e.message) || e) };
      }
    },
  };

  /* =========================================================
   * 6.1 前程无忧适配器（申请职位按钮式投递）
   *     selector 待实测；投递成功后多为“已申请”状态或弹窗提示
   * ========================================================= */
  var Job51Adapter = {
    id: '51job',
    name: '前程无忧',
    cityInSearch: true, // 支持 jobArea 城市参数（已实测：jobArea=060000 出重庆岗位）

    isListPage: function () {
      var h = location.hostname;
      var p = location.pathname;
      if (/we\.51job\.com$/i.test(h)) return /\/pc\/(search|joblist)/.test(p);
      if (/sou\.51job\.com$/i.test(h)) return /list|search/i.test(p + location.search);
      return /search|joblist|list/i.test(p);
    },
    isDetailPage: function () {
      var h = location.hostname;
      if (/we\.51job\.com$/i.test(h)) {
        return /\/pc\/jobdetail/.test(location.pathname) || /[?&]jobId=/.test(location.search);
      }
      // jobs.51job.com 详情页：https://jobs.51job.com/{城市拼音}/{jobId}.html
      if (/jobs\.51job\.com$/i.test(h)) {
        return /\/\d{6,}\.html/.test(location.pathname);
      }
      return /\/\d{6,}\.html/.test(location.pathname) || /[?&]jobId=/.test(location.search);
    },
    jobIdOnPage: function () {
      var m = location.search.match(/[?&]jobId=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
      var m2 = location.pathname.match(/\/(\d{6,})\.html/);
      return m2 ? m2[1] : '';
    },
    searchUrl: function (task) {
      // 新版搜索页：keyword + jobArea（城市码）+ pageNum（分页）
      var u = 'https://we.51job.com/pc/search?keyword=' + encodeURIComponent(task.query) +
        '&searchType=2&sortType=0';
      var code = task.code || areaCodeOf(task.city);
      if (code) u += '&jobArea=' + code;
      if (task.page > 1) u += '&pageNum=' + task.page;
      return u;
    },
    isOnTaskPage: function (task) {
      if (!this.isListPage()) return false;
      try {
        var q = new URLSearchParams(location.search);
        var kw = q.get('keyword') || q.get('k') || '';
        var page = parseInt(q.get('pageNum') || q.get('page') || '1', 10) || 1;
        var code = task.code || areaCodeOf(task.city);
        var area = q.get('jobArea') || q.get('jobarea') || '';
        var areaOk = !code || !area || area === code;
        return kw === task.query && page === (task.page || 1) && areaOk;
      } catch (e) { return false; }
    },
    isSecurityPage: function () {
      var u = location.href;
      for (var i = 0; i < SEL51.captchaUrlHint.length; i++) {
        if (u.indexOf(SEL51.captchaUrlHint[i]) >= 0) return true;
      }
      return !!pick(SEL51.captcha);
    },

    // 从链接提取职位 ID
    extractId: function (href) {
      var m = String(href || '').match(/[?&]jobId=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
      var m2 = String(href || '').match(/\/(\d{6,})\.html/);
      if (m2) return m2[1];
      var m3 = String(href || '').match(/jobId[=\/](\d{5,})/);
      return m3 ? m3[1] : '';
    },

    // 解析卡片上的 sensorsdata 属性（新版 we.51job.com 最可靠的数据源）
    parseSensors: function (card) {
      try {
        var el = card.querySelector('.joblist-item-job[sensorsdata]') || card.querySelector('[sensorsdata]');
        if (!el) return null;
        var raw = el.getAttribute('sensorsdata') || '';
        // 兼容 HTML 实体转义
        raw = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#34;/g, '"');
        var data = JSON.parse(raw);
        if (!data || !data.jobId) return null;
        return data;
      } catch (e) { return null; }
    },

    // 在列表页查找指定 jobId 的卡片元素
    findJobOnList: function (jobId) {
      var cards = pickAll(SEL51.card);
      for (var i = 0; i < cards.length; i++) {
        var sd = this.parseSensors(cards[i]);
        if (sd && String(sd.jobId) === String(jobId)) return cards[i];
      }
      return null;
    },

    // 从列表卡片提取职位信息（优先 sensorsdata，兜底 DOM 文本）
    scrapeJobFromCard: function (card) {
      var sd = this.parseSensors(card);
      var jobId = sd ? String(sd.jobId) : '';
      if (!jobId) {
        var linkEl = pick(SEL51.cardLink, card);
        if (linkEl) jobId = this.extractId(linkEl.getAttribute('href') || '');
      }
      if (!jobId) return null;
      var records = Store.getRecords();
      var prev = records[Store.recKey('51job', jobId)];
      var title = (sd && sd.jobTitle) || elText(pick(SEL51.cardTitle, card)) || '';
      var salary = (sd && sd.jobSalary) || elText(pick(SEL51.cardSalary, card)) || '';
      var city = (sd && sd.jobArea) || elText(pick(SEL51.cardArea, card)) || '';
      var company = elText(pick(SEL51.cardCompany, card)) || (sd && sd.companyName) || '';
      var tags = pickAll(SEL51.cardTags, card).map(function (t) { return elText(t); });
      // 详情页 URL：新版搜索结果卡片大多数没有 <a href>，直接用官方详情页格式
      var linkEl2 = pick(SEL51.cardLink, card);
      var url = '';
      if (linkEl2) {
        var href = linkEl2.getAttribute('href') || '';
        url = href.indexOf('http') === 0 ? href : 'https://we.51job.com' + href;
      }
      if (!url) url = 'https://we.51job.com/pc/jobdetail?jobId=' + jobId;
      return {
        jobId: jobId,
        platform: '51job',
        url: url,
        title: title,
        salary: salary,
        city: city,
        company: company,
        tags: tags,
        dup: hasText(card, SEL51.appliedText) || !!(prev && prev.status === 'sent'),
      };
    },

    scrapeList: function () {
      var jobs = this.scrapeBySelectors();
      if (!jobs.length) jobs = this.scrapeGeneric();
      return jobs;
    },

    scrapeBySelectors: function () {
      var cards = pickAll(SEL51.card);
      var jobs = [];
      var seen = {};
      for (var i = 0; i < cards.length; i++) {
        try {
          var j = this.scrapeJobFromCard(cards[i]);
          if (!j || seen[j.jobId]) continue;
          seen[j.jobId] = true;
          jobs.push(j);
        } catch (e) { /* 单卡片失败不影响整体 */ }
      }
      return jobs;
    },

    // 通用兜底：扫职位详情链接，按文本启发式解析
    scrapeGeneric: function () {
      var sels = ['a[href*="jobId="]', 'a[href*="/pc/jobdetail"]', 'a[href*="jobdetail"]', 'a[href*="jobs.51job.com"]'];
      var anchors = [];
      for (var s = 0; s < sels.length && !anchors.length; s++) {
        try { anchors = Array.prototype.slice.call(document.querySelectorAll(sels[s])); } catch (e) { /* 忽略 */ }
      }
      var jobs = [];
      var seen = {};
      var records = Store.getRecords();
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var href = a.getAttribute('href') || '';
        var jobId = this.extractId(href);
        if (!jobId || seen[jobId]) continue;
        var card = null;
        try { card = a.closest('.joblist-item') || a.closest('li') || a.closest('div.e') || a.parentElement; }
        catch (e) { card = a.parentElement; }
        var text = (card && card.innerText) ? card.innerText : (a.innerText || '');
        var lines = text.split('\n').map(function (x) { return x.trim(); }).filter(function (x) { return !!x; });
        var title = (a.innerText || '').split('\n')[0].trim() || lines[0] || '';
        if (title.length > 30) title = lines[0] || title.slice(0, 30);
        var salary = '';
        var sm = text.match(/\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*[Kk千]|\d+(?:\.\d+)?\s*[Kk]\s*以上|面议/);
        if (sm) salary = sm[0].replace(/\s/g, '');
        var city = '';
        var cm = text.match(/([\u4e00-\u9fa5]{2,6})[·•]/);
        if (cm) city = cm[1];
        var company = '';
        for (var k = 0; k < lines.length; k++) {
          if (lines[k] !== title && lines[k].length <= 30 &&
            /公司|有限|集团|科技|网络|信息|股份/.test(lines[k])) { company = lines[k]; break; }
        }
        seen[jobId] = true;
        var prev = records[Store.recKey('51job', jobId)];
        jobs.push({
          jobId: jobId,
          platform: '51job',
          url: href.indexOf('http') === 0 ? href : 'https://we.51job.com' + href,
          title: title,
          salary: salary,
          city: city,
          company: company,
          tags: [],
          dup: hasText(card, SEL51.appliedText) || !!(prev && prev.status === 'sent'),
        });
      }
      return jobs;
    },

    scrapeDetail: async function () {
      await waitFor(function () { return pick(SEL51.dTitle); }, 8000, 400);
      return {
        jobId: this.jobIdOnPage() || undefined,
        title: elText(pick(SEL51.dTitle)),
        salary: elText(pick(SEL51.dSalary)),
        company: elText(pick(SEL51.dCompany)),
        city: elText(pick(SEL51.dCity)),
        url: location.origin + location.pathname + location.search,
      };
    },

    // 判定投递成功：只看可见弹窗与当前卡片/详情页自身的按钮状态。
    // 绝不能扫 document.body —— 列表页其它卡片的「已申请」会造成假阳性。
    applyOkNow: function (jobId) {
      // 1) 成功弹窗（新版 51job 的 .success-popup / 各类弹窗容器）
      if (pick(SEL51.successPopup)) return true;
      var dialogs = document.querySelectorAll(
        '.el-dialog__wrapper, .ant-modal-wrap, .modal, [class*="dialog"], [class*="popup"]');
      for (var i = 0; i < dialogs.length; i++) {
        var d = dialogs[i];
        if (d.style.display === 'none' || !d.offsetParent) continue;
        if (/投递成功|申请成功/.test(d.textContent || '')) return true;
      }
      // 2) 当前卡片按钮已变为已投递/已申请，或按钮消失（投递后被移除）
      if (jobId && this.isListPage() && typeof this.findJobOnList === 'function') {
        var cardNow = this.findJobOnList(jobId);
        if (cardNow) {
          var b = pick(SEL51.listApplyBtn, cardNow);
          if (!b) return true;
          if (/已申请|已投递/.test(elText(b))) return true;
          if (hasText(cardNow, ['投递成功', '申请成功'])) return true;
        }
      }
      // 3) 详情页：投递按钮变为已投递态（列表页不可用此分支，避免其它卡片干扰）
      if (this.isDetailPage()) {
        var btnNow = pickByText(SEL51.applyBtn, ['已申请', '已投递'], document.body);
        if (btnNow) return true;
      }
      return false;
    },

    // 核心投递链路
    // 优先：列表页直接点「投递」按钮（避免进入 jobs.51job.com 触发滑动验证）
    // 兜底：详情页点「申请职位」-> 确认弹窗 -> 判定结果
    applyOnDetail: async function (greeting, job) {
      try {
        var jobId = job && job.jobId ? String(job.jobId) : '';

        // —— 列表页直接投递 ——
        if (this.isListPage() && jobId) {
          var card = this.findJobOnList(jobId);
          if (!card) return { status: 'failed', msg: '列表页未找到该职位卡片（可能已翻页/下线）' };
          // 已投递判定
          if (hasText(card, SEL51.appliedText)) {
            return { status: 'duplicate', msg: '该职位已投递，自动跳过' };
          }
          var applyBtn = pick(SEL51.listApplyBtn, card);
          if (!applyBtn) return { status: 'failed', msg: '卡片上未找到「投递」按钮' };
          applyBtn.click();
          await sleep(1200);

          // 可能弹出「请选择需要投递的简历」，点「立即申请」
          var confirmBtn = await waitFor(function () {
            return pickByText(SEL51.confirmBtn, ['立即申请', '确认投递', '立即投递', '确定', '提交', '发送']);
          }, 3500, 300);
          if (confirmBtn) {
            confirmBtn.click();
            await sleep(1500);
          }

          return { status: 'sent', msg: this.applyOkNow(jobId)
            ? '投递成功（列表页直接投递）'
            : '已点击投递（乐观标记，请到投递记录核对）' };
        }

        // —— 详情页投递（兜底） ——
        // 已申请过
        if (pickByText(SEL51.applyBtn, SEL51.appliedText)) {
          return { status: 'duplicate', msg: '该职位已申请过，自动跳过' };
        }
        var btn = await waitFor(function () {
          return pickByText(SEL51.applyBtn, ['申请职位', '立即申请', '投递简历', '投递']);
        }, 8000, 400);
        if (!btn) return { status: 'failed', msg: '未找到「申请职位」按钮（selector 待实测：SEL51.applyBtn）' };
        btn.click();
        await sleep(1200);

        // 可能出现确认弹窗 / 选择简历弹窗
        var confirmBtn2 = await waitFor(function () {
          return pickByText(SEL51.confirmBtn, ['立即申请', '确认投递', '立即投递', '确定', '提交', '发送']);
        }, 3500, 300);
        if (confirmBtn2) {
          confirmBtn2.click();
          await sleep(1500);
        }

        return { status: 'sent', msg: this.applyOkNow(jobId)
          ? '投递成功（页面已提示）'
          : '已点击申请（乐观标记，请到投递记录核对）' };
      } catch (e) {
        return { status: 'failed', msg: '投递流程异常：' + ((e && e.message) || e) };
      }
    },
  };

  /* =========================================================
   * 6c. 应届生求职网适配器（q.yingjiesheng.com）
   *    2026-11 实测：列表页 div.search-list-item.job，点「立即申请」即投递
   * ========================================================= */
  var YjsAdapter = {
    id: 'yjs',
    name: '应届生求职网',
    cityInSearch: true, // 支持 jobarea 城市参数（已实测：060000=重庆, 090200=成都, 030200=广州）

    // 判断是否为职位列表页
    isListPage: function () {
      var p = location.pathname;
      if (/\/jobs\/search\/?/.test(p)) return true;
      if (p === '/' || /^\/(jobs|job)\/?$/.test(p)) return true;
      return false;
    },

    // 判断是否为职位详情页
    isDetailPage: function () {
      return /\/jobdetail\//.test(location.pathname);
    },

    // 从详情页 URL 提取 jobId
    jobIdOnPage: function () {
      var m = location.pathname.match(/jobdetail\/(\d+)\.html/);
      return m ? m[1] : null;
    },

    // 搜索 URL（已实测）：
    //   https://q.yingjiesheng.com/jobs/search/?keyword=运维&jobarea=060000&pageNum=2
    // 注意必须带结尾斜杠并用 query 参数；把关键词塞进路径会 404
    searchUrl: function (task) {
      var u = 'https://q.yingjiesheng.com/jobs/search/?keyword=' + encodeURIComponent(task.query);
      var code = task.code || areaCodeOf(task.city);
      if (code) u += '&jobarea=' + code;
      if (task.page > 1) u += '&pageNum=' + task.page;
      return u;
    },

    // 判断当前列表页是否对应当前搜索任务
    isOnTaskPage: function (task) {
      if (!this.isListPage()) return false;
      try {
        var q = new URLSearchParams(location.search);
        var kw = q.get('keyword') || '';
        var page = parseInt(q.get('pageNum') || '1', 10) || 1;
        var code = task.code || areaCodeOf(task.city);
        var area = q.get('jobarea') || '';
        var areaOk = !code || !area || area === code;
        return kw === task.query && page === (task.page || 1) && areaOk;
      } catch (e) { return false; }
    },

    // 安全验证页
    isSecurityPage: function () {
      var u = location.href;
      for (var i = 0; i < SELYJS.captchaUrlHint.length; i++) {
        if (u.indexOf(SELYJS.captchaUrlHint[i]) >= 0) return true;
      }
      return /滑动验证|访问验证/.test(document.title || '') || !!pick(SELYJS.captcha);
    },

    // —— 数据抓取 ——

    // 从卡片 DOM 提取 Vue 数据（职位列表在父组件 $props.jobList）
    getVueJobList: function () {
      try {
        var card = document.querySelector(SELYJS.card[0]);
        if (!card) return null;
        var el = card.parentElement;
        while (el) {
          if (el.__vue__ && el.__vue__.$props && el.__vue__.$props.jobList) {
            return el.__vue__.$props.jobList;
          }
          el = el.parentElement;
        }
      } catch (e) { /* 忽略 */ }
      return null;
    },

    // 按 selector 解析职位卡片（优先 Vue 数据，兜底 DOM 文本）
    scrapeBySelectors: function () {
      var cards = pickAll(SELYJS.card);
      var vueList = this.getVueJobList();
      var jobs = [];
      var seen = {};
      var records = Store.getRecords();
      for (var i = 0; i < cards.length; i++) {
        try {
          var card = cards[i];
          var titleEl = pick(SELYJS.cardTitle, card);
          if (!titleEl) continue;

          // 优先用 Vue 数据（按索引对齐）
          var vd = vueList && vueList[i] ? vueList[i] : null;
          var jobId = (vd && vd.jobid) || '';
          // 兜底 1：从卡片内的详情链接提取真实 ID
          if (!jobId) {
            var linkEl = pick(SELYJS.cardLink, card);
            var lm = linkEl ? String(linkEl.getAttribute('href') || '').match(/jobdetail\/(\d+)/) : null;
            if (lm) jobId = lm[1];
          }
          if (!jobId) {
            // 兜底 2（最后手段）：文本指纹。url 置空，避免拼出打不开的假详情页
            jobId = 'yjs_' + (card.textContent || '').slice(0, 40);
          }
          if (seen[jobId]) continue;
          seen[jobId] = true;

          var prev = records[Store.recKey('yjs', jobId)];
          var title = (vd && vd.jobname) || elText(titleEl);
          var salary = (vd && vd.providesalary) || elText(pick(SELYJS.cardSalary, card));
          var company = (vd && vd.coname) || elText(pick(SELYJS.cardCompany, card));
          var city = (vd && vd.jobarea) || elText(pick(SELYJS.cardArea, card));
          var tags = [];
          if (vd && vd.jobtag) {
            tags = String(vd.jobtag).split(',');
          } else {
            tags = pickAll(SELYJS.cardTags, card).map(function (t) { return elText(t); });
          }

          // 已投递判定：Vue 数据 isapply / 按钮文字为「已申请」/ 按钮消失
          var isApply = vd && String(vd.isapply) === '1';
          var applyBtn = pick(SELYJS.listApplyBtn, card);
          var btnText = applyBtn ? elText(applyBtn) : '';
          var noBtn = !applyBtn; // 投递后按钮被移除
          var dup = isApply || noBtn || /已申请|已投递/.test(btnText) || !!(prev && prev.status === 'sent');

          jobs.push({
            jobId: String(jobId),
            platform: 'yjs',
            // 只有真实数字 ID 才拼详情页 URL；文本指纹的条目留空，仅支持列表页直接投递
            url: /^\d+$/.test(String(jobId)) ? 'https://q.yingjiesheng.com/jobdetail/' + jobId + '.html' : '',
            title: title,
            salary: salary,
            city: city,
            company: company,
            tags: tags,
            dup: dup,
          });
        } catch (e) { /* 单卡片解析失败不影响整体 */ }
      }
      return jobs;
    },

    scrapeList: function () {
      // 必须同步返回数组：调用方（syncList / waitFor / Search.tick）都按 `j.length`
      // 判断有没有抓到卡片。原来返回 Promise，j.length === undefined，
      // 结果就是应届生永远「抓取 0 个卡片」，一个岗位都收不到。
      return this.scrapeBySelectors();
    },

    // 在列表页查找指定 jobId 的卡片元素
    findJobOnList: function (jobId) {
      var cards = pickAll(SELYJS.card);
      var vueList = this.getVueJobList();
      for (var i = 0; i < cards.length; i++) {
        var vd = vueList && vueList[i] ? vueList[i] : null;
        if (vd && String(vd.jobid) === String(jobId)) return cards[i];
      }
      return null;
    },

    scrapeDetail: async function () {
      await waitFor(function () { return pick(SELYJS.dTitle); }, 8000, 400);
      var mid = location.pathname.match(/jobdetail\/(\d+)\.html/);
      return {
        jobId: mid ? mid[1] : undefined,
        title: elText(pick(SELYJS.dTitle)),
        salary: elText(pick(SELYJS.dSalary)),
        company: elText(pick(SELYJS.dCompany)),
        city: elText(pick(SELYJS.dCity)),
        url: location.origin + location.pathname,
      };
    },

    // 核心投递链路：列表页直接点「立即申请」
    // 返回 {status: sent|failed|duplicate, msg}
    applyOnDetail: async function (greeting, job) {
      try {
        var jobId = job && job.jobId ? String(job.jobId) : '';

        // —— 列表页直接投递 ——
        if (this.isListPage() && jobId) {
          var card = this.findJobOnList(jobId);
          if (!card) return { status: 'failed', msg: '列表页未找到该职位卡片' };

          var applyBtn = pick(SELYJS.listApplyBtn, card);
          if (!applyBtn) {
            return { status: 'duplicate', msg: '该职位已投递（按钮消失），自动跳过' };
          }

          // 已投递判定
          if (/已申请|已投递/.test(elText(applyBtn))) {
            return { status: 'duplicate', msg: '该职位已投递，自动跳过' };
          }

          applyBtn.click();
        } else {
          // 详情页投递
          var btn = await waitFor(function () {
            return pickByText(SELYJS.applyBtn, ['立即申请', '投递简历', '申请职位']);
          }, 8000, 400);
          if (!btn) return { status: 'failed', msg: '未找到「立即申请」按钮' };
          btn.click();
        }

        // 等待成功弹窗（含「投递成功」）
        var ok = await waitFor(function () {
          var dialogs = document.querySelectorAll('.el-dialog__wrapper');
          for (var i = 0; i < dialogs.length; i++) {
            var d = dialogs[i];
            if (d.style.display === 'none') continue;
            if (/投递成功|申请成功/.test(d.textContent || '')) return true;
          }
          return false;
        }, 8000, 400);

        // 关闭弹窗
        var closeBtn = document.querySelector('.el-dialog__wrapper:not([style*="display: none"]) .el-dialog__close');
        if (closeBtn) closeBtn.click();

        if (ok) return { status: 'sent', msg: '投递成功' };
        return { status: 'sent', msg: '已点击申请（乐观标记，请到投递记录核对）' };
      } catch (e) {
        return { status: 'failed', msg: '投递流程异常：' + ((e && e.message) || e) };
      }
    },
  };

  /* =========================================================
   * 7. 投递队列执行器（跨页面状态机）
   *    状态持久化到 GM 存储：导航到目标详情页 -> 投递 -> 间隔 -> 下一个
   *
   *    多标签页注意：GM 存储是同一脚本的所有标签页共享的，
   *    所以队列状态天然是「全局唯一」的。这里用 TAB_ID + foreign 标记
   *    保证同一个队列只会有一个页面在真正操作：
   *      - foreign=true 的页面只读展示，绝不回写状态
   *      - start() 发现别人在跑就拒绝覆盖
   * ========================================================= */
  var TAB_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  var RUNNER_STALE_MS = 120000; // 心跳超时：关掉标签页/崩溃后，2 分钟后允许别的页面接管

  var Runner = {
    state: null,
    foreign: false, // 本页只读（队列目标在当前平台之外）

    start: function (queue) {
      // 互斥：别的标签页正在跑，且心跳还新鲜 -> 不覆盖它的队列
      var exist = Store.getRunner();
      if (exist && exist.status === 'running' && exist.tab && exist.tab !== TAB_ID &&
        Date.now() - (exist.heartbeatAt || 0) < RUNNER_STALE_MS) {
        var cur0 = exist.queue && exist.queue[exist.idx];
        Panel.notify('另一个标签页正在投递（' + platLabel(cur0 && cur0.platform) + ' ' +
          (exist.idx + 1) + '/' + exist.queue.length + '），请先在那边停止，或等它跑完');
        Panel.switchTab('queue');
        return false;
      }
      var st = Store.getSettings();
      this.foreign = false;
      this.state = {
        queue: queue.map(function (j) {
          return {
            jobId: j.jobId, url: j.url, title: j.title, company: j.company,
            salary: j.salary, city: j.city, tags: j.tags || [],
            platform: j.platform || plat().id, // 保留来源平台，跨平台路由依赖它
          };
        }),
        idx: 0,
        status: 'running',
        pauseReason: '',
        mode: st.mode,
        startedAt: Date.now(),
        tab: TAB_ID,
        heartbeatAt: Date.now(),
      };
      this.persist();
      Panel.notify('投递队列已启动（' + queue.length + ' 条）');
      Panel.refresh();
      this.gotoCurrent();
      return true;
    },

    persist: function () {
      if (!this.state) return;
      if (this.foreign) return; // 只读页不回写，否则会把正在投递的页面改成暂停
      this.state.tab = TAB_ID;
      this.state.heartbeatAt = Date.now();
      Store.saveRunner(this.state);
    },

    // 主动跳转前交出所有权：否则下一个页面会以为自己不是「队列主人」而卡住
    handoff: function () {
      if (!this.state || this.foreign) return;
      this.state.tab = '';
      this.state.heartbeatAt = Date.now();
      Store.saveRunner(this.state);
    },

    current: function () { return this.state ? this.state.queue[this.state.idx] : null; },

    isOnJob: function (job) {
      return !!(job && adapter().jobIdOnPage() === job.jobId);
    },

    gotoCurrent: function () {
      var job = this.current();
      if (!job) return this.finish();
      if (adapter().isSecurityPage()) {
        return this.pause('出现安全验证/滑块，请手动完成后点「继续投递」');
      }
      // 跨平台路由：该岗位来自其它平台时，导航到它自己的域名。
      // GM 存储全局共享，新页面的脚本实例会恢复队列并继续处理。
      if (job.platform && job.platform !== plat().id) {
        if (!job.url) {
          Panel.notify('跳过（跨平台岗位无有效链接）：' + job.title);
          this.state.idx += 1;
          this.persist();
          return this.gotoCurrent();
        }
        this.handoff();
        location.assign(job.url);
        return;
      }
      // 51job 等支持列表页直接投递：若当前就在列表页且能找到该职位卡片，直接投递
      if (adapter().isListPage() && typeof adapter().findJobOnList === 'function') {
        if (adapter().findJobOnList(job.jobId)) {
          Panel.refresh();
          this.tick();
          return;
        }
      }
      if (this.isOnJob(job)) {
        Panel.refresh();
        this.tick();
      } else {
        this.handoff();
        location.assign(job.url);
      }
    },

    tick: async function () {
      if (!this.state || this.state.status !== 'running') return;
      var job = this.current();
      if (!job) return this.finish();

      // 熔断检查：验证码 / 登录态 / 夜间静默 / 每日上限
      if (adapter().isSecurityPage()) {
        return this.pause('出现安全验证/滑块，请手动完成后点「继续投递」');
      }
      var login = await detectLogin();
      if (login.status === 'out') {
        return this.pause('登录态失效（' + login.how + '），请手动登录后点「继续投递」');
      }
      if (Limit.isQuietHour()) {
        return this.pause('夜间静默时段（' + plat().rateLimit.quietHours.join('–') + '），暂停投递');
      }
      var settings = Store.getSettings();
      var sentCnt = Limit.sentToday(Store.getRecords());
      if (sentCnt >= settings.dailyCap) {
        return this.pause('已达每日投递上限（' + sentCnt + '/' + settings.dailyCap + '）');
      }

      // 台账去重：已投过的直接跳过
      var records = Store.getRecords();
      var prev = Store.findRec(records, plat().id, job.jobId);
      if (prev && prev.status === 'sent') {
        Panel.notify('跳过已投递岗位：' + job.title);
        return this.advance();
      }

      Panel.badge('投递中');
      // 详情页信息校准 + 渲染招呼语（列表页直接投递时跳过 scrapeDetail）
      var detail;
      if (adapter().isListPage()) {
        detail = {};
      } else {
        detail = await adapter().scrapeDetail();
      }
      var merged = {
        jobId: job.jobId, url: job.url, title: job.title, company: job.company,
        salary: job.salary, city: job.city, tags: job.tags || [],
      };
      var keys = ['title', 'salary', 'company', 'city', 'url'];
      for (var i = 0; i < keys.length; i++) {
        if (detail[keys[i]]) merged[keys[i]] = detail[keys[i]];
      }
      var greeting = renderGreeting(settings.greetingTemplate, merged);

      var res = await adapter().applyOnDetail(greeting, merged);
      Store.upsertRecord({
        jobId: merged.jobId,
        platform: plat().id,
        title: merged.title,
        company: merged.company,
        salary: merged.salary,
        city: merged.city,
        url: merged.url,
        status: res.status,
        msg: res.msg,
        updatedAt: Date.now(),
        sentDate: res.status === 'sent' ? todayStr() : (prev && prev.sentDate) || '',
      });

      if (res.status === 'sent') {
        var after = Limit.sentToday(Store.getRecords());
        Panel.notify('已投递：' + merged.title + '（今日 ' + after + '/' + settings.dailyCap + '）');
      } else if (res.status === 'failed') {
        Panel.notify('投递失败：' + merged.title + ' — ' + res.msg);
      }
      Panel.refresh();
      await this.advance();
    },

    advance: async function () {
      if (!this.state) return;
      if (this.state.idx + 1 < this.state.queue.length) {
        var st = Store.getSettings();
        var iv = st.intervalSec || plat().rateLimit.intervalSec;
        var wait = randInt(iv[0], iv[1]);
        await Panel.countdown(wait, '下一岗位 ');
        // 等待期间可能被暂停/终止
        if (!this.state || this.state.status !== 'running') return;
        this.state.idx += 1;
        this.persist();
        Panel.refresh();
        this.gotoCurrent();
      } else {
        this.finish();
      }
    },

    pause: function (reason) {
      if (!this.state) return;
      if (this.foreign) return; // 只读页不许改别人队列的状态
      this.state.status = 'paused';
      this.state.pauseReason = reason;
      this.persist();
      Panel.notify('队列已暂停：' + reason);
      Panel.refresh();
    },

    resume: function () {
      if (!this.state) return;
      if (this.foreign) {
        return Panel.notify('队列当前岗位属于 ' + platLabel(this.current() && this.current().platform) +
          '，请到那个平台的标签页点「继续投递」');
      }
      this.state.status = 'running';
      this.state.pauseReason = '';
      this.persist();
      Panel.notify('队列继续投递');
      this.gotoCurrent();
    },

    stop: function () {
      if (this.foreign) {
        return Panel.notify('队列由 ' + platLabel(this.current() && this.current().platform) +
          ' 的标签页执行，请到那边终止');
      }
      this.state = null;
      Store.clearRunner();
      Panel.notify('队列已终止');
      Panel.refresh();
    },

    finish: function () {
      if (this.state) {
        this.state.status = 'done';
        this.persist();
      }
      Panel.badge('完成');
      Panel.notify('本次队列已全部处理完毕，可在「投递台账」查看结果');
      Panel.refresh();
    },
  };

  /* =========================================================
   * 7.5 自动搜索器
   *     按「必含关键词 × 优先城市」逐条打开 BOSS 搜索结果，翻页抓取，
   *     命中意向的岗位汇总进待投队列（持久化），再交给投递队列执行。
   * ========================================================= */
  var Search = {
    // 按平台分键：三个平台的标签页各自跑自己的自动搜索，任务进度互不覆盖
    key: 'jaap_search_v1:' + platformId(),
    state: null,

    cityCode: function (city) {
      return CITY_CODES[normCity(city)] || '';
    },

    // 依据当前求职意向生成搜索任务（关键词别名 × 城市）
    buildTasks: function () {
      var st = Store.getSettings();
      var kws = aliasList(st); // 「运维/技术支持」→ 运维、技术支持 两个搜索词
      if (!kws.length) return [];
      var a = adapter();
      var cities = a.cityInSearch === false
        ? [] // 该平台搜索不支持城市参数，按关键词搜全国再由本地城市过滤
        : st.preferredCities.slice(0, Math.max(1, st.searchCityLimit || 3));
      var tasks = [];
      for (var i = 0; i < kws.length; i++) {
        if (!cities.length) {
          tasks.push({ query: kws[i], city: '', code: '', page: 1 });
        } else {
          for (var j = 0; j < cities.length; j++) {
            var c = cities[j];
            var code = a.id === 'boss' ? (CITY_CODES[normCity(c)] || '') : areaCodeOf(c);
            tasks.push({ query: kws[i], city: c, code: code, page: 1 });
          }
        }
      }
      return tasks;
    },

    urlOf: function (task) { return adapter().searchUrl(task); },

    load: function () { this.state = Store.gmGet(this.key, null); },
    persist: function () { if (this.state) Store.gmSet(this.key, this.state); },
    current: function () { return this.state ? this.state.tasks[this.state.idx] : null; },

    start: function () {
      if (Runner.state && Runner.state.status === 'running') {
        Panel.notify('投递队列运行中，请先暂停或终止后再自动搜索');
        return;
      }
      var tasks = this.buildTasks();
      if (!tasks.length) {
        Panel.notify('请先在「求职意向」填写必含关键词，再使用自动搜索');
        Panel.open();
        Panel.switchTab('settings');
        return;
      }
      this.state = { tasks: tasks, idx: 0, status: 'running', pauseReason: '', collected: 0 };
      this.persist();
      Panel.notify('开始自动搜索：共 ' + tasks.length + ' 个搜索任务');
      Panel.refresh();
      this.goto();
    },

    goto: function () {
      var t = this.current();
      if (!t) return this.finish();
      if (adapter().isSecurityPage()) {
        return this.pause('出现安全验证/滑块，请手动完成后点「继续搜索」');
      }
      if (this.isOnTaskPage(t)) return this.tick();

      var url = this.urlOf(t);
      // 防止站点重定向导致“同地址反复跳转”死循环
      var nav = Store.gmGet('jaap_search_nav', null);
      var now = Date.now();
      if (nav && nav.url === url && now - (nav.ts || 0) < 10000) {
        return this.pause('搜索页跳转异常（同一地址重复跳转），可手动打开搜索结果页后点「继续搜索」');
      }
      Store.gmSet('jaap_search_nav', { url: url, ts: now });
      location.assign(url);
    },

    isOnTaskPage: function (t) { return adapter().isOnTaskPage(t); },

    tick: async function () {
      if (!this.state || this.state.status !== 'running') return;
      var t = this.current();
      if (!t) return this.finish();
      if (adapter().isSecurityPage()) {
        return this.pause('出现安全验证/滑块，请手动完成后点「继续搜索」');
      }
      var login = await detectLogin();
      if (login.status === 'out') {
        return this.pause('登录态失效，请手动登录后点「继续搜索」');
      }

      var jobs = await waitFor(function () {
        var j = adapter().scrapeList();
        return j.length ? j : null;
      }, 8000, 500);
      jobs = jobs || [];

      // 过滤不在意向内的、已投过的、已沟通过的
      var st = Store.getSettings();
      var records = Store.getRecords();
      var pid = plat().id;
      var picked = [];
      for (var i = 0; i < jobs.length; i++) {
        var j = jobs[i];
        if (j.dup || Store.findRec(records, pid, j.jobId)) continue;
        var m = matchJob(j, st);
        if (!m.pass) continue;
        j.score = m.score;
        picked.push(j);
      }
      var added = Panel.addToStaging(picked);
      // 并把本页抓到的岗位并入"本页匹配职位"，滚出来/翻页后的新卡片也能立刻看到
      Panel.absorb(picked);
      this.state.collected = (this.state.collected || 0) + added;
      Panel.notify('「' + t.query + (t.city ? ' · ' + t.city : '') + '」第 ' + t.page + ' 页：抓取 ' +
        jobs.length + ' 条，新增候选 ' + added + ' 条，累计 ' + this.state.collected + ' 条');
      Panel.refresh();

      // 就地评估：此刻卡片还在 DOM 里，能点开读正文；等翻页后这些岗位
      // 就离开页面了，队列里的条目再也没法补详情，只能拿摘要瞎评。
      if (added && Store.getSettings().evalDuringSearch !== false) {
        var fresh = picked.filter(function (x) { return !x.ai; });
        if (fresh.length) await Eval.run(fresh, { onlyNew: true, silent: true });
      }

      // 翻页间隔，降低风控触发概率
      await sleep(randInt(2500, 6000));
      if (!this.state || this.state.status !== 'running') return;

      if (t.page < (st.searchPages || 2)) {
        if (typeof adapter().scrollLoadMore === 'function') {
          // 滚动加载型平台（BOSS）：不导航，滚出下一屏后重新抓取
          t.page += 1;
          this.persist();
          await adapter().scrollLoadMore();
          return this.tick();
        }
        t.page += 1;
        this.persist();
        this.goto();
      } else if (this.state.idx + 1 < this.state.tasks.length) {
        this.state.idx += 1;
        this.state.tasks[this.state.idx].page = 1;
        this.persist();
        this.goto();
      } else {
        this.finish();
      }
    },

    pause: function (reason) {
      if (!this.state) return;
      this.state.status = 'paused';
      this.state.pauseReason = reason;
      this.persist();
      Panel.notify('搜索已暂停：' + reason);
      Panel.refresh();
    },

    resume: function () {
      if (!this.state) return;
      this.state.status = 'running';
      this.state.pauseReason = '';
      this.persist();
      Panel.notify('继续自动搜索');
      Panel.refresh();
      this.goto();
    },

    stop: function () {
      this.state = null;
      try { GM_deleteValue(this.key); } catch (e) { /* 忽略 */ }
      Panel.notify('已终止自动搜索（已收集的候选仍保留在待投队列）');
      Panel.refresh();
    },

    finish: function () {
      if (!this.state) return;
      this.state.status = 'done';
      this.persist();
      var n = this.state.collected || 0;
      Panel.notify('自动搜索完成，共收集 ' + n + ' 条候选');
      Panel.refresh();
      // 搜索结束后开启普通扫描监听
      if (adapter().isListPage()) {
        watchListPage();
        syncList({}); // 最后一页落了地，立刻同步一次，别让结果停在"要手动点重新扫描"
      }

      // 收集到的候选先过一遍 AI 评估（去坑/算真实到手），再决定是否投递
      var st = Store.getSettings();
      var pid2 = plat().id;
      var mine = Panel.staging.filter(function (j) {
        return (j.platform || pid2) === pid2 && !j.ai && !Eval.cache[Eval.cacheKey(j)];
      });
      if (!mine.length) return;
      if (st.mode === 'fast') {
        Eval.run(mine, { thenStart: true });
      } else {
        Eval.run(mine);
      }
    },
  };

  /* =========================================================
   * 7.6 AI 评估（调本地服务，key 不落浏览器）
   *     python job_eval_server.py 起在 127.0.0.1:8899，
   *     岗位数据 POST 过去，拿回 score/verdict/flags。
   * ========================================================= */
  function httpJson(method, url, body) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        return reject(new Error('当前脚本管理器不支持 GM_xmlhttpRequest'));
      }
      GM_xmlhttpRequest({
        method: method,
        url: url,
        headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 200000,
        onload: function (r) {
          var txt = r.responseText || '';
          try {
            resolve(JSON.parse(txt));
          } catch (e) {
            reject(new Error('评估服务返回的不是 JSON：' + txt.slice(0, 100)));
          }
        },
        onerror: function () {
          reject(new Error('连不上本地评估服务，请先在插件目录运行 python job_eval_server.py'));
        },
        ontimeout: function () { reject(new Error('评估超时（免费模型较慢，可减少一次评估条数）')); },
      });
    });
  }

  var Eval = {
    busy: false,
    lastSummary: '',
    // 评估结果缓存：BOSS 这类 SPA 每次 DOM 变动都会重新抓列表，
    // 抓出来的是全新对象，AI 结果必须按 jobId 单独存一份，否则渲染时 j.ai 就没了。
    // 额外落一份到 sessionStorage（同标签页同源），站内跳详情页再回来也不用重评。
    cache: (function () {
      try {
        if (typeof sessionStorage === 'undefined') return {};
        return JSON.parse(sessionStorage.getItem('jaap_ai_cache') || '{}') || {};
      } catch (e) { return {}; }
    })(),
    // 岗位详情缓存：点开卡片读正文很慢（每条 1 秒多），读过就别再读
    descCache: (function () {
      try {
        if (typeof sessionStorage === 'undefined') return {};
        return JSON.parse(sessionStorage.getItem('jaap_desc_cache') || '{}') || {};
      } catch (e) { return {}; }
    })(),
    _cacheTimer: null,
    abort: false,
    // 公司口碑结果（按 平台:jobId 存，重扫/重建卡片都不会丢）
    reviewCache: {},

    cacheKey: function (j) {
      return (j && j.platform || plat().id) + ':' + (j && j.jobId || '');
    },

    saveCache: function () {
      var self = this;
      if (this._cacheTimer) return;
      this._cacheTimer = setTimeout(function () {
        self._cacheTimer = null;
        // 别无限长：超出就从最早的开始丢（自动搜索一轮可能几百条，留宽一点）
        var ks = Object.keys(self.cache);
        if (ks.length > 1500) for (var i = 0; i < ks.length - 1200; i++) delete self.cache[ks[i]];
        var ds = Object.keys(self.descCache);
        if (ds.length > 400) for (var d = 0; d < ds.length - 300; d++) delete self.descCache[ds[d]];
        try {
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('jaap_ai_cache', JSON.stringify(self.cache));
            sessionStorage.setItem('jaap_desc_cache', JSON.stringify(self.descCache));
          }
        } catch (e) { /* 超配额就只留内存 */ }
      }, 600);
    },

    baseUrl: function () {
      var u = Store.getSettings().evalUrl || DEFAULT_SETTINGS.evalUrl;
      return String(u).replace(/\/+$/, '');
    },

    // 把一条岗位转成评估服务要的形状
    payloadOf: function (j) {
      return {
        jobId: j.jobId,
        platform: j.platform || plat().id,
        title: j.title || '',
        company: j.company || '',
        salary: j.salary || '',
        city: j.city || '',
        tags: j.tags || [],
        desc: j.desc || '',
        url: j.url || '',
      };
    },

    // 服务商配置：Key 存在浏览器（GM 存储），每次请求随包发给本机服务，服务端不落盘
    llmConfig: function () {
      var st = Store.getSettings();
      var p = presetOf(st.llmProvider);
      var baseUrl = st.llmBaseUrl || p.baseUrl;
      var model = st.llmModel || p.model;
      var key = (st.llmKey || '').trim();
      // 没有 Key 且不是本地模型 → 返回 null，让服务端用 .env 兜底（兼容老用法）
      if (!key && !p.local) return null;
      return {
        baseUrl: baseUrl,
        apiKey: key,
        model: model,
        fallbackModel: st.llmFallback || p.fallback || '',
        noThinking: !!p.noThinking,
      };
    },

    // 从表单读配置（用于「测试连接」，不必先保存）
    formConfig: function () {
      function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
      var pv = document.getElementById('jaapLlmPreset');
      var pid = pv && pv.value ? pv.value : Store.getSettings().llmProvider;
      var p = presetOf(pid);
      var key = val('jaapLlmKey').trim();
      var base = val('jaapLlmBase').trim() || p.baseUrl;
      var model = val('jaapLlmModel').trim() || p.model;
      if (!key && !p.local) return null;
      return {
        baseUrl: base, apiKey: key, model: model,
        fallbackModel: val('jaapLlmFallback').trim() || p.fallback || '',
        noThinking: !!p.noThinking,
      };
    },

    // 连通性测试：确认地址/Key/模型三件套可用
    test: async function () {
      var cfg = this.formConfig();
      var box = document.getElementById('jaapLlmTest');
      if (!cfg) {
        if (box) box.textContent = '请先填 API Key';
        Panel.notify('请先填 API Key（本地 Ollama 可留空）');
        return;
      }
      if (box) box.textContent = '测试中…';
      try {
        var res = await httpJson('POST', this.baseUrl() + '/test', { llm: cfg });
        if (res && res.ok) {
          if (box) box.textContent = '连通 ' + res.ms + 'ms · ' + res.model + ' 回复「' + res.reply + '」';
          Panel.notify('连接成功：' + res.model);
        } else {
          var msg = (res && res.error) || '失败';
          if (box) box.textContent = msg;
          Panel.notify('连接失败：' + msg);
        }
      } catch (err) {
        var m2 = (err && err.message) || String(err);
        if (box) box.textContent = m2;
        Panel.notify('连接失败：' + m2);
      }
    },

    // 评估一批岗位（就地写回 j.ai / j.score）
    // opts.onlyNew: 只评还没评过的（自动评估路径用，避免重复调用 API）
    // opts.silent:  没有新岗位可评时不弹提示
    run: async function (list, opts) {
      opts = opts || {};
      if (this.busy) return;
      var jobs = (list || []).filter(function (j) { return j && j.jobId; });
      if (opts.onlyNew) {
        jobs = jobs.filter(function (j) { return !j.ai && !Eval.cache[Eval.cacheKey(j)]; });
      }
      if (!jobs.length) {
        if (!opts.silent) Panel.notify(opts.onlyNew ? '这些岗位都评估过了（要重评用「重新评估」）' : '没有可评估的岗位');
        return;
      }
      // 逐条评估：不再一刀切只取前 30 条，第二页/滚出来的岗位也能评到
      var batch = jobs.slice(0, 60);
      var a = adapter();
      var canDesc = !opts.noDesc && a.isListPage() && typeof a.fetchDesc === 'function';
      var llm = this.llmConfig();
      var pass = 0, watch = 0, reject = 0, done = 0, failed = 0, lastErr = '';

      this.busy = true;
      this.abort = false;
      Panel.notify('AI 评估中：共 ' + batch.length + ' 条，评一条显示一条');
      try {
        for (var bi = 0; bi < batch.length; bi++) {
          if (!this.busy || this.abort) break;
          var j = batch[bi];
          var dk = this.cacheKey(j);

          // 详情：先查缓存（同一岗位只读一次详情），没有再点开卡片读
          if (!j.desc && this.descCache[dk]) j.desc = this.descCache[dk];
          if (!j.desc && canDesc) {
            Panel.badge('读详情 ' + (bi + 1) + '/' + batch.length);
            try {
              var d = await a.fetchDesc(j);
              if (d) { j.desc = d; this.descCache[dk] = d; this.saveCache(); }
            } catch (e) { /* 单条失败不影响后续 */ }
          }

          Panel.badge('评估 ' + (bi + 1) + '/' + batch.length);
          try {
            var res = await httpJson('POST', this.baseUrl() + '/evaluate', {
              jobs: [this.payloadOf(j)],
              llm: llm,
            });
            var r = res && res.ok && res.results && res.results[0];
            if (r && !r.error) {
              j.ruleScore = j.ruleScore || j.score; // 保留规则分，别被 AI 分覆盖丢掉
              j.ai = r;
              j.score = r.score;
              this.cache[dk] = r;
              done++;
              if (r.verdict === 'pass') pass++;
              else if (r.verdict === 'watch') watch++;
              else reject++;
              this.lastSummary = '已评 ' + done + '/' + batch.length +
                '（推荐 ' + pass + ' · 观望 ' + watch + ' · 别投 ' + reject + '）';
              this.saveCache();
              Panel.refresh(); // ← 评完一条立刻显示，不等整批
            } else {
              failed++;
              lastErr = (res && res.error) || '服务返回为空';
            }
          } catch (err) {
            failed++;
            lastErr = (err && err.message) || String(err);
            if (done === 0 && failed >= 3) throw err; // 连续失败说明是配置问题，别硬撑
          }
        }
        this.lastSummary = (done ? '评估完成：' : '评估失败：') + '推荐 ' + pass + ' / 观望 ' + watch +
          ' / 别投 ' + reject + (failed ? ' · 失败 ' + failed : '');
        Panel.notify(this.lastSummary + (!done && lastErr ? '（' + lastErr + '）' : ''));
        if (opts.thenStart && done) Panel.handleAction('startRun');
      } catch (err) {
        this.lastSummary = '';
        Panel.notify('评估失败：' + ((err && err.message) || err));
      } finally {
        this.busy = false;
        this.abort = false;
        Panel.badge('');
        Panel.refresh();
      }
    },

    // 取"能投的"：有 AI 结果就按分数过滤，没有 AI 结果则保留（交给规则匹配）
    eligible: function (list) {
      var st = Store.getSettings();
      var min = typeof st.minScore === 'number' ? st.minScore : 60;
      return (list || []).filter(function (j) {
        if (j.dup) return false;
        // 队列条目是从共享存储读的（不含 ai 字段），得回落到 Eval.cache 查
        var ai = j.ai || Eval.cache[Eval.cacheKey(j)];
        if (ai) return ai.score >= min && ai.verdict !== 'reject';
        return true;
      });
    },

    // 扫描后自动评估（防抖 3 秒；只评新出现的岗位；搜索/投递运行中不打扰）
    _autoTimer: null,
    autoRun: function () {
      if (this._autoTimer) clearTimeout(this._autoTimer);
      var self = this;
      this._autoTimer = setTimeout(function () {
        self._autoTimer = null;
        if (self.busy) return;
        if (Search.state && Search.state.status === 'running') return; // 搜索流程自己会评
        if (Runner.state && Runner.state.status === 'running') return; // 投递中不打扰
        var st = Store.getSettings();
        if (!st.autoEval) return;
        var fresh = self.eligible(Panel.matched).filter(function (j) { return !j.ai; });
        if (!fresh.length) return;
        self.run(fresh, { onlyNew: true, silent: true });
      }, 3000);
    },
  };

  /* =========================================================
   * 8.1 浮窗面板 CSS
   * ========================================================= */
  var CSS_TEXT = [
    '#jaapBall{position:fixed;right:18px;bottom:64px;width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#2f6bff,#38b7ff);color:#fff;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:grab;z-index:999998;box-shadow:0 4px 14px rgba(47,107,255,.45);user-select:none;touch-action:none}',
    '#jaapBall .jaap-badge{position:absolute;top:-9px;left:50%;transform:translateX(-50%);background:#ff5722;color:#fff;font-size:11px;line-height:17px;padding:0 6px;border-radius:9px;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:400}',
    '.jaap-panel{position:fixed;right:14px;bottom:118px;width:400px;max-height:72vh;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.22);z-index:999999;display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#222;font-size:12px}',
    '.jaap-panel.open{display:flex}',
    '.jaap-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#2f6bff;color:#fff;font-size:14px;font-weight:600;cursor:move;user-select:none}',
    '.jaap-dragging{cursor:grabbing!important}',
    '.jaap-close{cursor:pointer;font-size:18px;line-height:1;padding:0 4px;font-weight:400}',
    '.jaap-tabs{display:flex;border-bottom:1px solid #eee;background:#f7f9fc}',
    '.jaap-tab{flex:1;text-align:center;padding:9px 0;font-size:13px;cursor:pointer;color:#666;border-bottom:2px solid transparent}',
    '.jaap-tab.active{color:#2f6bff;border-bottom-color:#2f6bff;font-weight:600;background:#fff}',
    '.jaap-body{overflow-y:auto;padding:10px 12px}',
    '.jaap-strip{background:#f2f6ff;border:1px solid #dbe6ff;border-radius:8px;padding:8px 10px;margin-bottom:8px;line-height:1.6}',
    '.jaap-strip.warn{background:#fff7e8;border-color:#ffe1a8}',
    '.jaap-btn{display:inline-block;border:1px solid #2f6bff;color:#2f6bff;background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;margin:0 6px 6px 0;user-select:none}',
    '.jaap-btn.primary{background:#2f6bff;color:#fff}',
    '.jaap-btn.danger{border-color:#e5534b;color:#e5534b}',
    '.jaap-btn.mini{padding:1px 6px;font-size:11px;margin:0}',
    '.jaap-sec{margin:8px 0 4px;font-weight:600;color:#333}',
    '.jaap-item{border:1px solid #eee;border-radius:8px;padding:6px 8px;margin-bottom:6px;line-height:1.5}',
    '.jaap-item .t{font-weight:600;font-size:12.5px}',
    '.jaap-item .meta{color:#888;margin-top:2px}',
    '.jaap-item.dup{opacity:.55}',
    '.jaap-score{float:right;color:#2f6bff;font-weight:700}',
    '.jaap-table{width:100%;border-collapse:collapse;margin-top:6px}',
    '.jaap-table th,.jaap-table td{border-bottom:1px solid #eee;padding:4px;text-align:left;vertical-align:top}',
    '.jaap-table th{color:#999;font-weight:500}',
    '.jaap-form label{display:block;margin:8px 0 3px;color:#555}',
    '.jaap-form input,.jaap-form textarea,.jaap-form select{width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit}',
    '.jaap-form textarea{height:56px;resize:vertical}',
    '.jaap-hint{color:#999;line-height:1.5;margin-top:2px;font-weight:400}',
    '.jaap-toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);background:rgba(20,20,20,.85);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:1000000;max-width:70vw;opacity:0;transition:opacity .3s;pointer-events:none}',
    '.jaap-toast.show{opacity:1}',
    '.jaap-muted{color:#999;line-height:1.6}',
  ].join('\n');

  /* ---------- 拖动支持（悬浮球与面板均可拖动，位置持久化） ---------- */
  function clampNum(v, min, max) {
    if (max < min) max = min;
    return Math.min(Math.max(v, min), max);
  }

  // el: 被拖动元素；handle: 拖动柄；key: 位置存储键；onClick: 未发生拖动时的点击回调
  function attachDrag(el, handle, key, onClick) {
    var dragging = false;
    var moved = false;
    var start = null;

    function pt(e) {
      var ev = (e.touches && e.touches[0]) ? e.touches[0] : e;
      return { x: ev.clientX, y: ev.clientY };
    }
    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('.jaap-close')) return;
      var p = pt(e);
      var r = el.getBoundingClientRect();
      start = { x: p.x, y: p.y, left: r.left, top: r.top, w: r.width, h: r.height };
      moved = false;
      dragging = true;
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.classList.add('jaap-dragging');
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      document.addEventListener('touchmove', onMove, true);
      document.addEventListener('touchend', onUp, true);
    }
    function onMove(e) {
      if (!dragging || !start) return;
      var p = pt(e);
      var dx = p.x - start.x;
      var dy = p.y - start.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      if (e.cancelable) e.preventDefault();
      el.style.left = clampNum(start.left + dx, 0, window.innerWidth - start.w) + 'px';
      el.style.top = clampNum(start.top + dy, 0, window.innerHeight - start.h) + 'px';
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('touchmove', onMove, true);
      document.removeEventListener('touchend', onUp, true);
      el.classList.remove('jaap-dragging');
      if (moved) {
        Store.savePos(key, { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 });
      } else if (typeof onClick === 'function') {
        onClick();
      }
      start = null;
    }

    handle.addEventListener('mousedown', onDown, false);
    handle.addEventListener('touchstart', onDown, { passive: true });
  }

  // 恢复已保存位置并夹到可视区域内
  function restorePos(el, key, fallbackW, fallbackH) {
    var pos = Store.getPos(key);
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
    var w = el.offsetWidth || fallbackW || 0;
    var h = el.offsetHeight || fallbackH || 0;
    el.style.left = clampNum(pos.left, 0, window.innerWidth - w) + 'px';
    el.style.top = clampNum(pos.top, 0, window.innerHeight - h) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  var Panel = {
    el: null,
    tab: 'queue',
    matched: [],
    excludedCount: 0,
    rawCount: 0,
    staging: [],
    stagingExpand: false, // 待投队列超过 30 条时默认折叠，避免面板被长列表撑爆
    _clearArm: 0,         // 清空按钮的二次确认时间戳
    _clearOtherArm: 0,    // 清空「其它平台」的二次确认时间戳
    _sig: '',

    build: function () {
      if (this.el) return;
      if (typeof GM_addStyle === 'function') GM_addStyle(CSS_TEXT);
      else {
        var s = document.createElement('style');
        s.textContent = CSS_TEXT;
        (document.head || document.documentElement).appendChild(s);
      }

      var wrap = document.createElement('div');
      wrap.id = 'jaapRoot';
      wrap.innerHTML =
        '<div class="jaap-toast" id="jaapToast"></div>' +
        '<div id="jaapBall" title="求职自动投递助手"><span>投</span><div class="jaap-badge" id="jaapBadge"></div></div>' +
        '<div class="jaap-panel" id="jaapPanel">' +
        '  <div class="jaap-head"><span>求职自动投递 · ' + esc(plat().name) + '</span><span class="jaap-close" id="jaapClose">×</span></div>' +
        '  <div class="jaap-tabs">' +
        '    <div class="jaap-tab active" data-tab="queue">投递队列</div>' +
        '    <div class="jaap-tab" data-tab="ledger">投递台账</div>' +
        '    <div class="jaap-tab" data-tab="settings">求职意向</div>' +
        '  </div>' +
        '  <div class="jaap-body">' +
        '    <div id="jaapTabQueue"></div>' +
        '    <div id="jaapTabLedger" style="display:none"></div>' +
        '    <div id="jaapTabSettings" style="display:none"></div>' +
        '  </div>' +
        '</div>';
      document.body.appendChild(wrap);
      this.el = wrap;

      // 事件委托（重渲染后无需重复绑定）
      var self = this;
      wrap.addEventListener('click', function (e) {
        var tabEl = e.target.closest('.jaap-tab');
        if (tabEl) {
          self.switchTab(tabEl.getAttribute('data-tab'));
          return;
        }
        if (e.target.id === 'jaapClose') { self.close(); return; }
        var actEl = e.target.closest('[data-act]');
        if (actEl) self.handleAction(actEl.getAttribute('data-act'), actEl);
      });

      // 服务商预设切换：立刻把地址/模型/提示填进表单（不必先保存）
      wrap.addEventListener('change', function (e) {
        if (e.target && e.target.id === 'jaapLlmPreset') {
          var p = presetOf(e.target.value);
          var baseEl = document.getElementById('jaapLlmBase');
          var modelEl = document.getElementById('jaapLlmModel');
          var fbEl = document.getElementById('jaapLlmFallback');
          var keyEl = document.getElementById('jaapLlmKey');
          var hintEl = document.getElementById('jaapLlmHint');
          if (baseEl) baseEl.value = p.baseUrl || '';
          if (modelEl) modelEl.value = p.model || '';
          if (fbEl) fbEl.value = p.fallback || '';
          if (keyEl) keyEl.placeholder = p.local ? '本地模型可留空' : 'sk-…';
          if (hintEl) hintEl.textContent = p.hint || '';
          var box = document.getElementById('jaapLlmTest');
          if (box) box.textContent = '';
        }
      });
      // 悬浮球：可拖动，拖动后位置持久化；未拖动视为点击（开合面板）
      var ball = document.getElementById('jaapBall');
      attachDrag(ball, ball, 'jaap_ball_pos_v1', function () { self.toggle(); });
      restorePos(ball, 'jaap_ball_pos_v1', 46, 46);

      // 面板：拖标题栏移动
      var panelEl = document.getElementById('jaapPanel');
      attachDrag(panelEl, panelEl.querySelector('.jaap-head'), 'jaap_panel_pos_v1', null);
      this._panelPosPending = true;

      window.addEventListener('resize', function () {
        self.keepInView(ball, 46, 46);
        if (panelEl.classList.contains('open')) self.keepInView(panelEl, 0, 0);
      });

      this.renderSettings();
      this.loadStaging();
      this.refresh();
    },

    // 切换标签页
    switchTab: function (tab) {
      var wrap = this.el;
      if (!wrap) return;
      var tabs = wrap.querySelectorAll('.jaap-tab');
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].getAttribute('data-tab') === tab) tabs[i].classList.add('active');
        else tabs[i].classList.remove('active');
      }
      document.getElementById('jaapTabQueue').style.display = tab === 'queue' ? '' : 'none';
      document.getElementById('jaapTabLedger').style.display = tab === 'ledger' ? '' : 'none';
      document.getElementById('jaapTabSettings').style.display = tab === 'settings' ? '' : 'none';
      this.tab = tab;
    },

    // 待投队列（持久化：自动搜索跨页面收集不丢）
    loadStaging: function () { this.staging = Store.getStaging(); },
    saveStaging: function () { Store.saveStaging(this.staging); },
    // 追加候选（按 jobId 去重），返回新增条数
    // 写前重读共享存储再合并：三个平台各开一个标签页同时扫描时不会互相覆盖
    addToStaging: function (list) {
      if (!list || !list.length) return 0;
      var r = Store.mergeStaging(list);
      this.staging = r.list;
      if (r.added) this.refresh();
      return r.added;
    },

    // 窗口尺寸变化后把元素夹回可视区
    keepInView: function (el, fw, fh) {
      if (!el || !el.style.left) return;
      var w = el.offsetWidth || fw;
      var h = el.offsetHeight || fh;
      if (!w || !h) return;
      el.style.left = clampNum(parseFloat(el.style.left) || 0, 0, window.innerWidth - w) + 'px';
      el.style.top = clampNum(parseFloat(el.style.top) || 0, 0, window.innerHeight - h) + 'px';
    },

    open: function () {
      var p = document.getElementById('jaapPanel');
      if (!p) return;
      p.classList.add('open');
      // 面板隐藏时尺寸为 0，需在显示后再恢复位置
      if (this._panelPosPending) {
        restorePos(p, 'jaap_panel_pos_v1', 400, 320);
        this._panelPosPending = false;
      }
    },
    close: function () {
      var p = document.getElementById('jaapPanel');
      if (p) p.classList.remove('open');
    },
    toggle: function () {
      var p = document.getElementById('jaapPanel');
      if (!p) return;
      if (p.classList.contains('open')) this.close();
      else this.open();
    },

    notify: function (msg) {
      var t = document.getElementById('jaapToast');
      if (!t) return;
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3000);
    },

    badge: function (text) {
      var b = document.getElementById('jaapBadge');
      if (!b) return;
      b.textContent = text || '';
      b.style.display = text ? '' : 'none';
    },

    countdown: function (sec, prefix) {
      var self = this;
      return new Promise(function (resolve) {
        var left = sec;
        var timer = setInterval(function () {
          if (!Runner.state || Runner.state.status !== 'running') {
            clearInterval(timer);
            resolve();
            return;
          }
          self.badge(prefix + left + 's');
          left -= 1;
          if (left < 0) { clearInterval(timer); resolve(); }
        }, 1000);
      });
    },

    // 对本页抓取结果做意向匹配，拆分通过/过滤；返回结果是否发生变化
    setMatched: function (jobs) {
      var st = Store.getSettings();
      var pass = [];
      var excluded = 0;
      var list = jobs || [];
      // 每次抓取都会造一批新对象，这里先把上一轮对象上的东西按 jobId 建索引：
      // BOSS/51job 的列表会被 MutationObserver 反复重抓，不迁移就会把 AI 明细冲掉，
      // 表现就是「明明评估过、统计也对，但卡片上只剩一个裸分数」。
      var prev = {};
      for (var p = 0; p < this.matched.length; p++) {
        var pj = this.matched[p];
        if (pj && pj.jobId) prev[Eval.cacheKey(pj)] = pj;
      }
      for (var i = 0; i < list.length; i++) {
        var j = list[i];
        var m = matchJob(j, st);
        if (m.pass && !j.dup) {
          j.score = m.score;
          var key = Eval.cacheKey(j);
          var old = prev[key];
          var ai = (old && old.ai) || Eval.cache[key];
          if (ai) {
            j.ai = ai;
            j.ruleScore = m.score;
            j.score = ai.score;
          } else if (old && typeof old.ruleScore === 'number') {
            j.ruleScore = old.ruleScore;
          }
          if (old && old.desc && !j.desc) j.desc = old.desc; // 已读过的详情不重复抓
          if (old && old.review) j.review = old.review;      // 查过的口碑别被重扫冲掉
          if (!j.review && Eval.reviewCache[key]) j.review = Eval.reviewCache[key];
          pass.push(j);
        }
        else excluded++;
      }
      var sig = pass.map(function (x) { return x.jobId; }).join(',') + '|' + excluded + '|' + list.length;
      var changed = sig !== this._sig;
      this._sig = sig;
      this.rawCount = list.length;
      this.matched = pass;
      this.excludedCount = excluded;
      return changed;
    },

    // 把 AI 评估结果按 jobId 回填到「当前正在显示」的对象上。
    // 自动搜索/翻页/SPA 重扫都会造一批全新对象，而评估结果只存在 Eval.cache 里；
    // 不回填的后果是：明明已经评过、顶部统计也对，卡片上却看不到明细，
    // 必须点「重新扫描本页」走一遍 setMatched 才会迁过来。
    applyAICache: function () {
      var cache = Eval.cache, descs = Eval.descCache, reviews = Eval.reviewCache;
      function fill(j) {
        if (!j || !j.jobId) return;
        var k = Eval.cacheKey(j);
        if (!j.ai && cache[k]) {
          if (typeof j.ruleScore !== 'number' && typeof j.score === 'number') j.ruleScore = j.score;
          j.ai = cache[k];
          j.score = cache[k].score;
        }
        if (!j.desc && descs[k]) j.desc = descs[k];
        if (!j.review && reviews[k]) j.review = reviews[k];
      }
      for (var i = 0; i < this.matched.length; i++) fill(this.matched[i]);
      for (var m = 0; m < this.staging.length; m++) fill(this.staging[m]);
    },

    // 把自动搜索刚抓到的岗位并入「本页匹配职位」：滚动加载出来的新卡片
    // 不会被 syncList 收进来（搜索运行中监听是让位的），不并入就一直是 0 条。
    absorb: function (list) {
      if (!list || !list.length) return 0;
      var have = {};
      for (var i = 0; i < this.matched.length; i++) have[Eval.cacheKey(this.matched[i])] = true;
      var added = 0;
      for (var j = 0; j < list.length; j++) {
        var k = Eval.cacheKey(list[j]);
        if (have[k]) continue;
        have[k] = true;
        this.matched.push(list[j]);
        added++;
      }
      if (added) {
        this.rawCount = (this.rawCount || 0) + added;
        this._sig = ''; // 清掉签名，免得后续 syncList 认为"没变化"而不刷新
      }
      return added;
    },

    // 待投池是多标签页共享的，节流重读一次：别的页面刚收的岗位这边也能看到。
    // 必须先重读再回填 AI 结果，否则刚填好的对象会被新读出来的覆盖掉。
    syncStaging: function () {
      var nowTs = Date.now();
      if (!this._stageReadAt || nowTs - this._stageReadAt > 1500) {
        this._stageReadAt = nowTs;
        this.staging = Store.getStaging();
      }
    },

    refresh: function () {
      this.syncStaging();
      this.applyAICache(); // 先回填，再渲染
      this.renderQueue();
      this.renderLedger();
      var r = Runner.state;
      if (r && r.status === 'running') this.badge('运行 ' + (r.idx + 1) + '/' + r.queue.length);
      else if (r && r.status === 'paused') this.badge('已暂停');
      else if (r && r.status === 'done') this.badge('完成');
      else this.badge('');
    },

    renderQueue: function () {
      var box = document.getElementById('jaapTabQueue');
      if (!box) return;
      this.syncStaging();
      var st = Store.getSettings();
      var r = Runner.state;
      var html = '';

      if (r) {
        var cls = r.status === 'paused' ? ' warn' : '';
        var job = r.queue[r.idx];
        var cur = job ? String(job.title || '').slice(0, 18) : '-';
        var text;
        if (r.status === 'running') text = '运行中：正在处理「' + esc(cur) + '」（' + (r.idx + 1) + '/' + r.queue.length + '）';
        else if (r.status === 'paused') text = '已暂停：' + esc(r.pauseReason || '') + '（' + r.idx + '/' + r.queue.length + '）';
        else text = '队列已完成';
        if (Runner.foreign) {
          text = '队列在 ' + platLabel(job && job.platform) + ' 执行中（本页只读，不会抢占）';
          cls = '';
        }
        html += '<div class="jaap-strip' + cls + '">' + text + '<div style="margin-top:6px">';
        if (Runner.foreign) {
          html += '</div></div>';
        } else {
          if (r.status === 'running') html += '<span class="jaap-btn" data-act="pauseRun">暂停</span>';
          if (r.status === 'paused') html += '<span class="jaap-btn primary" data-act="resumeRun">继续投递</span>';
          if (r.status !== 'done') html += '<span class="jaap-btn danger" data-act="stopRun">终止队列</span>';
          html += '</div></div>';
        }
      } else {
        html += '<div class="jaap-strip">待机中 · 模式：' + (st.mode === 'fast' ? '极速全自动' : '确认队列（默认）') +
          ' · 今日已投 ' + Limit.sentToday(Store.getRecords()) + '/' + st.dailyCap + '</div>';
      }

      // 自动搜索进度 / 入口
      var s = Search.state;
      if (s) {
        var tt = s.tasks[s.idx] || {};
        var info = '任务 ' + (s.idx + 1) + '/' + s.tasks.length;
        if (tt.query) info += ' · ' + esc(tt.query) + (tt.city ? '（' + esc(tt.city) + '）' : '') + ' 第 ' + (tt.page || 1) + ' 页';
        var sText;
        if (s.status === 'running') sText = '自动搜索中：' + info + ' · 已收集 ' + (s.collected || 0) + ' 条';
        else if (s.status === 'paused') sText = '搜索已暂停：' + esc(s.pauseReason || '') + ' · 已收集 ' + (s.collected || 0) + ' 条';
        else sText = '上次搜索已完成，收集 ' + (s.collected || 0) + ' 条候选';
        var sCls = s.status === 'paused' ? ' warn' : '';
        html += '<div class="jaap-strip' + sCls + '">' + sText + '<div style="margin-top:6px">';
        if (s.status === 'running') html += '<span class="jaap-btn" data-act="pauseSearch">暂停搜索</span>';
        if (s.status === 'paused') html += '<span class="jaap-btn primary" data-act="resumeSearch">继续搜索</span>';
        if (s.status !== 'done') html += '<span class="jaap-btn danger" data-act="stopSearch">终止搜索</span>';
        else html += '<span class="jaap-btn" data-act="autoSearch">重新搜索</span>';
        html += '</div></div>';
      } else {
        html += '<div style="margin:6px 0"><span class="jaap-btn primary" data-act="autoSearch">自动搜索（按关键词+城市）</span></div>' +
          '<div class="jaap-hint">按「求职意向」的必含关键词与优先城市，自动打开搜索结果并翻页收集候选（每个组合 ' +
          (st.searchPages || 2) + ' 页，最多 ' + (st.searchCityLimit || 3) + ' 个城市）</div>';
      }

      html += '<div class="jaap-sec">本页匹配职位（' + this.matched.length + ' 条）' +
        '<span class="jaap-hint"> 抓取 ' + (this.rawCount || 0) + ' 个卡片，过滤 ' + (this.excludedCount || 0) + ' 条</span></div>';
      if (adapter().isListPage()) html += '<span class="jaap-btn" data-act="rescan">重新扫描本页</span>';
      if (this.matched.length) {
        if (Eval.busy) {
          html += '<span class="jaap-btn danger" data-act="stopEval">停止评估</span>' +
            '<div class="jaap-hint">正在逐条评估，评完一条显示一条</div>';
        } else {
          html += '<span class="jaap-btn primary" data-act="evalPage">AI 评估本页（只评新的）</span>' +
            '<span class="jaap-btn" data-act="evalAll">重评全部</span>' +
            '<div class="jaap-hint">把本页职位发给本地评估服务（' + esc(st.evalUrl || '') + '），用免费模型判断坑和真实到手薪资；' +
            '评分低于 ' + (st.minScore || 60) + ' 分的不进自动投递。</div>';
        }
        if (Eval.lastSummary) html += '<div class="jaap-hint" style="color:#2f6bff">' + esc(Eval.lastSummary) + '</div>';
      }

      if (this.matched.length) {
        html += '<div style="margin:6px 0"><span class="jaap-btn primary" data-act="addChecked">勾选加入队列</span>' +
          '<span class="jaap-btn" data-act="addAllFast">全部加入并开始</span></div>';
        for (var i = 0; i < this.matched.length; i++) {
          var j = this.matched[i];
          var ai = j.ai;
          var vtxt = '', vcolor = '#999';
          if (ai) {
            vtxt = ai.verdict === 'pass' ? '推荐' : (ai.verdict === 'watch' ? '观望' : '别投');
            vcolor = ai.verdict === 'pass' ? '#1a9d4b' : (ai.verdict === 'watch' ? '#d08800' : '#e5534b');
          }
          html += '<div class="jaap-item"><label><input type="checkbox" class="jaap-chk" data-i="' + i + '"> ' +
            '<span class="t">' + esc(j.title) + '</span>' +
            (ai ? '<span class="jaap-score" style="color:' + vcolor + '">' + vtxt + ' ' + ai.score + '分</span>'
                : '<span class="jaap-score">' + j.score + '分</span>') +
            '</label>' +
            '<div class="meta">' + esc(j.salary || '-') + ' · ' + esc(j.city || '-') + ' · ' + esc(j.company || '-') +
            (j.company ? ' <span class="jaap-btn mini" data-act="companyReview" data-i="' + i + '">查口碑</span>' : '') +
            '</div>';
          if (j.review) {
            html += '<div class="meta" style="color:#166534">口碑：' + esc(j.review) + '</div>';
          }
          if (ai) {
            var extra = [];
            if (ai.real_monthly && ai.real_monthly !== 'unknown') extra.push('现实月薪 ' + ai.real_monthly);
            if (ai.hourly && ai.hourly !== 'unknown') extra.push('时薪 ' + ai.hourly);
            if (extra.length) html += '<div class="meta">' + esc(extra.join(' · ')) + '</div>';
            if (ai.reason) html += '<div class="meta" style="color:#444">' + esc(ai.reason) + '</div>';
            if (ai.flags && ai.flags.length) {
              var fl = ai.flags.slice(0, 4).map(function (f) {
                var mark = f.level === 'hard' ? '硬伤' : (f.level === 'unknown' ? '待确认' : '软坑');
                return '[' + mark + '] ' + f.text;
              }).join('；');
              html += '<div class="meta" style="color:#b35c00">' + esc(fl) + '</div>';
            }
          }
          html += '<div class="meta"><a href="' + esc(j.url) + '" target="_blank">查看职位</a>' +
            ' <span class="jaap-btn mini" data-act="applyOne" data-i="' + i + '">立即投递这条</span></div></div>';
        }
      } else if (this.rawCount === 0) {
        html += '<div class="jaap-muted">未识别到职位卡片（抓取 0 个）。可能原因：页面还在加载、当前不是搜索结果列表页，' +
          '或站点改版导致 selector 失效。可点「重新扫描本页」重试，仍为 0 时请按说明微调脚本顶部 SEL 配置。</div>';
      } else {
        html += '<div class="jaap-muted">本页抓取到 ' + this.rawCount + ' 个职位，但都不符合当前求职意向（关键词/城市/薪资/已投递）。' +
          '可在「求职意向」中放宽条件后保存，脚本会自动重新匹配。</div>';
      }

      if (this.staging.length) {
        // 待投队列是三平台共用的（BOSS 自动搜索收的岗位会进同一个池子），
        // 但本页只该投本平台的岗位 —— 否则在 51job 页面会看到一屏 BOSS 岗位，
        // 点「立即投递」还会跨站跳转。所以这里按平台分层显示。
        var pid0 = plat().id;
        var mineArr = [], otherCount = 0, otherByPlat = {};
        for (var si = 0; si < this.staging.length; si++) {
          var sx = this.staging[si];
          var sp = sx.platform || pid0;
          if (sp === pid0) mineArr.push(sx);
          else { otherCount++; otherByPlat[sp] = (otherByPlat[sp] || 0) + 1; }
        }
        var otherDesc = Object.keys(otherByPlat).map(function (k) {
          return platLabel(k) + ' ' + otherByPlat[k];
        }).join(' · ');

        var armed = Date.now() - (this._clearArm || 0) < 4000;
        html += '<div class="jaap-sec" style="display:flex;align-items:center;justify-content:space-between;gap:6px">' +
          '<span>待投队列（本平台 ' + mineArr.length + ' 条' +
          (otherCount ? ' · 其它平台 ' + otherCount + ' 条' : '') + '）</span>' +
          (mineArr.length
            ? '<span style="display:flex;gap:6px">' +
              '<span class="jaap-btn mini primary" data-act="startRun">开始投递</span>' +
              '<span class="jaap-btn mini danger" data-act="clearStaging"' +
              (armed ? ' style="background:#e5534b;color:#fff"' : '') + '>' +
              (armed ? '确认清空？' : '清空') + '</span></span>'
            : '<span class="jaap-hint">本平台暂无候选</span>') +
          '</div>';

        if (mineArr.length) {
          html += '<div class="jaap-hint">点「开始投递」后队列持久化，投递过程可跨页面继续</div>';
          var shown = this.stagingExpand ? mineArr.length : Math.min(mineArr.length, 30);
          for (var m = 0; m < shown; m++) {
            var sg = mineArr[m];
            // 队列里的岗位也要能看出评估结果，否则搜完一屏只看到标题，以为没评
            var sai = sg.ai;
            var stxt = '', scol = '#999';
            if (sai) {
              stxt = (sai.verdict === 'pass' ? '推荐' : sai.verdict === 'watch' ? '观望' : '别投') + ' ' + sai.score + '分';
              scol = sai.verdict === 'pass' ? '#1a9d4b' : (sai.verdict === 'watch' ? '#d08800' : '#e5534b');
            }
            html += '<div class="jaap-item"><span class="t">' + esc(sg.title) + '</span>' +
              (stxt ? '<span class="jaap-score" style="color:' + scol + '">' + stxt + '</span>' : '') +
              ' <span class="jaap-btn mini" data-act="removeStaging" data-key="' +
              esc(Eval.cacheKey(sg)) + '">移除</span>' +
              (sai && sai.real_monthly && sai.real_monthly !== 'unknown'
                ? '<div class="meta">现实月薪 ' + esc(sai.real_monthly) + '</div>' : '') +
              '</div>';
          }
          if (mineArr.length > 30) {
            html += '<div style="margin:4px 0"><span class="jaap-btn mini" data-act="toggleStaging">' +
              (this.stagingExpand ? '收起（只看前 30 条）' : '展开其余 ' + (mineArr.length - 30) + ' 条') +
              '</span></div>';
          }
          html += '<div style="margin-top:6px"><span class="jaap-btn primary" data-act="startRun">开始投递</span>' +
            '<span class="jaap-btn" data-act="clearStaging">清空本平台</span></div>';
        }

        if (otherCount) {
          var otherArmed = Date.now() - (this._clearOtherArm || 0) < 4000;
          html += '<div class="jaap-strip" style="background:#f7f8fb;border-color:#e4e7ef;margin-top:8px">' +
            '其它平台还有 <b>' + otherCount + '</b> 条待投（' + esc(otherDesc) + '）。' +
            '<div class="jaap-hint">' + platLabel(pid0) + ' 页面只列本平台岗位；换到对应平台的标签页就能看到并投递，' +
            '数据不会丢。</div>' +
            '<div style="margin-top:6px"><span class="jaap-btn mini danger" data-act="clearOtherStaging"' +
            (otherArmed ? ' style="background:#e5534b;color:#fff"' : '') + '>' +
            (otherArmed ? '确认清空其它平台？' : '清空其它平台') + '</span></div></div>';
        }
      }
      box.innerHTML = html;
    },

    renderLedger: function () {
      var box = document.getElementById('jaapTabLedger');
      if (!box) return;
      var recs = Store.getRecords();
      var list = Object.keys(recs).map(function (k) { return recs[k]; })
        .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      var today = Limit.sentToday(recs);
      var cap = Store.getSettings().dailyCap;
      var sentTotal = 0;
      for (var i = 0; i < list.length; i++) if (list[i].status === 'sent') sentTotal++;

      var html = '<div class="jaap-strip">今日已投 <b>' + today + '</b>/' + cap +
        ' · 累计成功 <b>' + sentTotal + '</b> 条 · 记录共 ' + list.length + ' 条</div>' +
        '<div><span class="jaap-btn" data-act="exportLedger">导出 JSON</span>' +
        '<span class="jaap-btn danger" data-act="clearLedger">清空台账</span></div>';

      if (!list.length) {
        html += '<div class="jaap-muted">暂无投递记录</div>';
        box.innerHTML = html;
        return;
      }
      var stmap = { sent: '已投', failed: '失败', duplicate: '重复', queued: '排队' };
      html += '<table class="jaap-table"><tr><th>时间</th><th>职位</th><th>状态</th></tr>';
      var head = list.slice(0, 50);
      for (var j = 0; j < head.length; j++) {
        var r = head[j];
        var d = r.updatedAt ? new Date(r.updatedAt) : null;
        var tstr = '-';
        if (d) {
          tstr = (d.getMonth() + 1) + '-' + d.getDate() + ' ' +
            ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        }
        html += '<tr><td>' + tstr + '</td><td>' + esc(r.title) +
          '<div class="jaap-hint">' + platLabel(r.platform) + ' · ' + esc(r.company || '') + ' · ' + esc(r.city || '') +
          (r.msg ? ' · ' + esc(r.msg) : '') + '</div></td><td>' + (stmap[r.status] || esc(r.status)) + '</td></tr>';
      }
      html += '</table>';
      box.innerHTML = html;
    },

    renderSettings: function () {
      var box = document.getElementById('jaapTabSettings');
      if (!box) return;
      var st = Store.getSettings();
      box.innerHTML =
        '<div class="jaap-form">' +
        '<label>必含关键词（标题/技能标签任一命中即投，逗号分隔；留空 = 不限）</label>' +
        '<input id="jaapIncl" value="' + esc(st.includeKeywords.join(',')) + '">' +
        '<label>屏蔽关键词（任一命中即排除，逗号分隔）</label>' +
        '<input id="jaapExcl" value="' + esc(st.excludeKeywords.join(',')) + '">' +
        '<label>优先城市（按优先级排序，逗号分隔）</label>' +
        '<input id="jaapCities" value="' + esc(st.preferredCities.join(',')) + '">' +
        '<div class="jaap-hint">城市群/半径扩展将在 M2 接入 cities.json，当前按城市名精确匹配</div>' +
        '<label>最低薪资（K/月，0 = 不限）</label>' +
        '<input id="jaapSalary" type="number" min="0" value="' + st.salaryMinK + '">' +
        '<label>每日投递上限</label>' +
        '<input id="jaapCap" type="number" min="1" value="' + st.dailyCap + '">' +
        '<label>自动搜索：每个关键词/城市组合翻页数</label>' +
        '<input id="jaapSearchPages" type="number" min="1" max="10" value="' + st.searchPages + '">' +
        '<label>自动搜索：最多搜索几个优先城市</label>' +
        '<input id="jaapSearchCityLimit" type="number" min="1" max="10" value="' + st.searchCityLimit + '">' +
        '<div class="jaap-hint">点「自动搜索」后，脚本会按关键词×城市逐个打开搜索结果并翻页收集候选</div>' +
        '<label>投递间隔（秒，随机取值）</label>' +
        '<input id="jaapImin" type="number" min="5" style="width:47%" value="' + st.intervalSec[0] + '"> ~ ' +
        '<input id="jaapImax" type="number" min="5" style="width:47%" value="' + st.intervalSec[1] + '">' +
        '<label>服务商预设（选一个自动填好地址和模型）</label>' +
        '<select id="jaapLlmPreset">' +
        LLM_PRESETS.map(function (p) {
          return '<option value="' + p.id + '"' + (st.llmProvider === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
        }).join('') +
        '</select>' +
        '<div class="jaap-hint" id="jaapLlmHint">' + esc(presetOf(st.llmProvider).hint || '') + '</div>' +
        '<label>API Key（只存本机浏览器，随请求发给本地服务，不写进脚本）</label>' +
        '<input id="jaapLlmKey" type="password" placeholder="' + (presetOf(st.llmProvider).local ? '本地模型可留空' : 'sk-…') + '" value="' + esc(st.llmKey || '') + '">' +
        '<label>接口地址（OpenAI 兼容）</label>' +
        '<input id="jaapLlmBase" placeholder="' + esc(presetOf(st.llmProvider).baseUrl || 'https://…/v1') + '" value="' + esc(st.llmBaseUrl || '') + '">' +
        '<label>模型名</label>' +
        '<input id="jaapLlmModel" placeholder="' + esc(presetOf(st.llmProvider).model || '模型名') + '" value="' + esc(st.llmModel || '') + '">' +
        '<label>备用模型（可留空）</label>' +
        '<input id="jaapLlmFallback" placeholder="' + esc(presetOf(st.llmProvider).fallback || '可留空') + '" value="' + esc(st.llmFallback || '') + '">' +
        '<div style="margin:6px 0"><span class="jaap-btn" data-act="testLlm">测试连接</span>' +
        '<span class="jaap-hint" id="jaapLlmTest"></span></div>' +
        '<label>扫描到新岗位后自动 AI 评估</label>' +
        '<select id="jaapAutoEval">' +
        '<option value="on"' + (st.autoEval === false ? '' : ' selected') + '>开（推荐，只评新岗位）</option>' +
        '<option value="off"' + (st.autoEval === false ? ' selected' : '') + '>关（手动点「AI 评估本页」）</option>' +
        '</select>' +
        '<label>自动搜索时也逐条评估</label>' +
        '<select id="jaapEvalSearch">' +
        '<option value="on"' + (st.evalDuringSearch === false ? '' : ' selected') + '>开（每页搜完就地评估，慢但队列里的岗位都有分）</option>' +
        '<option value="off"' + (st.evalDuringSearch === false ? ' selected' : '') + '>关（只收集，回头在列表页评）</option>' +
        '</select>' +
        '<label>AI 最低分（低于此分不自动投递）</label>' +
        '<input id="jaapMinScore" type="number" min="0" max="100" value="' + st.minScore + '">' +
        '<div class="jaap-hint">本地评估服务地址：' + esc(st.evalUrl || '') + '（要另开一个窗口跑 python job_eval_server.py）</div>' +
        '<label>投递模式</label>' +
        '<select id="jaapMode">' +
        '<option value="confirm"' + (st.mode === 'confirm' ? ' selected' : '') + '>确认队列（默认，推荐）</option>' +
        '<option value="fast"' + (st.mode === 'fast' ? ' selected' : '') + '>极速全自动（列表页自动加队开跑，风险自负）</option>' +
        '</select>' +
        '<label>招呼语模板（占位符：{职位} {公司} {城市} {薪资}）</label>' +
        '<textarea id="jaapGreet">' + esc(st.greetingTemplate) + '</textarea>' +
        '<div style="margin-top:10px"><span class="jaap-btn primary" data-act="saveSettings">保存求职意向</span></div>' +
        '</div>';
    },

    saveSettingsFromForm: function () {
      function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
      function num(id, def) { var v = parseInt(val(id), 10); return isNaN(v) ? def : v; }
      var before = Store.getSettings();
      var oldKw = (before.includeKeywords || []).join(',');
      var st = Store.getSettings();
      st.includeKeywords = splitList(val('jaapIncl'));
      st.excludeKeywords = splitList(val('jaapExcl'));
      st.preferredCities = splitList(val('jaapCities'));
      st.salaryMinK = num('jaapSalary', 0);
      if (st.salaryMinK < 0) st.salaryMinK = 0;
      var cap = num('jaapCap', DEFAULT_SETTINGS.dailyCap);
      st.dailyCap = cap > 0 ? cap : DEFAULT_SETTINGS.dailyCap;
      var sp = num('jaapSearchPages', DEFAULT_SETTINGS.searchPages);
      st.searchPages = sp >= 1 ? Math.min(sp, 10) : DEFAULT_SETTINGS.searchPages;
      var scl = num('jaapSearchCityLimit', DEFAULT_SETTINGS.searchCityLimit);
      st.searchCityLimit = scl >= 1 ? Math.min(scl, 10) : DEFAULT_SETTINGS.searchCityLimit;
      var imin = num('jaapImin', DEFAULT_SETTINGS.intervalSec[0]);
      var imax = num('jaapImax', DEFAULT_SETTINGS.intervalSec[1]);
      if (imin < 5) imin = 5;
      if (imax < imin) imax = imin;
      st.intervalSec = [imin, imax];
      var eu = val('jaapEvalUrl').trim();
      st.evalUrl = eu || before.evalUrl || DEFAULT_SETTINGS.evalUrl;
      // —— 大模型服务商配置（Key 存在 GM 存储，即浏览器本地）——
      var pv = document.getElementById('jaapLlmPreset');
      st.llmProvider = pv && pv.value ? pv.value : DEFAULT_SETTINGS.llmProvider;
      st.llmKey = val('jaapLlmKey').trim();
      st.llmBaseUrl = val('jaapLlmBase').trim();
      st.llmModel = val('jaapLlmModel').trim();
      st.llmFallback = val('jaapLlmFallback').trim();
      var aeEl = document.getElementById('jaapAutoEval');
      st.autoEval = !(aeEl && aeEl.value === 'off');
      var esEl = document.getElementById('jaapEvalSearch');
      st.evalDuringSearch = !(esEl && esEl.value === 'off');
      var ms = num('jaapMinScore', DEFAULT_SETTINGS.minScore);
      st.minScore = Math.max(0, Math.min(100, ms));
      var modeEl = document.getElementById('jaapMode');
      st.mode = modeEl && modeEl.value === 'fast' ? 'fast' : 'confirm';
      var g = val('jaapGreet');
      if (g && g.trim()) st.greetingTemplate = g.trim();
      Store.saveSettings(st);
      this._sig = ''; // 意向已变，强制重新匹配
      // 关键词/城市变了，旧的搜索任务作废
      if (Search.state && Search.state.status === 'done') {
        Search.state = null;
        try { GM_deleteValue(Search.key); } catch (e) { /* 忽略 */ }
      }
      if (st.includeKeywords.length) {
        var newKw = st.includeKeywords.join(',');
        if (newKw !== oldKw) {
          // 关键词变了才重新搜索；只改了评估/限速等参数时不该打断当前浏览
          this.notify('求职意向已保存，开始按关键词自动搜索…');
          Search.start();
        } else {
          this.notify('已保存（关键词未变，不重新搜索）');
          if (adapter().isListPage()) syncList({ notify: false });
          else this.refresh();
        }
      } else {
        this.notify('已保存（未填必含关键词，只扫描当前页）');
        if (adapter().isListPage()) syncList({ notify: true, retryMs: 3000 });
        else this.refresh();
      }
    },

    exportLedger: function () {
      downloadJson('投递台账-' + todayStr() + '.json', {
        platform: plat().id,
        exportedAt: new Date().toISOString(),
        records: Store.getRecords(),
      });
    },

    handleAction: async function (act, el) {
      var self = this;
      switch (act) {
        case 'addChecked': {
          var chks = this.el.querySelectorAll('.jaap-chk:checked');
          var picked = [];
          chks.forEach(function (c) {
            var j = self.matched[Number(c.getAttribute('data-i'))];
            if (j) picked.push(j);
          });
          if (!picked.length) return this.notify('请先勾选职位');
          var n1 = this.addToStaging(picked);
          this.notify('已加入待投队列 ' + n1 + ' 条');
          break;
        }
        case 'addAllFast': {
          var cand = Eval.eligible(this.matched);
          if (!cand.length) return this.notify('本页没有可投递的匹配职位（或 AI 已判定都不建议投）');
          this.addToStaging(cand);
          this.handleAction('startRun');
          break;
        }
        case 'evalPage': {
          if (Eval.busy) return this.notify('正在评估中，请稍等');
          if (!this.matched.length) return this.notify('本页没有可评估的职位');
          Eval.run(this.matched, { onlyNew: true });
          break;
        }
        case 'evalAll': {
          if (Eval.busy) return this.notify('正在评估中，请稍等');
          if (!this.matched.length) return this.notify('本页没有可评估的职位');
          Eval.run(this.matched, {});
          break;
        }
        case 'stopEval':
          Eval.abort = true;
          Eval.busy = false;
          this.notify('已停止评估（已评完的保留）');
          this.refresh();
          break;
        case 'companyReview': {
          var ri = Number((el && el.getAttribute('data-i')) || -1);
          var rj = this.matched[ri];
          if (!rj || !rj.company) return this.notify('这家公司没有名称，查不了');
          this.notify('正在搜「' + rj.company + '」的口碑…');
          // 同时开一个必应搜索页，模型没搜到评价时用户也能自己翻
          try {
            window.open('https://www.bing.com/search?q=' +
              encodeURIComponent(rj.company + ' 怎么样 员工评价 加班'), '_blank');
          } catch (e) { /* 弹窗被拦就算了 */ }
          var rk = Eval.cacheKey(rj);
          var rtxt = '';
          try {
            var rv = await httpJson('POST', Eval.baseUrl() + '/company', {
              company: rj.company, summarize: true, llm: Eval.llmConfig(),
            });
            rtxt = (rv && rv.summary ? String(rv.summary).replace(/\s+/g, ' ') : '')
              || (rv && rv.note) || '没搜到公开评价，可点上面的必应结果自己看';
          } catch (e) {
            rtxt = '查询失败：' + ((e && e.message) || e);
          }
          Eval.reviewCache[rk] = rtxt;
          // 请求期间列表可能已被重扫、对象被换掉，所以写回「当前」那个对象
          for (var ci2 = 0; ci2 < this.matched.length; ci2++) {
            if (Eval.cacheKey(this.matched[ci2]) === rk) { this.matched[ci2].review = rtxt; break; }
          }
          this.refresh();
          break;
        }
        case 'testLlm': {
          Eval.test();
          break;
        }
        case 'applyOne': {
          var ai2 = Number(el.getAttribute('data-i'));
          var one = this.matched[ai2];
          if (!one) return this.notify('职位已失效，请重新扫描');
          if (Runner.state && Runner.state.status === 'running') {
            return this.notify('已有投递队列在运行，请先暂停或终止');
          }
          Runner.start([one]);
          break;
        }
        case 'startRun': {
          if (!this.staging.length) return this.notify('待投队列为空');
          if (Runner.state && Runner.state.status === 'running') return this.notify('已有队列在运行中');
          // 只投本平台：待投池是三平台共用的，但本页只能操作本平台的岗位，
          // 否则会跨站跳转、丢登录态，还容易触发风控。
          var pidNow = plat().id;
          var mineNow = this.staging.filter(function (x) { return (x.platform || pidNow) === pidNow; });
          if (!mineNow.length) {
            return this.notify('待投队列里没有' + plat().name + '的岗位，其它平台的请到对应标签页投递');
          }
          var queue = Eval.eligible(mineNow);
          var dropped = mineNow.length - queue.length;
          if (!queue.length) return this.notify('本平台的岗位都被 AI 判定不建议投（或低于最低分）');
          // 只把「本次真正进入队列」的岗位从待投里摘掉；
          // 别的平台标签页攒的候选、以及本页低分待定的，都保留。
          var inQueue = {};
          for (var qi = 0; qi < queue.length; qi++) {
            inQueue[(queue[qi].platform || plat().id) + ':' + queue[qi].jobId] = true;
          }
          var cur = Store.getStaging(); // 重读一次，避免覆盖别的标签页刚收集到的
          var keep = [];
          for (var sj = 0; sj < cur.length; sj++) {
            var kk = (cur[sj].platform || plat().id) + ':' + cur[sj].jobId;
            if (!inQueue[kk]) keep.push(cur[sj]);
          }
          this.staging = keep;
          this.saveStaging();
          if (dropped > 0) this.notify('已跳过 ' + dropped + ' 条低分/已投岗位');
          Runner.start(queue);
          break;
        }
        case 'clearStaging': {
          var pidClr = plat().id;
          var mineClr = this.staging.filter(function (x) { return (x.platform || pidClr) === pidClr; });
          var nClear = mineClr.length;
          if (!nClear) return this.notify('本平台没有待投岗位');
          // 二次确认：几百条攒了很久，误点一次全没太伤，4 秒内点第二下才真清
          if (Date.now() - (this._clearArm || 0) > 4000) {
            this._clearArm = Date.now();
            this.refresh();
            return this.notify('再点一次「清空」确认删除本平台 ' + nClear + ' 条（4 秒内有效）');
          }
          this._clearArm = 0;
          var dropKeys = {};
          for (var dk = 0; dk < mineClr.length; dk++) dropKeys[Eval.cacheKey(mineClr[dk])] = true;
          this.staging = Store.getStaging().filter(function (x) { return !dropKeys[Eval.cacheKey(x)]; });
          this.stagingExpand = false;
          this.saveStaging();
          this.refresh();
          this.notify('已清空本平台待投（' + nClear + ' 条），其它平台保留');
          break;
        }
        case 'clearOtherStaging': {
          var pidOther = plat().id;
          var othersArr = this.staging.filter(function (x) { return (x.platform || pidOther) !== pidOther; });
          if (!othersArr.length) return this.notify('没有其它平台的待投岗位');
          if (Date.now() - (this._clearOtherArm || 0) > 4000) {
            this._clearOtherArm = Date.now();
            this.refresh();
            return this.notify('再点一次确认移除其它平台 ' + othersArr.length + ' 条（4 秒内有效）');
          }
          this._clearOtherArm = 0;
          this.staging = Store.getStaging().filter(function (x) {
            return (x.platform || pidOther) === pidOther;
          });
          this.saveStaging();
          this.refresh();
          this.notify('已移除其它平台待投 ' + othersArr.length + ' 条');
          break;
        }
        case 'toggleStaging':
          this.stagingExpand = !this.stagingExpand;
          this.refresh();
          break;
        case 'removeStaging': {
          var rmKey = el.getAttribute('data-key');
          if (rmKey) {
            // 按 key 删而不是按下标 splice：写前重读，避免覆盖别的标签页刚收集的条目
            this.staging = Store.getStaging().filter(function (x) { return Eval.cacheKey(x) !== rmKey; });
            this.saveStaging();
            this.refresh();
          }
          break;
        }
        case 'autoSearch': Search.start(); break;
        case 'pauseSearch': Search.pause('手动暂停搜索'); break;
        case 'resumeSearch': Search.resume(); break;
        case 'stopSearch': if (confirm('确定终止自动搜索？已收集的候选会保留。')) Search.stop(); break;
        case 'rescan': {
          if (!adapter().isListPage()) return this.notify('请在职位列表页使用扫描');
          syncList({ notify: true, retryMs: 2000 });
          break;
        }
        case 'pauseRun': Runner.pause('手动暂停'); break;
        case 'resumeRun': Runner.resume(); break;
        case 'stopRun': if (confirm('确定终止当前投递队列？')) Runner.stop(); break;
        case 'exportLedger': this.exportLedger(); break;
        case 'clearLedger':
          if (confirm('确定清空全部投递台账？该操作不可恢复。')) {
            Store.saveRecords({});
            this.refresh();
            this.notify('台账已清空');
          }
          break;
        case 'saveSettings': this.saveSettingsFromForm(); break;
        default: break;
      }
    },
  };

  /* =========================================================
   * 9. 列表页同步与主流程
   * ========================================================= */
  // 抓取本页职位并重新匹配。opts.retryMs>0 时在卡片未出现前按间隔重试
  async function syncList(opts) {
    opts = opts || {};
    if (!adapter().isListPage()) {
      Panel.matched = [];
      Panel.excludedCount = 0;
      Panel.rawCount = 0;
      Panel.refresh();
      return { jobs: [], changed: false };
    }

    var jobs = null;
    if (opts.retryMs > 0) {
      jobs = await waitFor(function () {
        var j = adapter().scrapeList();
        return j.length ? j : null;
      }, opts.retryMs, 500);
    } else {
      jobs = adapter().scrapeList();
    }
    jobs = jobs || [];
    var changed = Panel.setMatched(jobs);
    if (opts.notify) {
      if (!jobs.length) {
        Panel.notify('未抓取到职位卡片，请确认在搜索结果列表页并已登录');
      } else {
        var extra = '';
        if (!Panel.matched.length) extra = '（全部不符合意向，可在「求职意向」放宽条件）';
        Panel.notify('抓取 ' + jobs.length + ' 个职位，匹配 ' + Panel.matched.length + ' 条' + extra);
      }
    }
    if (changed) Panel.refresh();

    // 扫描完自动触发 AI 评估（防抖内只评新岗位，可在设置里关）
    if (changed && Panel.matched.length) Eval.autoRun();

    // 极速模式：匹配结果有更新且队列空闲时自动开跑（已处理过的岗位不再重复尝试）
    var st = Store.getSettings();
    var runnerIdle = !Runner.state || Runner.state.status === 'done';
    if (st.mode === 'fast' && changed && runnerIdle && Panel.matched.length) {
      var records = Store.getRecords();
      var queue = Panel.matched.filter(function (j) { return !Store.findRec(records, plat().id, j.jobId); });
      if (queue.length) {
        // 只移除当前平台的待投项，其它平台攒的候选保留
        Panel.staging = Panel.staging.filter(function (x) { return (x.platform || plat().id) !== plat().id; });
        Panel.saveStaging();
        Runner.start(queue);
      }
    }
    return { jobs: jobs, changed: changed };
  }

  // 监听列表页变化：DOM 异步加载/翻页 + SPA 路由变化，自动重新抓取并匹配
  var _watchStarted = false;
  function watchListPage() {
    if (_watchStarted) return;
    _watchStarted = true;
    var timer = null;
    var lastUrl = location.href;

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (!adapter().isListPage() || adapter().isSecurityPage()) return;
        // 自动搜索自己负责翻页抓取，避免与普通扫描互相干扰
        if (Search.state && Search.state.status === 'running') return;
        syncList({});
      }, 800);
    }

    // 忽略面板自身 DOM 变化，避免自触发循环
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var t = muts[i].target;
        if (t && t.nodeType === 1 && t.closest && t.closest('#jaapRoot')) continue;
        schedule();
        return;
      }
    });
    try { mo.observe(document.body, { childList: true, subtree: true }); }
    catch (e) { log('列表监听启动失败：', e); }

    // SPA 路由变化（BOSS 搜索结果翻页/改条件不刷新页面，脚本不会重新执行）
    setInterval(function () {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      if (adapter().isListPage()) {
        setTimeout(function () { syncList({}); }, 1200);
      } else {
        Panel.matched = [];
        Panel.excludedCount = 0;
        Panel.rawCount = 0;
        Panel._sig = '';
        Panel.refresh();
      }
    }, 1000);
  }

  async function main() {
    Search.load();
    Panel.build();

    // 登录态提示（不阻断浏览，仅在未识别/未登录时提醒）
    var login = await detectLogin();
    if (login.status === 'out') {
      Panel.notify('检测到未登录' + plat().name + '，请先登录后再使用自动投递');
    } else if (login.status === 'unknown') {
      log('登录态未能自动识别（DOM selector 待实测回填），将继续运行，投递前会再次校验');
    }

    // 恢复队列状态机（投递过程跨页面继续）
    // 多标签页守则：只有「队列当前岗位属于本平台、且没有别的页面在跑」时才接管，
    // 否则本页只读展示 —— 三个平台各开一个标签页时不会互相把队列改成暂停。
    var st = Store.getRunner();
    if (st && (st.status === 'running' || st.status === 'paused')) {
      var curJob = st.queue && st.queue[st.idx];
      var curPlat = curJob && curJob.platform;
      if (curPlat && curPlat !== plat().id) {
        Runner.state = st;
        Runner.foreign = true;
        log('投递队列当前岗位属于 ' + platLabel(curPlat) + '，本页只读，不接管队列');
      } else {
        Runner.state = st;
        Runner.foreign = false;
        var someoneElse = st.tab && st.tab !== TAB_ID &&
          Date.now() - (st.heartbeatAt || 0) < RUNNER_STALE_MS;
        if (adapter().isSecurityPage()) {
          Runner.pause('页面出现安全验证/滑块，请手动完成后点「继续投递」');
        } else if (st.status === 'running' && someoneElse) {
          log('队列正由另一个标签页执行，本页不介入');
        } else if (st.status === 'running') {
          if (Runner.current() && Runner.isOnJob(Runner.current())) {
            Runner.tick();
          } else {
            Runner.pause('当前页面不在队列目标职位页，点「继续投递」可恢复');
          }
        }
      }
    }

    // 自动搜索任务恢复（跨页面继续翻页抓取，优先级高于普通扫描）
    if (Search.state && Search.state.status === 'running' &&
      !(Runner.state && Runner.state.status === 'running')) {
      Panel.refresh();
      Search.goto();
      return;
    }

    // 列表页：首轮抓取 + 匹配，并开启持续监听（BOSS 是 SPA，翻页/改条件不重载脚本）
    if (adapter().isListPage() && !adapter().isSecurityPage()) {
      await syncList({ retryMs: 10000 });
      watchListPage();
    } else if (!adapter().isDetailPage()) {
      Panel.matched = [];
      Panel.excludedCount = 0;
      Panel.rawCount = 0;
    }

    Panel.refresh();
  }

  // 菜单命令
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('打开/收起投递面板', function () { Panel.toggle(); });
    GM_registerMenuCommand('导出投递台账(JSON)', function () { Panel.exportLedger(); });
  }

  main().catch(function (e) { log('初始化失败：', e); });
})();
