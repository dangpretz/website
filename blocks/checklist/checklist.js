import { toClassName } from '../../scripts/aem.js';
import { fetchLog, appendLog } from '../../scripts/sheet-logger.js';

export default function decorate(block) {
  const checklistName = toClassName(block.querySelector('h1, h2, h3').textContent);
  const now = new Date();
  const params = new URLSearchParams(window.location.search);
  const date = params.get('date') || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const transposeToTasks = (logData) => {
    const taskStatus = {};
    logData.forEach((item) => {
      const { state, timeStamp, by } = item;
      taskStatus[item.task] = { state, timeStamp, by };
    });
    return taskStatus;
  };

  const updateChecklist = async () => {
    const badgeElem = (elem, info) => {
      if (elem.querySelector('.checklist-badge')) {
        elem.querySelector('.checklist-badge').remove();
      }
      const badge = document.createElement('span');
      badge.classList.add('checklist-badge');
      const completedDate = new Date(info.timeStamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      badge.textContent = `${info.by} ${completedDate}`;
      elem.append(badge);
    };

    const logData = await fetchLog(`/dangpretz/checklists/${checklistName}/${date}`);
    const tasks = transposeToTasks(logData);
    Object.keys(tasks).forEach((task) => {
      const taskname = toClassName(task);
      const input = block.querySelector(`input[name="${taskname}"]`);
      if (input) {
        input.checked = tasks[task].state === 'done';
        const li = input.closest('li');
        li.className = tasks[task].state;
        badgeElem(li, tasks[task]);
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
      li.className = state;
      const by = window.internalUser;
      await appendLog(`/dangpretz/checklists/${checklistName}/${date}`, {
        task: taskname,
        by,
        state,
      });
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
