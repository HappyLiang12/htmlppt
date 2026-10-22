export const RUNTIME_SOURCE = String.raw`
(() => {
  var slides = Array.prototype.slice.call(document.querySelectorAll('[data-slide-id]'));
  if (!slides.length) return;
  var index = 0;
  var runtimeStyle = 'data-ppt-runtime-style';
  var originalDisplay = slides.map(function (slide) { return slide.style.display; });

  Array.prototype.forEach.call(document.querySelectorAll('[data-ppt-deck]'), function (deck) {
    deck.setAttribute('data-ppt-ready', '1');
  });

  function isEditing(target) {
    var element = target;
    while (element) {
      var tag = element.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable) return true;
      if (element === document.body) return false;
      element = element.parentElement;
    }
    return false;
  }

  function show(next) {
    index = Math.max(0, Math.min(slides.length - 1, next));
    slides.forEach(function (slide, i) {
      slide.style.display = i === index ? originalDisplay[i] : 'none';
    });
    history.replaceState(null, '', '#/' + (index + 1));
  }

  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditing(event.target)) return;
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

  if (!document.querySelector('[' + runtimeStyle + ']')) {
    var style = document.createElement('style');
    style.setAttribute(runtimeStyle, '1');
    style.textContent = '@media print{[data-slide-id]{break-after:page;page-break-after:always}}';
    document.head.appendChild(style);
  }

  var printState = null;
  window.addEventListener('beforeprint', function () {
    if (printState) return;
    printState = slides.map(function (slide) { return slide.style.display; });
    slides.forEach(function (slide, i) { slide.style.display = originalDisplay[i]; });
  });
  window.addEventListener('afterprint', function () {
    printState = null;
    show(index);
  });

  var initial = /#\/(\d+)/.exec(location.hash);
  show(initial ? Number(initial[1]) - 1 : 0);
})();
`;
