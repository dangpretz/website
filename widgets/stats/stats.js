export default async function decorate(widget) {
  const url = new URL(window.location);
  const view = url.searchParams.get('view');

  const formatDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const fetchStats = async (date) => {
    const response = await fetch(`https://toast-report.david8603.workers.dev/?date=${date}`);
    if (response.status === 200) {
      const data = await response.json();
      return data;
    }
    widget.querySelector('.stats-status').textContent = 'Credentials expired, update for latest data';
    return {
      stats: {
        pretzels: {},
        items: {},
        categories: {},
      },
      data: [],
    };
  };

  const computeLegendAndMax = (timeSeries) => {
    const allPretzels = [];
    let maxTotal = 0;
    Object.entries(timeSeries).forEach(([, data]) => {
      let total = 0;
      Object.keys(data.stats.pretzels).forEach((pretzel) => {
        total += data.stats.pretzels[pretzel];
        if (!allPretzels.includes(pretzel)) allPretzels.push(pretzel);
        if (total > maxTotal) maxTotal = total;
      });
      allPretzels.sort();
    });
    return { allPretzels, maxTotal };
  };

  const getPeriodSlug = () => {
    const range = widget.querySelector('input[name="stats-range"]:checked')?.value;
    if (range === 'week') return 'week';
    if (range === 'month') {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    if (range === 'pick') {
      const month = widget.querySelector('.stats-month')?.value;
      const year = widget.querySelector('.stats-year')?.value;
      if (month != null && year != null) {
        return `${year}-${String(Number(month) + 1).padStart(2, '0')}`;
      }
    }
    return 'stats';
  };

  const pushRangeState = () => {
    const slug = getPeriodSlug();
    if (slug === 'stats') return;
    const u = new URL(window.location);
    u.searchParams.set('range', slug);
    history.pushState({}, '', u.pathname + u.search);
  };

  const applyRangeFromParam = (param) => {
    if (!param) return false;
    if (param === 'week') {
      widget.querySelector('input[name="stats-range"][value="week"]').checked = true;
      return true;
    }
    if (param === 'month') {
      widget.querySelector('input[name="stats-range"][value="month"]').checked = true;
      return true;
    }
    const match = /^(\d{4})-(\d{2})$/.exec(param);
    if (match) {
      const [, year, month] = match;
      const monthNum = parseInt(month, 10) - 1;
      const yearNum = parseInt(year, 10);
      widget.querySelector('input[name="stats-range"][value="pick"]').checked = true;
      const monthSelect = widget.querySelector('.stats-month');
      const yearSelect = widget.querySelector('.stats-year');
      if (monthSelect && yearSelect) {
        monthSelect.value = String(monthNum);
        yearSelect.value = String(yearNum);
      }
      return true;
    }
    return false;
  };

  const getDatesForRange = () => {
    const range = widget.querySelector('input[name="stats-range"]:checked').value;
    const now = new Date();
    const dates = [];

    if (range === 'week') {
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        dates.push(d);
      }
      dates.reverse();
    } else if (range === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(new Date(d));
      }
    } else {
      const month = Number(widget.querySelector('.stats-month').value);
      const year = Number(widget.querySelector('.stats-year').value);
      const start = new Date(year, month, 1);
      const end = new Date(year, month + 1, 0);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(new Date(d));
      }
    }
    return dates;
  };

  const renderChart = (timeSeries, allPretzels, maxTotal) => {
    const chartEl = widget.querySelector('.stats-chart');
    chartEl.innerHTML = '';
    widget.querySelector('.stats-legend').innerHTML = allPretzels.map((pretzel, index) =>
      `<span class="stats-legend-item stats-color-${index + 1}">${pretzel}</span>`).join('');

    Object.entries(timeSeries).forEach(([, data]) => {
      const humanDate = data.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const total = Object.values(data.stats.pretzels).reduce((a, b) => a + b, 0);
      if (total) {
        const div = document.createElement('div');
        div.className = 'stats-chart-item';
        const description = document.createElement('div');
        description.className = 'stats-chart-item-description';
        description.innerHTML = `${humanDate} (${total})`;
        div.appendChild(description);
        const bar = document.createElement('div');
        bar.className = 'stats-chart-item-bar';
        allPretzels.forEach((pretzel, index) => {
          const value = data.stats.pretzels[pretzel];
          let width = 0;
          let label = '';
          if (value) {
            if (view === 'percent') {
              width = (value / total) * 100;
              label = `${Math.round(width)}%`;
            } else {
              width = (value / maxTotal) * 100;
              label = value;
            }
            bar.innerHTML += `<div class="stats-color-${index + 1} stats-chart-item-value" style="width: ${width}%;">${label}</div>`;
          }
        });
        div.appendChild(bar);
        chartEl.appendChild(div);
      }
    });
  };

  const escapeTsvCell = (val) => {
    const s = String(val ?? '');
    if (/[\t\n"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const buildTsv = (timeSeries) => {
    const rawRows = [];
    const keySet = new Set();
    Object.entries(timeSeries).forEach(([formattedDate, dayData]) => {
      const dataList = Array.isArray(dayData.data) ? dayData.data : [];
      dataList.forEach((row) => {
        if (row && typeof row === 'object') {
          rawRows.push({ date: formattedDate, ...row });
          Object.keys(row).forEach((k) => keySet.add(k));
        }
      });
    });
    const keys = ['date', ...[...keySet].sort()];
    const header = keys.map(escapeTsvCell).join('\t');
    const rows = rawRows.map((r) => keys.map((k) => r[k]).map(escapeTsvCell).join('\t'));
    return [header, ...rows].join('\n');
  };

  let lastLoadedData = null;

  const loadData = async () => {
    const statusEl = widget.querySelector('.stats-status');
    const chartEl = widget.querySelector('.stats-chart');
    statusEl.textContent = '';
    const dates = getDatesForRange();
    if (dates.length === 0) {
      chartEl.innerHTML = '';
      return;
    }

    chartEl.innerHTML = '';
    const timeSeries = {};
    const totalDays = dates.length;
    const exportBtn = widget.querySelector('.stats-export');

    try {
      for (let i = 0; i < dates.length; i += 1) {
        const date = dates[i];
        const formattedDate = formatDate(date);
        statusEl.textContent = `Loading ${i + 1} of ${totalDays}…`;
        let statsData;
        try {
          statsData = await fetchStats(formattedDate);
        } catch (err) {
          statsData = { stats: { pretzels: {}, items: {}, categories: {} }, data: [] };
          statsData.date = date;
        }
        timeSeries[formattedDate] = { ...statsData, date };

        const { allPretzels, maxTotal } = computeLegendAndMax(timeSeries);
        renderChart(timeSeries, allPretzels, maxTotal);

        lastLoadedData = {
          timeSeries: { ...timeSeries },
          allPretzels: [...allPretzels],
          periodSlug: getPeriodSlug(),
        };
        exportBtn.disabled = false;
      }
    } finally {
      statusEl.textContent = '';
    }
  };

  // Ensure Export UI exists (in case HTML is cached or old)
  if (!widget.querySelector('.stats-export')) {
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'stats-actions';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'stats-export';
    exportBtn.disabled = true;
    exportBtn.textContent = 'Export TSV';
    actionsDiv.appendChild(exportBtn);

    const panel = document.createElement('div');
    panel.className = 'stats-export-panel stats-export-panel-hidden';
    panel.innerHTML = '<label class="stats-export-label">Exported data (TSV)</label><textarea class="stats-export-tsv" readonly rows="12"></textarea><button type="button" class="stats-export-download">Download</button>';

    const controls = widget.querySelector('.stats-controls');
    const statusEl = widget.querySelector('.stats-status');
    if (controls && statusEl) {
      controls.after(actionsDiv);
      actionsDiv.after(panel);
    }
  }

  // Populate month/year dropdowns
  const now = new Date();
  const monthSelect = widget.querySelector('.stats-month');
  const yearSelect = widget.querySelector('.stats-year');
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  monthNames.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = name;
    if (i === now.getMonth()) opt.selected = true;
    monthSelect.appendChild(opt);
  });
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y -= 1) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === now.getFullYear()) opt.selected = true;
    yearSelect.appendChild(opt);
  }

  const toggleMonthYear = () => {
    const isPick = widget.querySelector('input[name="stats-range"]:checked').value === 'pick';
    widget.querySelector('.stats-month-year').classList.toggle('stats-month-year-visible', isPick);
  };
  toggleMonthYear();

  widget.querySelectorAll('input[name="stats-range"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      toggleMonthYear();
      pushRangeState();
    });
  });
  monthSelect.addEventListener('change', pushRangeState);
  yearSelect.addEventListener('change', pushRangeState);

  widget.querySelector('.stats-load').addEventListener('click', loadData);

  const rangeParam = url.searchParams.get('range');
  if (applyRangeFromParam(rangeParam)) {
    toggleMonthYear();
    loadData();
  }

  const exportPanel = widget.querySelector('.stats-export-panel');
  const exportTsvEl = widget.querySelector('.stats-export-tsv');

  widget.querySelector('.stats-export').addEventListener('click', () => {
    if (!lastLoadedData) return;
    const tsv = buildTsv(lastLoadedData.timeSeries);
    exportTsvEl.value = tsv;
    exportPanel.classList.remove('stats-export-panel-hidden');
  });

  widget.querySelector('.stats-export-download').addEventListener('click', () => {
    const tsv = exportTsvEl.value;
    if (!tsv) return;
    const slug = lastLoadedData?.periodSlug ?? 'stats';
    const blob = new Blob([tsv], { type: 'text/tab-separated-values' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stats-${slug}.tsv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Show chart area right away (empty legend + chart)
  widget.querySelector('.stats-legend').innerHTML = '';
  widget.querySelector('.stats-chart').innerHTML = '<div class="stats-chart-placeholder">Select range and click Load.</div>';
}
