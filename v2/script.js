(function () {
  // Rotating eyebrow role label
  var eyebrowEl = document.getElementById('v2EyebrowRole');
  if (eyebrowEl) {
    var roles = ['AI Product Manager', 'Platform & Integrations', 'Data Enthusiast'];
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

  // ---- Selected Work: rendered from ../project.html so v2 always mirrors the classic site ----
  function escHtml(s) {
    return (s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Attach the cursor-follow label + accent-retheme behaviors to whatever work items exist now.
  function wireWorkItems() {
    var follow = document.getElementById('cursorFollow');
    var isHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    document.querySelectorAll('.v2-work-item[data-accent]').forEach(function (item) {
      item.addEventListener('click', function () {
        document.documentElement.style.setProperty('--accent', item.dataset.accent);
      });
      if (isHover && follow) {
        item.addEventListener('mouseenter', function () { follow.classList.add('active'); });
        item.addEventListener('mouseleave', function () { follow.classList.remove('active'); });
        item.addEventListener('mousemove', function (e) {
          follow.style.left = e.clientX + 'px';
          follow.style.top = e.clientY + 'px';
        });
      }
    });
  }

  function renderWork() {
    var list = document.getElementById('v2WorkList');
    if (!list) { wireWorkItems(); return; }
    var src = list.getAttribute('data-source') || '../project.html';
    fetch(src).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var section = doc.querySelector('.section.project');
      if (!section) throw new Error('no project section');
      var out = '';
      Array.prototype.forEach.call(section.children, function (node) {
        if (node.classList && node.classList.contains('project-group')) {
          var label = node.querySelector('.project-group-label');
          var note = node.querySelector('.project-group-note');
          out += '<div class="v2-work-group">' + escHtml(label ? label.textContent.trim() : '')
            + (note ? ' <span>' + escHtml(note.textContent.trim().replace(/^Products\s+/i, '')) + '</span>' : '')
            + '</div>';
        } else if (node.tagName === 'ARTICLE' && node.classList.contains('case-study')) {
          var h3 = node.querySelector('h3');
          var title = h3 ? h3.textContent.trim() : '';
          var accent = node.getAttribute('data-accent-dark') || node.getAttribute('data-accent-light') || 'var(--accent)';
          var meta = node.getAttribute('data-v2-meta');
          if (!meta) { var tag = node.querySelector('.case-tag'); meta = tag ? tag.textContent.trim() : ''; }
          if (!title) return;
          out += '<a class="v2-work-item" data-accent="' + escHtml(accent) + '" href="' + escHtml(src) + '">'
            + '<span class="v2-work-title">' + escHtml(title) + '</span>'
            + '<span class="v2-work-meta">' + escHtml(meta) + '</span></a>';
        }
      });
      list.innerHTML = out;
      wireWorkItems();
    }).catch(function () {
      // Graceful fallback if the source can't be fetched (e.g. opened via file://).
      list.innerHTML = '<a class="v2-work-item" href="../project.html">'
        + '<span class="v2-work-title">See all projects →</span>'
        + '<span class="v2-work-meta">Full case studies</span></a>';
      wireWorkItems();
    });
  }

  renderWork();

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

  var sayHelloBtn = document.getElementById('sayHelloBtn');
  if (sayHelloBtn) {
    sayHelloBtn.addEventListener('click', function (e) {
      e.preventDefault();
      openChat();
    });
  }
})();
