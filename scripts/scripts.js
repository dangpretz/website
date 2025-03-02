import { fetchLog, appendLog, transposeByKey } from './sheet-logger.js';
import {
  buildBlock,
  loadHeader,
  loadFooter,
  decorateButtons,
  decorateIcons,
  decorateSections,
  decorateBlocks,
  decorateTemplateAndTheme,
  getMetadata,
  waitForFirstImage,
  loadSection,
  loadSections,
  loadCSS,
  sampleRUM,
} from './aem.js';

/**
 * Builds hero block and prepends to main in a new section.
 * @param {Element} main The container element
 */
function buildHeroBlock(main) {
  const h1 = main.querySelector('h1');
  const picture = main.querySelector('picture');
  // eslint-disable-next-line no-bitwise
  if (h1 && picture && (h1.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_PRECEDING)) {
    const section = document.createElement('div');
    section.append(buildBlock('hero', { elems: [picture, h1] }));
    main.prepend(section);
  }
}

/**
 * load fonts.css and set a session storage flag
 */
async function loadFonts() {
  await loadCSS(`${window.hlx.codeBasePath}/styles/fonts.css`);
  try {
    if (!window.location.hostname.includes('localhost')) sessionStorage.setItem('fonts-loaded', 'true');
  } catch (e) {
    // do nothing
  }
}

function autolinkModals(doc) {
  doc.addEventListener('click', async (e) => {
    const origin = e.target.closest('a');
    if (origin && origin.href && origin.href.includes('/modals/')) {
      e.preventDefault();
      const { openModal } = await import(`${window.hlx.codeBasePath}/blocks/modal/modal.js`);
      openModal(origin.href);
    }
  });
}

/**
 * Builds all synthetic blocks in a container element.
 * @param {Element} main The container element
 */
function buildAutoBlocks(main) {
  try {
    buildHeroBlock(main);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto Blocking failed', error);
  }
}

async function loadInventory() {
  const now = new Date();
  const params = new URLSearchParams(window.location.search);
  const date = params.get('date') || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const isManaged = getMetadata('inventory');
  if (isManaged) {
    const invName = window.location.pathname.split('/').pop();
    const inventoryPath = `/dangpretz/inventory/${invName}/${date}`;
    const invLog = await fetchLog(inventoryPath);
    const inventory = transposeByKey(invLog, 'menuitem');

    document.querySelectorAll('h3').forEach((item) => {
      const itemId = item.id.split('--')[0];
      if (item.querySelector('.inventory-state')) {
        item.querySelector('.inventory-state').remove();
      }

      if (inventory[itemId] && inventory[itemId].state) {
        item.dataset.inventory = inventory[itemId].state;
        const state = document.createElement('span');
        if (inventory[itemId].state === 'baking') {
          const elapsed = (Date.now() - new Date(inventory[itemId].timeStamp).getTime()) / 60000;
          if (elapsed < 15) {
            state.innerHTML = `<span class="icon-alarm"></span> ${15 - Math.floor(elapsed)} min`;
          }
        } else {
          state.textContent = `${inventory[itemId].state}`;
        }
        if (state.textContent) {
          state.classList.add('inventory-state');
          state.classList.add(`inventory-state-${inventory[itemId].state}`);
          item.firstElementChild.append(state);
        }
      }

      if (window.internalUser) {
        item.addEventListener('click', async () => {
          const menuitem = itemId;
          const by = window.internalUser;
          const currentState = inventory[menuitem] ? inventory[menuitem].state : '';
          let state = '';
          if (currentState === 'baking') state = '';
          if (currentState === 'out') state = 'baking';
          if (currentState === '') state = 'out';

          await appendLog(inventoryPath, {
            menuitem,
            by,
            state,
          });
          window.location.reload();
        });
      }
    });
  }
}

async function decorateSignage() {
  let originalFiles = {};

  const hiddenSetup = document.querySelector('.icon-cute-devil');
  if (hiddenSetup) {
    hiddenSetup.addEventListener('click', () => {
      window.location.href = '/static/signage.html';
    });
  }

  async function fetchFiles() {
    const files = ['/scripts/scripts.js', '/styles/styles.css', window.location.href];
    const texts = [];
    while (files.length) {
      const file = files.shift();
      // eslint-disable-next-line no-await-in-loop
      const resp = await fetch(file, { cache: 'reload' });
      if (resp.status !== 200) {
        throw new Error(`Failed to fetch ${file}`);
      }
      // eslint-disable-next-line no-await-in-loop
      texts.push(await resp.text());
    }
    const invName = window.location.pathname.split('/').pop();
    const now = new Date();
    const params = new URLSearchParams(window.location.search);
    const date = params.get('date') || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    texts.push(JSON.stringify(await fetchLog(`/dangpretz/inventory/${invName}/${date}`)));
    return texts;
  }

  const refreshIfNeeded = async () => {
    try {
      await loadInventory();
      const texts = await fetchFiles();
      if (texts.some((text, i) => text !== originalFiles[i])) {
        window.location.reload();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  if (mode === 'signage') {
    const screen = +params.get('screen');
    document.querySelectorAll('.section').forEach((section, i) => {
      if (i + 1 !== screen) {
        section.style.display = 'none';
      }
    });
    document.body.classList.add('signage');
    document.body.addEventListener('click', refreshIfNeeded);
    setInterval(refreshIfNeeded, 1000 * 60);
  }
  originalFiles = await fetchFiles();
}

function decorateMenu(main) {
  const h3s = main.querySelectorAll('h3');
  h3s.forEach((h3) => {
    const inner = h3.innerHTML;
    if (inner.includes('... ')) {
      const [item, price] = inner.split('... ');
      h3.innerHTML = `<span>${item}</span><span>${price}</span>`;
    } else {
      h3.innerHTML = `<span>${inner}</span>`;
    }
  });
}

export function decoratePhoneLinks(elem) {
  const isMobile = (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent));
  const isMac = (navigator.appVersion.indexOf('Mac') !== -1);
  elem.querySelectorAll('a[href^="https://sms/"]').forEach((a) => {
    if (isMobile || isMac) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const url = new URL(a.href);
        const body = url.searchParams.get('body');
        const num = `+1${url.pathname}`;
        // TODO: Make this configurable
        window.open(`sms:${num}?&body=${body}`);
      });
    } else {
      a.removeAttribute('href');
      a.classList.remove('button');
    }
  });
}

