export const RUNTIME_SOURCE = String.raw`
(() => {
  var slides = Array.prototype.slice.call(document.querySelectorAll('[data-slide-id]'));
  if (!slides.length) return;
  var index = 0;

  function show(next) {
    index = Math.max(0, Math.min(slides.length - 1, next));
    slides.forEach(function (slide, i) {
      slide.style.display = i === index ? '' : 'none';
    });
    history.replaceState(null, '', '#/' + (index + 1));
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'PageDown') {
      event.preventDefault();
      show(index + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      show(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      show(slides.length - 1);
    }
  });

  window.addEventListener('hashchange', function () {
    var match = /#\/(\d+)/.exec(location.hash);
    if (match) show(Number(match[1]) - 1);
  });

  var initial = /#\/(\d+)/.exec(location.hash);
  show(initial ? Number(initial[1]) - 1 : 0);
})();
`;
