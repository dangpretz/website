import { toClassName } from '../../scripts/aem.js';
import { fetchLog, appendLog } from '../../scripts/sheet-logger.js';

export default function decorate(block) {
  const heading = block.querySelector('h1, h2, h3');
  const recipeName = toClassName(heading.textContent);
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const select = document.createElement('select');
  select.name = 'volume';
  select.innerHTML = `
    <option value="1">1 Sheet</option>
    <option value="2" selected>2 Sheets</option>
    <option value="3">3 Sheets</option>
    <option value="4">4 Sheets</option>
    <option value="5">5 Sheets</option>
    <option value="6">6 Sheets</option>
    <option value="7">7 Sheets</option>
    <option value="8">8 Sheets</option>
    `;

  heading.append(select);

  const note = document.createElement('span');
  note.className = 'recipe-note';
  note.innerHTML = '<span class="recipe-note-icon"></span><textarea placeholder="Type notes for this prep..."></textarea>';
  heading.after(note);

  const noteTextArea = note.querySelector('textarea');

  const updateIngredientAmounts = () => {
    const humanReadable = (grams) => {
      if (grams >= 1000) {
        return `${grams / 1000}kg`;
      }
      return `${grams}g`;
    };

    const sheets = select.value;
    block.querySelectorAll('.recipe-amount').forEach((span) => {
      const amount = span.dataset.originalValue;
      const grams = parseInt(amount, 10) * (amount.includes('k') ? 1000 : 1);
      span.textContent = humanReadable(grams * sheets);
    });
  };

  select.addEventListener('change', updateIngredientAmounts);

  const transposeToTasks = (logData) => {
    const taskStatus = {};
    logData.forEach((item) => {
      taskStatus[item.task] = item;
    });
    return taskStatus;
  };

  const updateRecipe = async () => {
    const logData = await fetchLog(`/dangpretz/recipes/${recipeName}/${date}`);
    const tasks = transposeToTasks(logData);
    Object.keys(tasks).forEach((task) => {
      const taskname = toClassName(task);
      const input = block.querySelector(`input[name="${taskname}"]`);
      if (input) {
        input.checked = tasks[task].state === 'done';
        const li = input.closest('li');
        li.classList.add(tasks[task].state);
        if (li.querySelector('.recipe-badge')) {
          li.querySelector('.recipe-badge').remove();
        }
        const badge = document.createElement('span');
        badge.classList.add('recipe-badge');
        const completedDate = new Date(tasks[task].timeStamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        badge.textContent = `${tasks[task].by} ${completedDate}`;
        li.append(badge);
      }
    });

    if (tasks.note && tasks.note.message) {
      note.classList.add('recipe-note-highlight');
      noteTextArea.value = tasks.note.message;
      if (note.querySelector('.recipe-badge')) {
        note.querySelector('.recipe-badge').remove();
      }
      const badge = document.createElement('span');
      badge.classList.add('recipe-badge');
      const completedDate = new Date(tasks.note.timeStamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      badge.textContent = `${tasks.note.by} ${completedDate}`;
      note.append(badge);
    } else {
      note.classList.remove('recipe-note-highlight');
    }
  };

  noteTextArea.addEventListener('change', async () => {
    const by = window.internalUser;
    const message = noteTextArea.value;
    await appendLog(`/dangpretz/recipes/${recipeName}/${date}`, {
      task: 'note',
      by,
      message,
    });
    updateRecipe();
  });

  block.querySelectorAll('ul li').forEach((li) => {
    const ingredient = li.textContent.split(' (')[0].split(' ').pop();
    const taskname = toClassName(ingredient);

    const amount = document.createElement('span');
    amount.className = 'recipe-amount';
    [amount.textContent] = li.textContent.split(' ');
    amount.dataset.originalValue = amount.textContent;
    li.innerHTML = li.innerHTML.replace(amount.textContent, '');
    li.prepend(amount);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = false;
    input.name = taskname;
    li.prepend(input);

    const toggleIngredient = async (event) => {
      event.preventDefault();
      if (event.target !== input) input.checked = !input.checked;
      const state = input.checked ? 'done' : 'open';
      li.classList.toggle('done');
      const by = window.internalUser;
      await appendLog(`/dangpretz/recipes/${recipeName}/${date}`, {
        task: taskname,
        by,
        state,
      });
      updateRecipe();
    };

    input.addEventListener('change', toggleIngredient);
    li.addEventListener('click', toggleIngredient);
  });

  updateIngredientAmounts();
  updateRecipe();

  window.addEventListener('focus', () => {
    // Code to execute when the window gains focus
    updateRecipe();
  });
}
