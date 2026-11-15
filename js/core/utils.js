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
    function formatPercent(value) {
        if (!isNum(value)) return '—';
        var n = Number(value);
        return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
    }

    function makeId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

    /* ---------------- Toast ---------------- */
    var toastTimer = null;
    function showToast(message) {
        var host = el('toastHost');
        if (!host) {
            host = document.createElement('div');
            host.id = 'toastHost';
            host.className = 'toast-host';
            document.body.appendChild(host);
        }
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
        makeId: makeId,
        showToast: showToast
    };
})(window.BT);
