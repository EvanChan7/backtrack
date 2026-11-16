/* ============================================================
   ui/sparkline.js — 列表迷你走势图
   设计约定：
     · 首个打点永远贴在左边缘，末个贴右边缘 —— 绝不悬在中间
     · 有数据的日子按真实间隔排布，缺数据的交易日自然留白
     · 断档处分段，绝不跨越缺失交易日连线
     · 无发光/模糊滤镜，只有纯净线条 + 渐变面 + 一条 0% 基准线
   ============================================================ */
(function (BT) {
    'use strict';

    var isNum = BT.util.isNum;

    var MAX_SLOTS = 30;
    var VIEW_W = 150;
    var VIEW_H = 48;
    var TOP = 6;
    var BOTTOM = 42;

    /**
     * @param {Array} track   行情轨道
     * @param {String} stockId 用于生成唯一的渐变 id
     * @returns {String} SVG 字符串，无有效数据时返回空串
     */
    function render(track, stockId) {
        if (!Array.isArray(track) || !track.length) return '';

        var visible = track.slice(-MAX_SLOTS);

        var validPoints = [];
        visible.forEach(function (item, index) {
            var price = Number(item && item.price);
            if (Number.isFinite(price) && price > 0) {
                validPoints.push({ index: index, price: price });
            }
        });
        if (!validPoints.length) return '';

        /* 横向映射：首点贴左、末点贴右。
           之前按「固定槽位」算，数据只有 1～2 天时点会落在中间，
           看起来像是曲线从半腰开始 —— 现在无论如何都从左边缘起步。
           保留 PAD 是为了让端点圆点不被裁掉一半。 */
        var PAD = 4;
        var span = VIEW_W - PAD * 2;
        var lastIndex = Math.max(1, visible.length - 1);
        var basePrice = validPoints[0].price;
        var returns = validPoints.map(function (p) { return (p.price / basePrice - 1) * 100; });

        // 纵轴按 5% 取整，避免小波动被放大成剧烈波动
        var maxAbs = returns.reduce(function (m, v) { return Math.max(m, Math.abs(v)); }, 0);
        var yScale = Math.max(5, Math.ceil(maxAbs / 5) * 5);

        var midY = (TOP + BOTTOM) / 2;
        var halfHeight = (BOTTOM - TOP) / 2;

        var points = validPoints.map(function (p, i) {
            return {
                index: p.index,
                x: PAD + (p.index / lastIndex) * span,
                y: midY - (returns[i] / yScale) * halfHeight
            };
        });

        // 按 index 连续性分段
        var segments = [];
        points.forEach(function (pt) {
            var current = segments[segments.length - 1];
            var last = current && current[current.length - 1];
            if (!last || pt.index !== last.index + 1) segments.push([pt]);
            else current.push(pt);
        });

        var delta = validPoints[validPoints.length - 1].price - basePrice;
        var color = delta > 0 ? '#FF453A' : delta < 0 ? '#30D158' : '#98989D';

        var safeId = String(stockId).replace(/[^a-zA-Z0-9_-]/g, '_');
        var gradientId = 'spark-fill-' + safeId;

        var body = segments.map(function (segment) {
            var linePath = segment.map(function (pt, i) {
                return (i ? 'L' : 'M') + ' ' + pt.x.toFixed(2) + ' ' + pt.y.toFixed(2);
            }).join(' ');

            var first = segment[0];
            var last = segment[segment.length - 1];
            var isLine = segment.length > 1;
            var areaPath = isLine
                ? linePath + ' L ' + last.x.toFixed(2) + ' ' + BOTTOM + ' L ' + first.x.toFixed(2) + ' ' + BOTTOM + ' Z'
                : '';

            /* 端点圆点：用「零长度线段 + 圆头」画，配合 non-scaling-stroke，
               无论横向怎么拉伸都是正圆（用 <circle> 会被拉成椭圆）。 */
            function dot(width, stroke) {
                return '<path d="M ' + last.x.toFixed(2) + ' ' + last.y.toFixed(2) + ' l .01 0"'
                    + ' fill="none" stroke="' + stroke + '" stroke-width="' + width + '"'
                    + ' stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
            }

            return (areaPath ? '<path d="' + areaPath + '" fill="url(#' + gradientId + ')"/>' : '')
                + (isLine
                    ? '<path d="' + linePath + '" fill="none" stroke="' + color + '" stroke-width="1.8"'
                        + ' stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'
                    : '')
                + dot(isLine ? 7 : 6, '#1C1C1E')
                + dot(isLine ? 5 : 4.4, color);
        }).join('');

        var aria = (delta > 0 ? '阶段上行' : delta < 0 ? '阶段下行' : '阶段横盘')
            + '趋势，已记录 ' + validPoints.length + ' 个交易日，最多显示最近 30 日';

        return '<svg class="mini-chart" viewBox="0 0 ' + VIEW_W + ' ' + VIEW_H + '"'
            + ' preserveAspectRatio="none" role="img" aria-label="' + aria + '">'
            + '<defs>'
            + '<linearGradient id="' + gradientId + '" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.24"/>'
            + '<stop offset="70%" stop-color="' + color + '" stop-opacity="0.07"/>'
            + '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.01"/>'
            + '</linearGradient>'
            + '</defs>'
            /* 0% 基准线：让还没走到的右侧区域仍然是「图表」，而不是一块空白 */
            + '<path d="M 0 ' + midY + ' L ' + VIEW_W + ' ' + midY + '" fill="none"'
            + ' stroke="rgba(255,255,255,.07)" stroke-width="1" vector-effect="non-scaling-stroke"/>'
            + body
            + '</svg>';
    }

    BT.sparkline = { render: render };
})(window.BT);
