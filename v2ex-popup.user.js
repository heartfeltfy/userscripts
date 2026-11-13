// ==UserScript==
// @name         V2EX 帖子弹窗预览（深浅色 + 楼中楼）
// @namespace    workbuddy.v2ex.popup
// @version      3.1.1
// @description  V2EX 帖子弹窗：自动签到、详情图片大图预览、楼主与全部回复头像、站点操作、卡片式回复框、楼主标识、标题吸顶、上下撑满、深浅色主题、简洁楼中楼、已读标记
// @author       WorkBuddy
// @match        https://www.v2ex.com/*
// @match        https://v2ex.com/*
// @run-at       document-end
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CACHE_MS = 5 * 60 * 1000;
    const LS_THEME = 'tvp_theme';       // auto | light | dark
    const LS_MODE = 'tvp_reply_mode';   // thread | flat
    const MAX_DEPTH = 4;                // 楼中楼最大缩进层数
    const GUTTER = 8;                   // 弹窗四周留白(px)，改成 0 即完全贴边铺满
    const cache = new Map();            // /t/xxxx -> {time, data}
    const LS_CHECKIN = 'tvp_checkin_v1';       // 自动签到状态
    const CHECKIN_DELAY = 1200;                // 进站后延迟签到，避开页面主请求
    const CHECKIN_FAIL_COOLDOWN = 5 * 60 * 1000;

    let overlay = null, card = null, bodyBox = null, titleBox = null;
    let origLink = null, modeBtn = null, themeBtn = null, checkinBtn = null;
    let composeBox = null, composeInput = null, composeSend = null;
    let composeStatus = null, composeTarget = null, clearTargetBtn = null;
    let sending = false;
    let currentData = null, currentPath = '';
    let invertFix = null;               // 页面整体反色时用于抵消的滤镜
    let themeObserver = null;
    let checkinRunning = false, checkinToast = null, checkinToastTimer = 0;
    // 图片查看器状态
    let lightbox = null, lbStage = null, lbImg = null, lbErr = null;
    let lbCount = null, lbName = null, lbZoomText = null, lbOpenLink = null, lbThumbs = null;
    let lbList = [], lbIndex = 0, lbScale = 1, lbTx = 0, lbTy = 0, lbDrag = null;

    function absUrl(href) {
        try { return new URL(href, location.origin).href; } catch (e) { return href; }
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function getPref(key, def) {
        try { return localStorage.getItem(key) || def; } catch (e) { return def; }
    }
    function setPref(key, val) {
        try { localStorage.setItem(key, val); } catch (e) { /* 隐私模式忽略 */ }
    }

    /* ============================================================
       零、已读状态：拦截跳转后浏览器不记 :visited，这里自己记录并置灰
       ============================================================ */

    const LS_READ = 'tvp_read_ids';
    const READ_LIMIT = 3000;
    const readIds = new Set();
    try {
        const saved = JSON.parse(localStorage.getItem(LS_READ) || '[]');
        if (Array.isArray(saved)) saved.forEach(function (id) { readIds.add(String(id)); });
    } catch (e) { /* 数据损坏则忽略 */ }

    function saveReadIds() {
        const arr = Array.from(readIds);
        while (arr.length > READ_LIMIT) arr.shift();
        readIds.clear();
        arr.forEach(function (id) { readIds.add(id); });
        try { localStorage.setItem(LS_READ, JSON.stringify(arr)); } catch (e) { /* 忽略 */ }
    }

    function topicIdOf(anchor) {
        const m = (anchor.getAttribute('href') || '').match(/^\/t\/(\d+)/);
        return m ? m[1] : null;
    }

    // 给页面上的帖子链接补已读 class（跳过弹窗内部，避免影响弹窗内链接配色）
    function syncReadLinks(root) {
        const scope = root || document;
        const nodes = scope.querySelectorAll ? scope.querySelectorAll('a[href^="/t/"]') : [];
        Array.prototype.forEach.call(nodes, function (a) {
            if (a.closest && a.closest('#tvp-overlay')) return;
            const id = topicIdOf(a);
            if (id && readIds.has(id)) a.classList.add('tvp-read');
        });
        if (scope.matches && scope.matches('a[href^="/t/"]')) {
            const a = scope;
            if (!(a.closest && a.closest('#tvp-overlay')) && readIds.has(topicIdOf(a))) {
                a.classList.add('tvp-read');
            }
        }
    }

    function markRead(id) {
        readIds.add(String(id));
        saveReadIds();
        syncReadLinks(document);
    }

    function clearRead() {
        readIds.clear();
        saveReadIds();
        Array.prototype.forEach.call(document.querySelectorAll('a.tvp-read'), function (a) {
            a.classList.remove('tvp-read');
        });
    }

    /* ============================================================
       一、主题：自动检测（真实暗色 CSS / filter 反色 / 系统偏好）+ 手动覆盖
       ============================================================ */

    // 读取计算样式里的滤镜，构造它的逆滤镜（invert 自逆，hue-rotate 取负、顺序反转）
    function inverseFilter(filterStr) {
        if (!filterStr || filterStr === 'none') return null;
        const parts = [];
        const re = /([a-zA-Z-]+)\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(filterStr)) !== null) {
            parts.push({ name: m[1].toLowerCase(), args: m[2].trim() });
        }
        if (!parts.length) return null;
        const hasInvert = parts.some(function (p) { return p.name === 'invert'; });
        if (!hasInvert) return null;
        return parts.reverse().map(function (p) {
            if (p.name === 'invert') return 'invert(' + p.args + ')';
            if (p.name === 'hue-rotate') {
                const deg = parseFloat(p.args) || 0;
                return 'hue-rotate(' + (-deg) + 'deg)';
            }
            return p.name + '(' + p.args + ')';
        }).join(' ');
    }

    function pageFilterInfo() {
        const html = document.documentElement, body = document.body;
        for (const el of [html, body]) {
            const cs = getComputedStyle(el);
            const inv = inverseFilter(cs.filter || cs.webkitFilter);
            if (inv) return inv;
        }
        return null;
    }

    function luminance(colorStr) {
        const m = /rgba?\(([^)]+)\)/.exec(colorStr || '');
        if (!m) return null;
        const v = m[1].split(',').map(function (x) { return parseFloat(x); });
        if (v.length > 3 && v[3] < 0.4) return null; // 透明，继续找下一个
        return (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255;
    }

    // 站点若用真正的暗色 CSS（body/.cell 背景变深），计算样式能直接读出来
    function pageIsCssDark() {
        const list = [document.querySelector('#Main .cell'), document.querySelector('#Main'), document.body];
        for (const el of list) {
            if (!el) continue;
            const lum = luminance(getComputedStyle(el).backgroundColor);
            if (lum !== null) return lum < 0.42;
        }
        try {
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch (e) { return false; }
    }

    // 站点自身是深色还是浅色（决定列表里「已读标题」该用哪套灰色）
    function syncSiteInk() {
        const inv = pageFilterInfo();
        const ink = inv ? 'light' : (pageIsCssDark() ? 'dark' : 'light');
        document.documentElement.setAttribute('data-tvp-site-ink', ink);
    }

    function applyTheme() {
        syncSiteInk();
        if (!overlay) return;
        const pref = getPref(LS_THEME, 'auto');
        const inv = pageFilterInfo();
        invertFix = inv;

        let theme;
        if (pref === 'light' || pref === 'dark') {
            theme = pref;                       // 手动指定：用自己的配色，并抵消页面反色
        } else if (inv) {
            theme = 'dark';                     // 页面靠 filter 反色 → 站点视觉是暗色
        } else {
            theme = pageIsCssDark() ? 'dark' : 'light';
        }

        overlay.setAttribute('data-theme', theme);
        if (inv) {
            // 双重反色抵消站点滤镜，弹窗配色完全由自己控制
            overlay.style.filter = inv;
            overlay.setAttribute('data-invert-fix', '1');
            overlay.classList.add('tvp-inverted');
        } else {
            overlay.style.filter = '';
            overlay.removeAttribute('data-invert-fix');
            overlay.classList.remove('tvp-inverted');
        }
        syncOverlayPosition();

        if (themeBtn) {
            const labels = { auto: '◐ 自动', light: '☀ 浅色', dark: '☾ 深色' };
            themeBtn.textContent = labels[pref] || labels.auto;
            themeBtn.title = '当前：' + (labels[pref] || labels.auto).slice(2) +
                '（点击切换：自动 → 浅色 → 深色）';
        }
    }

    // html 带 filter 时，fixed 定位会退化为相对文档定位：滚动时手动同步 top
    function syncOverlayPosition() {
        if (!overlay || !overlay.classList.contains('tvp-inverted')) return;
        overlay.style.top = window.scrollY + 'px';
    }

    /* ============================================================
       二、详情页解析：正文、楼层、作者、时间、引用关系
       ============================================================ */

    function authorFromCell(cell) {
        let a = cell.querySelector('strong a[href^="/member/"], .fade a[href^="/member/"]');
        if (!a) {
            const anchors = Array.prototype.slice.call(cell.querySelectorAll('a[href^="/member/"]'));
            a = anchors.find(function (x) { return x.textContent.trim().length > 0; });
        }
        if (a && a.textContent.trim()) return a.textContent.trim();
        const any = cell.querySelector('a[href^="/member/"]');
        if (any) {
            try { return decodeURIComponent(any.getAttribute('href').split('/')[2] || ''); } catch (e) { return ''; }
        }
        return '';
    }

    // 从详情页里提取回复表单（action / 隐藏字段 once 等），用于弹窗内直接发表回复
    function parseReplyForm(doc, html, topicPath) {
        // V2EX 的回复框 id 为 reply_content，表单里带隐藏字段 once（CSRF 令牌）
        const forms = Array.prototype.slice.call(doc.querySelectorAll('form'));
        const form = forms.find(function (f) {
            return f.querySelector('textarea#reply_content, textarea[name="content"], textarea[name="reply_content"]');
        });
        const fields = {};
        if (form) {
            form.querySelectorAll('input[name]').forEach(function (i) {
                if (i.type === 'hidden' || i.type === 'text') fields[i.name] = i.value;
            });
        }
        if (!fields.once) {
            const onceEl = doc.querySelector('input[name="once"]');
            if (onceEl) fields.once = onceEl.value;
        }
        if (!fields.once) {
            const m = html.match(/name=["']once["'][^>]*value=["']([^"']+)["']/) ||
                      html.match(/value=["']([^"']+)["'][^>]*name=["']once["']/) ||
                      html.match(/once["']?\s*[:=]\s*["']([0-9a-zA-Z]+)["']/) ||
                      html.match(/[?&]once=([0-9a-zA-Z]+)/);
            if (m) fields.once = m[1];
        }
        if (!fields.once) return null;   // 拿不到令牌（多半是未登录）就无法回复
        let action = (form && form.getAttribute('action')) || '';
        if (!action || action.charAt(0) === '#') action = topicPath;
        return {
            action: action,
            method: ((form && form.getAttribute('method')) || 'post').toUpperCase(),
            fields: fields
        };
    }

    function normAvatar(raw) {
        const u = (raw || '').trim();
        if (!u || /^data:/i.test(u)) return '';
        return absUrl(u);          // //cdn.v2ex.com/... 与 /avatar/... 都能补成完整 URL
    }

    // 从容器里找头像：优先带 avatar 类名 / URL 的图，排除回复正文里用户自己贴的图
    function avatarFrom(root) {
        if (!root || !root.querySelector) return '';
        const content = root.querySelector('.reply_content, .topic_content');
        const imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
        let fallback = '';
        for (let i = 0; i < imgs.length; i++) {
            const el = imgs[i];
            const meta = [el.getAttribute('class'), el.getAttribute('id'), el.getAttribute('alt')].join(' ');
            const raw = el.getAttribute('src') || el.getAttribute('data-src') ||
                        el.getAttribute('data-original') || el.getAttribute('data-lazy-src') ||
                        (el.getAttribute('srcset') || '').split(/[\s,]+/)[0] || '';
            const u = normAvatar(raw);
            if (!u) continue;
            // 头像 URL / class 几乎总带 avatar 关键词，全范围匹配（有些版本头像在正文容器内）
            if (/avatar|gravatar/i.test(meta + ' ' + u)) return u;
            // 兜底只取正文以外的图，避免把用户贴的图当头像
            if (!fallback && !(content && content.contains(el))) fallback = u;
        }
        const styled = root.querySelector('[style*="background-image"]');
        if (styled) {
            const m = (styled.getAttribute('style') || '').match(/url\(['"]?([^'")]+)/i);
            if (m) return normAvatar(m[1]);
        }
        return fallback;
    }

    // 楼主用户名：优先取标题下方 meta 里的 member 链接，逐级兜底到 meta 文本
    function opAuthorFrom(doc, header, metaEl, meta) {
        const scopes = [metaEl, header, doc.querySelector('#Main .header')];
        for (let i = 0; i < scopes.length; i++) {
            const s = scopes[i];
            if (!s || !s.querySelector) continue;
            const a = s.querySelector('a[href^="/member/"]');
            if (!a) continue;
            let name = a.textContent.trim();
            if (!name) {
                try { name = decodeURIComponent((a.getAttribute('href') || '').split('/')[2] || ''); }
                catch (e) { name = ''; }
            }
            if (name) return name;
        }
        // 兜底：meta 形如「miusmile 22 分钟前 · 178 次点击」
        const m = (meta || '').match(/^([A-Za-z0-9_-]{2,30})(?=\s|$)/);
        return m ? m[1] : '';
    }

    function parseTopicPage(html, topicPath) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const path = topicPath || currentPath || '';
        const header = doc.querySelector('#Main .header');
        const titleEl = (header && header.querySelector('h1')) || doc.querySelector('h1');
        const title = titleEl ? titleEl.textContent.trim()
            : (doc.title || '（无标题）').replace(/\s*[-|]\s*V2EX.*$/, '').trim();
        const metaEl = (header && header.querySelector('.gray')) || doc.querySelector('#Main .gray');
        const meta = metaEl ? metaEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const opAuthor = opAuthorFrom(doc, header, metaEl, meta);
        const opAvatar = avatarFrom(header) ||
            avatarFrom(doc.querySelector('#Main .header')) ||
            (function () {
                const a = doc.querySelector('img.avatar, img[class*="avatar"], img[src*="/avatar/"]');
                return a ? normAvatar(a.getAttribute('src') || a.getAttribute('data-src') || '') : '';
            })();

        // 正文 + 楼主补充（.subtle）；结构变化时用通用选择器兜底
        let contentEls = Array.prototype.slice.call(doc.querySelectorAll('#Main .topic_content'));
        if (!contentEls.length) {
            contentEls = Array.prototype.slice.call(doc.querySelectorAll(
                '.topic_content, .markdown_body, #Main .cell .content'));
        }
        let contentHTML = '';
        contentEls.forEach(function (el) { contentHTML += el.innerHTML + '<hr class="tvp-sep">'; });
        contentHTML = contentHTML.replace(/<hr class="tvp-sep">$/, '');

        // 回复单元格：优先 V2EX 的 .cell[id^="r_"]，失效时逐级兜底
        let cells = Array.prototype.slice.call(doc.querySelectorAll('#Main .cell[id^="r_"]'));
        if (!cells.length) {
            cells = Array.prototype.slice.call(doc.querySelectorAll('[id^="r_"]'))
                .filter(function (el) { return el.querySelector('.reply_content'); });
        }
        if (!cells.length) {
            const seen = new Set();
            cells = Array.prototype.slice.call(doc.querySelectorAll('.reply_content'))
                .map(function (el) { return el.closest('.cell') || el.parentElement; })
                .filter(function (el) {
                    if (!el || seen.has(el)) return false;
                    seen.add(el);
                    return true;
                });
        }

        // 楼层号：优先用页面上的 .no，但校验为递增序列，避免把「感谢数」误当楼层
        const rawNos = cells.map(function (cell) {
            const el = cell.querySelector('.no, .floor, [class*="floor"]');
            const n = el ? parseInt(el.textContent.trim(), 10) : NaN;
            return isNaN(n) ? null : n;
        });
        const validNos = rawNos.every(function (n, i) {
            return n !== null && (i === 0 || n > rawNos[i - 1]);
        });

        const replies = cells.map(function (cell, i) {
            const author = authorFromCell(cell);
            const agoEl = cell.querySelector('.ago');
            const ago = agoEl ? (agoEl.getAttribute('title') || agoEl.textContent).trim() : '';
            const contentEl = cell.querySelector('.reply_content');
            let inner = '';
            if (contentEl) {
                const clone = contentEl.cloneNode(true);
                // 某些版本把作者名放在 .reply_content 内，去掉避免重复
                const selfAuthor = clone.querySelector('strong a[href^="/member/"]');
                if (selfAuthor && selfAuthor.closest('strong')) selfAuthor.closest('strong').remove();
                inner = clone.innerHTML;
            }
            const text = (function () {
                const tmp = document.createElement('div');
                tmp.innerHTML = inner;
                return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
            })();
            // 每条回复右侧的操作区（感谢 / 回复箭头 / 感谢数），去掉内联事件避免执行站点 JS
            const opsEl = cell.querySelector('.fr');
            let cellOps = '';
            if (opsEl) {
                const opsClone = opsEl.cloneNode(true);
                opsClone.querySelectorAll('[onclick]').forEach(function (el) {
                    el.removeAttribute('onclick');
                });
                cellOps = opsClone.innerHTML;
            }
            return {
                floor: validNos ? rawNos[i] : i + 1,
                author: author,
                avatar: avatarFrom(cell),
                ago: ago,
                html: inner,
                text: text,
                cellOps: cellOps,
                parent: null,
                depth: 0,
                children: [],
                replyTo: null
            };
        });

        const pagEl = doc.querySelector('#Pagination');
        const paginationHTML = (pagEl && replies.length) ? pagEl.innerHTML : '';

        /* 主题级操作：收藏 / Tweet / 忽略主题 / 感谢 / 隐藏 / 感谢回复者
           直接按链接特征收集，避免依赖 V2EX 的具体 class 名 */
        const siteActions = [];
        const seenAct = new Set();
        doc.querySelectorAll('#Main a[href]').forEach(function (a) {
            if (a.closest('.cell[id^="r_"]')) return;   // 排除每条回复内的感谢链接
            const href = a.getAttribute('href') || '';
            const label = a.textContent.replace(/\s+/g, ' ').trim();
            if (!label || label.length > 16) return;
            if (!href || href.charAt(0) === '#') return;   // JS 伪链接无法在弹窗内复现
            if (!/(favorite|ignore|thank|hide|tweet|twitter)/i.test(href) && !/^tweet$/i.test(label)) return;
            if (seenAct.has(href)) return;
            seenAct.add(href);
            siteActions.push({ href: href, text: label });
        });

        const tags = [];
        const seenTag = new Set();
        doc.querySelectorAll('#Main a[href^="/tag/"]').forEach(function (a) {
            const href = a.getAttribute('href');
            const label = a.textContent.trim();
            if (label && !seenTag.has(href)) { seenTag.add(href); tags.push({ href: href, text: label }); }
        });

        let clicks = '';
        if (!/次点击/.test(meta)) {
            const plain = doc.body ? doc.body.textContent.replace(/\s+/g, ' ') : '';
            const cm = plain.match(/(\d[\d,]*)\s*次点击/);
            if (cm) clicks = cm[1] + ' 次点击';
        }

        const idM = path.match(/\/t\/(\d+)/);
        return {
            topicId: idM ? idM[1] : '',
            opAuthor: opAuthor, opAvatar: opAvatar,
            title: title, meta: meta, contentHTML: contentHTML,
            replies: replies, paginationHTML: paginationHTML,
            siteActions: siteActions, tags: tags, clicks: clicks,
            form: parseReplyForm(doc, html, path)
        };
    }

    /* ---------- 楼中楼：由 @用户名 / #楼层 引用推断父子关系 ---------- */
    function buildThreads(replies) {
        replies.forEach(function (r) {
            r.parent = null; r.depth = 0; r.children = []; r.replyTo = null;
        });

        const byFloor = new Map();
        replies.forEach(function (r, i) { byFloor.set(r.floor, i); });
        const lastByAuthor = new Map();

        replies.forEach(function (r, i) {
            const head = r.text.slice(0, 90);
            let parent = null;

            // 1) 优先按 #楼层 精确定位（V2EX 点「回复」会插入 @xxx #N）
            const hashM = head.match(/#\s*(\d{1,4})/);
            if (hashM) {
                const p = byFloor.get(parseInt(hashM[1], 10));
                if (p !== undefined && p < i) parent = p;
            }

            // 2) 退化为 @用户名：挂到此前该用户最近的一条回复下
            if (parent === null) {
                const atM = head.match(/@([A-Za-z0-9_-]{2,30})/);
                if (atM) {
                    const p = lastByAuthor.get(atM[1].toLowerCase());
                    if (p !== undefined && p < i) parent = p;
                }
            }

            // 3) 限制缩进深度：过深的挂到最近的浅层祖先下
            if (parent !== null) {
                let p = replies[parent];
                while (p.depth >= MAX_DEPTH - 1 && p.parent !== null) p = replies[p.parent];
                const realParent = replies.indexOf(p);
                r.parent = realParent;
                r.depth = p.depth + 1;
                r.replyTo = { author: p.author, floor: p.floor };
                p.children.push(i);
            }
            lastByAuthor.set(r.author.toLowerCase(), i);
        });
        return replies;
    }

    /* ---------- 楼中楼：剥离开头的 @用户名 / #楼层 引用前缀 ---------- */
    // 层级已由缩进表达，正文开头的 @xxx #N 是 V2EX 为平铺显示而生成的冗余元数据。
    // 只剥离「开头连续出现」的引用；句子中间的 @ 一律保留。平铺模式不调用本函数。
    function stripReplyRefs(html) {
        if (!html) return html;
        let s = html;
        const lead = /^(?:\s|&nbsp;|<br\s*\/?>)+/i;
        const ref = /^(?:@[A-Za-z0-9_-]{1,30}(?![A-Za-z0-9_])|#\d{1,5}(?![\dA-Za-z])|<a\b[^>]*href=["'][^"']*\/member\/[^"']*["'][^>]*>\s*@?[A-Za-z0-9_-]{1,30}\s*<\/a>)/i;
        let changed = false;
        for (let guard = 0; guard < 20; guard++) {
            const pre = s.match(lead);
            const rest = pre ? s.slice(pre[0].length) : s;
            const m = rest.match(ref);
            if (!m) break;
            s = rest.slice(m[0].length);
            changed = true;
        }
        if (changed) return s.replace(/^(?:\s|&nbsp;|<br\s*\/?>)+/i, '');

        // 内容被 <p>/<div>/<span> 包裹时，进入内部再试一次
        const wrap = s.match(/^(<(?:p|div|span)\b[^>]*>)([\s\S]+)$/i);
        if (wrap) {
            const inner = stripReplyRefs(wrap[2]);
            if (inner !== wrap[2]) return wrap[1] + inner;
        }
        return html;
    }

    /* ============================================================
       三、弹窗骨架与样式
       ============================================================ */

    function injectCss() {
        if (document.getElementById('tvp-styles')) return;   // 幂等：初始化和 ensureModal 都会调
        const style = document.createElement('style');
        style.id = 'tvp-styles';
        style.textContent = `
#tvp-overlay {
  --tvp-bg: #ffffff; --tvp-fg: #24292f; --tvp-sub: #8a8f98;
  --tvp-border: #e5e8ec; --tvp-soft: #f5f7f9; --tvp-quote: #eef3f8;
  --tvp-link: #3b7bbf; --tvp-accent: #2f6fbb; --tvp-mask: rgba(0,0,0,.45);
  --tvp-shadow: 0 12px 48px rgba(0,0,0,.30);
  --tvp-scroll: rgba(110,120,135,.38); --tvp-scroll-hover: rgba(90,100,115,.72);
  --tvp-op-bg: #fff3e0; --tvp-op-fg: #a26100; --tvp-op-border: #e7c284;
  --tvp-focus: rgba(47,111,187,.13);
  --tvp-send-bg: #2f6fbb; --tvp-send-hover: #28609f;
  --tvp-send-border: #2f6fbb; --tvp-send-fg: #ffffff;
}
#tvp-overlay[data-theme="dark"] {
  --tvp-bg: #1c1f23; --tvp-fg: #d7dce2; --tvp-sub: #8b939d;
  --tvp-border: #333941; --tvp-soft: #242930; --tvp-quote: #232c35;
  --tvp-link: #7fb2e5; --tvp-accent: #6aa6e8; --tvp-mask: rgba(0,0,0,.65);
  --tvp-shadow: 0 12px 48px rgba(0,0,0,.65);
  --tvp-scroll: rgba(160,172,188,.28); --tvp-scroll-hover: rgba(185,196,210,.62);
  --tvp-op-bg: #3a2b15; --tvp-op-fg: #e5b264; --tvp-op-border: #6d5127;
  --tvp-focus: rgba(106,166,232,.15);
  --tvp-send-bg: #3a6b9e; --tvp-send-hover: #467cb4;
  --tvp-send-border: #487fb3; --tvp-send-fg: #f4f8fc;
}
#tvp-overlay {
  position: fixed; inset: 0; z-index: 2147483646; display: none;
  background: var(--tvp-mask); overflow: hidden; padding: ${GUTTER}px 12px;
  color: var(--tvp-fg);
  font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
#tvp-overlay.tvp-open { display: flex; align-items: stretch; justify-content: center; }
#tvp-overlay.tvp-inverted { position: absolute; left: 0; right: 0; bottom: auto; height: 100vh; }
#tvp-overlay, #tvp-overlay * { box-sizing: border-box; }
#tvp-overlay a { color: var(--tvp-link); text-decoration: none; }
#tvp-overlay a:hover { text-decoration: underline; }
#tvp-overlay button { font: inherit; cursor: pointer; }
#tvp-overlay[data-invert-fix="1"] img,
#tvp-overlay[data-invert-fix="1"] video,
#tvp-overlay[data-invert-fix="1"] iframe { filter: none !important; -webkit-filter: none !important; }
/* 正文/回复来自站点 HTML，强制文字色跟随弹窗主题，避免出现深色底上的黑字 */
#tvp-overlay .tvp-content, #tvp-overlay .tvp-rbody,
#tvp-overlay .tvp-content > *:not(a), #tvp-overlay .tvp-rbody > *:not(a) { color: var(--tvp-fg) !important; }

/* 已读标记：拦截跳转后浏览器不会记 :visited，这里手动还原 V2EX 自带的置灰效果。
   data-tvp-site-ink 表示「CSS 里该写深色值还是浅色值」：整页反色模式下写浅色值，
   经站点滤镜反色后呈现为暗灰。 */
html[data-tvp-site-ink="light"] a.tvp-read[href^="/t/"],
html[data-tvp-site-ink="light"] a.tvp-read[href^="/t/"]:link,
html[data-tvp-site-ink="light"] a.tvp-read[href^="/t/"]:visited { color: #9aa1a9 !important; }
html[data-tvp-site-ink="dark"] a.tvp-read[href^="/t/"],
html[data-tvp-site-ink="dark"] a.tvp-read[href^="/t/"]:link,
html[data-tvp-site-ink="dark"] a.tvp-read[href^="/t/"]:visited { color: #69737e !important; }

#tvp-card {
  max-width: 880px; width: 100%; height: 100%; max-height: none; margin: 0 auto;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--tvp-bg); color: var(--tvp-fg);
  border: 1px solid var(--tvp-border); border-radius: 10px;
  box-shadow: var(--tvp-shadow); padding: 0;
}
/* 头部固定，只有 .tvp-body 内部滚动，标题不会跟着滚走 */
.tvp-head {
  flex: 0 0 auto; display: flex; align-items: flex-start; gap: 14px;
  background: var(--tvp-bg); border-bottom: 1px solid var(--tvp-border);
  padding: 16px 22px 12px; z-index: 2;
}
.tvp-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 22px 24px; overscroll-behavior: contain; }
/* 细窄半透明滚动条：覆盖站点深色主题下的白色粗滚动条 */
.tvp-body { scrollbar-width: thin; scrollbar-color: var(--tvp-scroll) transparent; }
.tvp-body::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
.tvp-body::-webkit-scrollbar-track { background: transparent !important; }
.tvp-body::-webkit-scrollbar-thumb {
  background: var(--tvp-scroll) !important; border-radius: 999px;
  border: 1px solid transparent; background-clip: padding-box;
}
.tvp-body::-webkit-scrollbar-thumb:hover {
  background: var(--tvp-scroll-hover) !important; background-clip: padding-box;
}
.tvp-body::-webkit-scrollbar-corner { background: transparent; }
.tvp-title { flex: 1; font-size: 18px; font-weight: 650; line-height: 1.45; word-break: break-word; color: var(--tvp-fg); }
.tvp-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; max-width: 260px; }
.tvp-btn {
  background: var(--tvp-soft); color: var(--tvp-sub); border: 1px solid var(--tvp-border);
  border-radius: 6px; padding: 3px 9px; font-size: 12px; line-height: 20px; white-space: nowrap;
}
.tvp-btn:hover { color: var(--tvp-accent); border-color: var(--tvp-accent); }
.tvp-btn.tvp-on { color: var(--tvp-accent); border-color: var(--tvp-accent); }
.tvp-orig { font-size: 12px; padding: 3px 6px; white-space: nowrap; }
.tvp-close { width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--tvp-border); background: var(--tvp-soft); color: var(--tvp-sub); font-size: 13px; line-height: 1; padding: 0; }
.tvp-close:hover { color: var(--tvp-fg); }

.tvp-meta { color: var(--tvp-sub); font-size: 12px; margin-bottom: 12px; }
.tvp-topicmeta { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.tvp-topicmeta .tvp-meta { margin-bottom: 0; min-width: 0; }
.tvp-avatar {
  position: relative; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 7px; overflow: hidden;
  background: var(--tvp-quote); border: 1px solid var(--tvp-border);
  color: var(--tvp-sub); font-size: 13px; font-weight: 650;
}
.tvp-avatar-letter { user-select: none; }
.tvp-avatar img {
  position: absolute; inset: 0; width: 100%; height: 100%; max-width: none;
  object-fit: cover; opacity: 0; transition: opacity .15s ease;
}
.tvp-avatar img.tvp-img-ok { opacity: 1; }
.tvp-avatar-topic { width: 38px; height: 38px; border-radius: 9px; font-size: 15px; }
.tvp-content, .tvp-rbody { word-break: break-word; overflow-wrap: anywhere; }
.tvp-content img, .tvp-rbody img { max-width: 100%; height: auto; }
.tvp-content pre, .tvp-rbody pre { max-width: 100%; overflow-x: auto; background: var(--tvp-soft); padding: 10px; border-radius: 6px; }
.tvp-content code, .tvp-rbody code { background: var(--tvp-soft); border-radius: 3px; padding: 1px 4px; }
.tvp-content blockquote, .tvp-rbody blockquote { margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--tvp-border); color: var(--tvp-sub); }
.tvp-sep { border: none; border-top: 1px dashed var(--tvp-border); margin: 16px 0; }
.tvp-empty { color: var(--tvp-sub); padding: 10px 0; }

.tvp-section { margin: 20px 0 8px; display: flex; align-items: center; gap: 10px; font-weight: 650; color: var(--tvp-fg); }
.tvp-section small { font-weight: 400; color: var(--tvp-sub); font-size: 12px; }
.tvp-section::after { content: ''; flex: 1; border-top: 1px solid var(--tvp-border); }

.tvp-item { display: flex; align-items: flex-start; gap: 10px; border-bottom: 1px solid var(--tvp-border); padding: 10px 0; }
.tvp-item:last-child { border-bottom: none; }
.tvp-main { flex: 1 1 auto; min-width: 0; }
.tvp-rhead { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--tvp-sub); margin-bottom: 4px; flex-wrap: wrap; }
.tvp-author { font-weight: 650; color: var(--tvp-accent); font-size: 13px; }
.tvp-op {
  display: inline-block; padding: 0 5px; border-radius: 4px; white-space: nowrap;
  border: 1px solid var(--tvp-op-border); background: var(--tvp-op-bg);
  color: var(--tvp-op-fg) !important; font-size: 11px; line-height: 16px; font-weight: 650;
}
.tvp-floor { background: var(--tvp-soft); border: 1px solid var(--tvp-border); border-radius: 4px; padding: 0 5px; font-size: 11px; }
.tvp-rhead .tvp-spacer { flex: 1; }
.tvp-quick { background: none; border: none; color: var(--tvp-sub); font-size: 12px; padding: 0 2px; }
.tvp-quick:hover { color: var(--tvp-accent); }
.tvp-cellops { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--tvp-sub); }
.tvp-cellops .fr { float: none !important; }
.tvp-cellops a { color: var(--tvp-sub) !important; }
.tvp-cellops a:hover { color: var(--tvp-accent) !important; }
.tvp-topicbar { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin: 16px 0 4px; padding: 8px 10px; border: 1px solid var(--tvp-border); border-radius: 8px; background: var(--tvp-soft); }
.tvp-topicbar .tvp-spacer { flex: 1; }
.tvp-site-action {
  display: inline-block; padding: 2px 9px; border: 1px solid var(--tvp-border);
  border-radius: 999px; background: var(--tvp-bg); color: var(--tvp-sub) !important;
  font-size: 12px; line-height: 18px; white-space: nowrap;
}
.tvp-site-action:hover { color: var(--tvp-accent) !important; border-color: var(--tvp-accent); }
.tvp-tag { padding: 1px 8px; border-radius: 4px; background: var(--tvp-quote); color: var(--tvp-link) !important; font-size: 12px; }
.tvp-tagsep { width: 1px; height: 16px; background: var(--tvp-border); margin: 0 3px; }
.tvp-clicks { font-size: 12px; color: var(--tvp-sub); white-space: nowrap; }
.tvp-collapse { background: none; border: none; color: var(--tvp-link); font-size: 12px; padding: 0 2px; }
.tvp-rbody { font-size: 14px; }
.tvp-children { margin: 8px 0 0 0; padding-left: 12px; border-left: 2px solid var(--tvp-border); }
.tvp-children .tvp-item { padding: 8px 0; border-bottom: 1px dashed var(--tvp-border); }
.tvp-children .tvp-avatar { width: 24px; height: 24px; border-radius: 6px; font-size: 11px; }
.tvp-children .tvp-item:last-child { border-bottom: none; }
.tvp-children.tvp-hidden { display: none; }
.tvp-pages { margin-top: 14px; color: var(--tvp-sub); font-size: 13px; }
.tvp-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 48px 0; color: var(--tvp-sub); }
.tvp-spinner { width: 18px; height: 18px; border: 3px solid var(--tvp-border); border-top-color: var(--tvp-accent); border-radius: 50%; animation: tvp-spin .8s linear infinite; }
@keyframes tvp-spin { to { transform: rotate(360deg); } }
.tvp-error { padding: 36px 0; text-align: center; color: var(--tvp-sub); }
.tvp-error a { display: inline-block; margin-top: 10px; }

/* 常驻底部的回复框：输入区 + 工具行 收进同一张卡片 */
.tvp-compose { flex: 0 0 auto; border-top: 1px solid var(--tvp-border); background: var(--tvp-bg); padding: 10px 22px 9px; }
.tvp-compose-bar {
  display: flex; align-items: center; gap: 8px; min-height: 18px;
  font-size: 12px; color: var(--tvp-sub); margin-bottom: 7px;
}
.tvp-compose-label { font-weight: 650; color: var(--tvp-fg); font-size: 12.5px; letter-spacing: .2px; }
.tvp-compose-target { color: var(--tvp-link); }
.tvp-compose-bar .tvp-spacer, .tvp-editor-foot .tvp-spacer { flex: 1; }
.tvp-editor {
  border: 1px solid var(--tvp-border); border-radius: 10px;
  background: var(--tvp-soft); overflow: hidden;
  transition: border-color .16s ease, box-shadow .16s ease;
}
.tvp-editor:focus-within { border-color: var(--tvp-accent); box-shadow: 0 0 0 3px var(--tvp-focus); }
.tvp-input {
  display: block; width: 100%; min-width: 0; resize: none; box-sizing: border-box;
  height: 62px; padding: 11px 13px 4px;
  border: none; background: transparent; color: var(--tvp-fg);
  font: inherit; font-size: 13.5px; line-height: 1.55; outline: none;
}
.tvp-input::placeholder { color: var(--tvp-sub); opacity: .8; }
.tvp-editor-foot { display: flex; align-items: center; gap: 6px; padding: 2px 9px 9px 13px; }
.tvp-hint { font-size: 11px; color: var(--tvp-sub); opacity: .8; user-select: none; }
.tvp-textbtn {
  background: none; border: none; padding: 4px 8px; border-radius: 5px;
  color: var(--tvp-sub); font-size: 12px; cursor: pointer;
  transition: color .15s ease, background .15s ease;
}
.tvp-textbtn:hover { color: var(--tvp-link); background: var(--tvp-quote); }
.tvp-send {
  flex-shrink: 0; height: 30px; padding: 0 15px; border-radius: 6px;
  border: 1px solid var(--tvp-send-border); background: var(--tvp-send-bg);
  color: var(--tvp-send-fg); font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: background .15s ease, border-color .15s ease, transform .08s ease;
}
.tvp-send:hover:not(:disabled) { background: var(--tvp-send-hover); }
.tvp-send:active:not(:disabled) { transform: translateY(1px); }
.tvp-send:disabled { opacity: .45; cursor: not-allowed; }
.tvp-compose-status { min-height: 14px; font-size: 11.5px; color: var(--tvp-sub); margin-top: 5px; padding-left: 2px; }
.tvp-compose-status.tvp-ok { color: #57b57f; }
.tvp-compose-status.tvp-err { color: #e57b7b; }
.tvp-compose.tvp-disabled .tvp-editor { opacity: .6; }

/* ---------- 详情图片：可点开 ---------- */
#tvp-overlay .tvp-content img.tvp-zoomable,
#tvp-overlay .tvp-rbody img.tvp-zoomable { cursor: zoom-in; transition: opacity .15s ease; }
#tvp-overlay .tvp-content img.tvp-zoomable:hover,
#tvp-overlay .tvp-rbody img.tvp-zoomable:hover { opacity: .86; }

/* ---------- 图片查看器（放在 overlay 内，继承主题变量与反色抵消） ---------- */
#tvp-lightbox {
  position: absolute; inset: 0; z-index: 20; display: none; flex-direction: column;
  background: rgba(10,12,15,.95); color: #e9edf2; user-select: none;
}
#tvp-lightbox.tvp-lb-open { display: flex; }
.tvp-lb-bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; background: rgba(255,255,255,.05);
  border-bottom: 1px solid rgba(255,255,255,.09); font-size: 12px; color: #cfd6de;
}
.tvp-lb-bar .tvp-spacer { flex: 1; }
.tvp-lb-count { font-variant-numeric: tabular-nums; color: #fff; font-weight: 600; }
.tvp-lb-name { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .7; }
.tvp-lb-tool {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; height: 26px; padding: 0 8px; border-radius: 5px;
  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06);
  color: #dfe5ec !important; text-decoration: none !important;
  font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.tvp-lb-tool:hover { background: rgba(255,255,255,.16); }
.tvp-lb-zoom { min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; opacity: .8; }
.tvp-lb-stage {
  flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
}
.tvp-lb-img {
  display: block; max-width: 96%; max-height: 96%; width: auto; height: auto;
  transform-origin: center center; cursor: zoom-in;
  box-shadow: 0 8px 40px rgba(0,0,0,.5);
}
.tvp-lb-nav {
  position: absolute; top: 50%; margin-top: -24px; width: 42px; height: 48px;
  border: none; border-radius: 7px; background: rgba(255,255,255,.09);
  color: #eef2f7; font-size: 30px; line-height: 1; cursor: pointer;
}
.tvp-lb-nav:hover { background: rgba(255,255,255,.2); }
.tvp-lb-prev { left: 14px; } .tvp-lb-next { right: 14px; }
.tvp-lb-nav[hidden] { display: none; }
.tvp-lb-err { color: #e9edf2; font-size: 13px; text-align: center; }
.tvp-lb-err a { display: block; margin-top: 8px; color: #8fc0f0 !important; }
.tvp-lb-thumbs {
  flex: 0 0 auto; display: flex; gap: 7px; padding: 9px 14px;
  overflow-x: auto; background: rgba(255,255,255,.04);
  border-top: 1px solid rgba(255,255,255,.09);
  scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent;
}
.tvp-lb-thumbs[hidden] { display: none; }
.tvp-lb-thumbs img {
  flex: 0 0 auto; width: 54px; height: 42px; object-fit: cover;
  border-radius: 4px; opacity: .55; cursor: pointer; border: 2px solid transparent;
}
.tvp-lb-thumbs img:hover { opacity: .9; }
.tvp-lb-thumbs img.tvp-lb-cur { opacity: 1; border-color: var(--tvp-accent); }

/* ---------- 自动签到提示条（独立于弹窗，挂在 body 上） ---------- */
#tvp-checkin-toast {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  display: none; align-items: center; gap: 10px; max-width: 340px;
  padding: 10px 14px 10px 12px; border-radius: 9px;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  cursor: pointer; border: 1px solid transparent; border-left-width: 3px;
}
#tvp-checkin-toast.tvp-ct-show { display: flex; animation: tvp-ct-in .22s ease both; }
#tvp-checkin-toast.tvp-ct-hide { animation: tvp-ct-out .24s ease both; }
@keyframes tvp-ct-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes tvp-ct-out { to { opacity: 0; transform: translateY(8px); } }
html[data-tvp-site-ink="light"] #tvp-checkin-toast {
  background: #fff; color: #24292f; border-color: #e5e8ec;
  box-shadow: 0 10px 30px rgba(0,0,0,.18);
}
html[data-tvp-site-ink="dark"] #tvp-checkin-toast {
  background: #1c1f23; color: #d7dce2; border-color: #333941;
  box-shadow: 0 10px 30px rgba(0,0,0,.5);
}
#tvp-checkin-toast[data-kind="ok"] { border-left-color: #3fa46a; }
#tvp-checkin-toast[data-kind="warn"] { border-left-color: #d9a441; }
#tvp-checkin-toast[data-kind="err"] { border-left-color: #d05a5a; }
.tvp-ct-icon { flex: 0 0 auto; font-size: 15px; font-weight: 700; }
.tvp-ct-text { min-width: 0; }
.tvp-ct-main { font-weight: 600; }
.tvp-ct-sub { font-size: 11.5px; opacity: .72; margin-top: 2px; }
`;
        document.head.appendChild(style);
    }

    function ensureModal() {
        if (overlay && document.body.contains(overlay)) return;
        injectCss();

        overlay = document.createElement('div');
        overlay.id = 'tvp-overlay';
        overlay.innerHTML = `
<div id="tvp-card">
  <div class="tvp-head">
    <div class="tvp-title"></div>
    <div class="tvp-actions">
      <button class="tvp-btn tvp-checkin" data-act="checkin" title="自动签到状态，点击立即检查">◎ 签到</button>
      <button class="tvp-btn" data-act="mode" title="切换回复排列方式：楼中楼 / 平铺"></button>
      <button class="tvp-btn" data-act="theme" title="切换弹窗主题"></button>
      <a class="tvp-orig" target="_blank" rel="noopener">原帖 ↗</a>
      <button class="tvp-close" data-act="close" title="关闭 (Esc)">✕</button>
    </div>
  </div>
  <div class="tvp-body"></div>
  <div class="tvp-compose">
    <div class="tvp-compose-bar">
      <span class="tvp-compose-label">回复本帖</span>
      <span class="tvp-compose-target"></span>
      <span class="tvp-spacer"></span>
      <button class="tvp-textbtn tvp-clear-target" hidden>取消回复对象</button>
    </div>
    <div class="tvp-editor">
      <textarea class="tvp-input" rows="2" placeholder="写下你的回复…"></textarea>
      <div class="tvp-editor-foot">
        <span class="tvp-hint">Ctrl + Enter 发送</span>
        <span class="tvp-spacer"></span>
        <button class="tvp-textbtn tvp-totop" title="回到顶部">↑ 顶部</button>
        <button class="tvp-send" data-act="send">发表回复</button>
      </div>
    </div>
    <div class="tvp-compose-status"></div>
  </div>
</div>
<div id="tvp-lightbox" aria-hidden="true">
  <div class="tvp-lb-bar">
    <span class="tvp-lb-count"></span>
    <span class="tvp-lb-name"></span>
    <span class="tvp-spacer"></span>
    <button class="tvp-lb-tool" data-lb="zoom-out" title="缩小 (-)">−</button>
    <span class="tvp-lb-zoom">100%</span>
    <button class="tvp-lb-tool" data-lb="zoom-in" title="放大 (+)">＋</button>
    <button class="tvp-lb-tool" data-lb="reset" title="还原 (0)">1:1</button>
    <a class="tvp-lb-tool tvp-lb-open" target="_blank" rel="noopener" title="在新标签页打开原图">↗ 原图</a>
    <button class="tvp-lb-tool" data-lb="close" title="关闭 (Esc)">✕</button>
  </div>
  <div class="tvp-lb-stage">
    <img class="tvp-lb-img" alt="">
    <div class="tvp-lb-err" hidden>图片加载失败<a target="_blank" rel="noopener">在新标签页打开 ↗</a></div>
    <button class="tvp-lb-nav tvp-lb-prev" data-lb="prev" title="上一张 (←)">‹</button>
    <button class="tvp-lb-nav tvp-lb-next" data-lb="next" title="下一张 (→)">›</button>
  </div>
  <div class="tvp-lb-thumbs" hidden></div>
</div>`;

        card = overlay.querySelector('#tvp-card');
        titleBox = overlay.querySelector('.tvp-title');
        bodyBox = overlay.querySelector('.tvp-body');
        origLink = overlay.querySelector('.tvp-orig');
        modeBtn = overlay.querySelector('[data-act="mode"]');
        themeBtn = overlay.querySelector('[data-act="theme"]');
        composeBox = overlay.querySelector('.tvp-compose');
        composeInput = overlay.querySelector('.tvp-input');
        composeSend = overlay.querySelector('.tvp-send');
        composeStatus = overlay.querySelector('.tvp-compose-status');
        composeTarget = overlay.querySelector('.tvp-compose-target');
        clearTargetBtn = overlay.querySelector('.tvp-clear-target');
        checkinBtn = overlay.querySelector('[data-act="checkin"]');

        lightbox = overlay.querySelector('#tvp-lightbox');
        lbStage = lightbox.querySelector('.tvp-lb-stage');
        lbImg = lightbox.querySelector('.tvp-lb-img');
        lbErr = lightbox.querySelector('.tvp-lb-err');
        lbCount = lightbox.querySelector('.tvp-lb-count');
        lbName = lightbox.querySelector('.tvp-lb-name');
        lbZoomText = lightbox.querySelector('.tvp-lb-zoom');
        lbOpenLink = lightbox.querySelector('.tvp-lb-open');
        lbThumbs = lightbox.querySelector('.tvp-lb-thumbs');
        bindLightboxEvents();
        syncCheckinBtn();
        checkinBtn.addEventListener('click', function () { manualCheckin(); });

        composeSend.addEventListener('click', sendReply);
        composeInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                sendReply();
            }
        });
        clearTargetBtn.addEventListener('click', function () {
            composeInput.value = composeInput.value.replace(/^@[A-Za-z0-9_-]+\s+#\d+\s*/, '');
            composeTarget.textContent = '';
            clearTargetBtn.hidden = true;
            composeInput.focus();
        });
        overlay.querySelector('.tvp-totop').addEventListener('click', function () {
            if (bodyBox) bodyBox.scrollTo({ top: 0, behavior: 'smooth' });
        });

        modeBtn.addEventListener('click', function () {
            const next = getPref(LS_MODE, 'thread') === 'thread' ? 'flat' : 'thread';
            setPref(LS_MODE, next);
            syncModeBtn();
            if (currentData) renderTopic(currentData);
        });
        themeBtn.addEventListener('click', function () {
            const order = ['auto', 'light', 'dark'];
            const cur = getPref(LS_THEME, 'auto');
            setPref(LS_THEME, order[(order.indexOf(cur) + 1) % order.length]);
            applyTheme();
        });
        overlay.querySelector('[data-act="close"]').addEventListener('click', closeModal);
        overlay.addEventListener('mousedown', function (e) {
            if (e.target === overlay) closeModal();
        });

        // 折叠/展开子回复、快捷 @ 回复
        card.addEventListener('click', function (e) {
            const zi = e.target.closest ? e.target.closest('img.tvp-zoomable') : null;
            if (zi) {
                e.preventDefault();
                e.stopPropagation();
                openLightbox(parseInt(zi.dataset.tvpZoom || '0', 10) || 0);
                return;
            }
            const quick = e.target.closest('.tvp-quick');
            if (quick) {
                e.preventDefault();
                setReplyTarget(quick.dataset.author || '', quick.dataset.floor || '');
                return;
            }
            const col = e.target.closest('.tvp-collapse');
            if (col) {
                e.preventDefault();
                const box = col.closest('.tvp-item')
                    .querySelector(':scope > .tvp-main > .tvp-children');
                if (box) {
                    box.classList.toggle('tvp-hidden');
                    col.textContent = box.classList.contains('tvp-hidden')
                        ? '展开 ' + col.dataset.count + ' 条回复'
                        : '收起 ' + col.dataset.count + ' 条回复';
                }
                return;
            }
            const a = e.target.closest('a');
            if (!a || !a.getAttribute('href')) return;
            const href = a.getAttribute('href');
            // 脚本注入的站点操作链接：外链/标签新开，其余在弹窗内用 GET 完成
            if (a.classList.contains('tvp-site-action')) {
                e.preventDefault();
                e.stopPropagation();
                if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
                if (/^https?:/i.test(href) || /^\/tag\//.test(href) || /tweet|twitter/i.test(href)) {
                    window.open(absUrl(href), '_blank', 'noopener');
                } else {
                    performSiteAction(href, a.textContent.trim() || '操作');
                }
                return;
            }
            if (/^\/t\/\d+/.test(href)) return;   // 帖子链接交给全局拦截，继续弹窗
            e.preventDefault();
            e.stopPropagation();
            window.open(absUrl(href), '_blank', 'noopener');
        });

        document.body.appendChild(overlay);
        syncModeBtn();
        applyTheme();

        // 站点主题切换 / 系统主题变化时自动跟随
        if ('MutationObserver' in window) {
            themeObserver = new MutationObserver(function () { applyTheme(); });
            themeObserver.observe(document.documentElement, {
                attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode']
            });
        }
        try {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
        } catch (e) { /* 老浏览器忽略 */ }
        window.addEventListener('scroll', syncOverlayPosition, { passive: true });
        window.addEventListener('resize', syncOverlayPosition, { passive: true });
    }

    function syncModeBtn() {
        if (!modeBtn) return;
        const mode = getPref(LS_MODE, 'thread');
        modeBtn.textContent = mode === 'thread' ? '☰ 楼中楼' : '☰ 平铺';
        modeBtn.classList.toggle('tvp-on', mode === 'thread');
        modeBtn.title = '当前：' + (mode === 'thread' ? '楼中楼' : '平铺') + '，点击切换';
    }

    function openModal() {
        syncOverlayPosition();
        overlay.classList.add('tvp-open');
        if (bodyBox) bodyBox.scrollTop = 0;
        document.documentElement.style.overflow = 'hidden';
    }
    function closeModal() {
        closeLightbox();
        if (overlay) overlay.classList.remove('tvp-open');
        document.documentElement.style.overflow = '';
    }
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay && overlay.classList.contains('tvp-open')) closeModal();
    });

    /* ============================================================
       四、渲染
       ============================================================ */

    function renderLoading(path) {
        closeLightbox();
        titleBox.textContent = '加载中…';
        origLink.href = absUrl(path);
        currentData = null;
        bodyBox.innerHTML = '<div class="tvp-loading"><span class="tvp-spinner"></span>正在获取帖子内容…</div>';
        setStatus('', '');
        if (composeTarget) composeTarget.textContent = '';
        if (clearTargetBtn) clearTargetBtn.hidden = true;
    }

    function renderError(path, msg) {
        currentData = null;
        bodyBox.innerHTML = '<div class="tvp-error"><div>' + esc(msg) + '</div>' +
            '<a href="' + esc(absUrl(path)) + '" target="_blank" rel="noopener">在新标签页打开原帖 ↗</a></div>';
        setStatus('帖子加载失败，暂时无法回复', 'err');
        if (composeInput) composeInput.disabled = true;
        if (composeSend) composeSend.disabled = true;
    }

    /* ---------- 回复框：状态提示、@ 某人、提交回复 ---------- */
    function setStatus(msg, kind) {
        if (!composeStatus) return;
        composeStatus.textContent = msg || '';
        composeStatus.className = 'tvp-compose-status' + (kind ? ' tvp-' + kind : '');
    }

    function setReplyTarget(author, floor) {
        if (!composeInput) return;
        if (!currentData || !currentData.form) {
            setStatus('需要先登录 V2EX 才能回复', 'err');
            return;
        }
        const prefix = '@' + author + ' #' + floor + ' ';
        composeInput.value = prefix + composeInput.value.replace(/^@[A-Za-z0-9_-]+\s+#\d+\s*/, '');
        composeTarget.textContent = '→ @' + author + ' (#' + floor + ')';
        clearTargetBtn.hidden = false;
        composeInput.focus();
        composeInput.setSelectionRange(prefix.length, prefix.length);
    }

    function updateComposer(data) {
        if (!composeBox) return;
        const can = !!data.form;
        composeBox.classList.toggle('tvp-disabled', !can);
        composeInput.disabled = !can;
        composeSend.disabled = !can || sending;
        composeInput.placeholder = can
            ? '写下你的回复…'
            : '需要先登录 V2EX 才能回复';
        if (!can) setStatus('未登录：点右上角「原帖 ↗」登录后重新打开弹窗即可回复', 'err');
    }

    async function sendReply() {
        if (sending || !currentData || !composeInput) return;
        const form = currentData.form;
        if (!form) { setStatus('未登录 V2EX，无法在弹窗内回复', 'err'); return; }
        const text = composeInput.value.trim();
        if (!text) { setStatus('先写点什么吧', 'err'); composeInput.focus(); return; }

        sending = true;
        composeSend.disabled = true;
        composeSend.textContent = '发送中…';
        setStatus('正在提交回复…', '');

        const payload = new URLSearchParams();
        Object.keys(form.fields).forEach(function (k) { payload.append(k, form.fields[k]); });
        // V2EX 后端按 CRLF 解析换行，直接用 \n 会导致多行排版错乱
        payload.append('content', text.replace(/\r?\n/g, '\r\n'));

        try {
            const resp = await fetch(form.action, {
                method: form.method || 'POST',
                credentials: 'same-origin',
                referrer: absUrl(currentPath),   // 让请求看起来是从帖子详情页发出的
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: payload.toString()
            });
            if (!resp.ok) {
                setStatus('提交失败（HTTP ' + resp.status + '），请点「原帖 ↗」确认', 'err');
                return;
            }
            // V2EX 的 POST 响应直接就是最新帖子页，解析它即可刷新列表 + 拿新 once
            const postHtml = await resp.text();
            const errDoc = new DOMParser().parseFromString(postHtml, 'text/html');
            const prob = errDoc.querySelector('.problem, .error_message');
            if (prob && prob.textContent.trim()) {
                setStatus(prob.textContent.trim().slice(0, 100), 'err');
                return;
            }
            let fresh = parseTopicPage(postHtml, currentPath);
            // 响应不像完整帖子页时，再 GET 一次兜底
            if (!fresh.form || (currentData.replies.length > 0 && fresh.replies.length === 0)) {
                const again = await fetch(currentPath, { credentials: 'same-origin', cache: 'no-store' });
                fresh = parseTopicPage(await again.text(), currentPath);
            }
            const added = fresh.replies.length - currentData.replies.length;
            cache.set(currentPath, { time: Date.now(), data: fresh });
            renderTopic(fresh);
            composeSend.disabled = true;

            if (added > 0) {
                composeInput.value = '';
                composeTarget.textContent = '';
                clearTargetBtn.hidden = true;
                setStatus('回复已发布', 'ok');
                if (bodyBox) bodyBox.scrollTop = bodyBox.scrollHeight;
            } else {
                setStatus('已提交但列表没变化（可能分页/限流/需审核），点「原帖 ↗」确认', 'err');
            }
        } catch (err) {
            setStatus('网络错误：' + err.message, 'err');
        } finally {
            sending = false;
            composeSend.textContent = '发表回复';
            composeSend.disabled = !(currentData && currentData.form);
        }
    }

    /* 收藏 / 忽略 / 感谢 / 隐藏等：V2EX 都是带 once 的 GET，执行后刷新弹窗内容 */
    async function performSiteAction(href, label) {
        if (!currentPath) return;
        setStatus('正在「' + label + '」…', '');
        const keepScroll = bodyBox ? bodyBox.scrollTop : 0;
        try {
            const resp = await fetch(href, {
                credentials: 'same-origin',
                referrer: absUrl(currentPath)
            });
            if (!resp.ok) {
                setStatus('「' + label + '」失败（HTTP ' + resp.status + '）', 'err');
                return;
            }
            const again = await fetch(currentPath, { credentials: 'same-origin', cache: 'no-store' });
            const fresh = parseTopicPage(await again.text(), currentPath);
            cache.set(currentPath, { time: Date.now(), data: fresh });
            renderTopic(fresh);
            if (bodyBox) bodyBox.scrollTop = keepScroll;
            setStatus('「' + label + '」完成', 'ok');
        } catch (err) {
            setStatus('「' + label + '」失败：' + err.message, 'err');
        }
    }

    // 头像：底层显示首字母占位，图片加载成功后盖上去；加载失败就自动留占位
    function avatarHtml(url, name, variant) {
        const letter = ((name || '?').trim().charAt(0) || '?').toUpperCase();
        return '<span class="tvp-avatar' + (variant ? ' tvp-avatar-' + variant : '') + '" aria-hidden="true">' +
            '<span class="tvp-avatar-letter">' + esc(letter) + '</span>' +
            (url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : '') +
            '</span>';
    }

    function bindAvatars(root) {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('.tvp-avatar img').forEach(function (img) {
            const ok = function () { img.classList.add('tvp-img-ok'); };
            const bad = function () { if (img.parentNode) img.parentNode.removeChild(img); };
            if (img.complete) { img.naturalWidth > 0 ? ok() : bad(); }
            else {
                img.addEventListener('load', ok, { once: true });
                img.addEventListener('error', bad, { once: true });
            }
        });
    }

    function itemHtml(r, childrenHtml, mode, opLower) {
        const showThread = mode === 'thread';
        const isOP = !!(opLower && r.author && r.author.toLowerCase() === opLower);
        let h = '<div class="tvp-item' + (isOP ? ' tvp-is-op' : '') + '">';
        h += avatarHtml(r.avatar, r.author, 'reply');
        h += '<div class="tvp-main">';
        h += '<div class="tvp-rhead">';
        h += '<span class="tvp-author">' + (r.author
            ? '<a href="/member/' + encodeURIComponent(r.author) + '">' + esc(r.author) + '</a>'
            : '匿名') + '</span>';
        if (isOP) h += '<span class="tvp-op" title="本帖楼主">楼主</span>';
        h += '<span class="tvp-floor">#' + r.floor + '</span>';
        if (r.ago) h += '<span class="tvp-ago">' + esc(r.ago) + '</span>';
        h += '<span class="tvp-spacer"></span>';
        if (r.cellOps) h += '<span class="tvp-cellops">' + r.cellOps + '</span>';
        h += '<button class="tvp-quick" data-author="' + esc(r.author) + '" data-floor="' + r.floor + '">回复</button>';
        if (showThread && r.children.length) {
            h += '<button class="tvp-collapse" data-count="' + r.children.length + '">收起 ' + r.children.length + ' 条回复</button>';
        }
        h += '</div>';
        // 楼中楼里已用缩进表达回复对象：不显示「↳ 回复 xx 的 #N」，
        // 并去掉正文开头重复的 @用户名 / #楼层（平铺模式保留原文）
        let bodyHTML = r.html;
        if (showThread && typeof r.parent === 'number') bodyHTML = stripReplyRefs(bodyHTML);
        h += '<div class="tvp-rbody">' + (bodyHTML || '<span class="tvp-empty">（空回复）</span>') + '</div>';
        if (childrenHtml) h += '<div class="tvp-children">' + childrenHtml + '</div>';
        h += '</div>';   // .tvp-main
        h += '</div>';   // .tvp-item
        return h;
    }

    function renderTopic(data) {
        titleBox.textContent = data.title;
        currentData = data;
        const mode = getPref(LS_MODE, 'thread');
        const useThread = mode === 'thread';
        const opLower = (data.opAuthor || '').toLowerCase();
        const replies = buildThreads(data.replies);

        let html = '';
        if (data.meta || data.opAvatar) {
            html += '<div class="tvp-topicmeta">' +
                avatarHtml(data.opAvatar, data.opAuthor, 'topic') +
                '<div class="tvp-meta">' + esc(data.meta) + '</div></div>';
        }
        html += data.contentHTML
            ? '<div class="tvp-content">' + data.contentHTML + '</div>'
            : '<div class="tvp-empty">（本帖无正文内容）</div>';

        // 站点操作条：收藏 / Tweet / 忽略主题 / 感谢 / 隐藏 / 感谢回复者 / 标签 / 点击数
        const acts = data.siteActions || [];
        const tags = data.tags || [];
        if (acts.length || tags.length || data.clicks) {
            html += '<div class="tvp-topicbar">';
            acts.forEach(function (x) {
                html += '<a class="tvp-site-action" href="' + esc(x.href) + '">' + esc(x.text) + '</a>';
            });
            if (tags.length) {
                html += '<span class="tvp-tagsep"></span>';
                tags.forEach(function (x) {
                    html += '<a class="tvp-site-action tvp-tag" href="' + esc(x.href) + '">' + esc(x.text) + '</a>';
                });
            }
            if (data.clicks) {
                html += '<span class="tvp-spacer"></span><span class="tvp-clicks">' + esc(data.clicks) + '</span>';
            }
            html += '</div>';
        }

        if (replies.length) {
            const childCount = useThread ? replies.filter(function (r) { return r.parent !== null; }).length : 0;
            html += '<div class="tvp-section">回复 ' + replies.length + ' 条' +
                '<small>' + (useThread
                    ? '楼中楼 · 其中 ' + childCount + ' 条为楼中回复'
                    : '平铺模式') + '</small></div>';

            function buildNode(i, depth) {
                const r = replies[i];
                let kids = '';
                if (useThread && r.children.length && depth < MAX_DEPTH + 2) {
                    kids = r.children.map(function (c) { return buildNode(c, depth + 1); }).join('');
                }
                return itemHtml(r, kids, mode, opLower);
            }

            if (useThread) {
                const roots = replies.map(function (r, i) { return r.parent === null ? i : -1; })
                    .filter(function (i) { return i >= 0; });
                html += roots.map(function (i) { return buildNode(i, 0); }).join('');
            } else {
                html += replies.map(function (r) { return itemHtml(r, '', mode, opLower); }).join('');
            }

            if (data.paginationHTML) {
                html += '<div class="tvp-pages">回复有分页，' +
                    '<a href="javascript:;" data-tvp-orig="1">到原帖查看全部回复 ↗</a></div>';
            }
        } else {
            html += '<div class="tvp-section">回复 0 条<small>暂无回复</small></div>';
            html += '<div class="tvp-empty">还没有人回复，来抢个沙发吧～</div>';
        }

        bodyBox.innerHTML = html;
        bindAvatars(bodyBox);
        bindZoomImages();
        // 每条回复右侧搬过来的感谢/回复链接也交给弹窗内处理
        bodyBox.querySelectorAll('.tvp-cellops a').forEach(function (a) {
            a.classList.add('tvp-site-action');
        });
        bodyBox.querySelectorAll('[data-tvp-orig]').forEach(function (a) {
            a.addEventListener('click', function () { window.open(origLink.href, '_blank', 'noopener'); });
        });
        updateComposer(data);
    }

    /* ============================================================
       五、自动签到：每天进站自动领取每日登录奖励
       接口实测依据：/mission/daily 页面给出 /mission/daily/redeem?once=xxx 领取链接，
       领取后页面显示「每日登录奖励已领取」。不登录时该页会跳到 /signin。
       ============================================================ */

    function checkinState() {
        try { return JSON.parse(getPref(LS_CHECKIN, '{}')) || {}; } catch (e) { return {}; }
    }
    function saveCheckinState(st) {
        try { localStorage.setItem(LS_CHECKIN, JSON.stringify(st)); } catch (e) { /* 隐私模式忽略 */ }
    }
    function dateKey(d, utc) {
        const y = utc ? d.getUTCFullYear() : d.getFullYear();
        const m = utc ? d.getUTCMonth() + 1 : d.getMonth() + 1;
        const day = utc ? d.getUTCDate() : d.getDate();
        return (utc ? 'U:' : 'L:') + y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }
    // 本地日 + UTC 日双键：无论 V2EX 按哪个时区换日都不会漏签，每天最多检查两次
    function todayKeys() {
        const d = new Date();
        return [dateKey(d, false), dateKey(d, true)];
    }
    function checkinDue(force) {
        if (force) return true;
        const st = checkinState();
        if (st.enabled === false) return false;
        if (st.failAt && Date.now() - st.failAt < CHECKIN_FAIL_COOLDOWN) return false;
        const done = st.done || {};
        return todayKeys().some(function (k) { return !done[k]; });
    }
    function markCheckinDone(status, info) {
        const st = checkinState();
        st.done = st.done || {};
        todayKeys().forEach(function (k) { st.done[k] = true; });
        Object.keys(st.done).forEach(function (k) {
            const t = Date.parse(k.slice(2) + 'T00:00:00Z');
            if (!isFinite(t) || Date.now() - t > 30 * 86400000) delete st.done[k];
        });
        st.status = status; st.info = info || ''; st.at = Date.now(); st.failAt = 0;
        saveCheckinState(st);
        syncCheckinBtn();
    }
    function markCheckinFail(status, msg, cooldown) {
        const st = checkinState();
        st.status = status; st.info = msg || '';
        st.failAt = cooldown === false ? 0 : Date.now();   // 未登录不设冷却，登录后可立即重试
        st.at = Date.now();
        saveCheckinState(st);
        syncCheckinBtn();
    }
    function syncCheckinBtn() {
        if (!checkinBtn) return;
        const st = checkinState();
        const done = st.done || {};
        const isDone = todayKeys().every(function (k) { return !!done[k]; });
        checkinBtn.textContent = checkinRunning ? '◌ 签到中…'
            : (st.status === 'loggedout' ? '未登录' : (isDone ? '✓ 已签到' : '◎ 签到'));
        checkinBtn.classList.toggle('tvp-on', isDone);
        checkinBtn.title = '自动签到：' + (isDone ? '今日已完成' : '今日待检查') +
            (st.info ? ' · ' + st.info : '') + '（点击立即检查）';
    }

    function checkinInfoFrom(html) {
        const text = String(html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;|&#160;/gi, ' ')
            .replace(/\s+/g, ' ');
        const sm = text.match(/(?:已)?连续登录\s*(\d+)\s*天/) || text.match(/连续\s*(\d+)\s*天/);
        const cm = text.match(/(?:获得|领取|奖励|得到)\s*(\d+)\s*铜币/) || text.match(/(\d+)\s*铜币/);
        return { streak: sm ? sm[1] : '', coins: cm ? cm[1] : '' };
    }
    function describeCheckin(info) {
        const bits = [];
        if (info.streak) bits.push('连续登录 ' + info.streak + ' 天');
        if (info.coins) bits.push('+' + info.coins + ' 铜币');
        return bits.join(' · ');
    }
    function isClaimed(html) {
        return /每日登录奖励已领取|今天已经领取|已领取|fa-ok-sign/.test(html || '');
    }
    function redeemUrlFrom(html) {
        let m = html.match(/\/mission\/daily\/redeem\?once=([0-9a-zA-Z]+)/);
        if (m) return '/mission/daily/redeem?once=' + m[1];
        m = html.match(/name=["']once["'][^>]*value=["']([0-9a-zA-Z]+)["']/) ||
            html.match(/value=["']([0-9a-zA-Z]+)["'][^>]*name=["']once["']/);
        if (m) return '/mission/daily/redeem?once=' + m[1];
        m = html.match(/\bonce=([0-9a-zA-Z]{4,})/);
        return m ? '/mission/daily/redeem?once=' + m[1] : '';
    }
    async function fetchDaily() {
        const resp = await fetch('/mission/daily', { credentials: 'same-origin', cache: 'no-store' });
        return { ok: resp.ok, status: resp.status, url: resp.url || '', html: await resp.text() };
    }

    async function runCheckin(force) {
        if (checkinRunning) return { status: 'busy', message: '正在检查签到状态…', info: '' };
        if (!checkinDue(force)) {
            const st = checkinState();
            return { status: st.status || 'already', message: '今日无需重复签到', info: st.info || '' };
        }
        // 多标签页简单锁，避免同一天并发领奖请求
        const LOCK = 'tvp_checkin_lock';
        let lockAt = 0;
        try { lockAt = parseInt(localStorage.getItem(LOCK) || '0', 10) || 0; } catch (e) { /* ignore */ }
        if (!force && Date.now() - lockAt < 30000) {
            return { status: 'busy', message: '另一个标签页正在签到', info: '' };
        }
        try { localStorage.setItem(LOCK, String(Date.now())); } catch (e) { /* ignore */ }

        checkinRunning = true;
        syncCheckinBtn();
        let result;
        try {
            const daily = await fetchDaily();
            if (!daily.ok) throw new Error('每日任务页 HTTP ' + daily.status);
            const html = daily.html || '';
            if (/\/signin/.test(daily.url) || /action=["']\/signin/.test(html)) {
                result = { status: 'loggedout', message: '未登录，跳过自动签到', info: '登录后刷新页面即可自动签到' };
                markCheckinFail('loggedout', result.message, false);
            } else {
                // 只有页面出现明确的「领取」入口才构造领取链接，避免把通用 once 令牌误用
                const hasEntry = /\/mission\/daily\/redeem\?once=/.test(html) ||
                    /value=["']领取|领取每日登录奖励|领取登录奖励|领取\s*\d+\s*铜币/.test(html);
                const redeem = hasEntry ? redeemUrlFrom(html) : '';
                if (redeem && !isClaimed(html)) {
                    const resp = await fetch(redeem, { credentials: 'same-origin', cache: 'no-store' });
                    if (!resp.ok) throw new Error('领取请求 HTTP ' + resp.status);
                    const redeemHtml = await resp.text();
                    let confirmHtml = redeemHtml;
                    if (!isClaimed(redeemHtml)) {
                        try { confirmHtml = (await fetchDaily()).html || redeemHtml; } catch (e) { /* 用领取响应兜底 */ }
                    }
                    const okHtml = isClaimed(confirmHtml) ? confirmHtml
                        : (isClaimed(redeemHtml) ? redeemHtml : '');
                    if (okHtml) {
                        const info = describeCheckin(checkinInfoFrom(okHtml));
                        result = { status: 'success', message: '自动签到完成', info: info };
                        markCheckinDone('success', info);
                    } else {
                        result = { status: 'unknown', message: '已发起签到但未能确认结果', info: '点击前往每日任务页查看' };
                        markCheckinFail('unknown', result.message);
                    }
                } else if (isClaimed(html)) {
                    const info = describeCheckin(checkinInfoFrom(html));
                    result = { status: 'already', message: '今日已签到', info: info };
                    markCheckinDone('already', info);
                } else {
                    result = { status: 'unknown', message: '未识别到签到入口', info: '可能页面改版或未登录，点击查看' };
                    markCheckinFail('unknown', result.message);
                }
            }
        } catch (err) {
            result = {
                status: 'error',
                message: '自动签到失败：' + (err && err.message ? err.message : String(err)),
                info: ''
            };
            markCheckinFail('error', result.message);
        } finally {
            checkinRunning = false;
            try { localStorage.removeItem(LOCK); } catch (e) { /* ignore */ }
            syncCheckinBtn();
        }
        const kind = (result.status === 'success' || result.status === 'already') ? 'ok'
            : (result.status === 'error' ? 'err' : 'warn');
        // 自动运行时「今日已签到」不打扰；成功/异常一律提示，手动检查永远提示
        if (force || (result.status !== 'already' && result.status !== 'busy')) {
            showCheckinToast(result.message, result.info, kind);
        }
        return result;
    }
    function manualCheckin() { return runCheckin(true); }

    function showCheckinToast(main, sub, kind) {
        if (!checkinToast) {
            checkinToast = document.createElement('div');
            checkinToast.id = 'tvp-checkin-toast';
            checkinToast.innerHTML = '<span class="tvp-ct-icon"></span><div class="tvp-ct-text">' +
                '<div class="tvp-ct-main"></div><div class="tvp-ct-sub"></div></div>';
            checkinToast.addEventListener('click', function () {
                window.open(location.origin + '/mission/daily', '_blank', 'noopener');
                hideCheckinToast();
            });
            checkinToast.addEventListener('mouseenter', function () { clearTimeout(checkinToastTimer); });
            checkinToast.addEventListener('mouseleave', function () { scheduleCheckinToastHide(); });
            document.body.appendChild(checkinToast);
        }
        checkinToast.setAttribute('data-kind', kind || 'ok');
        checkinToast.querySelector('.tvp-ct-icon').textContent = kind === 'ok' ? '✓' : '!';
        checkinToast.querySelector('.tvp-ct-main').textContent = main;
        const subEl = checkinToast.querySelector('.tvp-ct-sub');
        subEl.textContent = sub || '点击查看每日任务页';
        subEl.style.display = sub ? '' : 'none';
        checkinToast.classList.remove('tvp-ct-hide');
        checkinToast.classList.add('tvp-ct-show');
        scheduleCheckinToastHide();
    }
    function scheduleCheckinToastHide() {
        clearTimeout(checkinToastTimer);
        checkinToastTimer = setTimeout(hideCheckinToast, 6000);
    }
    function hideCheckinToast() {
        clearTimeout(checkinToastTimer);
        if (!checkinToast) return;
        checkinToast.classList.add('tvp-ct-hide');
        setTimeout(function () {
            if (checkinToast) checkinToast.classList.remove('tvp-ct-show', 'tvp-ct-hide');
        }, 260);
    }

    /* ============================================================
       六、详情图片预览：点击正文/回复里的图片打开大图查看器
       ============================================================ */

    function fileNameOf(url) {
        try {
            const p = new URL(url, location.origin).pathname.split('/');
            const last = decodeURIComponent(p[p.length - 1] || '');
            return last.length > 60 ? last.slice(0, 57) + '…' : last;
        } catch (e) { return ''; }
    }
    function zoomUrl(img) {
        // 若图片被链接包着，且链接指向图片/图床，用链接当原图
        const a = img.closest ? img.closest('a[href]') : null;
        if (a) {
            const h = (a.getAttribute('href') || '').trim();
            if (h && !/^(javascript:|#)/i.test(h) &&
                (/\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(h) ||
                 /^https?:\/\/[^\/]*(?:img|pic|photo|image|cdn|upload|attach|oss|sinaimg|qpic)[^\/]*\//i.test(h) ||
                 /^https?:\/\//i.test(h) && /\/(?:img|image|photo|picture|upload|attach|file)s?\//i.test(h))) {
                return absUrl(h);
            }
        }
        const s = (img.getAttribute('data-original') || img.getAttribute('data-src') ||
                   img.getAttribute('data-lazy-src') || img.getAttribute('src') ||
                   img.currentSrc || '').trim();
        return s ? absUrl(s) : '';
    }
    function isZoomCandidate(img) {
        if (!img || !img.closest) return false;
        if (img.closest('.tvp-avatar, #tvp-lightbox, .tvp-lb-thumbs')) return false;
        if (img.getAttribute('data-tvp-nozoom') !== null) return false;
        // 懒加载图的 src 常是 /static/... 占位图，优先用真实图地址判断，避免误排除
        const s = (img.getAttribute('data-original') || img.getAttribute('data-src') ||
                   img.getAttribute('data-lazy-src') || img.getAttribute('src') || '').trim();
        if (!s || /^data:/i.test(s)) return false;
        const u = s.toLowerCase();
        if (/\/(static|assets)\//.test(u) || /emoji|smile|icon|spinner|loading|blank\.gif|avatar|1x1|pixel/i.test(u)) return false;
        const w = parseInt(img.getAttribute('width') || '', 10);
        if (w && w < 32) return false;
        if (img.naturalWidth > 0 && img.naturalWidth < 32) return false;
        return true;
    }
    function bindZoomImages() {
        lbList = [];
        if (!bodyBox) return;
        const imgs = bodyBox.querySelectorAll('.tvp-content img, .tvp-rbody img');
        Array.prototype.forEach.call(imgs, function (img) {
            if (!isZoomCandidate(img)) return;
            const src = zoomUrl(img);
            if (!src) return;
            const i = lbList.length;
            lbList.push({ src: src, name: img.getAttribute('alt') || fileNameOf(src), el: img });
            img.classList.add('tvp-zoomable');
            img.setAttribute('data-tvp-zoom', String(i));
            img.setAttribute('title', '点击查看大图');
        });
    }
    function renderThumbs() {
        if (!lbThumbs) return;
        if (lbList.length < 2) { lbThumbs.hidden = true; lbThumbs.innerHTML = ''; return; }
        lbThumbs.hidden = false;
        lbThumbs.innerHTML = lbList.map(function (it, i) {
            return '<img src="' + esc(it.src) + '" data-lb-idx="' + i + '" alt="' +
                esc(it.name) + '" loading="lazy">';
        }).join('');
        highlightThumb();
    }
    function highlightThumb() {
        if (!lbThumbs) return;
        Array.prototype.forEach.call(lbThumbs.querySelectorAll('img'), function (t) {
            const on = parseInt(t.getAttribute('data-lb-idx'), 10) === lbIndex;
            t.classList.toggle('tvp-lb-cur', on);
            if (on) lbThumbs.scrollLeft = Math.max(0,
                t.offsetLeft - lbThumbs.clientWidth / 2 + t.offsetWidth / 2);
        });
    }
    function applyZoom() {
        if (!lbImg) return;
        lbImg.style.transform = 'translate(' + lbTx + 'px,' + lbTy + 'px) scale(' + lbScale + ')';
        lbImg.style.cursor = lbScale > 1.01 ? 'grab' : 'zoom-in';
        if (lbZoomText) lbZoomText.textContent = Math.round(lbScale * 100) + '%';
    }
    function setZoom(factor) {
        lbScale = Math.max(0.2, Math.min(8, lbScale * factor));
        if (lbScale <= 1.01) { lbTx = 0; lbTy = 0; }
        applyZoom();
    }
    function resetZoom() { lbScale = 1; lbTx = 0; lbTy = 0; applyZoom(); }
    function showLightboxAt(i) {
        if (!lbList.length || !lightbox) return;
        lbIndex = ((i % lbList.length) + lbList.length) % lbList.length;
        const it = lbList[lbIndex];
        resetZoom();
        lbErr.hidden = true;
        lbImg.hidden = false;
        lbImg.alt = it.name || '';
        lbImg.src = it.src;
        lbOpenLink.href = it.src;
        const errA = lbErr.querySelector('a');
        if (errA) errA.href = it.src;
        lbCount.textContent = (lbIndex + 1) + ' / ' + lbList.length;
        lbName.textContent = it.name || '';
        const prev = lightbox.querySelector('.tvp-lb-prev');
        const next = lightbox.querySelector('.tvp-lb-next');
        if (prev) prev.hidden = lbList.length < 2;
        if (next) next.hidden = lbList.length < 2;
        highlightThumb();
    }
    function openLightbox(i) {
        if (!lbList.length || !lightbox) return;
        lightbox.classList.add('tvp-lb-open');
        lightbox.setAttribute('aria-hidden', 'false');
        renderThumbs();
        showLightboxAt(i);
    }
    function closeLightbox() {
        if (!lightbox || !lightbox.classList.contains('tvp-lb-open')) return;
        lightbox.classList.remove('tvp-lb-open');
        lightbox.setAttribute('aria-hidden', 'true');
        lbDrag = null;
    }
    function bindLightboxEvents() {
        lightbox.addEventListener('click', function (e) {
            const t = e.target.closest ? e.target.closest('[data-lb]') : null;
            if (!t) return;
            e.preventDefault();
            e.stopPropagation();
            switch (t.getAttribute('data-lb')) {
                case 'close': closeLightbox(); break;
                case 'prev': showLightboxAt(lbIndex - 1); break;
                case 'next': showLightboxAt(lbIndex + 1); break;
                case 'zoom-in': setZoom(1.25); break;
                case 'zoom-out': setZoom(1 / 1.25); break;
                case 'reset': resetZoom(); break;
            }
        });
        lbThumbs.addEventListener('click', function (e) {
            const t = e.target.closest ? e.target.closest('img[data-lb-idx]') : null;
            if (t) showLightboxAt(parseInt(t.getAttribute('data-lb-idx'), 10) || 0);
        });
        lbStage.addEventListener('click', function (e) {
            if (e.target === lbStage) closeLightbox();   // 点空白关闭
        });
        lbStage.addEventListener('wheel', function (e) {
            e.preventDefault();
            setZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
        }, { passive: false });
        lbImg.addEventListener('dblclick', function (e) {
            e.preventDefault();
            if (lbScale > 1.01) resetZoom(); else setZoom(2);
        });
        lbImg.addEventListener('error', function () {
            if (!lbList.length || lbImg.getAttribute('src') !== lbList[lbIndex].src) return;
            lbImg.hidden = true;
            lbErr.hidden = false;
        });
        lbImg.addEventListener('mousedown', function (e) {
            if (lbScale <= 1.01 || e.button !== 0) return;
            lbDrag = { x: e.clientX, y: e.clientY, tx: lbTx, ty: lbTy };
            lbImg.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!lbDrag) return;
            lbTx = lbDrag.tx + (e.clientX - lbDrag.x);
            lbTy = lbDrag.ty + (e.clientY - lbDrag.y);
            applyZoom();
        });
        document.addEventListener('mouseup', function () { lbDrag = null; applyZoom(); });
    }
    // capture 阶段优先于「Esc 关闭弹窗」：大图开着时 Esc 只关大图
    document.addEventListener('keydown', function (e) {
        if (!lightbox || !lightbox.classList.contains('tvp-lb-open')) return;
        const k = e.key;
        let handled = true;
        if (k === 'Escape') closeLightbox();
        else if (k === 'ArrowLeft') showLightboxAt(lbIndex - 1);
        else if (k === 'ArrowRight') showLightboxAt(lbIndex + 1);
        else if (k === '+' || k === '=') setZoom(1.25);
        else if (k === '-' || k === '_') setZoom(1 / 1.25);
        else if (k === '0') resetZoom();
        else handled = false;
        if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    /* ============================================================
       七、主流程 + 全局点击拦截
       ============================================================ */

    async function openTopic(topicPath) {
        ensureModal();
        const prevPath = currentPath;
        currentPath = topicPath;
        // 换帖子时清掉上一个帖子的草稿，避免误发
        if (prevPath && prevPath !== topicPath && composeInput) composeInput.value = '';
        renderLoading(topicPath);
        openModal();
        if (bodyBox) bodyBox.scrollTop = 0;

        const hit = cache.get(topicPath);
        if (hit && Date.now() - hit.time < CACHE_MS) {
            renderTopic(hit.data);
            return;
        }

        try {
            const resp = await fetch(topicPath, { credentials: 'same-origin' });
            if (resp.status === 429) {
                renderError(topicPath, '请求过于频繁，V2EX 临时限流（HTTP 429），稍后再试或直接打开原帖。');
                return;
            }
            if (!resp.ok) {
                renderError(topicPath, '获取失败（HTTP ' + resp.status + '）。');
                return;
            }
            const data = parseTopicPage(await resp.text(), topicPath);
            cache.set(topicPath, { time: Date.now(), data: data });
            renderTopic(data);
            if (getPref('tvp_debug', '') === '1') console.log('[V2EX 弹窗] 解析结果', window.__tvpDebug());
        } catch (err) {
            renderError(topicPath, '网络错误：' + err.message);
        }
    }

    /* ---------- 自检：控制台执行 __tvpDebug() 可查看解析与主题判定结果 ---------- */
    window.__tvpDebug = function () {
        const d = currentData;
        const cell = document.querySelector('.cell[id^="r_"]');
        return {
            version: '3.1.1',
            checkin: checkinState(),
            checkinRunning: checkinRunning,
            lightbox: {
                open: !!(lightbox && lightbox.classList.contains('tvp-lb-open')),
                images: lbList.length, index: lbIndex,
                urls: lbList.slice(0, 10).map(function (x) { return x.src; })
            },
            themePref: getPref(LS_THEME, 'auto'),
            appliedTheme: overlay ? overlay.getAttribute('data-theme') : null,
            siteInk: document.documentElement.getAttribute('data-tvp-site-ink'),
            readCount: readIds.size,
            cssInjected: !!document.getElementById('tvp-styles'),
            readLinksOnPage: document.querySelectorAll('a.tvp-read').length,
            pageFilter: getComputedStyle(document.documentElement).filter,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            dom: {
                replyCells: document.querySelectorAll('.cell[id^="r_"]').length,
                replyContent: document.querySelectorAll('.reply_content').length,
                topicContent: document.querySelectorAll('.topic_content').length,
                firstReplyHTML: cell ? cell.outerHTML.slice(0, 1500) : null
            },
            canReply: d ? !!d.form : false,
            lastParse: d ? {
                path: currentPath,
                topicId: d.topicId,
                opAuthor: d.opAuthor || '',
                opAvatar: d.opAvatar || '',
                avatarCount: d.replies.filter(function (r) { return !!r.avatar; }).length,
                opReplies: d.opAuthor
                    ? d.replies.filter(function (r) {
                        return r.author && r.author.toLowerCase() === d.opAuthor.toLowerCase();
                    }).length : 0,
                canReply: !!d.form,
                title: d.title,
                meta: d.meta,
                contentLen: d.contentHTML.length,
                replies: d.replies.length,
                siteActions: (d.siteActions || []).map(function (x) { return x.text + ' → ' + x.href; }),
                tags: (d.tags || []).map(function (x) { return x.text; }),
                clicks: d.clicks || '',
                sample: d.replies.slice(0, 8).map(function (r) {
                    return '#' + r.floor + ' ' + r.author + ' | ' + r.text.slice(0, 40);
                })
            } : null
        };
    };

    document.addEventListener('click', function (e) {
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        const a = e.target && e.target.closest ? e.target.closest('a[href^="/t/"]') : null;
        if (!a) return;
        if (a.classList.contains('tvp-site-action')) return;  // 站点操作链接交给弹窗内部处理
        const m = a.getAttribute('href').match(/^\/t\/(\d+)/);
        if (!m) return;
        // Ctrl/Shift 点击走浏览器默认的新标签页行为，同样同步已读状态
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
            markRead(m[1]);
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        markRead(m[1]);
        openTopic('/t/' + m[1]);
    }, true);

    /* ---------- 初始化：恢复已读标记，并给动态加载的列表补标记 ---------- */
    injectCss();        // 必须首屏就注入：已读置灰的 CSS 若等到第一次开弹窗才生效，
                        // 会出现「刷新后全亮、点一条突然把历史全刷灰」的跳变
    syncSiteInk();      // 先定深浅，再打已读标记（灰色配色靠 html[data-tvp-site-ink] 选）
    syncReadLinks(document);
    if ('MutationObserver' in window) {
        new MutationObserver(function (records) {
            records.forEach(function (rec) {
                Array.prototype.forEach.call(rec.addedNodes, function (n) {
                    if (n.nodeType === 1) syncReadLinks(n);
                });
            });
        }).observe(document.body, { childList: true, subtree: true });
    }
    window.__tvpClearRead = clearRead;  // 控制台执行可清除全部已读标记

    /* ---------- 自动签到：控制台接口 + 延迟启动 ---------- */
    window.__tvpCheckin = manualCheckin;                 // 立即检查（强制，忽略今日去重）
    window.__tvpCheckinReset = function () {            // 清空状态，下次刷新会重新检查
        try { localStorage.removeItem(LS_CHECKIN); localStorage.removeItem('tvp_checkin_lock'); } catch (e) { /* ignore */ }
        syncCheckinBtn();
        return '签到状态已清空，刷新页面或执行 __tvpCheckin() 可重新检查';
    };
    window.__tvpCheckinToggle = function () {           // 关闭 / 开启自动签到
        const st = checkinState();
        st.enabled = st.enabled === false;
        saveCheckinState(st);
        return '自动签到已' + (st.enabled ? '开启' : '关闭') + '（手动检查仍可用）';
    };
    if (!/^\/(signin|signup|forgot|reset)/.test(location.pathname)) {
        setTimeout(function () { runCheckin(false); }, CHECKIN_DELAY);
    }
    // 装没装对，看控制台有没有这一行即可；Tampermonkey 列表里版本号应为 3.1.1
    console.info(
        '%c[V2EX 弹窗] v3.1.1 已加载',
        'color:#4a9eff;font-weight:bold',
        '点击帖子弹窗预览 · __tvpDebug() 自检 · __tvpCheckin() 立即签到'
    );
})();
