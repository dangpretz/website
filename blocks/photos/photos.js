export default function decorate(block) {
  block.addEventListener('click', (event) => {
    const target = event.target;
    if (target.tagName === 'IMG') {
      window.location = target.currentSrc.split('?')[0];
    }
  });
}