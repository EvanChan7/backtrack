/* ============================================================
   core/utils.js — 纯函数工具 + Toast
   不含任何业务状态，可被任意模块调用。
   ============================================================ */
window.BT = window.BT || {};

(function (BT) {
    'use strict';

    var ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    /** HTML 转义：所有拼接进 innerHTML 的用户数据都必须先过这里 */
    function escapeHTML(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/[&<>"']/g, function (ch) { return ESCAPE_MAP[ch]; });
    }

    function el(id) { return document.getElementById(id); }

    function pad2(n) { return String(n).padStart(2, '0'); }

    function toISO(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function todayISO() { return toISO(new Date()); }

    /** 严格校验 YYYY-MM-DD，且必须是真实存在的日期（拒绝 2023-02-30） */
    function isValidISODate(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        var parts = value.split('-').map(Number);
        var d = new Date(parts[0], parts[1] - 1, parts[2]);
        return d.getFullYear() === parts[0] && d.getMonth() === parts[1] - 1 && d.getDate() === parts[2];
    }

    function parseISO(value) {
        var parts = String(value).split('-').map(Number);
        return new Date(parts[0], parts[1] - 1, parts[2]);
    }

    var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
    function weekdayLabel(value) { return WEEKDAYS[parseISO(value).getDay()]; }

    /** 是否为有效数值（null / 空串 / NaN 一律视为缺失） */
    function isNum(value) {
        return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
    }

    /** 百分比展示：+1.23% / -0.85% / 缺失时返回 — */
    /* 无数据占位：用短横线，不用长破折号 —— 长破折号在数字列里宽度接近一个
       完整数字，会被误读成「一根横条」而不是「这里没有数据」。 */
    var NO_DATA = '-';

    function formatPercent(value) {
        if (!isNum(value)) return NO_DATA;
        var n = Number(value);
        return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
    }

    function makeId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

    /* ---------------- Toast ---------------- */
    var toastTimer = null;

    /* toast 默认贴在悬浮按钮上方；底部面板打开时那里正好是选项区，
       所以改成浮在面板上方，既看得到提示又不挡操作。
       用 offsetHeight 而不是 getBoundingClientRect：
       面板此刻可能还在 translateY 进场动画中，rect 会落在屏幕外。 */
    function placeToast(host) {
        /* 用 ":not([hidden])" 而不是 ".active"：open() 里 active 是在下一帧才加的，
           这里若是按 active 找会漏掉；hidden 在打开时就已去掉。 */
        var panel = document.querySelector('#actionSheet:not([hidden]) .sheet-panel')
            || document.querySelector('#datePicker:not([hidden]) .picker-sheet');
        if (panel) {
            host.style.top = 'auto';
            host.style.bottom = Math.max(24, panel.offsetHeight + 20) + 'px';
        } else {
            host.style.top = '';
            host.style.bottom = '';
        }
    }

    /** 面板晚于 toast 打开时（例如先弹出提示、紧接着弹面板）重新定位 */
    function repositionToast() {
        var host = el('toastHost');
        if (host && host.firstChild) placeToast(host);
    }

    function showToast(message) {
        var host = el('toastHost');
        if (!host) {
            host = document.createElement('div');
            host.id = 'toastHost';
            host.className = 'toast-host';
            document.body.appendChild(host);
        }
        placeToast(host);
        host.innerHTML = '<div class="toast-message" role="status">' + escapeHTML(message) + '</div>';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { host.innerHTML = ''; }, 2400);
    }

    BT.util = {
        escapeHTML: escapeHTML,
        el: el,
        pad2: pad2,
        toISO: toISO,
        todayISO: todayISO,
        isValidISODate: isValidISODate,
        parseISO: parseISO,
        weekdayLabel: weekdayLabel,
        isNum: isNum,
        formatPercent: formatPercent,
        NO_DATA: NO_DATA,
        makeId: makeId,
        showToast: showToast,
        repositionToast: repositionToast
    };
})(window.BT);
