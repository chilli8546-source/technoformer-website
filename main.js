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
})();
