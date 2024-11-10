export default function decorate(block) {
  block.addEventListener('click', (event) => {
    const { target } = event;
    if (target.tagName === 'IMG') {
      [window.location] = target.currentSrc.split('?');
    }
  });
}
