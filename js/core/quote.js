/* ============================================================
   core/quote.js — 行情/收益计算（纯函数）
   规则集中在这里，列表、总览、详情抽屉共用同一套口径。
   ============================================================ */
(function (BT) {
    'use strict';

    var isNum = BT.util.isNum;

    /** 一条行情记录是否可用（必须有正的价格） */
    function isValidPrice(record) {
        return !!record && isNum(record.price) && Number(record.price) > 0;
    }

    /** 单日涨跌幅：优先用已记录的 change，缺失时用 price/prevClose 现算 */
    function dailyChange(record) {
        if (!isValidPrice(record)) return null;
        if (isNum(record.change)) return Number(record.change);
        if (isNum(record.prevClose) && Number(record.prevClose) > 0) {
            return (Number(record.price) / Number(record.prevClose) - 1) * 100;
        }
        return null;
    }

    /**
     * 汇总一只标的的收益指标。
     * - cumulative 以「首个有效价格」为基准
     * - today 只读最后一个槽位，绝不拿前一日涨跌幅冒充今日
     * - daysTracked = 槽位数 - 1（推荐日算 D0）
     */
    function returnsOf(stock) {
        var track = Array.isArray(stock && stock.track) ? stock.track : [];
        var valid = track.filter(isValidPrice);

        if (!valid.length) {
            return {
                track: track,
                validTrack: [],
                validCount: 0,
                daysTracked: Math.max(0, track.length - 1),
                today: null,
                cumulative: null
            };
        }

        var first = track[0];
        var latestValid = valid[valid.length - 1];
        var cumulative = isValidPrice(first)
            ? (Number(latestValid.price) / Number(first.price) - 1) * 100
            : null;
        var latestSlot = track[track.length - 1];

        return {
            track: track,
            validTrack: valid,
            validCount: valid.length,
            daysTracked: Math.max(0, track.length - 1),
            today: dailyChange(latestSlot),
            cumulative: cumulative
        };
    }

    /** 涨跌 → 文本颜色类名 */
    function trendClass(value) {
        if (!isNum(value)) return 'neutral';
        var n = Number(value);
        return n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'neutral';
    }

    BT.quote = {
        isValidPrice: isValidPrice,
        dailyChange: dailyChange,
        returnsOf: returnsOf,
        trendClass: trendClass
    };
})(window.BT);
