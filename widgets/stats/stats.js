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

    for (let i = 0; i < dates.length; i += 1) {
      const date = dates[i];
      const formattedDate = formatDate(date);
      statusEl.textContent = `Loading ${i + 1} of ${totalDays}…`;
      const statsData = await fetchStats(formattedDate);
      timeSeries[formattedDate] = { ...statsData, date };

      const { allPretzels, maxTotal } = computeLegendAndMax(timeSeries);
      renderChart(timeSeries, allPretzels, maxTotal);
    }

    statusEl.textContent = '';
  };

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
    radio.addEventListener('change', toggleMonthYear);
  });

  widget.querySelector('.stats-load').addEventListener('click', loadData);

  // Show chart area right away (empty legend + chart)
  widget.querySelector('.stats-legend').innerHTML = '';
  widget.querySelector('.stats-chart').innerHTML = '<div class="stats-chart-placeholder">Select range and click Load.</div>';
}
