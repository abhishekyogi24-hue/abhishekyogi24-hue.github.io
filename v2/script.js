(function () {
  // Rotating eyebrow role label
  var eyebrowEl = document.getElementById('v2EyebrowRole');
  if (eyebrowEl) {
    var roles = ['Product Manager', 'Data Enthusiast'];
    var roleIndex = 0;
    setInterval(function () {
      eyebrowEl.classList.add('eyebrow-fade');
      setTimeout(function () {
        roleIndex = (roleIndex + 1) % roles.length;
        eyebrowEl.textContent = roles[roleIndex];
        eyebrowEl.classList.remove('eyebrow-fade');
      }, 350);
    }, 2400);
  }

  // Reveal-on-scroll for below-the-fold sections
  var reveals = document.querySelectorAll('.reveal-section');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in-view'); });
  }

  // Hamburger overlay menu
  var toggle = document.getElementById('menuToggle');
  var overlay = document.getElementById('overlayNav');
  function closeMenu() {
    overlay.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
  }
  function toggleMenu() {
    var open = !overlay.classList.contains('open');
    overlay.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    overlay.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('no-scroll', open);
  }
  toggle.addEventListener('click', toggleMenu);
  overlay.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', closeMenu);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });

  // Cursor-follow "View" label on work items (pointer devices only)
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    var follow = document.getElementById('cursorFollow');
    var workItems = document.querySelectorAll('.v2-work-item');
    workItems.forEach(function (item) {
      item.addEventListener('mouseenter', function () { follow.classList.add('active'); });
      item.addEventListener('mouseleave', function () { follow.classList.remove('active'); });
      item.addEventListener('mousemove', function (e) {
        follow.style.left = e.clientX + 'px';
        follow.style.top = e.clientY + 'px';
      });
    });
  }

  // Click a project -> retheme the accent color
  var workAccentItems = document.querySelectorAll('.v2-work-item[data-accent]');
  workAccentItems.forEach(function (item) {
    item.addEventListener('click', function () {
      document.documentElement.style.setProperty('--accent', item.dataset.accent);
    });
  });

  // Chat widget
  var launcher = document.getElementById('chat-launcher');
  var wrap = document.getElementById('chat-frame-wrap');
  var frame = document.getElementById('chat-frame');
  var widget = document.getElementById('chat-widget');
  var loaded = false;

  function openChat() {
    if (!loaded) { frame.src = '../chatbot.html?theme=v2'; loaded = true; }
    wrap.hidden = false;
    requestAnimationFrame(function () { widget.classList.add('open'); });
    launcher.setAttribute('aria-label', 'Close chat');
    launcher.setAttribute('aria-expanded', 'true');
  }
  function closeChat() {
    widget.classList.remove('open');
    launcher.setAttribute('aria-label', 'Open chat');
    launcher.setAttribute('aria-expanded', 'false');
    setTimeout(function () { if (!widget.classList.contains('open')) wrap.hidden = true; }, 200);
  }
  launcher.addEventListener('click', function () {
    if (widget.classList.contains('open')) closeChat(); else openChat();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && widget.classList.contains('open')) closeChat();
  });
})();
