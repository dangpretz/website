import { toClassName } from '../../scripts/aem.js';

export default function decorate(block) {
  const checklistName = toClassName(block.querySelector('h1, h2, h3').textContent);
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const fetchLogData = async (url) => {
    const response = await fetch(url);
    return response.json();
  };

  const transposeToTasks = (logData) => {
    const taskStatus = {};
    logData.forEach((item) => {
      const { state, timeStamp, by } = item;
      taskStatus[item.task] = { state, timeStamp, by };
    });
    return taskStatus;
  };

  const updateChecklist = async () => {
    const logData = await fetchLogData(`https://sheet-logger.david8603.workers.dev/dangpretz/${checklistName}/${date}`);
    const tasks = transposeToTasks(logData);
    Object.keys(tasks).forEach((task) => {
      const taskname = toClassName(task);
      const input = block.querySelector(`input[name="${taskname}"]`);
      if (input) {
        input.checked = tasks[task].state === 'done';
        const li = input.closest('li');
        li.classList.add(tasks[task].state);
        if (li.querySelector('.checklist-badge')) {
          li.querySelector('.checklist-badge').remove();
        }
        const badge = document.createElement('span');
        badge.classList.add('checklist-badge');
        const completedDate = new Date(tasks[task].timeStamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        badge.textContent = `${tasks[task].by} ${completedDate}`;
        li.append(badge);
      }
    });
  };

  block.querySelectorAll('ul li').forEach((li) => {
    const taskname = toClassName(li.textContent.split(':')[0]);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = false;
    input.name = taskname;
    li.prepend(input);

    const toggleChecklistItem = async (event) => {
      event.preventDefault();
      if (event.target !== input) input.checked = !input.checked;
      const state = input.checked ? 'done' : 'open';
      li.classList.toggle('done');
      const by = window.internalUser;
      const resp = await fetch(`https://sheet-logger.david8603.workers.dev/dangpretz/${checklistName}/${date}?task=${taskname}&state=${state}&by=${by}`, {
        method: 'POST',
      });
      if (resp.status === 200) {
        console.log('Logged', taskname, state, by);
      }
      updateChecklist();
    };

    input.addEventListener('change', toggleChecklistItem);
    li.addEventListener('click', toggleChecklistItem);
  });

  document.querySelector('.icon-date').outerHTML = ` ${date.substring(5)}`;

  updateChecklist();

  window.addEventListener('focus', () => {
    // Code to execute when the window gains focus
    updateChecklist();
  });
}
