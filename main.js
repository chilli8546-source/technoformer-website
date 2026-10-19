// TechnoFormer v2 — shared JS
(function(){
  // Mobile menu toggle
  var btn = document.getElementById('navToggle');
  var menu = document.getElementById('mobileMenu');
  if(btn && menu){
    btn.addEventListener('click', function(){ menu.classList.toggle('open'); });
    menu.querySelectorAll('a').forEach(function(a){
      a.addEventListener('click', function(){ menu.classList.remove('open'); });
    });
  }
  // Scroll reveal
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ e.target.classList.add('visible'); io.unobserve(e.target); }
    });
  }, {threshold:.12});
  document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });
  // Footer year
  var y = document.getElementById('year');
  if(y){ y.textContent = new Date().getFullYear(); }
  // Contact form (mailto fallback — no backend)
  var form = document.getElementById('contactForm');
  if(form){
    form.addEventListener('submit', function(ev){
      ev.preventDefault();
      var name = document.getElementById('cf-name').value.trim();
      var email = document.getElementById('cf-email').value.trim();
      var msg = document.getElementById('cf-msg').value.trim();
      if(!name || !email || !msg){ alert('Please fill all fields.'); return; }
      var subject = encodeURIComponent('TechnoFormer contact from ' + name);
      var body = encodeURIComponent('Name: ' + name + '\nEmail: ' + email + '\n\n' + msg);
      window.location.href = 'mailto:hello@technoformer.example?' + 'subject=' + subject + '&body=' + body;
      var note = document.getElementById('formNote');
      if(note){ note.textContent = 'Opening your email app… if it did not open, write to us on YouTube/Instagram.'; }
    });
  }
})();
