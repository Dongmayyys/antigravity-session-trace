/**
 * Token Usage Dashboard — Webview panel with pure SVG/CSS charts.
 *
 * Displays aggregated token consumption data across all conversations:
 *   - Summary cards (total tokens, API calls, avg per call, cache rate)
 *   - Bar chart: daily token usage over the last 14 days
 *   - Donut chart: model distribution
 *
 * All charts are rendered with inline SVG — zero external dependencies.
 * Theme integration via --vscode-* CSS variables.
 */

import * as vscode from 'vscode';

// ====================== Types ======================

export interface DashboardData {
    totalInput: number;
    totalOutput: number;
    totalCache: number;
    totalCalls: number;
    conversationCount: number;
    dailyUsage: { date: string; input: number; output: number; calls: number }[];
    modelDistribution: { model: string; calls: number; tokens: number }[];
    avgTTFT: number;
    avgStreamDuration: number;
}

// ====================== Data Aggregation ======================

/**
 * Aggregate raw generator metadata from all conversations into dashboard-ready data.
 *
 * Each conversation contributes an array of metadata items (one per LLM API call).
 * Token counts arrive as strings (protobuf serialization) and must be parsed.
 */
export function aggregateTokenData(allMetadata: any[][]): DashboardData {
    let totalInput = 0, totalOutput = 0, totalCache = 0, totalCalls = 0;
    let ttftSum = 0, streamSum = 0, perfCount = 0;

    const daily = new Map<string, { input: number; output: number; calls: number }>();
    const models = new Map<string, { calls: number; tokens: number }>();

    for (const items of allMetadata) {
        for (const item of items) {
            const usage = item.chatModel?.usage;
            if (!usage) { continue; }

            const input = parseInt(usage.inputTokens || '0', 10);
            const output = parseInt(usage.outputTokens || '0', 10);
            const cache = parseInt(usage.cacheReadTokens || '0', 10);

            totalInput += input;
            totalOutput += output;
            totalCache += cache;
            totalCalls++;

            // Daily aggregation
            const createdAt = item.chatModel?.chatStartMetadata?.createdAt;
            if (createdAt) {
                const day = createdAt.substring(0, 10);
                const d = daily.get(day) || { input: 0, output: 0, calls: 0 };
                d.input += input;
                d.output += output;
                d.calls++;
                daily.set(day, d);
            }

            // Model distribution
            const model = usage.model || 'Unknown';
            const m = models.get(model) || { calls: 0, tokens: 0 };
            m.calls++;
            m.tokens += input + output;
            models.set(model, m);

            // Performance metrics
            const ttftStr = item.chatModel?.timeToFirstToken;
            const streamStr = item.chatModel?.streamingDuration;
            if (ttftStr) {
                const v = parseFloat(ttftStr);
                if (!isNaN(v)) { ttftSum += v; perfCount++; }
            }
            if (streamStr) {
                const v = parseFloat(streamStr);
                if (!isNaN(v)) { streamSum += v; }
            }
        }
    }

    // Build daily array: last 14 days, fill gaps with zero
    const dailyArray: DashboardData['dailyUsage'] = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().substring(0, 10);
        const data = daily.get(key) || { input: 0, output: 0, calls: 0 };
        dailyArray.push({ date: key, ...data });
    }

    const modelArray = [...models.entries()]
        .map(([model, data]) => ({ model, ...data }))
        .sort((a, b) => b.tokens - a.tokens);

    return {
        totalInput, totalOutput, totalCache, totalCalls,
        conversationCount: allMetadata.length,
        dailyUsage: dailyArray,
        modelDistribution: modelArray,
        avgTTFT: perfCount > 0 ? ttftSum / perfCount : 0,
        avgStreamDuration: perfCount > 0 ? streamSum / perfCount : 0,
    };
}

// ====================== Webview Panel ======================

export class TokenDashboard {
    private static instance: TokenDashboard | undefined;
    private panel: vscode.WebviewPanel;

