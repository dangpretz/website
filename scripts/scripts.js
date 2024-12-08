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

function decorateMenu(main) {
  const h3s = main.querySelectorAll('h3');
  h3s.forEach((h3) => {
    const inner = h3.innerHTML;
    if (inner.includes(' ... ')) {
      const [item, price] = inner.split(' ... ');
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
      if (window.location.search === '?login') {
        window.location.search = '';
      }
      dialog.close();
      handleInternalUser();
    });
    document.body.append(dialog);
    dialog.showModal();
  }
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

  loadHeader(doc.querySelector('header'));
  loadFooter(doc.querySelector('footer'));

  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
  loadFonts();
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

async function loadPage() {
  await loadEager(document);
  await loadLazy(document);
  loadDelayed();
}

loadPage();