/**
 * Handles internal user login dialog
 * @returns {void}
 */

function handleInternalUser() {
  window.internalUser = localStorage.getItem('internalUser');
  const isInternal = window.location.pathname.includes('/internal/');
  const forceLogin = window.location.search === '?login';
  if ((isInternal && !window.internalUser) || forceLogin) {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `
      <h2>Pretzlers only.</h2>
      <form>
        <label for="internalUser">Login with your name to access the bakery</label><br>
        <input id="internalUser" name="internalUser" type="text" required><br>
        <button type="submit">Login</button>
      </form>`;
    dialog.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      window.internalUser = dialog.querySelector('#internalUser').value;
      localStorage.setItem('internalUser', window.internalUser);
      dialog.close();
      handleInternalUser();
      if (window.location.search === '?login') {
        window.location.search = '';
      } else {
        window.location.reload();
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  if (isInternal && window.internalUser) {
    document.querySelectorAll('.icon-user').forEach((user) => {
      user.outerHTML = `${window.internalUser}`;
    });
  }
}

function decorateMenuIcons(main) {
  const spans = main.querySelectorAll('.icon-v, .icon-vg');
  spans.forEach((span) => {
    span.classList.remove('icon');
  });
}

/**
 * Decorates the main element.
 * @param {Element} main The main element
 */
// eslint-disable-next-line import/prefer-default-export
export function decorateMain(main) {
  // hopefully forward compatible button decoration
  if (document.body.classList.contains('menu')) decorateMenu(main);
  decorateButtons(main);
  decorateMenuIcons(main);
  decorateIcons(main);
  buildAutoBlocks(main);
  decorateSections(main);
  decorateBlocks(main);
  decoratePhoneLinks(main);
  handleInternalUser();
}

/**
 * Loads everything needed to get to LCP.
 * @param {Element} doc The container element
 */
async function loadEager(doc) {
  doc.documentElement.lang = 'en';
  decorateTemplateAndTheme();
  if (getMetadata('breadcrumbs').toLowerCase() === 'true') {
    doc.body.dataset.breadcrumbs = true;
  }
  const main = doc.querySelector('main');
  if (main) {
    decorateMain(main);
    doc.body.classList.add('appear');
    await loadSection(main.querySelector('.section'), waitForFirstImage);
  }

  sampleRUM.enhance();

  try {
    /* if desktop (proxy for fast connection) or fonts already loaded, load fonts.css */
    if (window.innerWidth >= 900 || sessionStorage.getItem('fonts-loaded')) {
      loadFonts();
    }
  } catch (e) {
    // do nothing
  }
}

/**
 * Loads everything that doesn't need to be delayed.
 * @param {Element} doc The container element
 */
async function loadLazy(doc) {
  autolinkModals(doc);

  const main = doc.querySelector('main');
  await loadSections(main);

  const { hash } = window.location;
  const element = hash ? doc.getElementById(hash.substring(1)) : false;
  if (hash && element) element.scrollIntoView();

  decorateSignage();

  loadHeader(doc.querySelector('header'));
  loadFooter(doc.querySelector('footer'));

  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
  loadFonts();
  loadInventory();
}

/**
 * Loads everything that happens a lot later,
 * without impacting the user experience.
 */
function loadDelayed() {
  document.querySelectorAll('.section.mission-statement').forEach((section) => {
    [1, 2, 3, 4, 5].forEach((i) => {
      const devil = document.createElement('img');
      devil.src = `/icons/devil-${i}.svg`;
      devil.alt = 'devil';
      devil.loading = 'lazy';
      devil.classList.add('blink-1');
      devil.classList.add('animated-devil');
      setTimeout(() => {
        const place = (d) => {
          d.style.top = `${Math.floor(Math.random() * 60) + 20}%`;
          d.style.left = `${Math.floor(Math.random() * 60) + 20}%`;
        };
        section.append(devil);
        place(devil);
        setInterval(() => {
          place(devil);
        }, 5000);
      }, i * 1000);
    });
  });
  // eslint-disable-next-line import/no-cycle
  window.setTimeout(() => import('./delayed.js'), 3000);
  // load anything that can be postponed to the latest here
}

export function getVoter() {
  const randomString = () => `${Math.random().toString(36).substring(2, 5)}-${Math.random().toString(36).substring(2, 5)}`.toUpperCase();
  let voter = localStorage.getItem('voter');
  if (!voter) {
    voter = randomString();
    localStorage.setItem('voter', voter);
  }
  return voter;
}

async function loadPage() {
  await loadEager(document);
  await loadLazy(document);
  loadDelayed();
}

loadPage();