    private constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;
        panel.onDidDispose(() => { TokenDashboard.instance = undefined; });
    }

    /** Create or reveal the dashboard panel. Returns the instance for sending data. */
    static create(): TokenDashboard {
        if (TokenDashboard.instance) {
            TokenDashboard.instance.panel.reveal();
            return TokenDashboard.instance;
        }

        const panel = vscode.window.createWebviewPanel(
            'convManager.tokenDashboard',
            'Token Usage Dashboard',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        panel.webview.html = getHtml();
        const instance = new TokenDashboard(panel);
        TokenDashboard.instance = instance;
        return instance;
    }

    /** Update loading progress. */
    sendProgress(current: number, total: number): void {
        this.panel.webview.postMessage({ type: 'progress', current, total });
    }

    /** Send aggregated data to render charts. */
    sendData(data: DashboardData): void {
        this.panel.webview.postMessage({ type: 'data', data });
    }
}

// ====================== HTML Generation ======================

function getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Token Usage Dashboard</title>
<style>
/* ====================== Base ====================== */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 24px;
    line-height: 1.5;
}

/* ====================== Loading ====================== */
#loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 300px;
    gap: 16px;
}

.loading-spinner {
    width: 40px; height: 40px;
    border: 3px solid var(--vscode-editorWidget-border, #333);
    border-top: 3px solid var(--vscode-progressBar-background, #0078d4);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.loading-bar-container {
    width: 260px; height: 4px;
    background: var(--vscode-editorWidget-border, #333);
    border-radius: 2px;
    overflow: hidden;
}

.loading-bar {
    height: 100%; width: 0;
    background: var(--vscode-progressBar-background, #0078d4);
    border-radius: 2px;
    transition: width 0.3s ease-out;
}

.loading-text {
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
}

/* ====================== Dashboard ====================== */
#dashboard { display: none; }

.dash-header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 24px;
}

.dash-header h1 {
    font-size: 20px;
    font-weight: 600;
}

.dash-header .subtitle {
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
}

/* ====================== Cards ====================== */
.cards {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin-bottom: 28px;
}

.card {
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 10px;
    padding: 18px;
    text-align: center;
    animation: fadeInUp 0.5s ease-out both;
}

.card:nth-child(2) { animation-delay: 0.08s; }
.card:nth-child(3) { animation-delay: 0.16s; }
.card:nth-child(4) { animation-delay: 0.24s; }

@keyframes fadeInUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
}

.card-icon {
    font-size: 22px;
    margin-bottom: 6px;
    opacity: 0.8;
}

.card-value {
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.5px;
}

.card-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
}

.card-sub {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 6px;
    opacity: 0.7;
}

/* Color accents via top border */
.card--tokens  { border-top: 3px solid var(--vscode-charts-blue, #3794ff); }
.card--calls   { border-top: 3px solid var(--vscode-charts-green, #89d185); }
.card--avg     { border-top: 3px solid var(--vscode-charts-yellow, #cca700); }
.card--cache   { border-top: 3px solid var(--vscode-charts-purple, #b180d7); }

/* ====================== Charts Grid ====================== */
.charts {
    display: grid;
    grid-template-columns: 5fr 3fr;
    gap: 18px;
    margin-bottom: 24px;
}

.chart-panel {
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 10px;
    padding: 20px;
    animation: fadeInUp 0.5s ease-out 0.3s both;
}

.chart-panel h2 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 16px;
}

/* ====================== Bar Chart ====================== */
#bar-chart-svg {
    width: 100%;
    overflow: visible;
}

.bar-rect {
    transition: height 0.5s ease-out, y 0.5s ease-out;
}

.bar-rect:hover { opacity: 1 !important; }

/* ====================== Donut Chart ====================== */
.donut-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
}

#donut-svg {
    width: 180px;
    height: 180px;
}

.donut-segment {
    transition: stroke-dashoffset 0.8s ease-out, stroke-dasharray 0.8s ease-out;
}

.legend {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
}

.legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
}

.legend-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
}

.legend-label { flex: 1; }

.legend-value {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}

/* ====================== Performance ====================== */
.perf-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
}

.perf-card {
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 10px;
    padding: 16px;
    text-align: center;
    animation: fadeInUp 0.5s ease-out 0.5s both;
}

.perf-value {
    font-size: 22px;
    font-weight: 600;
    color: var(--vscode-charts-blue, #3794ff);
}

.perf-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
}
</style>
</head>
<body>

<!-- Loading state -->
<div id="loading">
    <div class="loading-spinner"></div>
    <div class="loading-bar-container">
        <div class="loading-bar" id="loading-bar"></div>
    </div>
    <div class="loading-text" id="loading-text">Preparing dashboard…</div>
</div>

<!-- Dashboard -->
<div id="dashboard">
    <div class="dash-header">
        <h1>Token Usage Dashboard</h1>
        <span class="subtitle" id="subtitle"></span>
    </div>

    <div class="cards">
        <div class="card card--tokens">
            <div class="card-icon">📊</div>
            <div class="card-value" id="v-total">—</div>
            <div class="card-label">Total Tokens</div>
            <div class="card-sub" id="v-total-sub"></div>
        </div>
        <div class="card card--calls">
            <div class="card-icon">⚡</div>
            <div class="card-value" id="v-calls">—</div>
            <div class="card-label">API Calls</div>
            <div class="card-sub" id="v-calls-sub"></div>
        </div>
        <div class="card card--avg">
            <div class="card-icon">📈</div>
            <div class="card-value" id="v-avg">—</div>
            <div class="card-label">Avg / Call</div>
            <div class="card-sub" id="v-avg-sub"></div>
        </div>
        <div class="card card--cache">
            <div class="card-icon">💾</div>
            <div class="card-value" id="v-cache">—</div>
            <div class="card-label">Cache Read</div>
            <div class="card-sub" id="v-cache-sub"></div>
        </div>
    </div>

    <div class="charts">
        <div class="chart-panel">
            <h2>Daily Token Usage (last 14 days)</h2>
            <svg id="bar-chart-svg" viewBox="0 0 600 280"></svg>
        </div>
        <div class="chart-panel">
            <h2>Model Distribution</h2>
            <div class="donut-container">
                <svg id="donut-svg" viewBox="0 0 200 200"></svg>
                <div class="legend" id="donut-legend"></div>
            </div>
        </div>
    </div>

    <div class="perf-row">
        <div class="perf-card">
            <div class="perf-value" id="v-ttft">—</div>
            <div class="perf-label">Avg Time to First Token</div>
        </div>
        <div class="perf-card">
            <div class="perf-value" id="v-stream">—</div>
            <div class="perf-label">Avg Streaming Duration</div>
        </div>
        <div class="perf-card">
            <div class="perf-value" id="v-convs">—</div>
            <div class="perf-label">Conversations Analyzed</div>
        </div>
    </div>
</div>

<script>
(function() {
    const vscode = acquireVsCodeApi();

    const CHART_COLORS = [
        'var(--vscode-charts-blue, #3794ff)',
        'var(--vscode-charts-green, #89d185)',
        'var(--vscode-charts-yellow, #cca700)',
        'var(--vscode-charts-red, #f14c4c)',
        'var(--vscode-charts-purple, #b180d7)',
        'var(--vscode-charts-orange, #d18616)',
    ];

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'progress') {
            updateProgress(msg.current, msg.total);
        } else if (msg.type === 'data') {
            renderDashboard(msg.data);
        }
    });

    function updateProgress(current, total) {
        const pct = total > 0 ? (current / total) * 100 : 0;
        document.getElementById('loading-bar').style.width = pct + '%';
        document.getElementById('loading-text').textContent =
            'Loading ' + current + '/' + total + ' conversations…';
    }

    // ==================== Format Helpers ====================

    function fmt(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n.toString();
    }

    function fmtTime(seconds) {
        if (seconds < 1) return (seconds * 1000).toFixed(0) + 'ms';
        return seconds.toFixed(1) + 's';
    }

    function shortModelName(raw) {
        // "MODEL_PLACEHOLDER_M26" → "M26"
        const m = raw.match(/M\d+$/);
        return m ? m[0] : raw.replace(/^MODEL_PLACEHOLDER_/, '').substring(0, 8);
    }

    // ==================== Render Dashboard ====================

    function renderDashboard(data) {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';

        const total = data.totalInput + data.totalOutput;
        const avg = data.totalCalls > 0 ? Math.round(total / data.totalCalls) : 0;

        // Summary cards
        document.getElementById('v-total').textContent = fmt(total);
        document.getElementById('v-total-sub').textContent =
            'in: ' + fmt(data.totalInput) + ' · out: ' + fmt(data.totalOutput);

        document.getElementById('v-calls').textContent = data.totalCalls.toLocaleString();
        document.getElementById('v-calls-sub').textContent =
            data.conversationCount + ' conversations';

        document.getElementById('v-avg').textContent = fmt(avg);
        document.getElementById('v-avg-sub').textContent =
            'in: ' + fmt(Math.round(data.totalInput / Math.max(data.totalCalls, 1))) +
            ' · out: ' + fmt(Math.round(data.totalOutput / Math.max(data.totalCalls, 1)));

        document.getElementById('v-cache').textContent = fmt(data.totalCache);
        const cacheRate = (data.totalInput + data.totalCache) > 0
            ? Math.round((data.totalCache / (data.totalInput + data.totalCache)) * 100) : 0;
        document.getElementById('v-cache-sub').textContent = cacheRate + '% cache hit rate';

        document.getElementById('subtitle').textContent =
            data.conversationCount + ' conversations · ' + fmt(total) + ' tokens total';

        // Performance
        document.getElementById('v-ttft').textContent = fmtTime(data.avgTTFT);
        document.getElementById('v-stream').textContent = fmtTime(data.avgStreamDuration);
        document.getElementById('v-convs').textContent = data.conversationCount.toString();

        // Charts (with slight delay for animation)
        setTimeout(function() { renderBarChart(data.dailyUsage); }, 100);
        setTimeout(function() { renderDonutChart(data.modelDistribution); }, 200);
    }

    // ==================== Bar Chart ====================

    function renderBarChart(dailyUsage) {
        var svg = document.getElementById('bar-chart-svg');
        svg.innerHTML = '';

        if (!dailyUsage || dailyUsage.length === 0) {
            svg.innerHTML = '<text x="300" y="140" text-anchor="middle" ' +
                'fill="var(--vscode-descriptionForeground)" font-size="13">No data</text>';
            return;
        }

        var padL = 55, padR = 10, padT = 10, padB = 24;
        var chartW = 600 - padL - padR;
        var chartH = 280 - padT - padB;

        var maxVal = Math.max(1, ...dailyUsage.map(function(d) { return d.input + d.output; }));

        var barW = Math.min(32, (chartW / dailyUsage.length) - 6);
        var gap = (chartW - barW * dailyUsage.length) / (dailyUsage.length + 1);

        // Grid lines + Y labels
        for (var i = 0; i <= 4; i++) {
            var yVal = (i / 4) * maxVal;
            var y = padT + chartH - (i / 4) * chartH;
            svg.innerHTML += '<line x1="' + padL + '" y1="' + y + '" x2="' + (600 - padR) +
                '" y2="' + y + '" stroke="var(--vscode-editorWidget-border, #333)" ' +
                'stroke-dasharray="3" opacity="0.5"/>';
            svg.innerHTML += '<text x="' + (padL - 6) + '" y="' + (y + 3) +
                '" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="10">' +
                fmt(Math.round(yVal)) + '</text>';
        }

        // Single bar per day (start at height 0, animate via JS)
        var barsHtml = '';
        dailyUsage.forEach(function(d, idx) {
            var x = padL + gap + idx * (barW + gap);
            var total = d.input + d.output;
            var totalH = maxVal > 0 ? (total / maxVal) * chartH : 0;
            var baseY = padT + chartH;

            // Tooltip: single-line with separator (avoids template literal escape issues)
            var tip = fmt(total) + ' tokens  |  in: ' + fmt(d.input) +
                '  out: ' + fmt(d.output) + '  |  ' + d.calls + ' calls';

            barsHtml += '<rect class="bar-rect" x="' + x + '" y="' + baseY +
                '" width="' + barW + '" height="0" rx="3" opacity="0.8" ' +
                'fill="var(--vscode-charts-blue, #3794ff)" ' +
                'data-target-h="' + totalH + '" ' +
                'data-delay="' + (idx * 40) + '">' +
                '<title>' + tip + '</title></rect>';

            // Date label
            var dt = new Date(d.date);
            var label = (dt.getMonth() + 1) + '/' + dt.getDate();
            barsHtml += '<text x="' + (x + barW / 2) + '" y="' + (padT + chartH + 14) +
                '" text-anchor="middle" fill="var(--vscode-descriptionForeground)" font-size="9">' +
                label + '</text>';
        });

        svg.innerHTML += barsHtml;

        // Animate bars growing from bottom
        setTimeout(function() {
            var bars = svg.querySelectorAll('.bar-rect');
            bars.forEach(function(bar) {
                var delay = parseInt(bar.getAttribute('data-delay') || '0');
                var targetH = parseFloat(bar.getAttribute('data-target-h') || '0');
                var baseY = parseFloat(bar.getAttribute('y'));

                setTimeout(function() {
                    bar.setAttribute('height', String(targetH));
                    bar.setAttribute('y', String(baseY - targetH));
                }, delay);
            });
        }, 50);
    }

    // ==================== Donut Chart ====================

    function renderDonutChart(modelData) {
        var svg = document.getElementById('donut-svg');
        var legend = document.getElementById('donut-legend');

        if (!modelData || modelData.length === 0) {
            svg.innerHTML = '<text x="100" y="100" text-anchor="middle" ' +
                'fill="var(--vscode-descriptionForeground)" font-size="13">No data</text>';
            return;
        }

        var totalTokens = modelData.reduce(function(sum, m) { return sum + m.tokens; }, 0);
        var r = 70;
        var circumference = 2 * Math.PI * r;
        var offset = 0;
        var svgContent = '';

        modelData.forEach(function(m, i) {
            var pct = totalTokens > 0 ? m.tokens / totalTokens : 0;
            var dashLen = pct * circumference;
            var color = CHART_COLORS[i % CHART_COLORS.length];

            // Start with dasharray=0 and animate
            svgContent += '<circle class="donut-segment" cx="100" cy="100" r="' + r +
                '" fill="none" stroke="' + color + '" stroke-width="24" ' +
                'stroke-dasharray="0 ' + circumference + '" ' +
                'stroke-dashoffset="' + (-offset) + '" ' +
                'transform="rotate(-90 100 100)" ' +
                'data-target-dash="' + dashLen + ' ' + circumference + '" ' +
                'data-delay="' + (i * 150) + '">' +
                '<title>' + shortModelName(m.model) + ': ' + (pct * 100).toFixed(1) + '%</title>' +
                '</circle>';

            offset += dashLen;
        });

        // Center text
        svgContent += '<text x="100" y="96" text-anchor="middle" ' +
            'fill="var(--vscode-foreground)" font-size="18" font-weight="700">' +
            fmt(totalTokens) + '</text>';
        svgContent += '<text x="100" y="114" text-anchor="middle" ' +
            'fill="var(--vscode-descriptionForeground)" font-size="10">total</text>';

        svg.innerHTML = svgContent;

        // Legend
        var legendHtml = '';
        modelData.forEach(function(m, i) {
            var pct = totalTokens > 0 ? (m.tokens / totalTokens * 100).toFixed(1) : '0';
            var color = CHART_COLORS[i % CHART_COLORS.length];
            legendHtml += '<div class="legend-item">' +
                '<span class="legend-dot" style="background:' + color + '"></span>' +
                '<span class="legend-label">' + shortModelName(m.model) + '</span>' +
                '<span class="legend-value">' + pct + '% · ' + fmt(m.tokens) + '</span>' +
                '</div>';
        });
        legend.innerHTML = legendHtml;

        // Animate donut segments
        setTimeout(function() {
            var segments = svg.querySelectorAll('.donut-segment');
            segments.forEach(function(seg) {
                var delay = parseInt(seg.getAttribute('data-delay') || '0');
                var targetDash = seg.getAttribute('data-target-dash');
                setTimeout(function() {
                    seg.setAttribute('stroke-dasharray', targetDash);
                }, delay);
            });
        }, 100);
    }
})();
</script>
</body>
</html>`;
}
