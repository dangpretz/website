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
    const data = await response.json();
    return data;
  };

  const fetchDays = async (days) => {
    const now = new Date();
    const timeSeries = {};
    for (let i = 1; i <= days; i += 1) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const formattedDate = formatDate(date);
      // eslint-disable-next-line no-await-in-loop
      const statsData = await fetchStats(formattedDate);
      timeSeries[formattedDate] = statsData;
      timeSeries[formattedDate].date = date;
    }
    return (timeSeries);
  };

  const week = await fetchDays(30);
  const allPretzels = [];
  let maxTotal = 0;
  Object.entries(week).forEach(([, data]) => {
    let total = 0;
    Object.keys(data.stats.pretzels).forEach((pretzel) => {
      total += data.stats.pretzels[pretzel];
      if (!allPretzels.includes(pretzel)) {
        allPretzels.push(pretzel);
      }
      if (total > maxTotal) {
        maxTotal = total;
      }
    });
    allPretzels.sort();
    widget.querySelector('.stats-legend').innerHTML = allPretzels.map((pretzel, index) => `<span class="stats-legend-item stats-color-${index + 1}">${pretzel}</span>`).join('');
  });

  Object.entries(week).forEach(([, data]) => {
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
      widget.querySelector('.stats-chart').appendChild(div);
    }
  });
}
