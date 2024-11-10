export default function decorate(block) {
  if (block.classList.contains('top-devils')) {
    [1, 3].forEach((i) => {
      const devil = document.createElement('img');
      devil.src = `/icons/devil-${i}.svg`;
      devil.alt = 'devil';
      devil.loading = 'lazy';
      devil.classList.add('blink-1');
      devil.classList.add('animated-devil');
      setTimeout(() => {
        const place = (d) => {
          const distro = window.innerWidth > 900 ? 40 : 60;
          d.style.top = '2.1em';
          d.style.left = `${Math.floor(Math.random() * distro)}%`;
        };
        block.append(devil);
        place(devil);
        setInterval(() => {
          place(devil);
        }, 5000);
      }, i * 1000);
    });
  }
}
