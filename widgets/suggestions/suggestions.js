import { fetchLog, appendLog } from '../../scripts/sheet-logger.js';
import { getVoter } from '../../scripts/scripts.js';



export default async function decorate(widget) {
  const LIST = widget.querySelector('#suggestions-list');
  const RECIPE = widget.querySelector('#suggestions-recipe');
  const DESCRIPTION = widget.querySelector('#suggestions-description');
  const url = new URL(widget.dataset.widgetUrl);
  const box = url.searchParams.get('box');

  const transposeToRecipes = (logData) => {
    const recipes = {};
    logData.forEach((item) => {
      if (item.action === 'add') {
        recipes[item.recipe] = item;
        recipes[item.recipe].likes = [];
      }
      if (item.action === 'remove') {
        delete recipes[item.recipe];
      }
      if (item.action === 'like') {
        recipes[item.recipe].likes.push(item.by);
      }
      if (item.action === 'unlike') {
        recipes.splice(recipes.indexOf(item.by), 1);
      }
    });
    return recipes;
  };

  const updateList = async () => {
    LIST.textContent = '';
    const logs = await fetchLog(`/dangpretz/suggestions/${box}`);
    const recipes = transposeToRecipes(logs);
    const keys = Object.keys(recipes);
    keys.forEach((key) => {
      const li = document.createElement('li');
      li.textContent = key;
      LIST.append(li);
    });
  };

  const form = widget.querySelector('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    console.log(widget.dataset);
    console.log(box);
    const recipe = RECIPE.value;
    const description = DESCRIPTION.value;
    const by = getVoter();
    await appendLog(`/dangpretz/suggestions/${box}`, {
      action: 'add',
      recipe,
      description,
      by,
    });
    form.reset();
  });
  await updateList();
}
